package main

// webhook.go: the webhook delivery channel.
//
// One instance per binding. ALL delivery semantics live here (the binding
// layer only hands over arrivals): summary payload (snippet, no full body —
// the bot reads back via the read-only HTTP API), per-mailbox batching with
// a delay window D and a minimum interval M between calls, one deliveryId
// per round kept stable across retries (new arrivals merge into the running
// round), bounded retry with backoff, circuit-abandon (the batch is dropped
// and recorded — NOT a permanent disable: the next mail starts a fresh
// round), HMAC signing, SSRF checks, and startup catch-up from persisted
// per-mailbox watermarks.
//
// Bot-facing contract (payload and headers) is documented in README; it is
// a property of THIS channel, not of the binding layer.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

type webhookConfig struct {
	URL     string            `json:"url"`
	Secret  string            `json:"secret"`
	Headers map[string]string `json:"headers,omitempty"`
	// Sign toggles the X-Mailbox-Timestamp/X-Mailbox-Signature HMAC pair
	// (default true). Static headers still apply either way.
	Sign *bool `json:"sign,omitempty"`
}

func (c *webhookConfig) signed() bool { return c.Sign == nil || *c.Sign }

var headerNameRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// reservedWebhookHeaders must not be overridable from config: they are
// protocol-owned (content type and the signature pair).
var reservedWebhookHeaders = map[string]bool{
	"content-type":        true,
	"x-mailbox-timestamp": true,
	"x-mailbox-signature": true,
}

// validateWebhookURL enforces the SSRF rule: https anywhere, http only for
// loopback/private targets. Called at config validation AND before every
// POST (hostnames can be re-pointed).
func validateWebhookURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid url: %v", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		if u.Host == "" {
			return fmt.Errorf("https url requires a host")
		}
		return nil
	case "http":
		if u.Host == "" {
			return fmt.Errorf("http url requires a host")
		}
		host := u.Hostname()
		if ip := net.ParseIP(host); ip != nil {
			if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() {
				return nil
			}
			return fmt.Errorf("http:// is only allowed for loopback/private targets (use https)")
		}
		ips, err := net.LookupIP(host)
		if err != nil || len(ips) == 0 {
			return fmt.Errorf("http host %q does not resolve", host)
		}
		for _, ip := range ips {
			if !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast() {
				return fmt.Errorf("http host %q resolves to a public address (use https)", host)
			}
		}
		return nil
	default:
		return fmt.Errorf("url scheme must be https (or http for loopback/private targets)")
	}
}

// ---------------------------------------------------------------------------
// state (persisted through the binding record's channel state blob)
// ---------------------------------------------------------------------------

type webhookFailure struct {
	At         string `json:"at"`
	Mailbox    string `json:"mailbox"`
	DeliveryID string `json:"deliveryId"`
	Attempt    int    `json:"attempt"`
	Error      string `json:"error"`
}

type webhookStats struct {
	LastSuccessAt    string `json:"lastSuccessAt,omitempty"`
	LastFailureAt    string `json:"lastFailureAt,omitempty"`
	BatchesDelivered int    `json:"batchesDelivered"`
	BatchesAbandoned int    `json:"batchesAbandoned"`
}

type webhookState struct {
	Watermarks map[string]string `json:"watermarks,omitempty"`
	Failures   []webhookFailure  `json:"failures,omitempty"`
	Stats      *webhookStats     `json:"stats,omitempty"`
}

func (s *webhookState) stats() *webhookStats {
	if s.Stats == nil {
		s.Stats = &webhookStats{}
	}
	return s.Stats
}

func (s *webhookState) watermark(mailbox string) string {
	if s.Watermarks == nil {
		return ""
	}
	return s.Watermarks[mailbox]
}

func (s *webhookState) setWatermark(mailbox, mailID string) {
	if s.Watermarks == nil {
		s.Watermarks = map[string]string{}
	}
	s.Watermarks[mailbox] = mailID
}

func (s *webhookState) recordFailure(f webhookFailure) {
	s.Failures = append(s.Failures, f)
	if len(s.Failures) > 200 {
		s.Failures = s.Failures[len(s.Failures)-200:]
	}
	s.stats().LastFailureAt = f.At
}

// ---------------------------------------------------------------------------
// channel type (static face)
// ---------------------------------------------------------------------------

type webhookChannelType struct{}

func (webhookChannelType) Type() string { return "webhook" }

func (webhookChannelType) ValidateConfig(cfg json.RawMessage) error {
	var c webhookConfig
	if len(cfg) == 0 || json.Unmarshal(cfg, &c) != nil {
		return fmt.Errorf("config must be a JSON object")
	}
	if strings.TrimSpace(c.URL) == "" {
		return fmt.Errorf("url is required")
	}
	if len(c.Secret) < 8 {
		return fmt.Errorf("secret must be at least 8 characters")
	}
	if err := validateWebhookURL(c.URL); err != nil {
		return err
	}
	if len(c.Headers) > 16 {
		return fmt.Errorf("too many headers (max 16)")
	}
	for k, v := range c.Headers {
		if !headerNameRe.MatchString(k) || reservedWebhookHeaders[strings.ToLower(k)] {
			return fmt.Errorf("invalid or reserved header %q", k)
		}
		if len(v) > 512 {
			return fmt.Errorf("header %q value too long (max 512 bytes)", k)
		}
	}
	return nil
}

// Describe renders a secret-free summary for listings.
func (webhookChannelType) Describe(cfg, state json.RawMessage) string {
	var c webhookConfig
	_ = json.Unmarshal(cfg, &c)
	var st webhookState
	_ = json.Unmarshal(state, &st)
	sign := "signed"
	if !c.signed() {
		sign = "unsigned"
	}
	s := fmt.Sprintf("webhook %s (%s", c.URL, sign)
	if len(c.Headers) > 0 {
		s += fmt.Sprintf(", %d static header(s)", len(c.Headers))
	}
	s += ")"
	if st.Stats != nil {
		s += fmt.Sprintf(" — delivered=%d abandoned=%d", st.Stats.BatchesDelivered, st.Stats.BatchesAbandoned)
	}
	if n := len(st.Watermarks); n > 0 {
		s += fmt.Sprintf(", watermarks=%d", n)
	}
	if len(st.Failures) > 0 {
		last := st.Failures[len(st.Failures)-1]
		s += fmt.Sprintf(", last failure %s", last.At)
	}
	return s
}

func (webhookChannelType) NewInstance() ChannelInstance {
	inst := &webhookInstance{
		D:        10 * time.Second, // delay window (coalesce a wave)
		M:        45 * time.Second, // min interval between calls
		Timeout:  10 * time.Second, // per-attempt timeout
		Backoffs: []time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute, 30 * time.Minute},
	}
	if webhookTestTimings != nil {
		webhookTestTimings(inst)
	} else if os.Getenv("PI_MAILBOXD_WEBHOOK_FAST") != "" {
		// test escape hatch (core-test / smoke drive the real binary):
		// D/M/backoff in milliseconds so the JS suites can observe POSTs
		// without waiting the production pacing
		inst.D = 30 * time.Millisecond
		inst.M = 40 * time.Millisecond
		inst.Timeout = 2 * time.Second
		inst.Backoffs = []time.Duration{20 * time.Millisecond, 20 * time.Millisecond, 20 * time.Millisecond, 20 * time.Millisecond}
	}
	return inst
}

// webhookTestTimings, when non-nil, overrides instance defaults (tests only;
// nil in production).
var webhookTestTimings func(*webhookInstance)

// ---------------------------------------------------------------------------
// instance (per binding)
// ---------------------------------------------------------------------------

// mailboxRun is one target mailbox's delivery round state.
type mailboxRun struct {
	mailbox    string // canonical name
	pending    []string
	deliveryID string // current round; "" when idle
	attempt    int    // failed attempts this round
	timer      *time.Timer
	inFlight   bool
}

type webhookInstance struct {
	// timing knobs (test-overridable; defaults above)
	D        time.Duration
	M        time.Duration
	Timeout  time.Duration
	Backoffs []time.Duration
	Jitter   float64

	mu          sync.Mutex
	env         ChannelEnv
	b           BindingSnapshot
	cfg         webhookConfig
	state       webhookState
	runs        map[string]*mailboxRun
	nextAllowed time.Time
	stopped     bool
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

func (w *webhookInstance) Start(env ChannelEnv, b BindingSnapshot) error {
	var cfg webhookConfig
	if err := json.Unmarshal(b.Config, &cfg); err != nil {
		return fmt.Errorf("webhook config: %v", err)
	}
	if len(b.State) > 0 {
		_ = json.Unmarshal(b.State, &w.state)
	}
	w.env = env
	w.b = b
	w.cfg = cfg
	w.runs = map[string]*mailboxRun{}
	w.ctx, w.cancel = context.WithCancel(context.Background())
	// startup catch-up: deliver everything past the watermarks (the
	// "restart does not lose mail" guarantee; queued retries are in-memory
	// and die with the process, the watermark scan covers them)
	lost := map[string]bool{}
	for _, l := range b.Lost {
		lost[l] = true
	}
	for _, t := range b.Targets {
		if lost[t] {
			continue
		}
		mails, err := env.ScanAfter(b.Owner, t, w.state.watermark(t))
		if err != nil {
			continue // project not loadable (no owner root); skip quietly
		}
		if len(mails) > 0 {
			ids := make([]string, len(mails))
			for i, m := range mails {
				ids[i] = m.ID
			}
			w.enqueue(t, ids, time.Duration(0)) // catch-up posts without the D wait
		}
	}
	return nil
}

func (w *webhookInstance) Stop() {
	w.mu.Lock()
	if w.stopped {
		w.mu.Unlock()
		return
	}
	w.stopped = true
	for _, r := range w.runs {
		if r.timer != nil {
			r.timer.Stop()
			r.timer = nil
		}
	}
	cancel := w.cancel
	w.mu.Unlock()
	if cancel != nil {
		cancel() // abort in-flight POSTs
	}
	w.wg.Wait()
	w.saveState()
}

func (w *webhookInstance) OnMailArrived(_ BindingSnapshot, mailbox string, mailIDs []string) {
	w.enqueue(mailbox, mailIDs, w.D)
}

func (w *webhookInstance) OnOwnerGained(_ BindingSnapshot, mailbox string) {
	// (re)claimed: deliver everything the watermark has not covered
	mails, err := w.env.ScanAfter(w.b.Owner, mailbox, w.state.watermark(mailbox))
	if err != nil {
		return
	}
	if len(mails) > 0 {
		ids := make([]string, len(mails))
		for i, m := range mails {
			ids[i] = m.ID
		}
		w.enqueue(mailbox, ids, 0)
	}
}

func (w *webhookInstance) OnOwnerLost(_ BindingSnapshot, mailbox string) {
	w.mu.Lock()
	if w.stopped {
		w.mu.Unlock()
		return
	}
	if r := w.runs[mailbox]; r != nil {
		if r.timer != nil {
			r.timer.Stop()
		}
		delete(w.runs, mailbox)
	}
	w.state.recordFailure(webhookFailure{
		At:      w.env.Now().UTC().Format(timeStampLayout),
		Mailbox: mailbox,
		Error:   "owner lost (session took the mailbox over)",
	})
	w.mu.Unlock()
	w.saveState()
}

// enqueue adds mail ids to a mailbox's pending set and arms the delivery
// timer if the mailbox is idle. delay is the wait before the POST (D for
// live arrivals, 0 for catch-up); the M gate applies on top.
func (w *webhookInstance) enqueue(mailbox string, mailIDs []string, delay time.Duration) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return
	}
	r := w.runs[mailbox]
	if r == nil {
		r = &mailboxRun{mailbox: mailbox}
		w.runs[mailbox] = r
	}
	r.pending = append(r.pending, mailIDs...)
	if r.timer != nil || r.inFlight {
		return // round already armed: the ids merge into it
	}
	if r.deliveryID == "" {
		r.deliveryID = "dlv" + newShortID()
		r.attempt = 0
	}
	w.armTimerLocked(r, delay)
}

// armTimerLocked schedules the next POST attempt, honoring the M gate and
// jitter. No-ops when stopped (a successful POST still records its
// watermark; it just must not schedule further rounds). Callers hold w.mu.
func (w *webhookInstance) armTimerLocked(r *mailboxRun, delay time.Duration) {
	if w.stopped {
		return
	}
	at := w.env.Now().Add(delay)
	if w.nextAllowed.After(at) {
		at = w.nextAllowed
	}
	if w.Jitter > 0 && delay > 0 {
		at = at.Add(time.Duration(float64(delay) * w.Jitter * rand.Float64()))
	}
	d := time.Until(at)
	if d < 0 {
		d = 0
	}
	mailbox := r.mailbox
	if r.timer != nil {
		r.timer.Stop()
	}
	r.timer = time.AfterFunc(d, func() { w.deliver(mailbox) })
}

// deliver is the timer callback: one POST attempt for the mailbox's round.
func (w *webhookInstance) deliver(mailbox string) {
	w.wg.Add(1)
	defer w.wg.Done()
	w.mu.Lock()
	if w.stopped {
		w.mu.Unlock()
		return
	}
	r := w.runs[mailbox]
	if r == nil || r.inFlight {
		w.mu.Unlock()
		return
	}
	if len(r.pending) == 0 { // nothing left (e.g. owner lost raced us)
		r.deliveryID = ""
		r.attempt = 0
		r.timer = nil
		w.mu.Unlock()
		return
	}
	r.timer = nil
	r.inFlight = true
	batch := append([]string(nil), r.pending...)
	deliveryID := r.deliveryID
	attempt := r.attempt + 1
	w.mu.Unlock()

	err := w.postBatch(mailbox, deliveryID, batch)

	w.mu.Lock()
	r = w.runs[mailbox]
	if r == nil { // owner lost while in flight
		w.mu.Unlock()
		return
	}
	r.inFlight = false
	if err == nil {
		// success: advance the watermark past the batch, keep whatever
		// arrived during the POST for the next round. This runs EVEN when
		// stopped: a completed POST must be recorded, or a restart would
		// redeliver the batch.
		w.markDeliveredLocked(r, batch)
		w.mu.Unlock()
		w.saveState()
		return
	}
	if w.stopped {
		// aborted by Stop (ctx cancel): leave the batch pending; the
		// watermark did not advance, so the restart catch-up re-finds it
		w.mu.Unlock()
		return
	}
	w.state.recordFailure(webhookFailure{
		At:         w.env.Now().UTC().Format(timeStampLayout),
		Mailbox:    mailbox,
		DeliveryID: deliveryID,
		Attempt:    attempt,
		Error:      err.Error(),
	})
	if attempt >= len(w.Backoffs)+1 {
		// circuit-abandon: the batch is dropped and recorded; NOT a
		// permanent disable — the next arrival starts a fresh round
		w.state.stats().BatchesAbandoned++
		r.pending = nil
		r.deliveryID = ""
		r.attempt = 0
		w.mu.Unlock()
		w.saveState()
		return
	}
	r.attempt = attempt
	w.armTimerLocked(r, w.Backoffs[attempt-1])
	w.mu.Unlock()
	w.saveState()
}

// markDeliveredLocked updates watermarks/stats and re-arms for leftovers.
// Callers hold w.mu.
func (w *webhookInstance) markDeliveredLocked(r *mailboxRun, batch []string) {
	// the batch is a prefix snapshot of pending
	if len(batch) <= len(r.pending) {
		r.pending = r.pending[len(batch):]
	} else {
		r.pending = nil
	}
	// watermark: the batch's newest mail (max createdAt); pending leftovers
	// stay pending for the next round
	newest := ""
	var newestNS int64 = -1
	if mails, err := w.env.FetchMails(w.b.Owner, r.mailbox, batch); err == nil {
		for _, m := range mails {
			if m.NS > newestNS {
				newestNS = m.NS
				newest = m.ID
			}
		}
	}
	if newest != "" {
		w.state.setWatermark(r.mailbox, newest)
	}
	w.state.stats().LastSuccessAt = w.env.Now().UTC().Format(timeStampLayout)
	w.state.stats().BatchesDelivered++
	w.nextAllowed = w.env.Now().Add(w.M)
	if len(r.pending) > 0 {
		r.deliveryID = "dlv" + newShortID()
		r.attempt = 0
		w.armTimerLocked(r, w.D)
	} else {
		r.deliveryID = ""
		r.attempt = 0
	}
}

// ---------------------------------------------------------------------------
// payload + HTTP
// ---------------------------------------------------------------------------

type payloadMail struct {
	ID         string `json:"id"`
	From       string `json:"from"`
	Subject    string `json:"subject"`
	Snippet    string `json:"snippet"`
	ReceivedAt string `json:"receivedAt"`
}

type batchPayload struct {
	Event       string        `json:"event"`
	Version     int           `json:"version"`
	BindingID   string        `json:"bindingId"`
	DeliveryID  string        `json:"deliveryId"`
	Mailbox     string        `json:"mailbox"`
	MailCount   int           `json:"mailCount"`
	Earliest    string        `json:"earliest,omitempty"`
	Latest      string        `json:"latest,omitempty"`
	Mails       []payloadMail `json:"mails"`
	Truncated   bool          `json:"truncated"`
	UnreadCount int           `json:"unreadCount"`
}

const (
	payloadMaxMails = 20
	snippetMaxRunes = 200
)

func snippet(body string) string {
	s := strings.Join(strings.Fields(body), " ")
	runes := []rune(s)
	if len(runes) > snippetMaxRunes {
		return string(runes[:snippetMaxRunes]) + "…"
	}
	return s
}

// postBatch fetches the batch's mails, builds the summary payload and
// performs one signed POST attempt.
func (w *webhookInstance) postBatch(mailbox, deliveryID string, batch []string) error {
	mails, err := w.env.FetchMails(w.b.Owner, mailbox, batch)
	if err != nil {
		return fmt.Errorf("fetch mails: %v", err)
	}
	// order by createdAt (oldest first) for a stable summary
	sort.Slice(mails, func(i, j int) bool {
		if mails[i].NS != mails[j].NS {
			return mails[i].NS < mails[j].NS
		}
		return mails[i].ID < mails[j].ID
	})
	p := batchPayload{
		Event:       "mail.batch",
		Version:     1,
		BindingID:   w.b.ID,
		DeliveryID:  deliveryID,
		Mailbox:     mailbox + "@" + w.b.Owner,
		MailCount:   len(mails),
		Mails:       []payloadMail{},
		UnreadCount: -1,
	}
	if len(mails) > 0 {
		p.Earliest = mails[0].CreatedAt
		p.Latest = mails[len(mails)-1].CreatedAt
	}
	// list the NEWEST mails, oldest-first within the list
	listed := mails
	if len(listed) > payloadMaxMails {
		listed = listed[len(listed)-payloadMaxMails:]
		p.Truncated = true
	}
	for _, m := range listed {
		p.Mails = append(p.Mails, payloadMail{
			ID:         m.ID,
			From:       m.From.Session + "@" + m.From.Project,
			Subject:    m.Subject,
			Snippet:    snippet(m.Body),
			ReceivedAt: m.CreatedAt,
		})
	}
	if n, err := w.env.UnreadCount(w.b.Owner, mailbox); err == nil {
		p.UnreadCount = n
	}
	body, err := json.Marshal(p)
	if err != nil {
		return err
	}
	// SSRF re-check before every POST (hostnames can be re-pointed)
	if err := validateWebhookURL(w.cfg.URL); err != nil {
		return err
	}
	return w.httpPost(body)
}

func (w *webhookInstance) httpPost(body []byte) error {
	ctx := w.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, w.Timeout)
	defer cancel()
	var resp *http.Response
	var err error
	if httpPOSTHook != nil {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, w.cfg.URL, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err = httpPOSTHook(req)
	} else {
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, w.cfg.URL, bytes.NewReader(body))
		if reqErr != nil {
			return reqErr
		}
		req.Header.Set("Content-Type", "application/json")
		// static headers (sorted for determinism), then the signature pair
		keys := make([]string, 0, len(w.cfg.Headers))
		for k := range w.cfg.Headers {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			req.Header.Set(k, w.cfg.Headers[k])
		}
		if w.cfg.signed() {
			ts := strconv.FormatInt(w.env.Now().Unix(), 10)
			mac := hmac.New(sha256.New, []byte(w.cfg.Secret))
			mac.Write([]byte(ts + "." + string(body)))
			req.Header.Set("X-Mailbox-Timestamp", ts)
			req.Header.Set("X-Mailbox-Signature", hex.EncodeToString(mac.Sum(nil)))
		}
		client := &http.Client{}
		resp, err = client.Do(req)
	}
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("http %d", resp.StatusCode)
	}
	return nil
}

// saveState persists the channel state blob (watermarks, failures, stats).
func (w *webhookInstance) saveState() {
	w.mu.Lock()
	data, err := json.Marshal(w.state)
	w.mu.Unlock()
	if err != nil {
		return
	}
	if w.env != nil {
		if err := w.env.SaveState(w.b.ID, data); err != nil {
			log.Printf("webhook save state: %v", err)
		}
	}
}
