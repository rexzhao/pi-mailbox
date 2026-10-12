package main

// Named-mailbox login tests: claim, exclusivity, inheritance, GC exemption.

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// helloLogin registers with a short id + origin and logs in to a named
// mailbox (hello "as" + optional "tags").
func (c *testClient) helloLogin(rid int, project, root, sessionDir, short, origin, agent, as, tags string) map[string]interface{} {
	msg := map[string]interface{}{
		"t": "hello", "rid": rid, "project": project, "projectRoot": root,
		"sessionDir": sessionDir,
		"session":    short, "origin": origin, "agent": agent,
		"as": as,
	}
	if tags != "" {
		msg["tags"] = tags
	}
	return c.request(msg)
}

func TestNamedMailboxLogin(t *testing.T) {
	tmp := t.TempDir()
	projectRoot := filepath.Join(tmp, "proj")
	os.MkdirAll(filepath.Join(projectRoot, ".pi", "mailbox"), 0o755)
	sessionDir := filepath.Join(tmp, "sessions")
	os.MkdirAll(sessionDir, 0o755)
	for _, origin := range []string{"originA", "originB", "originC"} {
		os.WriteFile(filepath.Join(sessionDir, "2026-01-01_"+origin+".jsonl"), []byte("{}\n"), 0o644)
	}

	gcGrace = 0
	defer func() {
		gcGrace = time.Hour
	}()

	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	const project = "proj-login"

	// 1. claim: login as "reviewer" with tags
	a := dialTest(t, port)
	wa := a.helloLogin(1, project, projectRoot, sessionDir, "shortaaaa", "originA", "agent-a", "reviewer", "review,urgent")
	if wa["t"] != "welcome" {
		t.Fatalf("welcome expected, got %v", wa)
	}
	if wa["mailbox"] != "reviewer" {
		t.Fatalf("welcome.mailbox: %v", wa)
	}
	meta := wa["meta"].(map[string]interface{})
	if meta["name"] != "reviewer" || meta["tags"] != "review,urgent" || meta["_named"] != "1" || meta["_origin"] != "originA" {
		t.Fatalf("login meta wrong: %v", meta)
	}

	// 2. mail to the named mailbox is delivered (address = name)
	s := dialTest(t, port)
	if w := s.helloShort(1, project, projectRoot, sessionDir, "shortcccc", "originC", "agent-c", nil); w["t"] != "welcome" {
		t.Fatalf("C welcome: %v", w)
	}
	if m := s.request(map[string]interface{}{
		"t": "send", "rid": 2,
		"target":  map[string]string{"project": project, "session": "reviewer"},
		"subject": "for reviewer", "body": "hi",
	}); m["t"] != "sent" {
		t.Fatalf("send to named mailbox failed: %v", m)
	}
	if n := a.expectNotify(); n != 1 {
		t.Fatalf("notify unread=1 expected, got %d", n)
	}

	// 3. concurrent login from a different origin is rejected
	b := dialTest(t, port)
	eb := b.helloLogin(1, project, projectRoot, sessionDir, "shortbbbb", "originB", "agent-b", "reviewer", "")
	if eb["t"] != "error" || eb["code"] != "mailbox_in_use" {
		t.Fatalf("expected mailbox_in_use, got %v", eb)
	}

	// 4. the same origin reconnecting replaces the old connection
	a2 := dialTest(t, port)
	wa2 := a2.helloLogin(1, project, projectRoot, sessionDir, "shortaaaa", "originA", "agent-a", "reviewer", "")
	if wa2["t"] != "welcome" || wa2["mailbox"] != "reviewer" {
		t.Fatalf("same-origin relogin should replace, got %v", wa2)
	}
	// tags were inherited (claim without tags keeps them)
	meta2 := wa2["meta"].(map[string]interface{})
	if meta2["tags"] != "review,urgent" {
		t.Fatalf("tags should be inherited, got %v", meta2)
	}

	// 5. tag overwrite on login with tags (same connection re-hello)
	wa3 := a2.helloLogin(2, project, projectRoot, sessionDir, "shortaaaa", "originA", "agent-a", "reviewer", "fresh")
	if wa3["t"] != "welcome" {
		t.Fatalf("re-hello login: %v", wa3)
	}
	if meta3 := wa3["meta"].(map[string]interface{}); meta3["tags"] != "fresh" {
		t.Fatalf("tags should be overwritten, got %v", meta3)
	}

	// 6. invalid names are rejected
	for _, bad := range []string{"user", "ABC", "abcdefghij", "ab", "has.dot", "-lead"} {
		e := s.helloLogin(9, project, projectRoot, sessionDir, "shortcccc", "originC", "agent-c", bad, "")
		if e["t"] != "error" || e["code"] != "bad_name" {
			t.Fatalf("expected bad_name for %q, got %v", bad, e)
		}
	}

	// 7. logout (disconnect) frees the name; the next claimant inherits
	//    mails and tags wholesale
	a2.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	b2 := dialTest(t, port) // b's socket was closed by the step-3 rejection
	wb := b2.helloLogin(2, project, projectRoot, sessionDir, "shortbbbb", "originB", "agent-b", "reviewer", "")
	if wb["t"] != "welcome" || wb["mailbox"] != "reviewer" {
		t.Fatalf("B login after logout: %v", wb)
	}
	if metaB := wb["meta"].(map[string]interface{}); metaB["tags"] != "fresh" {
		t.Fatalf("B should inherit tags, got %v", metaB)
	}
	if n := b2.expectNotify(); n != 1 {
		t.Fatalf("B should inherit unread backfill, got %d", n)
	}
	in := b2.request(map[string]interface{}{"t": "inbox", "rid": 3})
	if mails := in["mails"].([]interface{}); len(mails) != 1 {
		t.Fatalf("B should inherit the mail, got %v", in)
	}

	// 8. named mailboxes are exempt from the lifecycle GC: delete the
	//    holder's pi session file, disconnect, run cleanup — the mailbox
	//    must survive
	os.Remove(filepath.Join(sessionDir, "2026-01-01_originB.jsonl"))
	b2.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	cm := s.request(map[string]interface{}{"t": "cleanup", "rid": 4})
	if cm["t"] != "cleanup" {
		t.Fatalf("cleanup failed: %v", cm)
	}
	mailDir := filepath.Join(projectRoot, ".pi", "mailbox")
	if _, err := os.Stat(filepath.Join(mailDir, "reviewer.jsonl")); err != nil {
		t.Fatalf("named mailbox should survive the GC: %v", err)
	}
}
