package main

// Webhook channel tests: payload format (the bot contract), coalescing,
// deliveryId stability across retries, merge-during-retry, circuit-abandon,
// catch-up, signing, SSRF, and one end-to-end pass through the daemon.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// direct-instance tests (fake env, in-memory store)
// ---------------------------------------------------------------------------

type fakeEnv struct {
	mu     sync.Mutex
	store  *Store
	states map[string]json.RawMessage
}

func newFakeEnv(t *testing.T) *fakeEnv {
	store, err := NewStore(filepath.Join(t.TempDir(), "store"))
	if err != nil {
		t.Fatal(err)
	}
	return &fakeEnv{store: store, states: map[string]json.RawMessage{}}
}

func (e *fakeEnv) FetchMails(project, mailbox string, ids []string) ([]MailRecord, error) {
	var out []MailRecord
	for _, id := range ids {
		m, err := e.store.Mail(mailbox, id)
		if err != nil {
			return nil, err
		}
		if m != nil {
			out = append(out, *m)
		}
	}
	return out, nil
}

func (e *fakeEnv) ScanAfter(project, mailbox, afterID string) ([]MailRecord, error) {
	return scanAfterInbox(e.store, mailbox, afterID)
}

// scanAfterInbox is ScanAfter against a bare store (the daemon env uses the
// same logic through Inbox).
func scanAfterInbox(store *Store, mailbox, afterID string) ([]MailRecord, error) {
	mails, err := store.Inbox(mailbox)
	if err != nil {
		return nil, err
	}
	var afterNS int64 = -1
	if afterID != "" {
		for _, m := range mails {
			if m.ID == afterID {
				afterNS = m.NS
				break
			}
		}
	}
	var kept []*MailRecord
	for _, m := range mails {
		if afterNS < 0 || m.NS > afterNS {
			kept = append(kept, m)
		}
	}
	out := make([]MailRecord, 0, len(kept))
	for i := len(kept) - 1; i >= 0; i-- {
		out = append(out, *kept[i])
	}
	return out, nil
}

func (e *fakeEnv) UnreadCount(project, mailbox string) (int, error) {
	return e.store.UnreadCount(mailbox)
}

func (e *fakeEnv) SaveState(bindingID string, state json.RawMessage) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.states[bindingID] = append(json.RawMessage(nil), state...)
	return nil
}

func (e *fakeEnv) Now() time.Time { return time.Now() }

func (e *fakeEnv) stateOf(id string) []byte {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]byte(nil), e.states[id]...)
}

func appendTestMail(t *testing.T, env *fakeEnv, mailbox, id, subject, body string) *MailRecord {
	t.Helper()
	m := &MailRecord{ID: id, From: AgentRef{Project: "ptest", Session: "sender"}, Subject: subject, Body: body}
	if err := env.store.AppendSend(mailbox, m); err != nil {
		t.Fatal(err)
	}
	return m
}

func fastWebhook(env *fakeEnv, cs *captureServer) *webhookInstance {
	w := &webhookInstance{
		D:        30 * time.Millisecond,
		M:        40 * time.Millisecond,
		Timeout:  2 * time.Second,
		Backoffs: []time.Duration{20 * time.Millisecond, 20 * time.Millisecond, 20 * time.Millisecond, 20 * time.Millisecond},
	}
	_ = env
	_ = cs
	return w
}

func snapshotFor(cfg string, targets ...string) BindingSnapshot {
	return BindingSnapshot{
		ID: "btest01", Owner: "ptest", Channel: "webhook",
		Config: json.RawMessage(cfg), Targets: targets, Enabled: true,
	}
}

const testCfg = `{"url":"REPLACEME","secret":"s3cretpass"}`

// payload shape (the bot contract, A section) + catch-up coalescing at Start
func TestWebhookPayloadAndCatchup(t *testing.T) {
	env := newFakeEnv(t)
	cs := newCaptureServer(t, nil)
	appendTestMail(t, env, "botbox", "m1", "first", strings.Repeat("word ", 100)+"tail")
	appendTestMail(t, env, "botbox", "m2", "second", "plain body")

	w := fastWebhook(env, cs)
	if err := w.Start(env, snapshotFor(strings.Replace(testCfg, "REPLACEME", cs.url(), 1), "botbox")); err != nil {
		t.Fatal(err)
	}
	defer w.Stop()
	cs.wait(t, 1)

	req := cs.get(0)
	var p map[string]any
	if err := json.Unmarshal(req.Body, &p); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]any{
		"event": "mail.batch", "version": float64(1), "bindingId": "btest01",
		"mailbox": "botbox@ptest", "mailCount": float64(2), "truncated": false,
		"unreadCount": float64(2),
	} {
		if p[key] != want {
			t.Fatalf("payload.%s = %v, want %v", key, p[key], want)
		}
	}
	if p["earliest"] == nil || p["latest"] == nil {
		t.Fatalf("earliest/latest missing: %v", p)
	}
	mails := p["mails"].([]any)
	if len(mails) != 2 {
		t.Fatalf("mails: %v", mails)
	}
	first := mails[0].(map[string]any)
	if first["id"] != "m1" || first["from"] != "sender@ptest" || first["subject"] != "first" {
		t.Fatalf("mail[0]: %v", first)
	}
	// snippet: whitespace-collapsed, capped at 200 runes, tail marker
	snip := first["snippet"].(string)
	runes := len([]rune(snip))
	if runes != 201 { // 200 + ellipsis
		t.Fatalf("snippet length %d: %q", runes, snip)
	}
	if strings.Contains(snip, "  ") || strings.Contains(snip, "tail") {
		t.Fatalf("snippet not collapsed/capped: %q", snip)
	}

	// signature headers verify against the raw body
	ts := req.Headers.Get("X-Mailbox-Timestamp")
	sig := req.Headers.Get("X-Mailbox-Signature")
	if ts == "" || sig == "" {
		t.Fatalf("signature headers missing: %v", req.Headers)
	}
	mac := hmac.New(sha256.New, []byte("s3cretpass"))
	mac.Write([]byte(ts + "." + string(req.Body)))
	if sig != hex.EncodeToString(mac.Sum(nil)) {
		t.Fatal("HMAC signature mismatch")
	}
	if ct := req.Headers.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content type: %q", ct)
	}
}

// live arrival coalescing within D; new round gets a new deliveryId
func TestWebhookCoalescingAndRounds(t *testing.T) {
	env := newFakeEnv(t)
	cs := newCaptureServer(t, nil)
	appendTestMail(t, env, "botbox", "m0", "pre", "x") // covered by catch-up

	w := fastWebhook(env, cs)
	if err := w.Start(env, snapshotFor(strings.Replace(testCfg, "REPLACEME", cs.url(), 1), "botbox")); err != nil {
		t.Fatal(err)
	}
	defer w.Stop()
	cs.wait(t, 1) // catch-up batch (m0)
	d1 := deliveryIDOf(t, cs.get(0).Body)

	// two mails within the D window -> ONE post, one deliveryId
	appendTestMail(t, env, "botbox", "m1", "a", "x")
	appendTestMail(t, env, "botbox", "m2", "b", "x")
	w.OnMailArrived(snapshotFor("", "botbox"), "botbox", []string{"m1"})
	w.OnMailArrived(snapshotFor("", "botbox"), "botbox", []string{"m2"})
	cs.wait(t, 2)
	time.Sleep(80 * time.Millisecond) // let any erroneous third post surface
	if cs.count() != 2 {
		t.Fatalf("expected 2 posts (coalesced), got %d", cs.count())
	}
	var p map[string]any
	json.Unmarshal(cs.get(1).Body, &p)
	if p["mailCount"] != float64(2) {
		t.Fatalf("merged batch should carry 2 mails: %v", p)
	}
	d2 := deliveryIDOf(t, cs.get(1).Body)
	if d2 == "" || d2 == d1 {
		t.Fatalf("deliveryId should rotate per round: %q vs %q", d1, d2)
	}
}

// failures retry with the SAME deliveryId; arrivals during retry merge into
// the running round; success advances the watermark
func TestWebhookRetryMergeAndWatermark(t *testing.T) {
	env := newFakeEnv(t)
	var fails int
	cs := newCaptureServer(t, func(rw http.ResponseWriter, r *http.Request, body []byte) {
		fails++
		if fails <= 2 {
			rw.WriteHeader(500)
			return
		}
		rw.WriteHeader(200)
	})
	appendTestMail(t, env, "botbox", "m0", "pre", "x")

	w := fastWebhook(env, cs)
	if err := w.Start(env, snapshotFor(strings.Replace(testCfg, "REPLACEME", cs.url(), 1), "botbox")); err != nil {
		t.Fatal(err)
	}
	// m0 delivery: attempt1 -> 500, attempt2 -> 500, then merge m1 and succeed
	appendTestMail(t, env, "botbox", "m1", "late", "x")
	w.OnMailArrived(snapshotFor("", "botbox"), "botbox", []string{"m1"})

	deadline := time.Now().Add(5 * time.Second)
	var last map[string]any
	for time.Now().Before(deadline) {
		if cs.count() >= 3 {
			var p map[string]any
			json.Unmarshal(cs.get(cs.count()-1).Body, &p)
			if p["mailCount"] == float64(2) { // m0 + merged m1
				last = p
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if last == nil {
		t.Fatalf("retry never delivered the merged batch (count=%d)", cs.count())
	}
	ids := []string{deliveryIDOf(t, cs.get(0).Body), deliveryIDOf(t, cs.get(1).Body), deliveryIDOf(t, cs.get(2).Body)}
	if ids[0] == "" || ids[0] != ids[1] || ids[1] != ids[2] {
		t.Fatalf("deliveryId must stay stable across retries: %v", ids)
	}
	// watermark covers both mails (state persisted through the fake env)
	var st webhookState
	if err := json.Unmarshal(env.stateOf("btest01"), &st); err != nil {
		t.Fatal(err)
	}
	if st.Watermarks["botbox"] != "m1" {
		t.Fatalf("watermark should be m1: %v", st.Watermarks)
	}
	if st.Stats == nil || st.Stats.BatchesDelivered != 1 {
		t.Fatalf("stats: %+v", st.Stats)
	}
	w.Stop()
}

// circuit-abandon: budget exhausted drops the batch (recorded), the next
// mail starts a FRESH round — circuit breaking is not a permanent disable
func TestWebhookAbandonThenFreshRound(t *testing.T) {
	env := newFakeEnv(t)
	var fails int
	cs := newCaptureServer(t, func(rw http.ResponseWriter, r *http.Request, body []byte) {
		fails++
		if fails <= 5 { // 1 + 4 retries = 5 attempts
			rw.WriteHeader(500)
			return
		}
		rw.WriteHeader(200)
	})
	appendTestMail(t, env, "botbox", "m0", "pre", "x")

	w := fastWebhook(env, cs)
	if err := w.Start(env, snapshotFor(strings.Replace(testCfg, "REPLACEME", cs.url(), 1), "botbox")); err != nil {
		t.Fatal(err)
	}
	defer w.Stop()
	cs.wait(t, 5)
	time.Sleep(100 * time.Millisecond)
	if cs.count() != 5 {
		t.Fatalf("expected exactly 5 attempts, got %d", cs.count())
	}
	abandoned := deliveryIDOf(t, cs.get(0).Body)

	// the failed batch is recorded and abandoned
	var st webhookState
	if err := json.Unmarshal(env.stateOf("btest01"), &st); err != nil {
		t.Fatal(err)
	}
	if st.Stats.BatchesAbandoned != 1 || len(st.Failures) == 0 {
		t.Fatalf("state after abandon: %+v %+v", st.Stats, st.Failures)
	}

	// a NEW mail starts a fresh round (new deliveryId) and succeeds
	appendTestMail(t, env, "botbox", "m1", "fresh", "x")
	w.OnMailArrived(snapshotFor("", "botbox"), "botbox", []string{"m1"})
	cs.wait(t, 6)
	fresh := deliveryIDOf(t, cs.get(5).Body)
	if fresh == "" || fresh == abandoned {
		t.Fatalf("fresh round must have a new deliveryId: %q vs %q", fresh, abandoned)
	}
	var p map[string]any
	json.Unmarshal(cs.get(5).Body, &p)
	if p["mailCount"] != float64(1) {
		t.Fatalf("fresh round carries only the new mail: %v", p)
	}
}

// owner lost drops the mailbox runtime and records the loss
func TestWebhookOwnerLost(t *testing.T) {
	env := newFakeEnv(t)
	cs := newCaptureServer(t, nil)
	appendTestMail(t, env, "botbox", "m0", "pre", "x")
	w := fastWebhook(env, cs)
	if err := w.Start(env, snapshotFor(strings.Replace(testCfg, "REPLACEME", cs.url(), 1), "botbox")); err != nil {
		t.Fatal(err)
	}
	defer w.Stop()
	cs.wait(t, 1)
	w.OnOwnerLost(snapshotFor("", "botbox"), "botbox")

	var st webhookState
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := json.Unmarshal(env.stateOf("btest01"), &st); err == nil {
			if len(st.Failures) > 0 && strings.Contains(st.Failures[len(st.Failures)-1].Error, "owner lost") {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(st.Failures) == 0 || !strings.Contains(st.Failures[len(st.Failures)-1].Error, "owner lost") {
		t.Fatalf("owner lost not recorded: %+v", st.Failures)
	}
	time.Sleep(100 * time.Millisecond)
	if cs.count() != 1 {
		t.Fatalf("no further posts expected after owner lost: %d", cs.count())
	}
}

// static headers ride along; sign=false drops the signature pair
func TestWebhookStaticHeadersAndNoSign(t *testing.T) {
	env := newFakeEnv(t)
	cs := newCaptureServer(t, nil)
	appendTestMail(t, env, "botbox", "m0", "pre", "x")
	cfg := fmt.Sprintf(`{"url":%q,"secret":"s3cretpass","headers":{"X-Bot-Key":"botkey123"},"sign":false}`, cs.url())
	w := fastWebhook(env, cs)
	if err := w.Start(env, snapshotFor(cfg, "botbox")); err != nil {
		t.Fatal(err)
	}
	defer w.Stop()
	cs.wait(t, 1)
	req := cs.get(0)
	if req.Headers.Get("X-Bot-Key") != "botkey123" {
		t.Fatalf("static header missing: %v", req.Headers)
	}
	if req.Headers.Get("X-Mailbox-Signature") != "" {
		t.Fatalf("signature should be off: %v", req.Headers)
	}
}

// SSRF rules
func TestWebhookSSRFValidation(t *testing.T) {
	ct := webhookChannelType{}
	for _, bad := range []string{
		`{"url":"http://8.8.8.8/hook","secret":"s3cretpass"}`,                                            // public IP, http
		`{"url":"ftp://127.0.0.1/hook","secret":"s3cretpass"}`,                                           // wrong scheme
		`{"url":"https://","secret":"s3cretpass"}`,                                                       // no host
		`{"url":"https://x.example/hook","secret":"short"}`,                                              // weak secret
		`{"url":"https://x.example/hook"}`,                                                               // no secret
		`{"url":"https://x.example/hook","secret":"s3cretpass","headers":{"Content-Type":"text/plain"}}`, // reserved
	} {
		if err := ct.ValidateConfig(json.RawMessage(bad)); err == nil {
			t.Fatalf("should reject: %s", bad)
		}
	}
	for _, good := range []string{
		`{"url":"https://bot.example/hook","secret":"s3cretpass"}`,
		`{"url":"http://127.0.0.1:9999/hook","secret":"s3cretpass"}`,
		`{"url":"http://localhost:9999/hook","secret":"s3cretpass"}`,
		`{"url":"http://192.168.1.10/hook","secret":"s3cretpass"}`,
		`{"url":"https://x.example/hook","secret":"s3cretpass","headers":{"X-Key":"v"}}`,
	} {
		if err := ct.ValidateConfig(json.RawMessage(good)); err != nil {
			t.Fatalf("should accept %s: %v", good, err)
		}
	}
	// Describe never leaks the secret
	d := ct.Describe(json.RawMessage(`{"url":"https://bot.example/hook","secret":"s3cretpass"}`), nil)
	if strings.Contains(d, "s3cretpass") {
		t.Fatalf("describe leaks: %s", d)
	}
}

// ---------------------------------------------------------------------------
// end-to-end: daemon + real factory + httptest bot (milestone 2 shape)
// ---------------------------------------------------------------------------

func TestWebhookEndToEnd(t *testing.T) {
	// fast timings for the factory-built instances
	old := webhookTestTimings
	webhookTestTimings = func(w *webhookInstance) {
		w.D = 30 * time.Millisecond
		w.M = 40 * time.Millisecond
		w.Timeout = 2 * time.Second
		w.Backoffs = []time.Duration{20 * time.Millisecond, 20 * time.Millisecond, 20 * time.Millisecond, 20 * time.Millisecond}
	}
	t.Cleanup(func() { webhookTestTimings = old })

	env := setupBindingDaemon(t)
	defer env.stop()
	cs := newCaptureServer(t, nil)

	// manager + sender sessions
	m := dialTest(t, env.port)
	defer m.ws.CloseNow()
	m.request(map[string]any{
		"t": "hello", "rid": 1, "project": "ptest", "projectRoot": filepath.Join(env.tmp, "proj"),
		"session": "short00001", "origin": "o1", "agent": "t", "as": "Manager",
	})
	s := dialTest(t, env.port)
	defer s.ws.CloseNow()
	s.request(map[string]any{
		"t": "hello", "rid": 1, "project": "other", "projectRoot": filepath.Join(env.tmp, "other"),
		"session": "short00002", "origin": "o2", "agent": "t", "as": "Sender",
	})

	// bind the mailbox "botbox" (fresh name) to the fake bot
	cfg := fmt.Sprintf(`{"url":%q,"secret":"s3cretpass","headers":{"X-Bot-Key":"botkey123"}}`, cs.url())
	r := bindingAdd(t, m, 2, "webhook", cfg, false, "botbox")
	if r["t"] != "binding" {
		t.Fatalf("binding_add: %v", r)
	}

	// cross-project mail -> one signed POST to the bot
	if r = s.request(map[string]any{
		"t": "send", "rid": 2, "target": map[string]string{"project": "ptest", "session": "botbox"},
		"subject": "notify the bot", "body": "hello from the other project",
	}); r["t"] != "sent" {
		t.Fatalf("send: %v", r)
	}
	mailID := r["mail"].(map[string]any)["mail"].(string)
	cs.wait(t, 1)
	req := cs.get(0)
	var p map[string]any
	json.Unmarshal(req.Body, &p)
	if p["event"] != "mail.batch" || p["mailbox"] != "botbox@ptest" || p["mailCount"] != float64(1) {
		t.Fatalf("payload: %v", p)
	}
	mails := p["mails"].([]any)
	if mails[0].(map[string]any)["id"] != mailID {
		t.Fatalf("mail id: %v", mails[0])
	}
	if req.Headers.Get("X-Bot-Key") != "botkey123" {
		t.Fatalf("static header: %v", req.Headers)
	}
	// signature verifies
	ts := req.Headers.Get("X-Mailbox-Timestamp")
	mac := hmac.New(sha256.New, []byte("s3cretpass"))
	mac.Write([]byte(ts + "." + string(req.Body)))
	if req.Headers.Get("X-Mailbox-Signature") != hex.EncodeToString(mac.Sum(nil)) {
		t.Fatal("signature mismatch")
	}
}

func deliveryIDOf(t *testing.T, body []byte) string {
	t.Helper()
	var p map[string]any
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatal(err)
	}
	s, _ := p["deliveryId"].(string)
	return s
}
