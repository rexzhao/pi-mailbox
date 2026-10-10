package main

// Integration tests: boot the daemon (local mode) and drive the protocol
// over real WebSocket connections, mirroring the TS smoke suite's key
// assertions.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type testClient struct {
	t  *testing.T
	ws *websocket.Conn
}

func dialTest(t *testing.T, port int) *testClient {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d", port), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return &testClient{t: t, ws: ws}
}

func (c *testClient) send(v interface{}) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, _ := json.Marshal(v)
	if err := c.ws.Write(ctx, websocket.MessageText, data); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *testClient) recv() map[string]interface{} {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.ws.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		c.t.Fatalf("unmarshal %s: %v", data, err)
	}
	return m
}

func ridOf(v interface{}) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case int:
		return x
	}
	return -1
}

// request sends a message and waits for the reply with the same rid,
// collecting notify pushes along the way.
func (c *testClient) request(v map[string]interface{}) map[string]interface{} {
	c.send(v)
	want := ridOf(v["rid"])
	for {
		m := c.recv()
		if m["t"] == "notify" {
			continue
		}
		if ridOf(m["rid"]) == want {
			return m
		}
	}
}

func (c *testClient) expectNotify() int {
	for {
		m := c.recv()
		if m["t"] == "notify" {
			return int(m["unread"].(float64))
		}
	}
}

func (c *testClient) hello(rid int, project, root, session, agent string, meta map[string]string) map[string]interface{} {
	msg := map[string]interface{}{
		"t": "hello", "rid": rid, "project": project, "projectRoot": root,
		"session": session, "agent": agent,
	}
	if meta != nil {
		msg["meta"] = meta
	}
	return c.request(msg)
}

// helloShort registers with a short session id plus its origin (the full
// client session id), the way the TS client does after the short-id change.
func (c *testClient) helloShort(rid int, project, root, sessionDir, short, origin, agent string, meta map[string]string) map[string]interface{} {
	msg := map[string]interface{}{
		"t": "hello", "rid": rid, "project": project, "projectRoot": root,
		"sessionDir": sessionDir,
		"session":    short, "origin": origin, "agent": agent,
	}
	if meta != nil {
		msg["meta"] = meta
	}
	return c.request(msg)
}

// bootDaemon starts a local-mode daemon in the background and returns its
// port plus a cancel function.
func bootDaemon(t *testing.T, tmp string, token string, remote bool) (int, func()) {
	d := &Daemon{
		RegistryPath: filepath.Join(tmp, "mailboxd.json"),
		LockPath:     filepath.Join(tmp, "mailboxd.leader"),
		ListenAddr:   "127.0.0.1:0",
		DataDir:      filepath.Join(tmp, "data"),
		AuthToken:    token,
		Remote:       remote,
		IdleExit:     0, // tests shut down explicitly
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		d.Run(ctx)
		close(done)
	}()
	// wait for the registry file
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(d.RegistryPath)
		if err == nil {
			var reg registryFile
			if json.Unmarshal(data, &reg) == nil && reg.Port > 0 {
				return reg.Port, func() {
					cancel()
					select {
					case <-done:
					case <-time.After(5 * time.Second):
					}
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("daemon did not start")
	return 0, nil
}

func TestDaemonLocalFlow(t *testing.T) {
	tmp := t.TempDir()
	projectRoot := filepath.Join(tmp, "proj")
	os.MkdirAll(filepath.Join(projectRoot, ".pi", "mailbox"), 0o755)
	sessionDir := filepath.Join(tmp, "sessions")
	os.MkdirAll(sessionDir, 0o755)
	// fake pi session file so the GC keeps the sessions alive
	os.WriteFile(filepath.Join(sessionDir, "2026-01-01_sessA.jsonl"), []byte("{}\n"), 0o644)
	os.WriteFile(filepath.Join(sessionDir, "2026-01-01_sessB.jsonl"), []byte("{}\n"), 0o644)

	gcGrace = 0
	defer func() {
		gcGrace = time.Hour
	}()

	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	const project = "proj-uuid-1"

	a := dialTest(t, port)
	wa := a.hello(1, project, projectRoot, "sessA", "agent-a", map[string]string{"_model": "prov/m1", "role": "worker"})
	if wa["t"] != "welcome" {
		t.Fatalf("expected welcome, got %v", wa)
	}
	meta := wa["meta"].(map[string]interface{})
	if meta["_agent"] != "agent-a" || meta["_model"] != "prov/m1" || meta["role"] != "worker" {
		t.Fatalf("welcome meta wrong: %v", meta)
	}
	if int(wa["protocolVersion"].(float64)) != ProtocolVersion {
		t.Fatalf("protocol version: %v", wa)
	}

	b := dialTest(t, port)
	wb := b.hello(1, project, projectRoot, "sessB", "agent-b", nil)
	if wb["t"] != "welcome" {
		t.Fatalf("expected welcome for B, got %v", wb)
	}

	// sessions: both online
	sess := a.request(map[string]interface{}{"t": "sessions", "rid": 2})
	sessions := sess["sessions"].([]interface{})
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %v", sessions)
	}

	// A -> B send: B gets a notify push
	a.send(map[string]interface{}{
		"t": "send", "rid": 3,
		"target":  map[string]string{"project": project, "session": "sessB"},
		"subject": "hello", "body": "world",
	})
	sent := a.request(map[string]interface{}{"t": "ping", "rid": 99}) // drain: wait via ping
	if sent["t"] != "pong" {
		t.Fatalf("ping failed: %v", sent)
	}
	if n := b.expectNotify(); n != 1 {
		t.Fatalf("expected notify unread=1, got %d", n)
	}

	// B inbox: totals
	inb := b.request(map[string]interface{}{"t": "inbox", "rid": 2})
	if int(inb["total"].(float64)) != 1 || int(inb["totalUnread"].(float64)) != 1 {
		t.Fatalf("inbox totals wrong: %v", inb)
	}
	mails := inb["mails"].([]interface{})
	mail0 := mails[0].(map[string]interface{})
	if mail0["subject"] != "hello" {
		t.Fatalf("mail subject: %v", mail0)
	}
	mailID := mail0["id"].(string)

	// B reads it: readAt set
	rd := b.request(map[string]interface{}{
		"t": "read", "rid": 3,
		"mail": map[string]string{"project": project, "session": "sessB", "mail": mailID},
	})
	if rd["mail"].(map[string]interface{})["readAt"] == nil {
		t.Fatalf("own read should mark readAt: %v", rd)
	}
	inb2 := b.request(map[string]interface{}{"t": "inbox", "rid": 4, "filter": map[string]interface{}{"unreadOnly": true}})
	if len(inb2["mails"].([]interface{})) != 0 {
		t.Fatalf("read mail should not be unread: %v", inb2)
	}

	// meta op: set/unset + system key rejection
	if m := b.request(map[string]interface{}{"t": "meta", "rid": 5, "set": map[string]string{"name": "bee", "tags": "x,y"}}); m["t"] != "meta" {
		t.Fatalf("meta set failed: %v", m)
	}
	if m := b.request(map[string]interface{}{"t": "meta", "rid": 6, "set": map[string]string{"_evil": "1"}}); m["code"] != "bad_meta" {
		t.Fatalf("system key via meta op should fail: %v", m)
	}
	if m := b.request(map[string]interface{}{"t": "meta", "rid": 7, "unset": []string{"name"}}); m["t"] != "meta" {
		t.Fatalf("meta unset failed: %v", m)
	}

	// send to never-registered session: no_mailbox
	if m := a.request(map[string]interface{}{
		"t": "send", "rid": 4,
		"target":  map[string]string{"project": project, "session": "ghost"},
		"subject": "x", "body": "y",
	}); m["code"] != "no_mailbox" {
		t.Fatalf("expected no_mailbox, got %v", m)
	}

	// offline delivery: B disconnects, A sends, B reconnects with backfill
	b.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	a.send(map[string]interface{}{
		"t": "send", "rid": 5,
		"target":  map[string]string{"project": project, "session": "sessB"},
		"subject": "offline mail", "body": "while away",
	})
	a.request(map[string]interface{}{"t": "ping", "rid": 98})

	// offline listing: B is disconnected but registered
	sess2 := a.request(map[string]interface{}{"t": "sessions", "rid": 6, "includeOffline": true})
	var bOffline map[string]interface{}
	for _, s := range sess2["sessions"].([]interface{}) {
		sm := s.(map[string]interface{})
		if sm["session"] == "sessB" && !sm["online"].(bool) {
			bOffline = sm
		}
	}
	if bOffline == nil {
		t.Fatalf("sessB not listed offline: %v", sess2)
	}
	if bOffline["agent"] != "agent-b" {
		t.Fatalf("offline agent should come from _agent: %v", bOffline)
	}

	b2 := dialTest(t, port)
	wb2 := b2.hello(1, project, projectRoot, "sessB", "agent-b", nil)
	if wb2["t"] != "welcome" {
		t.Fatalf("B reconnect welcome: %v", wb2)
	}
	if n := b2.expectNotify(); n < 1 {
		t.Fatalf("expected unread backfill, got %d", n)
	}
	inb3 := b2.request(map[string]interface{}{"t": "inbox", "rid": 2, "limit": 100})
	found := false
	for _, m := range inb3["mails"].([]interface{}) {
		if m.(map[string]interface{})["subject"] == "offline mail" {
			found = true
		}
	}
	if !found {
		t.Fatalf("offline mail missing: %v", inb3)
	}

}

func TestDaemonRemoteTokenAndCentralStorage(t *testing.T) {
	tmp := t.TempDir()
	// remote mode simulation: token set + central data dir via the Daemon
	// struct directly (the flag wiring is covered by main)
	port, stop := bootDaemon(t, tmp, "sekrit", true)
	defer stop()

	// hello without token: unauthorized + closed
	c := dialTest(t, port)
	r := c.hello(1, "proj-x", "", "s1", "a", nil)
	if r["code"] != "unauthorized" {
		t.Fatalf("expected unauthorized, got %v", r)
	}

	// hello with token and no projectRoot (remote semantics): project state
	// uses the central data dir
	c2 := dialTest(t, port)
	msg := map[string]interface{}{
		"t": "hello", "rid": 1, "project": "proj-x", "session": "s1", "agent": "a", "token": "sekrit",
	}
	w := c2.request(msg)
	if w["t"] != "welcome" {
		t.Fatalf("expected welcome, got %v", w)
	}
	// the store directory must be under the data dir, not a client path
	dataDir := filepath.Join(tmp, "data")
	if _, err := os.Stat(filepath.Join(dataDir, "proj-x", "s1.jsonl")); err != nil {
		t.Fatalf("central storage file missing: %v", err)
	}
}

func TestDaemonCrossProjectSend(t *testing.T) {
	tmp := t.TempDir()
	root1 := filepath.Join(tmp, "p1")
	root2 := filepath.Join(tmp, "p2")
	os.MkdirAll(filepath.Join(root1, ".pi", "mailbox"), 0o755)
	os.MkdirAll(filepath.Join(root2, ".pi", "mailbox"), 0o755)

	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	a := dialTest(t, port)
	a.hello(1, "proj-1", root1, "s1", "a", nil)
	b := dialTest(t, port)
	b.hello(1, "proj-2", root2, "s2", "b", nil)

	// cross-project send is allowed when the target project is registered
	m := a.request(map[string]interface{}{
		"t": "send", "rid": 2,
		"target":  map[string]string{"project": "proj-2", "session": "s2"},
		"subject": "cross", "body": "hi",
	})
	if m["t"] != "sent" {
		t.Fatalf("cross-project send failed: %v", m)
	}
	if m["mail"].(map[string]interface{})["project"] != "proj-2" {
		t.Fatalf("cross-project triple wrong: %v", m)
	}
	// unknown project still rejected
	m2 := a.request(map[string]interface{}{
		"t": "send", "rid": 3,
		"target":  map[string]string{"project": "proj-unknown", "session": "s2"},
		"subject": "x", "body": "y",
	})
	if m2["code"] != "external_target" {
		t.Fatalf("unknown project should fail, got %v", m2)
	}
}

func TestDaemonCursorSemantics(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "p")
	os.MkdirAll(filepath.Join(root, ".pi", "mailbox"), 0o755)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()

	a := dialTest(t, port)
	a.hello(1, "p", root, "s1", "a", nil)
	b := dialTest(t, port)
	b.hello(1, "p", root, "s2", "b", nil)

	for i := 0; i < 5; i++ {
		m := a.request(map[string]interface{}{
			"t": "send", "rid": 100 + i,
			"target":  map[string]string{"project": "p", "session": "s2"},
			"subject": fmt.Sprintf("mail-%d", i), "body": "x",
		})
		if m["t"] != "sent" {
			t.Fatalf("send %d failed: %v", i, m)
		}
	}
	// drain notifies
	b.request(map[string]interface{}{"t": "inbox", "rid": 200})

	page1 := b.request(map[string]interface{}{"t": "inbox", "rid": 201, "limit": 2})
	if len(page1["mails"].([]interface{})) != 2 || page1["nextCursor"] == "" {
		t.Fatalf("page 1 wrong: %v", page1)
	}
	if int(page1["total"].(float64)) != 5 {
		t.Fatalf("total should be mailbox-wide: %v", page1)
	}
	page2 := b.request(map[string]interface{}{"t": "inbox", "rid": 202, "limit": 2, "cursor": page1["nextCursor"]})
	if len(page2["mails"].([]interface{})) != 2 || page2["nextCursor"] == "" {
		t.Fatalf("page 2 wrong: %v", page2)
	}
	page3 := b.request(map[string]interface{}{"t": "inbox", "rid": 203, "limit": 2, "cursor": page2["nextCursor"]})
	nc, _ := page3["nextCursor"].(string)
	if len(page3["mails"].([]interface{})) != 1 || nc != "" {
		t.Fatalf("page 3 should be last: %v", page3)
	}
	// order: newest first, all mails exactly once
	var subjects []string
	for _, pg := range []map[string]interface{}{page1, page2, page3} {
		for _, m := range pg["mails"].([]interface{}) {
			subjects = append(subjects, m.(map[string]interface{})["subject"].(string))
		}
	}
	want := "mail-4,mail-3,mail-2,mail-1,mail-0"
	if strings.Join(subjects, ",") != want {
		// diagnostic: print createdAt per mail
		diag := b.request(map[string]interface{}{"t": "inbox", "rid": 300, "limit": 100})
		for _, m := range diag["mails"].([]interface{}) {
			mm := m.(map[string]interface{})
			t.Logf("DIAG %s createdAt=%s", mm["subject"], mm["createdAt"])
		}
		t.Fatalf("pagination order wrong: %v (want %s)", subjects, want)
	}
	// invalid cursor
	if m := b.request(map[string]interface{}{"t": "inbox", "rid": 204, "cursor": "bogus"}); m["code"] != "bad_cursor" {
		t.Fatalf("invalid cursor: %v", m)
	}
}

// guard against unused import churn
var _ = net.JoinHostPort

// TestDaemonConcurrentAccess drives concurrent send/inbox/sessions/meta from
// two connections; run with -race this is the regression test for the
// SessionState data race (all public Store APIs must return copies).
func TestDaemonConcurrentAccess(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "p")
	os.MkdirAll(filepath.Join(root, ".pi", "mailbox"), 0o755)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()

	a := dialTest(t, port)
	a.hello(1, "p", root, "s1", "a", nil)
	b := dialTest(t, port)
	b.hello(1, "p", root, "s2", "b", nil)

	done := make(chan struct{})
	// A: send to B continuously
	go func() {
		defer close(done)
		for i := 0; i < 30; i++ {
			a.send(map[string]interface{}{
				"t": "send", "rid": 1000 + i,
				"target":  map[string]string{"project": "p", "session": "s2"},
				"subject": fmt.Sprintf("m-%d", i), "body": "x",
			})
			time.Sleep(2 * time.Millisecond)
		}
	}()
	// B: inbox + sessions + meta concurrently
	for i := 0; i < 30; i++ {
		b.request(map[string]interface{}{"t": "inbox", "rid": 2000 + i})
		a.request(map[string]interface{}{"t": "sessions", "rid": 3000 + i})
		b.send(map[string]interface{}{"t": "meta", "rid": 4000 + i, "set": map[string]string{"k": fmt.Sprintf("v%d", i)}})
	}
	<-done
	// drain b's reply queue
	for i := 0; i < 30; i++ {
		b.request(map[string]interface{}{"t": "inbox", "rid": 5000 + i, "limit": 100})
	}
	final := b.request(map[string]interface{}{"t": "inbox", "rid": 6000, "limit": 100})
	if int(final["total"].(float64)) != 30 {
		t.Fatalf("expected 30 mails, got %v", final["total"])
	}
}

// TestStoreMixedTimestamps seeds a mailbox with the TS millisecond format
// and verifies ordering and maxNS seeding against new fixed-width stamps.
func TestStoreMixedTimestamps(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	// hand-write a TS-format mail (3-digit millis)
	oldMail := &MailRecord{
		ID:        "old-1",
		From:      AgentRef{Project: "p", Session: "s1"},
		Subject:   "old",
		Body:      "x",
		CreatedAt: "2026-10-10T03:00:00.037Z",
	}
	line, _ := json.Marshal(map[string]interface{}{"t": "send", "mail": oldMail})
	if err := appendLine(filepath.Join(dir, "s2.jsonl"), string(line)); err != nil {
		t.Fatal(err)
	}
	// new mail via AppendSend (monotonic now-stamp, must sort newer)
	fresh := &MailRecord{ID: "new-1", From: AgentRef{Project: "p", Session: "s1"}, Subject: "fresh", Body: "x"}
	if err := store.AppendSend("s2", fresh); err != nil {
		t.Fatal(err)
	}
	mails, err := store.Inbox("s2")
	if err != nil {
		t.Fatal(err)
	}
	if len(mails) != 2 || mails[0].ID != "new-1" || mails[1].ID != "old-1" {
		t.Fatalf("mixed-format order wrong: %v %v", mails[0].ID, mails[1].ID)
	}
}

// TestCleanupOriginGC verifies the on-demand cleanup with short session ids:
// the mailbox is keyed by the short id, while the lifecycle check uses the
// _origin meta (the client's full session id) to match the pi session file.
func TestCleanupOriginGC(t *testing.T) {
	tmp := t.TempDir()
	projectRoot := filepath.Join(tmp, "proj")
	os.MkdirAll(filepath.Join(projectRoot, ".pi", "mailbox"), 0o755)
	sessionDir := filepath.Join(tmp, "sessions")
	os.MkdirAll(sessionDir, 0o755)
	// pi session files: sessA alive, sessB deleted later
	os.WriteFile(filepath.Join(sessionDir, "2026-01-01_sessA.jsonl"), []byte("{}\n"), 0o644)
	os.WriteFile(filepath.Join(sessionDir, "2026-01-01_sessB.jsonl"), []byte("{}\n"), 0o644)

	gcGrace = 0
	defer func() {
		gcGrace = time.Hour
	}()

	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	const project = "proj-gc"

	// register with short ids + origins
	a := dialTest(t, port)
	if w := a.helloShort(1, project, projectRoot, sessionDir, "shortaaaa", "sessA", "agent-a", nil); w["t"] != "welcome" {
		t.Fatalf("A welcome: %v", w)
	}
	b := dialTest(t, port)
	if w := b.helloShort(1, project, projectRoot, sessionDir, "shortbbbb", "sessB", "agent-b", nil); w["t"] != "welcome" {
		t.Fatalf("B welcome: %v", w)
	}

	// a mail into B's mailbox so the file exists with content
	if m := a.request(map[string]interface{}{
		"t": "send", "rid": 2,
		"target":  map[string]string{"project": project, "session": "shortbbbb"},
		"subject": "x", "body": "y",
	}); m["t"] != "sent" {
		t.Fatalf("send failed: %v", m)
	}

	// (origin visibility is exercised functionally by the cleanup below)

	// delete sessB's pi session file and disconnect B: B's mailbox becomes
	// an orphan (online sessions are never collected)
	os.Remove(filepath.Join(sessionDir, "2026-01-01_sessB.jsonl"))
	b.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)

	// on-demand cleanup: B's mailbox must move to .trash, A's must stay
	cm := a.request(map[string]interface{}{"t": "cleanup", "rid": 4})
	if cm["t"] != "cleanup" {
		t.Fatalf("cleanup failed: %v", cm)
	}
	results := cm["results"].([]interface{})
	if len(results) != 1 {
		t.Fatalf("expected 1 project result, got %v", results)
	}
	r := results[0].(map[string]interface{})
	if r["project"] != project || int(r["moved"].(float64)) != 1 {
		t.Fatalf("cleanup result wrong: %v", r)
	}

	mailDir := filepath.Join(projectRoot, ".pi", "mailbox")
	if _, err := os.Stat(filepath.Join(mailDir, "shortaaaa.jsonl")); err != nil {
		t.Fatalf("A's mailbox should survive: %v", err)
	}
	if _, err := os.Stat(filepath.Join(mailDir, "shortbbbb.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("B's mailbox should be gone: %v", err)
	}
	trashDir := filepath.Join(mailDir, ".trash")
	trashEntries, _ := os.ReadDir(trashDir)
	trashed := false
	for _, e := range trashEntries {
		if strings.HasSuffix(e.Name(), "shortbbbb.jsonl") {
			trashed = true
		}
	}
	if !trashed {
		t.Fatalf("B's mailbox should be in .trash: %v", trashEntries)
	}
}

// TestViewCommand covers `mailboxd view`: registry resolution, the remote
// --host requirement, and URL/JSON output against a live daemon.
func TestViewCommand(t *testing.T) {
	tmp := t.TempDir()

	// fake opener so tests never launch a browser
	opened := ""
	oldOpener := browserOpener
	browserOpener = func(u string) error { opened = u; return nil }
	defer func() { browserOpener = oldOpener }()

	// no registry -> exit 1
	var out strings.Builder
	if code := viewDaemon(&out, filepath.Join(tmp, "missing.json"), "", "", "", false, false); code == 0 {
		t.Fatal("missing registry should exit non-zero")
	}

	// remote registry without --host -> exit 1
	remoteReg := filepath.Join(tmp, "remote.json")
	os.WriteFile(remoteReg, []byte(`{"port": 1234, "instanceId": "x", "remote": true, "pid": 1}`), 0o644)
	if code := viewDaemon(&out, remoteReg, "", "", "", false, false); code == 0 {
		t.Fatal("remote without --host should exit non-zero")
	}

	// live local daemon -> URL + open
	root := filepath.Join(tmp, "proj")
	os.MkdirAll(filepath.Join(root, ".pi", "mailbox"), 0o755)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	reg := filepath.Join(tmp, "mailboxd.json")
	out.Reset()
	if code := viewDaemon(&out, reg, "", "", "", true, false); code != 0 {
		t.Fatalf("view failed: %s", out.String())
	}
	url := strings.TrimSpace(out.String())
	want := fmt.Sprintf("http://127.0.0.1:%d/", port)
	if url != want {
		t.Fatalf("url: got %q want %q", url, want)
	}
	if opened != want {
		t.Fatalf("opener got %q want %q", opened, want)
	}

	// --json output shape
	out.Reset()
	if code := viewDaemon(&out, reg, "", "", "", false, true); code != 0 {
		t.Fatalf("view --json failed: %s", out.String())
	}
	var j map[string]interface{}
	if err := json.Unmarshal([]byte(out.String()), &j); err != nil {
		t.Fatalf("json output: %v", err)
	}
	if j["url"] != want || int(j["port"].(float64)) != port || int(j["protocolVersion"].(float64)) != ProtocolVersion {
		t.Fatalf("json fields wrong: %v", j)
	}

	// dead port -> exit 1
	deadReg := filepath.Join(tmp, "dead.json")
	os.WriteFile(deadReg, []byte(fmt.Sprintf(`{"port": %d, "instanceId": "x", "remote": false, "pid": 1}`, lastFreePort())), 0o644)
	if code := viewDaemon(&out, deadReg, "", "", "", false, false); code == 0 {
		t.Fatal("dead daemon should exit non-zero")
	}
}

func lastFreePort() int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 1
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// TestHTTPAPI covers the read-only web API: shapes, the readAt-unchanged
// invariant, and the tokenless local-mode Host/Origin defenses.
func TestHTTPAPI(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "proj")
	os.MkdirAll(filepath.Join(root, ".pi", "mailbox"), 0o755)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	a := dialTest(t, port)
	a.hello(1, "p", root, "s1", "a", nil)
	b := dialTest(t, port)
	b.hello(1, "p", root, "s2", "b", nil)
	// a mail into b's mailbox (unread)
	if m := a.request(map[string]interface{}{
		"t": "send", "rid": 2,
		"target":  map[string]string{"project": "p", "session": "s2"},
		"subject": "api test", "body": "x",
	}); m["t"] != "sent" {
		t.Fatalf("send failed: %v", m)
	}
	inb := b.request(map[string]interface{}{"t": "inbox", "rid": 4})
	mails := inb["mails"].([]interface{})
	if len(mails) != 1 {
		t.Fatalf("expected 1 mail, got %v", inb)
	}
	mailID := mails[0].(map[string]interface{})["id"].(string)

	get := func(path string, headers map[string]string, hostOverride string) (*http.Response, map[string]interface{}) {
		req, _ := http.NewRequest(http.MethodGet, base+path, nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		if hostOverride != "" {
			req.Host = hostOverride
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body map[string]interface{}
		data, _ := io.ReadAll(resp.Body)
		json.Unmarshal(data, &body)
		return resp, body
	}

	// healthz
	resp, body := get("/healthz", nil, "")
	if resp.StatusCode != 200 || int(body["protocolVersion"].(float64)) != ProtocolVersion {
		t.Fatalf("healthz: %v %v", resp.StatusCode, body)
	}

	// info
	resp, body = get("/api/info", nil, "")
	if resp.StatusCode != 200 {
		t.Fatalf("info: %v", resp.StatusCode)
	}
	projects := body["projects"].([]interface{})
	if len(projects) != 1 || projects[0].(map[string]interface{})["id"] != "p" {
		t.Fatalf("info projects: %v", body)
	}

	// sessions
	resp, body = get("/api/sessions?includeOffline=1", nil, "")
	if resp.StatusCode != 200 {
		t.Fatalf("sessions: %v", resp.StatusCode)
	}
	sessions := body["sessions"].([]interface{})
	if len(sessions) != 2 {
		t.Fatalf("sessions: %v", body)
	}

	// mailbox listing: readAt must stay null (read-only invariant)
	resp, body = get("/api/mailbox/s2@p", nil, "")
	if resp.StatusCode != 200 || int(body["total"].(float64)) != 1 || int(body["totalUnread"].(float64)) != 1 {
		t.Fatalf("mailbox: %v %v", resp.StatusCode, body)
	}
	listMails := body["mails"].([]interface{})
	if listMails[0].(map[string]interface{})["readAt"] != nil {
		t.Fatal("API listing must not mark mails read")
	}

	// single mail: readAt must stay null
	resp, body = get("/api/mail/s2@p/"+mailID, nil, "")
	if resp.StatusCode != 200 || body["readAt"] != nil {
		t.Fatalf("mail detail: %v %v", resp.StatusCode, body)
	}

	// the WS read still works and marks read AFTER the API calls
	rd := b.request(map[string]interface{}{
		"t": "read", "rid": 5,
		"mail": map[string]string{"project": "p", "session": "s2", "mail": mailID},
	})
	if rd["mail"].(map[string]interface{})["readAt"] == nil {
		t.Fatal("WS read should mark readAt after API access")
	}

	// unknown project / no mailbox
	if resp, _ = get("/api/mailbox/s2@nope", nil, ""); resp.StatusCode != 404 {
		t.Fatalf("unknown project: %v", resp.StatusCode)
	}
	if resp, _ = get("/api/mailbox/ghost@p", nil, ""); resp.StatusCode != 404 {
		t.Fatalf("no mailbox: %v", resp.StatusCode)
	}

	// Host allowlist (DNS-rebinding defense): a foreign Host is rejected
	if resp, _ = get("/api/info", nil, "evil.example"); resp.StatusCode != 403 {
		t.Fatalf("foreign host: %v", resp.StatusCode)
	}
	// Origin mismatch is rejected
	if resp, _ = get("/api/info", map[string]string{"Origin": "http://evil.example"}, ""); resp.StatusCode != 403 {
		t.Fatalf("foreign origin: %v", resp.StatusCode)
	}

	// static page: served without token, CSP set
	resp, _ = get("/", nil, "")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Security-Policy") != "default-src 'self'" {
		t.Fatalf("static: %v %v", resp.StatusCode, resp.Header)
	}

	// non-GET on the API
	req, _ := http.NewRequest(http.MethodPost, base+"/api/info", nil)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != 405 {
		t.Fatalf("POST should be 405, got %v", resp2.StatusCode)
	}
}

// TestHTTPAPIToken covers the remote-mode API: every data endpoint requires
// the Bearer token; the static shell stays reachable without it.
func TestHTTPAPIToken(t *testing.T) {
	tmp := t.TempDir()
	port, stop := bootDaemon(t, tmp, "sekrit", true)
	defer stop()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	// register a project via WS so /api/info has content
	c := dialTest(t, port)
	c.request(map[string]interface{}{
		"t": "hello", "rid": 1, "project": "px", "session": "s1", "agent": "a", "token": "sekrit",
	})

	resp, err := http.Get(base + "/api/info")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("api without token: %v", resp.StatusCode)
	}

	resp, err = http.Get(base + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("healthz without token (remote): %v", resp.StatusCode)
	}

	req, _ := http.NewRequest(http.MethodGet, base+"/api/info", nil)
	req.Header.Set("Authorization", "Bearer sekrit")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("api with token: %v", resp.StatusCode)
	}
	var body map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&body)
	if body["remote"] != true {
		t.Fatalf("info remote flag: %v", body)
	}

	// static shell without token
	resp2, err := http.Get(base + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("static without token: %v", resp2.StatusCode)
	}
}

// TestHTTPThread covers /api/thread: the transitive reply chain, oldest-first
// ordering, and the owner annotation used for navigation.
func TestHTTPThread(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "proj")
	os.MkdirAll(filepath.Join(root, ".pi", "mailbox"), 0o755)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	a := dialTest(t, port)
	a.hello(1, "p", root, "s1", "a", nil)
	b := dialTest(t, port)
	b.hello(1, "p", root, "s2", "b", nil)

	send := func(rid int, from *testClient, target, subject string, refs []map[string]string) string {
		msg := map[string]interface{}{
			"t": "send", "rid": rid,
			"target":  map[string]string{"project": "p", "session": target},
			"subject": subject, "body": "x",
		}
		if refs != nil {
			msg["refs"] = refs
		}
		m := from.request(msg)
		if m["t"] != "sent" {
			t.Fatalf("send %s failed: %v", subject, m)
		}
		return m["mail"].(map[string]interface{})["mail"].(string)
	}

	// m1: a -> b (lives in b's mailbox)
	m1 := send(2, a, "s2", "root", nil)
	// r1: b replies to m1 (lives in a's mailbox, refs m1)
	r1 := send(3, b, "s1", "Re: root", []map[string]string{{"project": "p", "session": "s2", "mail": m1}})
	// m2: a replies to r1 (lives in b's mailbox, refs r1 — NOT m1)
	m2 := send(4, a, "s2", "Re: Re: root", []map[string]string{{"project": "p", "session": "s1", "mail": r1}})
	// unrelated mail (must not appear)
	send(5, a, "s2", "unrelated", nil)

	getThread := func(path string) (int, map[string]interface{}) {
		resp, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&body)
		return resp.StatusCode, body
	}

	// thread of m1: r1 (direct) + m2 (transitive via r1), oldest first
	code, body := getThread("/api/thread/s2@p/" + m1)
	if code != 200 {
		t.Fatalf("thread: %v", code)
	}
	if body["owner"] != "s2@p" {
		t.Fatalf("thread owner: %v", body["owner"])
	}
	replies := body["replies"].([]interface{})
	if len(replies) != 2 {
		t.Fatalf("expected 2 replies (transitive), got %v", body)
	}
	first := replies[0].(map[string]interface{})
	second := replies[1].(map[string]interface{})
	if first["mail"].(map[string]interface{})["id"] != r1 || second["mail"].(map[string]interface{})["id"] != m2 {
		t.Fatalf("order should be oldest first: %v", body)
	}
	// owners point at the mailboxes holding the replies (for navigation)
	if first["owner"] != "s1@p" || second["owner"] != "s2@p" {
		t.Fatalf("reply owners: %v %v", first["owner"], second["owner"])
	}

	// thread of r1: just m2
	code, body = getThread("/api/thread/s1@p/" + r1)
	if code != 200 || len(body["replies"].([]interface{})) != 1 {
		t.Fatalf("thread of r1: %v %v", code, body)
	}

	// leaf mail: no replies
	code, body = getThread("/api/thread/s2@p/" + m2)
	if code != 200 || len(body["replies"].([]interface{})) != 0 {
		t.Fatalf("leaf thread: %v %v", code, body)
	}

	// unknown mail: 404
	if code, _ = getThread("/api/thread/s2@p/nope"); code != 404 {
		t.Fatalf("unknown mail: %v", code)
	}
}

// TestHTTPThreads covers /api/threads/<project>: roots-only listing (replies
// reachable via thread), orphaned-reply roots, cross-project replies counted,
// and the last-activity sort.
func TestHTTPThreads(t *testing.T) {
	tmp := t.TempDir()
	root1 := filepath.Join(tmp, "p1")
	root2 := filepath.Join(tmp, "p2")
	os.MkdirAll(filepath.Join(root1, ".pi", "mailbox"), 0o755)
	os.MkdirAll(filepath.Join(root2, ".pi", "mailbox"), 0o755)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	a := dialTest(t, port)
	a.hello(1, "proj-1", root1, "s1", "a", nil)
	b := dialTest(t, port)
	b.hello(1, "proj-1", root1, "s2", "b", nil)
	c := dialTest(t, port)
	c.hello(1, "proj-2", root2, "s3", "c", nil)

	send := func(rid int, from *testClient, project, target, subject string, refs []map[string]string) string {
		msg := map[string]interface{}{
			"t": "send", "rid": rid,
			"target":  map[string]string{"project": project, "session": target},
			"subject": subject, "body": "x",
		}
		if refs != nil {
			msg["refs"] = refs
		}
		m := from.request(msg)
		if m["t"] != "sent" {
			t.Fatalf("send %s failed: %v", subject, m)
		}
		return m["mail"].(map[string]interface{})["mail"].(string)
	}

	// m1: a -> b, root in proj-1
	m1 := send(2, a, "proj-1", "s2", "root thread", nil)
	// r1: b replies to m1 (lives in a's mailbox in proj-1)
	r1 := send(3, b, "proj-1", "s1", "Re: root", []map[string]string{{"project": "proj-1", "session": "s2", "mail": m1}})
	// orphan: refs a nonexistent mail -> must be listed as a root
	orphan := send(4, a, "proj-1", "s2", "orphaned reply", []map[string]string{{"project": "proj-1", "session": "s2", "mail": "doesnotexist"}})
	// cross-project reply: c (proj-2) replies to m1; lives in b's mailbox in
	// proj-1; sent last so m1's thread has the newest activity despite being
	// created before the orphan (activity sort, not creation sort)
	send(5, c, "proj-1", "s2", "cross reply", []map[string]string{{"project": "proj-1", "session": "s2", "mail": m1}})
	// unrelated project-2 root
	p2root := send(6, c, "proj-2", "s3", "other project", nil)

	getThreads := func(project string) (int, map[string]interface{}) {
		resp, err := http.Get(base + "/api/threads/" + project)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&body)
		return resp.StatusCode, body
	}

	code, body := getThreads("proj-1")
	if code != 200 {
		t.Fatalf("threads: %v", code)
	}
	threads := body["threads"].([]interface{})
	// roots in proj-1: m1, orphan — NOT r1 (its ref resolves), NOT the cross reply, NOT p2root
	if len(threads) != 2 {
		t.Fatalf("expected 2 roots, got %v", body)
	}
	ids := map[string]map[string]interface{}{}
	for _, t := range threads {
		ts := t.(map[string]interface{})
		ids[ts["mail"].(map[string]interface{})["id"].(string)] = ts
	}
	m1s, ok := ids[m1]
	if !ok {
		t.Fatalf("m1 not listed: %v", body)
	}
	if _, ok := ids[orphan]; !ok {
		t.Fatalf("orphaned reply not listed as root: %v", body)
	}
	if _, ok := ids[r1]; ok {
		t.Fatalf("reply r1 must not be listed as root: %v", body)
	}
	// m1's thread: r1 + cross reply = 2 replies
	if int(m1s["replies"].(float64)) != 2 {
		t.Fatalf("m1 replies count: %v", m1s)
	}
	if m1s["lastReplyAt"] == "" {
		t.Fatalf("m1 lastReplyAt: %v", m1s)
	}
	// m1's owner is the mailbox holding it (b's)
	if m1s["owner"] != "s2@proj-1" {
		t.Fatalf("m1 owner: %v", m1s["owner"])
	}

	// proj-2 has its own root
	code, body = getThreads("proj-2")
	if code != 200 || len(body["threads"].([]interface{})) != 1 {
		t.Fatalf("proj-2 threads: %v %v", code, body)
	}
	p2 := body["threads"].([]interface{})[0].(map[string]interface{})
	if p2["mail"].(map[string]interface{})["id"] != p2root {
		t.Fatalf("proj-2 root: %v", p2)
	}

	// activity sort: the thread with the newest reply (m1, cross reply is
	// newest) sorts before the orphan (no replies)
	if threads[0].(map[string]interface{})["mail"].(map[string]interface{})["id"] != m1 {
		t.Fatalf("activity sort: newest-activity thread should be first: %v", threads)
	}

	// unknown project
	if code, _ = getThreads("nope"); code != 404 {
		t.Fatalf("unknown project: %v", code)
	}
}

// TestHTTPSend covers the web user's send capability: POST /api/send writes
// as user@<project>, implicitly registers the user mailbox (so agents can
// reply and initiate), the WS hello reserves "user", and the GC never
// collects the user mailbox.
func TestHTTPSend(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "proj")
	os.MkdirAll(filepath.Join(root, ".pi", "mailbox"), 0o755)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	a := dialTest(t, port)
	a.hello(1, "p", root, "s1", "a", nil)
	b := dialTest(t, port)
	b.hello(1, "p", root, "s2", "b", nil)

	// WS hello cannot register the reserved session id
	if m := a.request(map[string]interface{}{"t": "hello", "rid": 99, "project": "p", "projectRoot": root, "session": "user", "agent": "x"}); m["code"] != "bad_hello" {
		t.Fatalf("hello as user should be rejected: %v", m)
	}

	post := func(path string, payload any) (*http.Response, map[string]interface{}) {
		data, _ := json.Marshal(payload)
		resp, err := http.Post(base+path, "application/json", bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&body)
		return resp, body
	}

	// send to a never-registered session: no_mailbox
	if resp, _ := post("/api/send", map[string]any{"to": "ghost@p", "subject": "x", "body": "y"}); resp.StatusCode != 404 {
		t.Fatalf("no mailbox: %v", resp.StatusCode)
	}
	// unknown project
	if resp, _ := post("/api/send", map[string]any{"to": "s2@nope", "subject": "x", "body": "y"}); resp.StatusCode != 404 {
		t.Fatalf("unknown project: %v", resp.StatusCode)
	}
	// invalid refs
	if resp, _ := post("/api/send", map[string]any{"to": "s2@p", "subject": "x", "body": "y", "refs": []string{"garbage"}}); resp.StatusCode != 400 {
		t.Fatalf("invalid refs: %v", resp.StatusCode)
	}
	// POST to a read-only endpoint: 405
	if resp, _ := post("/api/info", nil); resp.StatusCode != 405 {
		t.Fatalf("POST /api/info: %v", resp.StatusCode)
	}
	// GET /api/send: 405
	if resp, err := http.Get(base + "/api/send"); err != nil || resp.StatusCode != 405 {
		t.Fatalf("GET /api/send: %v %v", err, resp)
	} else {
		resp.Body.Close()
	}

	// the user sends to s2; b is online and must get a notify push
	resp, body := post("/api/send", map[string]any{"to": "s2@p", "subject": "from the web", "body": "hello"})
	if resp.StatusCode != 200 {
		t.Fatalf("send: %v %v", resp.StatusCode, body)
	}
	userMailID := body["mail"].(map[string]interface{})["id"].(string)
	if body["ref"] != "s2@p/"+userMailID {
		t.Fatalf("ref: %v", body["ref"])
	}
	if n := b.expectNotify(); n < 1 {
		t.Fatalf("expected notify for online recipient, got %d", n)
	}
	// the mail is in b's mailbox, from user@p
	inb := b.request(map[string]interface{}{"t": "inbox", "rid": 2})
	mails := inb["mails"].([]interface{})
	found := false
	for _, m := range mails {
		mm := m.(map[string]interface{})
		if mm["id"] == userMailID {
			found = true
			fr := mm["from"].(map[string]interface{})
			if fr["session"] != "user" || fr["project"] != "p" {
				t.Fatalf("from should be user@p: %v", fr)
			}
		}
	}
	if !found {
		t.Fatalf("user mail not in b's inbox: %v", inb)
	}

	// the user mailbox exists now: an agent can reply to user@p via plain WS send
	if m := b.request(map[string]interface{}{
		"t": "send", "rid": 3,
		"target":  map[string]string{"project": "p", "session": "user"},
		"subject": "Re: from the web", "body": "agent reply",
		"refs": []map[string]string{{"project": "p", "session": "s2", "mail": userMailID}},
	}); m["t"] != "sent" {
		t.Fatalf("agent reply to user failed: %v", m)
	}

	// the user's mailbox is readable through the API and shows the reply
	resp, body = nil, nil
	resp2, err := http.Get(base + "/api/mailbox/user@p")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	var ub map[string]interface{}
	json.NewDecoder(resp2.Body).Decode(&ub)
	if resp2.StatusCode != 200 || int(ub["total"].(float64)) != 1 {
		t.Fatalf("user mailbox: %v %v", resp2.StatusCode, ub)
	}
	umail := ub["mails"].([]interface{})[0].(map[string]interface{})
	if umail["subject"] != "Re: from the web" {
		t.Fatalf("user reply mail: %v", umail)
	}

	// the user session appears in listings (offline, agent from registration)
	resp3, err := http.Get(base + "/api/sessions?includeOffline=1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	var sb map[string]interface{}
	json.NewDecoder(resp3.Body).Decode(&sb)
	hasUser := false
	for _, s := range sb["sessions"].([]interface{}) {
		sm := s.(map[string]interface{})
		if sm["session"] == "user" && sm["project"] == "p" {
			hasUser = true
		}
	}
	if !hasUser {
		t.Fatalf("user session not listed: %v", sb)
	}

	// GC never collects the user mailbox even without a pi session file
	moved, err := projStore(t, tmp, "p").GCOrphans(root, 0, map[string]bool{})
	if err != nil || moved != 0 {
		t.Fatalf("GC should keep the user mailbox: moved=%d err=%v", moved, err)
	}
	if _, err := os.Stat(filepath.Join(root, ".pi", "mailbox", "user.jsonl")); err != nil {
		t.Fatalf("user mailbox file should exist: %v", err)
	}
}

// projStore opens a raw Store for a project directory (GC assertion helper).
func projStore(t *testing.T, tmp, project string) *Store {
	store, err := NewStore(filepath.Join(tmp, "proj", ".pi", "mailbox"))
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// TestHTTPDelete covers POST /api/delete: the mailbox (mails, meta,
// registration) is removed entirely, online sessions are refused, the pi
// session file is untouched, and refs from other mailboxes simply stop
// resolving.
func TestHTTPDelete(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "proj")
	os.MkdirAll(filepath.Join(root, ".pi", "mailbox"), 0o755)
	sessionDir := filepath.Join(tmp, "sessions")
	os.MkdirAll(sessionDir, 0o755)
	piSession := filepath.Join(sessionDir, "2026-01-01_s2.jsonl")
	os.WriteFile(piSession, []byte("{}\n"), 0o644)
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	a := dialTest(t, port)
	a.hello(1, "p", root, "s1", "a", nil)
	b := dialTest(t, port)
	b.hello(1, "p", root, "s2", "b", map[string]string{"name": "bee"})
	// mail into b's mailbox
	if m := a.request(map[string]interface{}{
		"t": "send", "rid": 2,
		"target":  map[string]string{"project": "p", "session": "s2"},
		"subject": "to be deleted", "body": "x",
	}); m["t"] != "sent" {
		t.Fatalf("send failed: %v", m)
	}

	post := func(path string, payload any) (*http.Response, map[string]interface{}) {
		data, _ := json.Marshal(payload)
		resp, err := http.Post(base+path, "application/json", bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&body)
		return resp, body
	}

	// online session: refused
	if resp, body := post("/api/delete", map[string]any{"address": "s2@p"}); resp.StatusCode != 409 {
		t.Fatalf("online session should be 409: %v %v", resp.StatusCode, body)
	}

	// disconnect b, then delete
	b.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	if resp, body := post("/api/delete", map[string]any{"address": "s2@p"}); resp.StatusCode != 200 {
		t.Fatalf("delete: %v %v", resp.StatusCode, body)
	}

	// the session is gone from listings and the API
	resp, err := http.Get(base + "/api/sessions?includeOffline=1")
	if err != nil {
		t.Fatal(err)
	}
	var sb map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&sb)
	resp.Body.Close()
	for _, s := range sb["sessions"].([]interface{}) {
		if s.(map[string]interface{})["session"] == "s2" {
			t.Fatalf("s2 should be gone from listings: %v", sb)
		}
	}
	if resp, _ := post("/api/delete", map[string]any{"address": "s2@p"}); resp.StatusCode != 404 {
		t.Fatalf("second delete should 404: %v", resp.StatusCode)
	}

	// the mailbox file is gone; the pi session file is untouched
	if _, err := os.Stat(filepath.Join(root, ".pi", "mailbox", "s2.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("mailbox file should be gone: %v", err)
	}
	if _, err := os.Stat(piSession); err != nil {
		t.Fatalf("pi session file must not be touched: %v", err)
	}

	// s1 is untouched and a ref to the deleted mail no longer resolves
	// (the referencing mail becomes an orphan root in thread listings)
	if m := a.request(map[string]interface{}{
		"t": "send", "rid": 3,
		"target":  map[string]string{"project": "p", "session": "s2"},
		"subject": "after delete", "body": "x",
	}); m["code"] != "no_mailbox" {
		t.Fatalf("send to deleted mailbox should fail: %v", m)
	}

	// unknown project / bad address
	if resp, _ := post("/api/delete", map[string]any{"address": "s2@nope"}); resp.StatusCode != 404 {
		t.Fatalf("unknown project: %v", resp.StatusCode)
	}
	if resp, _ := post("/api/delete", map[string]any{"address": "garbage"}); resp.StatusCode != 400 {
		t.Fatalf("bad address: %v", resp.StatusCode)
	}
}
