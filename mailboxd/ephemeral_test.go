package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestEphemeralUnnamedMailboxes pins the unnamed-mailbox lifecycle: no
// disk footprint while live, death with the connection, no_mailbox for
// senders afterwards, and named accounts unaffected.
func TestEphemeralUnnamedMailboxes(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "proj")
	mailDir := filepath.Join(root, ".pi", "mailbox")
	os.MkdirAll(mailDir, 0o755)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	const project = "proj-eph"

	a := dialTest(t, port)
	if w := a.helloShort(1, project, root, "", "shortaaaa", "sessA", "agent-a", nil); w["t"] != "welcome" {
		t.Fatalf("A welcome: %v", w)
	}
	b := dialTest(t, port)
	if w := b.helloShort(1, project, root, "", "shortbbbb", "sessB", "agent-b", nil); w["t"] != "welcome" {
		t.Fatalf("B welcome: %v", w)
	}

	// mail to the ONLINE unnamed mailbox works, entirely in memory
	if m := a.request(map[string]interface{}{
		"t": "send", "rid": 2,
		"target":  map[string]string{"project": project, "session": "shortbbbb"},
		"subject": "live", "body": "x",
	}); m["t"] != "sent" {
		t.Fatalf("send failed: %v", m)
	}
	inb := b.request(map[string]interface{}{"t": "inbox", "rid": 2, "limit": 10})
	if int(inb["total"].(float64)) != 1 {
		t.Fatalf("inbox total: %v", inb)
	}

	// no file ever landed for either derived id
	if _, err := os.Stat(filepath.Join(mailDir, "shortbbbb.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("unnamed mailbox must not be persisted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(mailDir, "shortaaaa.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("unnamed sender record must not be persisted: %v", err)
	}

	// B disconnects: the mailbox dies
	b.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	if m := a.request(map[string]interface{}{
		"t": "send", "rid": 3,
		"target":  map[string]string{"project": project, "session": "shortbbbb"},
		"subject": "gone", "body": "x",
	}); m["code"] != "no_mailbox" {
		t.Fatalf("send to the dead unnamed mailbox should be no_mailbox, got %v", m)
	}

	// B reconnects: fresh empty mailbox (the old mail is gone)
	b2 := dialTest(t, port)
	if w := b2.helloShort(1, project, root, "", "shortbbbb", "sessB", "agent-b", nil); w["t"] != "welcome" {
		t.Fatalf("B reconnect welcome: %v", w)
	}
	inb2 := b2.request(map[string]interface{}{"t": "inbox", "rid": 2, "limit": 10})
	if int(inb2["total"].(float64)) != 0 {
		t.Fatalf("reconnected unnamed mailbox must be empty: %v", inb2)
	}
	b2.ws.Close(websocket.StatusNormalClosure, "")

	// named login: the NAME persists, the derived _holds record does not
	c := dialTest(t, port)
	if w := c.helloLogin(1, project, root, "", "shortcccc", "sessC", "agent-c", "ephname", ""); w["t"] != "welcome" {
		t.Fatalf("C welcome: %v", w)
	}
	if _, err := os.Stat(filepath.Join(mailDir, "ephname.jsonl")); err != nil {
		t.Fatalf("named mailbox must persist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(mailDir, "shortcccc.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("derived record of a named login must not persist: %v", err)
	}
	// the in-memory _holds still enforces one name per session
	c2 := dialTest(t, port)
	if m := c2.helloLogin(1, project, root, "", "shortcccc", "sessC", "agent-c", "othername", ""); m["code"] != "session_bound" {
		t.Fatalf("in-memory _holds must enforce session_bound, got %v", m)
	}

	// daemon restart (fresh store over the same dir): named survives,
	// everything unnamed is gone
	a.ws.Close(websocket.StatusNormalClosure, "")
	c.ws.Close(websocket.StatusNormalClosure, "")
	stop()
	time.Sleep(150 * time.Millisecond)
	port2, stop2 := bootDaemon(t, tmp, "", false)
	defer stop2()
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/api/sessions?includeOffline=1&project=%s&projectRoot=%s", port2, project, root))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var sb struct {
		Sessions []struct {
			Session string `json:"session"`
		} `json:"sessions"`
	}
	json.NewDecoder(resp.Body).Decode(&sb)
	foundNamed := false
	for _, s := range sb.Sessions {
		if s.Session == "ephname" {
			foundNamed = true
		}
		if s.Session == "shortaaaa" || s.Session == "shortbbbb" || s.Session == "shortcccc" {
			t.Fatalf("unnamed record %s must be gone after restart: %v", s.Session, sb)
		}
	}
	if !foundNamed {
		t.Fatalf("named mailbox must survive the restart: %v", sb)
	}
}

// TestEphemeralLegacyFile: a legacy derived file (pre-ephemeral daemon) is
// loaded for a reconnecting session, new events apply in memory only, and
// the file is left byte-identical for the lifecycle GC.
func TestEphemeralLegacyFile(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "proj")
	mailDir := filepath.Join(root, ".pi", "mailbox")
	os.MkdirAll(mailDir, 0o755)
	legacy := filepath.Join(mailDir, "shortaaaa.jsonl")
	line1 := `{"t":"send","mail":{"id":"m1","from":{"project":"p","session":"s"},"subject":"old","body":"b","refs":null,"createdAt":"2026-01-01T00:00:00.000000000Z"}}`
	line2 := `{"t":"meta","set":{"_agent":"agent-a"}}`
	content := line1 + "\n" + line2 + "\n"
	if err := os.WriteFile(legacy, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	a := dialTest(t, port)
	if w := a.helloShort(1, "proj-l", root, "", "shortaaaa", "sessA", "agent-a", nil); w["t"] != "welcome" {
		t.Fatalf("welcome: %v", w)
	}
	// the legacy mail is visible while connected
	in := a.request(map[string]interface{}{"t": "inbox", "rid": 2, "limit": 10})
	if int(in["total"].(float64)) != 1 {
		t.Fatalf("legacy mail should be visible: %v", in)
	}
	// a new mail: memory only
	b := dialTest(t, port)
	if w := b.helloShort(1, "proj-l", root, "", "shortbbbb", "sessB", "agent-b", nil); w["t"] != "welcome" {
		t.Fatalf("B welcome: %v", w)
	}
	if m := b.request(map[string]interface{}{
		"t": "send", "rid": 2,
		"target":  map[string]string{"project": "proj-l", "session": "shortaaaa"},
		"subject": "new", "body": "x",
	}); m["t"] != "sent" {
		t.Fatalf("send failed: %v", m)
	}
	in2 := a.request(map[string]interface{}{"t": "inbox", "rid": 3, "limit": 10})
	if int(in2["total"].(float64)) != 2 {
		t.Fatalf("new mail should be readable in-memory: %v", in2)
	}
	after, err := os.ReadFile(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != content {
		t.Fatalf("legacy file must stay byte-identical: %q vs %q", content, string(after))
	}
}
