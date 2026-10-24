package main

// Binding layer tests: registry journal, ownership arbitration (sessions vs
// channels vs channels), caps advertisement, arrival dispatch, and a fake
// channel proving that a second channel type needs zero binding-layer
// changes (the abstraction acceptance test).

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// fake channel: a second channel type, implemented WITHOUT touching the
// binding layer — the "add a channel" checklist in executable form
// ---------------------------------------------------------------------------

type fakeChannelType struct {
	mu        sync.Mutex
	instances []*fakeInstance
}

func (f *fakeChannelType) Type() string { return "fake" }

func (f *fakeChannelType) ValidateConfig(cfg json.RawMessage) error {
	var v map[string]any
	if len(cfg) == 0 || json.Unmarshal(cfg, &v) != nil {
		return fmt.Errorf("config must be a JSON object")
	}
	return nil
}

func (f *fakeChannelType) Describe(cfg, state json.RawMessage) string {
	return "fake channel"
}

func (f *fakeChannelType) NewInstance() ChannelInstance {
	inst := &fakeInstance{}
	f.mu.Lock()
	f.instances = append(f.instances, inst)
	f.mu.Unlock()
	return inst
}

func (f *fakeChannelType) live() *fakeInstance {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.instances) == 0 {
		return nil
	}
	return f.instances[len(f.instances)-1]
}

type fakeInstance struct {
	mu      sync.Mutex
	events  []string
	started bool
	stopped bool
	env     ChannelEnv
	b       BindingSnapshot
}

func (f *fakeInstance) record(ev string) {
	f.mu.Lock()
	f.events = append(f.events, ev)
	f.mu.Unlock()
}

func (f *fakeInstance) snapshotEvents() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.events...)
}

func (f *fakeInstance) waitFor(t *testing.T, ev string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range f.snapshotEvents() {
			if e == ev {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("fake channel never saw %q (events: %v)", ev, f.snapshotEvents())
}

func (f *fakeInstance) Start(env ChannelEnv, b BindingSnapshot) error {
	f.env, f.b = env, b
	f.started = true
	f.record("start")
	return nil
}
func (f *fakeInstance) Stop() {
	f.stopped = true
	f.record("stop")
}
func (f *fakeInstance) OnMailArrived(b BindingSnapshot, mailbox string, mailIDs []string) {
	f.record(fmt.Sprintf("arrived:%s:%s", mailbox, strings.Join(mailIDs, ",")))
}
func (f *fakeInstance) OnOwnerGained(b BindingSnapshot, mailbox string) {
	f.record("gained:" + mailbox)
}
func (f *fakeInstance) OnOwnerLost(b BindingSnapshot, mailbox string) {
	f.record("lost:" + mailbox)
}

// withFakeChannel registers the fake channel type for one test.
func withFakeChannel(t *testing.T) *fakeChannelType {
	t.Helper()
	f := &fakeChannelType{}
	channelTypes["fake"] = f
	t.Cleanup(func() { delete(channelTypes, "fake") })
	return f
}

// ---------------------------------------------------------------------------
// registry journal
// ---------------------------------------------------------------------------

func TestBindingRegistryJournal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bindings.jsonl")
	r1 := NewBindingRegistry(path)
	b := &Binding{
		ID: "b00001", Owner: "proj", OwnerRoot: "/tmp/root", Channel: "webhook",
		Config:  json.RawMessage(`{"url":"https://x","secret":"s3cretpass"}`),
		Targets: []string{"alice"}, Enabled: true, CreatedAt: "2026-01-01T00:00:00Z",
	}
	if err := r1.Put(b); err != nil {
		t.Fatal(err)
	}
	if err := r1.SaveState("b00001", json.RawMessage(`{"watermarks":{"alice":"m1"}}`)); err != nil {
		t.Fatal(err)
	}
	b2 := &Binding{ID: "b00002", Owner: "proj", Channel: "webhook", Targets: []string{"bob"}, Enabled: false}
	if err := r1.Put(b2); err != nil {
		t.Fatal(err)
	}
	if err := r1.Delete("b00002"); err != nil {
		t.Fatal(err)
	}

	// reload: b00001 with state, b00002 gone
	r2 := NewBindingRegistry(path)
	if err := r2.Load(); err != nil {
		t.Fatal(err)
	}
	got := r2.Get("b00001")
	if got == nil {
		t.Fatal("b00001 lost on reload")
	}
	if string(got.State) != `{"watermarks":{"alice":"m1"}}` || got.OwnerRoot != "/tmp/root" {
		t.Fatalf("record mismatch: %+v", got)
	}
	if r2.Get("b00002") != nil {
		t.Fatal("b00002 should be deleted")
	}
	if len(r2.ForOwner("proj")) != 1 {
		t.Fatalf("ForOwner: %v", r2.ForOwner("proj"))
	}
}

// torn last line is tolerated
func TestBindingRegistryTornTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bindings.jsonl")
	r := NewBindingRegistry(path)
	if err := r.Put(&Binding{ID: "b1", Owner: "p", Channel: "webhook", Targets: []string{"a"}, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := appendLine(path, `{"t":"binding_put","binding":{"id":"b2","owner":"p`); err != nil {
		t.Fatal(err)
	}
	r2 := NewBindingRegistry(path)
	if err := r2.Load(); err != nil {
		t.Fatal(err)
	}
	if r2.Get("b1") == nil || r2.Get("b2") != nil {
		t.Fatalf("torn tail handling: b1=%v b2=%v", r2.Get("b1"), r2.Get("b2"))
	}
}

// ---------------------------------------------------------------------------
// arbitration + protocol (in-process daemon, real WS)
// ---------------------------------------------------------------------------

type bindingTestEnv struct {
	port int
	tmp  string
	stop func()
}

func setupBindingDaemon(t *testing.T) *bindingTestEnv {
	t.Helper()
	tmp := t.TempDir()
	port, stop := bootDaemon(t, tmp, "", false)
	return &bindingTestEnv{port: port, tmp: tmp, stop: stop}
}

func bindingAdd(t *testing.T, c *testClient, rid int, channel string, config string, force bool, targets ...string) map[string]any {
	t.Helper()
	msg := map[string]any{
		"t": "binding_add", "rid": rid, "channel": channel, "targets": targets,
		"config": json.RawMessage(config),
	}
	if force {
		msg["force"] = true
	}
	return c.request(msg)
}

func TestBindingArbitration(t *testing.T) {
	env := setupBindingDaemon(t)
	defer env.stop()

	// session claims "alice" and stays online
	a := dialTest(t, env.port)
	defer a.ws.CloseNow()
	w := a.request(map[string]any{
		"t": "hello", "rid": 1, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00001", "origin": "origin-a", "agent": "t", "as": "Alice",
	})
	if w["t"] != "welcome" {
		t.Fatalf("alice login: %v", w)
	}
	if caps, ok := w["caps"].([]any); !ok || !containsStr(caps, "bindings") || !containsStr(caps, "channel:webhook") {
		t.Fatalf("welcome caps: %v", w["caps"])
	}

	// manager session in the same project
	m := dialTest(t, env.port)
	defer m.ws.CloseNow()
	if r := m.request(map[string]any{
		"t": "hello", "rid": 2, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00002", "origin": "origin-m", "agent": "t", "as": "Manager",
	}); r["t"] != "welcome" {
		t.Fatalf("manager login: %v", r)
	}

	// online holder: refuse, even with force
	r := bindingAdd(t, m, 10, "webhook", `{"url":"https://bot.example/hook","secret":"s3cretpass"}`, true, "alice")
	if r["code"] != "mailbox_in_use" {
		t.Fatalf("online holder should be mailbox_in_use, got %v", r)
	}

	// holder goes offline
	a.ws.CloseNow()
	time.Sleep(100 * time.Millisecond)

	// offline holder without force: name_held
	r = bindingAdd(t, m, 11, "webhook", `{"url":"https://bot.example/hook","secret":"s3cretpass"}`, false, "alice")
	if r["code"] != "name_held" {
		t.Fatalf("offline holder should be name_held, got %v", r)
	}
	if !strings.Contains(r["message"].(string), "force") {
		t.Fatalf("name_held message should mention force: %v", r)
	}

	// with force: claim
	r = bindingAdd(t, m, 12, "webhook", `{"url":"https://bot.example/hook","secret":"s3cretpass"}`, true, "alice")
	if r["t"] != "binding" {
		t.Fatalf("forced claim should succeed, got %v", r)
	}
	bid := r["binding"].(map[string]any)["id"].(string)

	// a second binding cannot take a channel-held target
	r = bindingAdd(t, m, 13, "webhook", `{"url":"https://bot2.example/hook","secret":"s3cretpass"}`, true, "alice")
	if r["code"] != "mailbox_in_use" {
		t.Fatalf("channel-held target should be mailbox_in_use, got %v", r)
	}

	// invalid channel / config / targets
	if r = bindingAdd(t, m, 14, "nope", `{}`, false, "alice"); r["code"] != "unsupported_channel" {
		t.Fatalf("unsupported_channel: %v", r)
	}
	if r = bindingAdd(t, m, 15, "webhook", `{"url":"http://8.8.8.8/x","secret":"s3cretpass"}`, false, "alice"); r["code"] != "invalid_config" {
		t.Fatalf("ssrf config: %v", r)
	}
	if r = bindingAdd(t, m, 16, "webhook", `{"url":"https://x.example","secret":"s3cretpass"}`, false, "bad name!"); r["code"] != "bad_target" {
		t.Fatalf("bad_target: %v", r)
	}

	// list: redacted view, no secrets anywhere
	r = m.request(map[string]any{"t": "bindings", "rid": 20})
	bindings := r["bindings"].([]any)
	if len(bindings) != 1 {
		t.Fatalf("bindings list: %v", bindings)
	}
	raw, _ := json.Marshal(r)
	if strings.Contains(string(raw), "s3cretpass") {
		t.Fatalf("secret leaked into listing: %s", raw)
	}

	// a session force-takes the mailbox back: binding marks it lost
	s := dialTest(t, env.port)
	defer s.ws.CloseNow()
	r = s.request(map[string]any{
		"t": "hello", "rid": 30, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00003", "origin": "origin-s", "agent": "t", "as": "alice", "force": true,
	})
	if r["t"] != "welcome" {
		t.Fatalf("session force takeover: %v", r)
	}
	time.Sleep(100 * time.Millisecond)
	r = m.request(map[string]any{"t": "bindings", "rid": 21})
	b0 := r["bindings"].([]any)[0].(map[string]any)
	if b0["id"] != bid || !containsStrAny(b0["lost"], "alice") {
		t.Fatalf("binding should mark alice lost: %v", b0)
	}

	// re-claim via update with force clears lost (the holder must be
	// OFFLINE: channels never displace online sessions)
	s.ws.CloseNow()
	time.Sleep(100 * time.Millisecond)
	r = m.request(map[string]any{"t": "binding_update", "rid": 22, "id": bid, "targets": []string{"alice"}, "force": true})
	if r["t"] != "binding" {
		t.Fatalf("update re-claim: %v", r)
	}

	// delete releases: a session can claim alice WITHOUT force afterwards
	if r = m.request(map[string]any{"t": "binding_delete", "rid": 23, "id": bid}); r["t"] != "binding" {
		t.Fatalf("delete: %v", r)
	}
	q := dialTest(t, env.port)
	defer q.ws.CloseNow()
	r = q.request(map[string]any{
		"t": "hello", "rid": 40, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00004", "origin": "origin-q", "agent": "t", "as": "alice",
	})
	if r["t"] != "welcome" {
		t.Fatalf("released mailbox should be free to claim: %v", r)
	}
}

func containsStr(list []any, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func containsStrAny(list any, s string) bool {
	arr, ok := list.([]any)
	if !ok {
		return false
	}
	return containsStr(arr, s)
}

// sessions in ANOTHER project cannot manage this project's bindings
func TestBindingOwnerIsolation(t *testing.T) {
	env := setupBindingDaemon(t)
	defer env.stop()

	m := dialTest(t, env.port)
	defer m.ws.CloseNow()
	m.request(map[string]any{
		"t": "hello", "rid": 1, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00001", "origin": "o1", "agent": "t", "as": "Manager",
	})
	r := bindingAdd(t, m, 2, "webhook", `{"url":"https://bot.example/hook","secret":"s3cretpass"}`, false, "botbox")
	if r["t"] != "binding" {
		t.Fatalf("add: %v", r)
	}
	bid := r["binding"].(map[string]any)["id"].(string)

	// foreign project session: no listing, no update, no delete
	x := dialTest(t, env.port)
	defer x.ws.CloseNow()
	x.request(map[string]any{
		"t": "hello", "rid": 1, "project": "other", "projectRoot": filepath.Join(env.tmp, "other"),
		"session": "short00009", "origin": "o2", "agent": "t", "as": "Intruder",
	})
	if r = x.request(map[string]any{"t": "bindings", "rid": 2}); len(r["bindings"].([]any)) != 0 {
		t.Fatalf("foreign project must see no bindings: %v", r)
	}
	if r = x.request(map[string]any{"t": "binding_update", "rid": 3, "id": bid, "enabled": false}); r["code"] != "not_owner" {
		t.Fatalf("not_owner: %v", r)
	}
	if r = x.request(map[string]any{"t": "binding_delete", "rid": 4, "id": bid}); r["code"] != "not_owner" {
		t.Fatalf("not_owner: %v", r)
	}
}

// mail to a channel-owned mailbox is dispatched to the channel instance;
// the fake channel proves a second channel type needs no binding-layer change
func TestBindingArrivalDispatchFakeChannel(t *testing.T) {
	fake := withFakeChannel(t)
	env := setupBindingDaemon(t)
	defer env.stop()

	m := dialTest(t, env.port)
	defer m.ws.CloseNow()
	m.request(map[string]any{
		"t": "hello", "rid": 1, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00001", "origin": "o1", "agent": "t", "as": "Manager",
	})
	r := bindingAdd(t, m, 2, "fake", `{}`, false, "botbox")
	if r["t"] != "binding" {
		t.Fatalf("fake binding add: %v", r)
	}
	inst := fake.live()
	if inst == nil {
		t.Fatal("no fake instance created")
	}
	inst.waitFor(t, "start")

	// cross-project sender mails botbox@ptest
	sender := dialTest(t, env.port)
	defer sender.ws.CloseNow()
	sender.request(map[string]any{
		"t": "hello", "rid": 1, "project": "other", "projectRoot": filepath.Join(env.tmp, "other"),
		"session": "short00002", "origin": "o2", "agent": "t", "as": "Sender",
	})
	if r = sender.request(map[string]any{
		"t": "send", "rid": 2, "target": map[string]string{"project": "ptest", "session": "botbox"},
		"subject": "hello bot", "body": "via webhook",
	}); r["t"] != "sent" {
		t.Fatalf("send to channel-owned mailbox: %v", r)
	}
	mailID := r["mail"].(map[string]any)["mail"].(string)
	inst.waitFor(t, "arrived:botbox:"+mailID)

	// own-project mail also dispatches (mailbox need not be cross-project)
	if r = m.request(map[string]any{
		"t": "send", "rid": 3, "target": map[string]string{"project": "ptest", "session": "botbox"},
		"subject": "again", "body": "x",
	}); r["t"] != "sent" {
		t.Fatalf("own-project send: %v", r)
	}
	mailID2 := r["mail"].(map[string]any)["mail"].(string)
	inst.waitFor(t, "arrived:botbox:"+mailID2)

	// the fake channel could also read the mail back through its env
	// (the read-only fetch surface channels get)
	mail, err := inst.env.FetchMails("ptest", "botbox", []string{mailID})
	if err != nil || len(mail) != 1 || mail[0].Subject != "hello bot" {
		t.Fatalf("FetchMails: %v %v", mail, err)
	}
}

// disable releases targets and stops the instance; enable re-claims
func TestBindingEnableDisable(t *testing.T) {
	env := setupBindingDaemon(t)
	defer env.stop()

	m := dialTest(t, env.port)
	defer m.ws.CloseNow()
	m.request(map[string]any{
		"t": "hello", "rid": 1, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00001", "origin": "o1", "agent": "t", "as": "Manager",
	})
	r := bindingAdd(t, m, 2, "webhook", `{"url":"https://bot.example/hook","secret":"s3cretpass"}`, false, "botbox")
	if r["t"] != "binding" {
		t.Fatalf("add: %v", r)
	}
	bid := r["binding"].(map[string]any)["id"].(string)

	// disable: origin cleared, mailbox free
	if r = m.request(map[string]any{"t": "binding_update", "rid": 3, "id": bid, "enabled": false}); r["t"] != "binding" {
		t.Fatalf("disable: %v", r)
	}
	q := dialTest(t, env.port)
	if r = q.request(map[string]any{
		"t": "hello", "rid": 4, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00002", "origin": "o2", "agent": "t", "as": "botbox",
	}); r["t"] != "welcome" {
		t.Fatalf("disabled binding should release the target: %v", r)
	}
	q.ws.CloseNow()
	time.Sleep(50 * time.Millisecond)

	// enable: re-claim
	if r = m.request(map[string]any{"t": "binding_update", "rid": 5, "id": bid, "enabled": true, "force": true}); r["t"] != "binding" {
		t.Fatalf("enable: %v", r)
	}
	// the daemon survives an idle tick with an enabled binding (no
	// idle-exit) — implicitly covered by later requests still working
	if r = m.request(map[string]any{"t": "bindings", "rid": 6}); len(r["bindings"].([]any)) != 1 {
		t.Fatalf("list after enable: %v", r)
	}
}

// journal roundtrip through a daemon restart: bindings reload, channels
// restart, ownership persists, catch-up runs (watermark honored)
func TestBindingSurvivesRestart(t *testing.T) {
	old := webhookTestTimings
	webhookTestTimings = func(w *webhookInstance) {
		w.D = 30 * time.Millisecond
		w.M = 40 * time.Millisecond
		w.Timeout = 500 * time.Millisecond
		w.Backoffs = []time.Duration{30 * time.Millisecond, 30 * time.Millisecond, 30 * time.Millisecond, 30 * time.Millisecond}
	}
	t.Cleanup(func() { webhookTestTimings = old })
	env := setupBindingDaemon(t)
	cs := newCaptureServer(t, nil)

	m := dialTest(t, env.port)
	m.request(map[string]any{
		"t": "hello", "rid": 1, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00001", "origin": "o1", "agent": "t", "as": "Manager",
	})
	r := bindingAdd(t, m, 2, "webhook", fmt.Sprintf(`{"url":%q,"secret":"s3cretpass"}`, cs.url()), false, "botbox")
	if r["t"] != "binding" {
		t.Fatalf("add: %v", r)
	}
	// write a mail into botbox while connected; the webhook delivers it
	// (fast timings) before the restart, advancing the watermark
	if r = m.request(map[string]any{
		"t": "send", "rid": 3, "target": map[string]string{"project": "ptest", "session": "botbox"},
		"subject": "before restart", "body": "x",
	}); r["t"] != "sent" {
		t.Fatalf("send: %v", r)
	}
	cs.wait(t, 1)
	// let the client side finish reading the response and persist the
	// watermark (delivery is at-least-once: a POST whose response read is
	// aborted by shutdown may legitimately redeliver on catch-up; the test
	// gives the round a moment to settle so it asserts the steady path)
	time.Sleep(250 * time.Millisecond)
	m.ws.CloseNow()
	env.stop()
	time.Sleep(100 * time.Millisecond)

	// restart on the SAME tmp dir (same registry/lock/bindings paths)
	port2, stop2 := bootDaemon(t, env.tmp, "", false)
	defer stop2()

	m2 := dialTest(t, port2)
	defer m2.ws.CloseNow()
	if r = m2.request(map[string]any{
		"t": "hello", "rid": 1, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00001", "origin": "o1", "agent": "t", "as": "Manager",
	}); r["t"] != "welcome" {
		t.Fatalf("re-login: %v", r)
	}
	if r = m2.request(map[string]any{"t": "bindings", "rid": 2}); len(r["bindings"].([]any)) != 1 {
		t.Fatalf("binding lost on restart: %v", r)
	}
	// catch-up after restart: the watermark covers the delivered mail, so
	// no duplicate POST arrives (bounded wait for a would-be second post)
	time.Sleep(200 * time.Millisecond)
	if cs.count() != 1 {
		t.Fatalf("watermark lost on restart, duplicate post (count=%d)", cs.count())
	}
	// ownership persisted: a session cannot claim botbox without force
	q := dialTest(t, port2)
	defer q.ws.CloseNow()
	if r = q.request(map[string]any{
		"t": "hello", "rid": 3, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00003", "origin": "o3", "agent": "t", "as": "botbox",
	}); r["code"] != "name_held" {
		t.Fatalf("channel ownership should survive restart: %v", r)
	}
	if !strings.Contains(fmt.Sprint(r["message"]), "channel binding") {
		t.Fatalf("name_held should name the channel holder: %v", r["message"])
	}
}

// minimal HTTP capture server (shared with webhook_test)
type captureServer struct {
	mu       sync.Mutex
	server   *httptest.Server
	requests []capturedRequest
	signal   chan struct{}
}

type capturedRequest struct {
	Headers http.Header
	Body    []byte
}

func newCaptureServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request, body []byte)) *captureServer {
	t.Helper()
	cs := &captureServer{signal: make(chan struct{}, 64)}
	cs.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if handler != nil {
			handler(w, r, body)
		} else {
			w.WriteHeader(200)
		}
		cs.mu.Lock()
		cs.requests = append(cs.requests, capturedRequest{Headers: r.Header.Clone(), Body: body})
		cs.mu.Unlock()
		select {
		case cs.signal <- struct{}{}:
		default:
		}
	}))
	t.Cleanup(cs.server.Close)
	return cs
}

func (cs *captureServer) url() string { return cs.server.URL }

func (cs *captureServer) count() int {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return len(cs.requests)
}

func (cs *captureServer) get(i int) capturedRequest {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.requests[i]
}

func (cs *captureServer) wait(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cs.count() >= n {
			return
		}
		select {
		case <-cs.signal:
		case <-time.After(50 * time.Millisecond):
		}
	}
	t.Fatalf("expected %d webhook calls, got %d", n, cs.count())
}
