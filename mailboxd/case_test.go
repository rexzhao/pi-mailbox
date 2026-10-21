package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestNameCaseInsensitivity pins the display-case model: names may carry
// case (1-255 chars, letter first), the canonical identity is lowercase
// (files, registration, comparisons), the claimed spelling is display-only
// (_case meta + the welcome's mailbox field), and every address use
// (send/read/delete) is case-insensitive.
func TestNameCaseInsensitivity(t *testing.T) {
	tmp := t.TempDir()
	projectRoot := filepath.Join(tmp, "proj")
	mailDir := filepath.Join(projectRoot, ".pi", "mailbox")
	os.MkdirAll(mailDir, 0o755)
	sessionDir := filepath.Join(tmp, "sessions")
	os.MkdirAll(sessionDir, 0o755)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	const project = "proj-case"

	// claim with case: welcome echoes the CLAIMED spelling
	a := dialTest(t, port)
	w := a.helloLogin(1, project, projectRoot, sessionDir, "shortaaaa", "originA", "agent-a", "CaseTest", "")
	if w["t"] != "welcome" || w["mailbox"] != "CaseTest" {
		t.Fatalf("claim with case: %v", w)
	}
	// the file on disk is the CANONICAL lowercase identity
	if _, err := os.Stat(filepath.Join(mailDir, "casetest.jsonl")); err != nil {
		t.Fatalf("canonical lowercase file must exist: %v", err)
	}
	// the claimed spelling rides the _case meta
	sess := a.request(map[string]interface{}{"t": "sessions", "rid": 2, "includeOffline": true})
	found := false
	for _, s := range sess["sessions"].([]interface{}) {
		sm := s.(map[string]interface{})
		if sm["session"] == "casetest" {
			meta := sm["meta"].(map[string]interface{})
			if meta["_case"] != "CaseTest" {
				t.Fatalf("_case meta = %v, want CaseTest", meta["_case"])
			}
			found = true
		}
	}
	if !found {
		t.Fatalf("sessions listing must show the canonical id: %v", sess)
	}

	// a sender addresses the mailbox in ANY case: delivery folds
	b := dialTest(t, port)
	if w := b.helloLogin(3, project, projectRoot, sessionDir, "shortbbbb", "originB", "agent-b", "Sender-1", ""); w["t"] != "welcome" {
		t.Fatalf("sender (1-char-suffix name): %v", w)
	}
	if m := b.request(map[string]interface{}{
		"t": "send", "rid": 4,
		"target":  map[string]string{"project": project, "session": "CASETEST"},
		"subject": "cased", "body": "x",
	}); m["t"] != "sent" {
		t.Fatalf("send with UPPER case target must fold and deliver: %v", m)
	}
	// the recipient reads it back via a differently-cased ref
	in := a.request(map[string]interface{}{"t": "inbox", "rid": 5, "limit": 10})
	if int(in["total"].(float64)) != 1 {
		t.Fatalf("inbox after cased send: %v", in)
	}
	mailID := in["mails"].([]interface{})[0].(map[string]interface{})["id"].(string)
	if rd := a.request(map[string]interface{}{
		"t": "read", "rid": 6,
		"mail": map[string]string{"project": project, "session": "CaSeTeSt", "mail": mailID},
	}); rd["t"] != "mail" {
		t.Fatalf("read with mixed-case ref must fold: %v", rd)
	}

	// same identity, different spelling: a same-origin re-login as the
	// lowercase form is a re-claim (not session_bound), and the display
	// case follows the new claim
	if w := a.helloLogin(7, project, projectRoot, sessionDir, "shortaaaa", "originA", "agent-a", "casetest", ""); w["t"] != "welcome" || w["mailbox"] != "casetest" {
		t.Fatalf("lowercase re-claim of the same identity: %v", w)
	}
	// a DIFFERENT session claiming the same name in any case: the online
	// holder is protected case-insensitively (the rejection CLOSES the
	// connection — the anti-kick protection — so dial fresh afterwards)
	c := dialTest(t, port)
	if e := c.helloLogin(8, project, projectRoot, sessionDir, "shortcccc", "originC", "agent-c", "CaseTest", ""); e["t"] != "error" || e["code"] != "mailbox_in_use" {
		t.Fatalf("case-variant claim of an online-held name must be mailbox_in_use, got %v", e)
	}
	c = dialTest(t, port)

	// 1-char names are legal; the file is that single letter
	if w := c.helloLogin(9, project, projectRoot, sessionDir, "shortcccc", "originC", "agent-c", "A", ""); w["t"] != "welcome" || w["mailbox"] != "A" {
		t.Fatalf("1-char name: %v", w)
	}
	if _, err := os.Stat(filepath.Join(mailDir, "a.jsonl")); err != nil {
		t.Fatalf("1-char canonical file: %v", err)
	}
	// reserved ids are excluded case-insensitively
	if e := c.helloLogin(10, project, projectRoot, sessionDir, "shortcccc", "originC", "agent-c", "User", ""); e["t"] != "error" || e["code"] != "bad_name" {
		t.Fatalf("'User' must be reserved case-insensitively, got %v", e)
	}
	// the derived-id shape stays excluded (lowercase 10-char base36)
	if e := c.helloLogin(11, project, projectRoot, sessionDir, "shortcccc", "originC", "agent-c", "abcdefghij", ""); e["t"] != "error" || e["code"] != "bad_name" {
		t.Fatalf("derived-shape name must be rejected, got %v", e)
	}

	// delete via the HTTP API folds the address too
	a.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	{
		body, _ := json.Marshal(map[string]string{"address": "CASETEST@" + project})
		resp, err := http.Post(fmt.Sprintf("http://127.0.0.1:%d/api/delete", port), "application/json", bytes.NewReader(body))
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("cased delete must fold: %v %v", err, resp)
		}
		resp.Body.Close()
	}
	if _, err := os.Stat(filepath.Join(mailDir, "casetest.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("casetest.jsonl should be gone after the cased delete")
	}
}
