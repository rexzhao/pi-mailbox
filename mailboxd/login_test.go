package main

// Named-mailbox login tests: claim, exclusivity, inheritance, GC exemption.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
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

// helloLoginForce is helloLogin with force=true.
func (c *testClient) helloLoginForce(rid int, project, root, sessionDir, short, origin, agent, as, tags string) map[string]interface{} {
	msg := map[string]interface{}{
		"t": "hello", "rid": rid, "project": project, "projectRoot": root,
		"sessionDir": sessionDir,
		"session":    short, "origin": origin, "agent": agent,
		"as": as, "force": true,
	}
	if tags != "" {
		msg["tags"] = tags
	}
	return c.request(msg)
}

// A freshly spawned daemon has no project in memory (projects register on
// hello); /api/sessions must load one on demand in local mode so that
// identity-less lookups (resume) see the on-disk mailboxes.
func TestAPISessionsOnDemandProject(t *testing.T) {
	tmp := t.TempDir()
	projectRoot := filepath.Join(tmp, "proj")
	mailDir := filepath.Join(projectRoot, ".pi", "mailbox")
	os.MkdirAll(mailDir, 0o755)
	// a pre-existing named mailbox on disk
	st, err := NewStore(mailDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.HelloMerge("on-demand-name", "pi", "some-origin", map[string]string{}, &Claim{Name: "on-demand-name"}); err != nil {
		t.Fatal(err)
	}

	port, stop := bootDaemon(t, tmp, "", false) // fresh daemon, no hello yet
	defer stop()

	httpGet := func(path string) map[string]interface{} {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d%s", port, path))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var m map[string]interface{}
		if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
			t.Fatal(err)
		}
		return m
	}

	// without the params: the project is unknown, no sessions
	if m := httpGet("/api/sessions?includeOffline=1"); len(m["sessions"].([]interface{})) != 0 {
		t.Fatalf("fresh daemon should list no sessions, got %v", m)
	}
	// with project+projectRoot: loaded on demand, the mailbox is visible
	q := "/api/sessions?includeOffline=1&project=ondemand-proj&projectRoot=" + url.QueryEscape(projectRoot)
	m := httpGet(q)
	sessions := m["sessions"].([]interface{})
	if len(sessions) != 1 {
		t.Fatalf("on-demand load should list the disk mailbox, got %v", m)
	}
	s := sessions[0].(map[string]interface{})
	if s["session"] != "on-demand-name" || s["online"] != false {
		t.Fatalf("unexpected session info: %v", s)
	}
}

func TestNamedMailboxLogin(t *testing.T) {
	tmp := t.TempDir()
	projectRoot := filepath.Join(tmp, "proj")
	os.MkdirAll(filepath.Join(projectRoot, ".pi", "mailbox"), 0o755)
	sessionDir := filepath.Join(tmp, "sessions")
	os.MkdirAll(sessionDir, 0o755)

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
	if w := s.helloLogin(1, project, projectRoot, sessionDir, "shortcccc", "originC", "agent-c", "helper-c", ""); w["t"] != "welcome" {
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

	// 6. invalid names are rejected (case is legal now — "ABC" is a
	//    valid spelling of the mailbox "abc"; the grammar excludes
	//    digit-first, too-short-after-trim... no: 1-char is legal too —
	//    dots, leading hyphens, the derived shape, and reserved ids)
	for _, bad := range []string{"user", "USER", "abcdefghij", "has.dot", "-lead", "1abc", "has space"} {
		e := s.helloLogin(9, project, projectRoot, sessionDir, "shortcccc", "originC", "agent-c", bad, "")
		if e["t"] != "error" || e["code"] != "bad_name" {
			t.Fatalf("expected bad_name for %q, got %v", bad, e)
		}
	}

	// 7. an offline foreign holder requires a confirmed force: the normal
	//    attempt is rejected, the forced retry takes over and inherits
	//    mails and tags wholesale (the "forced B login after logout" is
	//    actually a socket drop — the release path is 7b-release above)
	a2.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	b2 := dialTest(t, port) // b's socket was closed by the step-3 rejection
	if e := b2.helloLogin(2, project, projectRoot, sessionDir, "shortbbbb", "originB", "agent-b", "reviewer", ""); e["t"] != "error" || e["code"] != "name_held" {
		t.Fatalf("expected name_held for the offline foreign holder, got %v", e)
	}
	wb := b2.helloLoginForce(3, project, projectRoot, sessionDir, "shortbbbb", "originB", "agent-b", "reviewer", "")
	if wb["t"] != "welcome" || wb["mailbox"] != "reviewer" {
		t.Fatalf("forced B login after logout: %v", wb)
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

	// 7b. one name per session (session_bound):
	// B (originB, now holding "reviewer") tries a second name -> rejected
	if e := b2.request(map[string]interface{}{
		"t": "hello", "rid": 5, "project": project, "projectRoot": projectRoot,
		"sessionDir": sessionDir, "session": "shortbbbb", "origin": "originB",
		"agent": "agent-b", "as": "reviewer-two",
	}); e["t"] != "error" || e["code"] != "session_bound" {
		t.Fatalf("expected session_bound, got %v", e)
	}
	// same-name re-login is fine (checked above as step 4/5)
	// the reverse marker survives a same-name re-login
	if w := b2.request(map[string]interface{}{
		"t": "hello", "rid": 6, "project": project, "projectRoot": projectRoot,
		"sessionDir": sessionDir, "session": "shortbbbb", "origin": "originB",
		"agent": "agent-b", "as": "reviewer",
	}); w["t"] != "welcome" {
		t.Fatalf("same-name re-login after login: %v", w)
	}
	if e := b2.request(map[string]interface{}{
		"t": "hello", "rid": 7, "project": project, "projectRoot": projectRoot,
		"sessionDir": sessionDir, "session": "shortbbbb", "origin": "originB",
		"agent": "agent-b", "as": "reviewer-three",
	}); e["t"] != "error" || e["code"] != "session_bound" {
		t.Fatalf("session_bound must survive a same-name re-login, got %v", e)
	}
	// _holds is not forgeable via hello meta: the forged value is
	// ignored and the claim (here a re-claim of the held name) succeeds
	if w := s.request(map[string]interface{}{
		"t": "hello", "rid": 8, "project": project, "projectRoot": projectRoot,
		"sessionDir": sessionDir, "session": "shortcccc", "origin": "originC",
		"agent": "agent-c", "as": "helper-c", "meta": map[string]string{"_holds": "reviewer"},
	}); w["t"] != "welcome" {
		t.Fatalf("forged _holds must be ignored (claim should succeed), got %v", w)
	}

	// 7b-release (model E): login A -> hello with release=A, as=B in ONE
	// hello -> the release must clear _holds BEFORE session_bound runs,
	// so the switch to B succeeds in a single round trip. The welcome
	// must carry released=true.
	if w := b2.request(map[string]interface{}{
		"t": "hello", "rid": 20, "project": project, "projectRoot": projectRoot,
		"sessionDir": sessionDir, "session": "shortbbbb", "origin": "originB",
		"agent": "agent-b", "as": "post-release-name", "release": "reviewer",
	}); w["t"] != "welcome" || w["mailbox"] != "post-release-name" {
		t.Fatalf("release+switch in one hello should succeed, got %v", w)
	} else if w["released"] != true {
		t.Fatalf("welcome must carry released=true, got %v", w)
	}
	// switching to yet another name requires releasing the current one
	// (model E: one name at a time, release-then-switch in ONE hello)
	if w := b2.request(map[string]interface{}{
		"t": "hello", "rid": 21, "project": project, "projectRoot": projectRoot,
		"sessionDir": sessionDir, "session": "shortbbbb", "origin": "originB",
		"agent": "agent-b", "as": "another-name", "release": "post-release-name",
	}); w["t"] != "welcome" || w["mailbox"] != "another-name" {
		t.Fatalf("release+switch again should succeed, got %v", w)
	}
	// release of a name we don't hold: delivered (welcome.released=true)
	// but a no-op (no error, binding unchanged)
	if w := b2.request(map[string]interface{}{
		"t": "hello", "rid": 22, "project": project, "projectRoot": projectRoot,
		"sessionDir": sessionDir, "session": "shortbbbb", "origin": "originB",
		"agent": "agent-b", "as": "another-name", "release": "not-ours",
	}); w["t"] != "welcome" || w["released"] != true {
		t.Fatalf("no-op release should still welcome with released=true, got %v", w)
	}
	// (release riding a NAMELESS hello is no longer reachable: nameless
	// hellos are rejected outright. Release-riding is covered above by the
	// different-name claim (rid 20) and the no-op release (rid 22) — every
	// hello now carries a name claim.)

	// 7c. self-heal: the ORIGINAL holder (originA) lost "reviewer" to B
	// (takeover in step 7); its stale _holds must not block a new name
	a3 := dialTest(t, port)
	if w := a3.request(map[string]interface{}{
		"t": "hello", "rid": 10, "project": project, "projectRoot": projectRoot,
		"sessionDir": sessionDir, "session": "shortaaaa", "origin": "originA",
		"agent": "agent-a", "as": "fresh-name",
	}); w["t"] != "welcome" || w["mailbox"] != "fresh-name" {
		t.Fatalf("stale _holds should self-heal and allow a new name, got %v", w)
	}

	// 7d. force edge cases: online holder still refuses; session_bound is
	// not bypassed; force on a free name is a no-op. c4 is a fresh
	// nameless session so the earlier checks cannot short-circuit.
	// (b2's plain re-hello in 7b re-registered it under its derived id, so
	// "reviewer" has no online holder; this re-login is the same-origin
	// OFFLINE re-claim (row 2). Row 3 (same-origin online replace) is
	// covered by step 4's a2 re-login.)
	if w := b2.helloLogin(14, project, projectRoot, sessionDir, "shortbbbb", "originB", "agent-b", "another-name", ""); w["t"] != "welcome" || w["mailbox"] != "another-name" {
		t.Fatalf("same-origin online re-login: %v", w)
	}
	c4 := dialTest(t, port)
	if e := c4.helloLoginForce(11, project, projectRoot, sessionDir, "shortdddd", "originD", "agent-d", "another-name", ""); e["t"] != "error" || e["code"] != "mailbox_in_use" {
		t.Fatalf("force must never displace an online holder, got %v", e)
	}
	if e := b2.helloLoginForce(12, project, projectRoot, sessionDir, "shortbbbb", "originB", "agent-b", "fresh-name-two", ""); e["t"] != "error" || e["code"] != "session_bound" {
		t.Fatalf("force must not bypass session_bound, got %v", e)
	}
	c5 := dialTest(t, port) // c4's socket was closed by the mailbox_in_use rejection
	if w := c5.helloLoginForce(13, project, projectRoot, sessionDir, "shortdddd", "originD", "agent-d", "free-name-three", ""); w["t"] != "welcome" || w["mailbox"] != "free-name-three" {
		t.Fatalf("force on a free name should be a no-op success, got %v", w)
	}

}
