package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestReplacedSignal: two connections with the SAME session identity —
// the second's hello kicks the first with the app-defined close status
// 4000/"replaced", so the loser can stand down instead of fighting for
// the identity forever (two live agents on one session used to replace
// each other in an endless ping-pong).
func TestReplacedSignal(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "proj")
	os.MkdirAll(filepath.Join(root, ".pi", "mailbox"), 0o755)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	const project = "proj-repl"

	a := dialTest(t, port)
	if w := a.helloLogin(1, project, root, "", "shortaaaa", "sessA", "agent-a", "replaced-test", ""); w["t"] != "welcome" {
		t.Fatalf("A welcome: %v", w)
	}
	b := dialTest(t, port)
	if w := b.helloLogin(1, project, root, "", "shortaaaa", "sessA", "agent-a", "replaced-test", ""); w["t"] != "welcome" {
		t.Fatalf("B welcome (the replacing hello): %v", w)
	}

	// A's connection must close with status 4000 (the replaced signal)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, _, err := a.ws.Read(ctx); err == nil {
		t.Fatal("expected the replaced connection to close")
	} else if got := websocket.CloseStatus(err); got != websocket.StatusCode(4000) {
		t.Fatalf("close status = %v, want 4000 (replaced)", got)
	}

	// case-VARIANT re-claim of the same identity (display case changes,
	// identity does not): the replace+signal must fire exactly the same
	a2 := dialTest(t, port)
	if w := a2.helloLogin(2, project, root, "", "shortaaaa", "sessA", "agent-a", "Replaced-Test", ""); w["t"] != "welcome" || w["mailbox"] != "Replaced-Test" {
		t.Fatalf("case-variant re-claim welcome: %v", w)
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel2()
	if _, _, err := b.ws.Read(ctx2); err == nil {
		t.Fatal("expected the case-variant replaced connection to close")
	} else if got := websocket.CloseStatus(err); got != websocket.StatusCode(4000) {
		t.Fatalf("case-variant close status = %v, want 4000 (replaced)", got)
	}
}
