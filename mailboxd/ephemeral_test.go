package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestNamelessLoginRejected pins the hard invariant: every connection
// must claim a named account. A nameless hello is rejected with
// name_required, before any project or mailbox state is created.
func TestNamelessLoginRejected(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "proj")
	mailDir := filepath.Join(root, ".pi", "mailbox")
	os.MkdirAll(mailDir, 0o755)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	const project = "proj-reject"

	// nameless: rejected
	a := dialTest(t, port)
	if w := a.helloShort(1, project, root, "", "shortaaaa", "sessA", "agent-a", nil); w["t"] != "error" || w["code"] != "name_required" {
		t.Fatalf("nameless hello must be rejected with name_required, got %v", w)
	}
	// no project state was created for the rejected hello
	if entries, err := os.ReadDir(mailDir); err != nil || len(entries) != 0 {
		t.Fatalf("rejected hello must not create mailbox files: %v %v", entries, err)
	}

	// named: works, and nothing unnamed ever lands on disk
	if w := a.helloLogin(1, project, root, "", "shortaaaa", "sessA", "agent-a", "reject-test", ""); w["t"] != "welcome" {
		t.Fatalf("named welcome: %v", w)
	}
	if _, err := os.Stat(filepath.Join(mailDir, "reject-test.jsonl")); err != nil {
		t.Fatalf("named mailbox must persist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(mailDir, "shortaaaa.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("the derived record of a named login must not be persisted: %v", err)
	}

	// the derived record's _holds lives in memory: multi-name login is
	// tracked within this daemon's lifetime (cross-restart forgetting is
	// the documented degradation) — a second name on the SAME session is
	// allowed (each name still exclusively held by one holder)
	a2 := dialTest(t, port)
	if w := a2.helloLogin(2, project, root, "", "shortaaaa", "sessA", "agent-a", "second-name", ""); w["t"] != "welcome" {
		t.Fatalf("in-memory _holds must allow a second name on the same session, got %v", w)
	}

	// a derived record is not a mailbox: sends to the derived id are
	// rejected (nothing would ever read that mail) — address the name
	if m := a.request(map[string]interface{}{
		"t": "send", "rid": 4,
		"target":  map[string]string{"project": project, "session": "shortaaaa"},
		"subject": "x", "body": "y",
	}); m["code"] != "no_mailbox" {
		t.Fatalf("send to a derived record must be rejected, got %v", m)
	}
	// ...but the named mailbox itself is a valid target
	if m := a.request(map[string]interface{}{
		"t": "send", "rid": 5,
		"target":  map[string]string{"project": project, "session": "reject-test"},
		"subject": "x", "body": "y",
	}); m["t"] != "sent" {
		t.Fatalf("send to the named mailbox should work, got %v", m)
	}

	// disconnect + reconnect: the multi-name set survives (memory lives
	// with the daemon); a third name is equally allowed
	a.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	a3 := dialTest(t, port)
	if w := a3.helloLogin(3, project, root, "", "shortaaaa", "sessA", "agent-a", "third-name", ""); w["t"] != "welcome" {
		t.Fatalf("multi-name login must survive a reconnect, got %v", w)
	}
}
