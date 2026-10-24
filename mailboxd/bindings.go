package main

// bindings.go: the channel-binding layer.
//
// A binding ties mailboxes of ONE project (the owner) to a delivery channel
// (this release: webhook). The binding layer owns records, persistence,
// ownership arbitration and the arrival event tap; ALL delivery semantics
// (payload, coalescing, pacing, retry, catch-up) live in the channel
// implementation.
//
// Ownership model ("one mailbox, one owner"): a channel instance claims its
// targets exactly like a session claims a name — through the _origin system
// meta, using the reserved value "channel:<bindingId>". Session claims and
// binding claims are serialized per project by claimMu, so the existing
// session-side competition semantics apply unchanged:
//
//   - a channel never displaces an ONLINE session holder (mailbox_in_use);
//   - a channel may force-take a name held by an OFFLINE session (explicit
//     force on the binding op, user-confirmed);
//   - a session may always force-take a name from a channel (humans win over
//     automation; the binding's target is then marked lost and does not
//     auto-recover);
//   - binding delete/disable releases its targets (the _origin marker is
//     cleared; the mailbox file and mails stay).

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// channelOriginPrefix is the reserved _origin value namespace for channel
// holders ("channel:<bindingId>"). Origins are opaque strings compared for
// equality, so existing session-side code paths (name_held / force takeover)
// work against channel holders unchanged.
const channelOriginPrefix = "channel:"

func channelOrigin(bindingID string) string {
	return channelOriginPrefix + bindingID
}

// bindingIDOfOrigin returns the binding id when the origin marks a channel
// holder, else "".
func bindingIDOfOrigin(origin string) string {
	if strings.HasPrefix(origin, channelOriginPrefix) {
		return strings.TrimPrefix(origin, channelOriginPrefix)
	}
	return ""
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

// Binding is one persistent binding record. Config and State are opaque to
// the binding layer: Config is channel-defined (validated by the channel
// type), State is the channel instance's own persisted blob (watermarks,
// failure logs, ...), written through SaveState.
type Binding struct {
	ID        string          `json:"id"`
	Owner     string          `json:"owner"`
	OwnerRoot string          `json:"ownerRoot,omitempty"` // local mode: project root, for boot-time materialization
	Channel   string          `json:"channel"`
	Config    json.RawMessage `json:"config,omitempty"`
	State     json.RawMessage `json:"state,omitempty"`
	Targets   []string        `json:"targets"`        // canonical (lowercase) names in the owner project
	Lost      []string        `json:"lost,omitempty"` // targets taken over by sessions; no auto-recovery
	Enabled   bool            `json:"enabled"`
	CreatedAt string          `json:"createdAt"`
}

// BindingSnapshot is the immutable view handed to channel instances.
type BindingSnapshot struct {
	ID      string
	Owner   string
	Channel string
	Targets []string
	Lost    []string
	Config  json.RawMessage
	State   json.RawMessage
	Enabled bool
}

func bindingSnapshot(b *Binding) BindingSnapshot {
	s := BindingSnapshot{
		ID:      b.ID,
		Owner:   b.Owner,
		Channel: b.Channel,
		Targets: append([]string(nil), b.Targets...),
		Lost:    append([]string(nil), b.Lost...),
		Config:  append(json.RawMessage(nil), b.Config...),
		State:   append(json.RawMessage(nil), b.State...),
		Enabled: b.Enabled,
	}
	return s
}

// ---------------------------------------------------------------------------
// channel interfaces
// ---------------------------------------------------------------------------

// ChannelEnv is the narrow service surface a channel instance may use.
// Read-only mail access plus opaque state persistence; nothing else of the
// daemon leaks into channels.
type ChannelEnv interface {
	// FetchMails returns deep copies of the given mails (order follows ids).
	FetchMails(project, mailbox string, ids []string) ([]MailRecord, error)
	// ScanAfter returns the mailbox's mails strictly newer than afterID
	// (by the monotonic createdAt), OLDEST FIRST. Empty or unknown afterID
	// returns every mail. This is the catch-up primitive.
	ScanAfter(project, mailbox, afterID string) ([]MailRecord, error)
	// UnreadCount is the mailbox's current unread total (reconciliation aid).
	UnreadCount(project, mailbox string) (int, error)
	// SaveState persists the channel's opaque state blob with the binding
	// record (same journal, same self-heal semantics).
	SaveState(bindingID string, state json.RawMessage) error
	// Now is the daemon's clock (tests substitute).
	Now() time.Time
}

// ChannelType is the static, stateless face of a delivery channel: what the
// binding layer needs before any instance exists (validation, redacted
// summaries) plus the instance factory. Adding a channel = implementing this
// pair and registering in channelTypes — the binding layer, protocol and
// persistence do not change.
type ChannelType interface {
	Type() string
	// ValidateConfig checks a channel config blob (structure, SSRF rules,
	// required secrets, size caps). Must not mutate the blob.
	ValidateConfig(cfg json.RawMessage) error
	// Describe renders a REDACTED human summary of config+state for
	// listings. It must never include secrets.
	Describe(cfg, state json.RawMessage) string
	NewInstance() ChannelInstance
}

// ChannelInstance is one binding's live channel runtime. Created on binding
// add/enable/update, stopped on delete/disable/update. Every callback must
// be non-blocking (enqueue internally); the instance owns its own timers
// and goroutines.
type ChannelInstance interface {
	// Start boots the runtime: load state (inside the snapshot), run the
	// startup catch-up (ScanAfter past the persisted watermarks), arm
	// timers. Called once per instance.
	Start(env ChannelEnv, b BindingSnapshot) error
	// Stop tears the runtime down, flushing state via env.SaveState.
	Stop()
	// OnMailArrived reports new mail ids for an owned mailbox. May arrive
	// while a delivery round is in flight; channels coalesce at will.
	OnMailArrived(b BindingSnapshot, mailbox string, mailIDs []string)
	// OnOwnerGained: this binding just (re)claimed the mailbox.
	OnOwnerGained(b BindingSnapshot, mailbox string)
	// OnOwnerLost: a session took the mailbox over (the target is lost).
	OnOwnerLost(b BindingSnapshot, mailbox string)
}

// channelTypes registers the available channel implementations. Tests may
// inject a fake type; production code only reads this map.
var channelTypes = map[string]ChannelType{
	"webhook": webhookChannelType{},
}

// ---------------------------------------------------------------------------
// registry (journal persistence, store.go's appendLine/replay pattern)
// ---------------------------------------------------------------------------

// BindingRegistry persists bindings in a daemon-level JSONL journal
// (add/update carry the full record; delete removes). Replayed on boot;
// a torn last line is tolerated.
type BindingRegistry struct {
	mu       sync.Mutex
	path     string
	bindings map[string]*Binding
}

func NewBindingRegistry(path string) *BindingRegistry {
	return &BindingRegistry{path: path, bindings: map[string]*Binding{}}
}

type bindingPutEvent struct {
	T       string   `json:"t"`
	Binding *Binding `json:"binding"`
}

type bindingDeleteEvent struct {
	T  string `json:"t"`
	ID string `json:"id"`
}

// Load replays the journal. A corrupt line stops the replay (the record
// before it stands); callers log and continue — a fresh journal is not an
// error.
func (r *BindingRegistry) Load() error {
	data, err := os.ReadFile(r.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var env struct {
			T string `json:"t"`
		}
		if json.Unmarshal([]byte(line), &env) != nil {
			break // torn tail
		}
		switch env.T {
		case "binding_put":
			var ev bindingPutEvent
			if json.Unmarshal([]byte(line), &ev) != nil || ev.Binding == nil || ev.Binding.ID == "" {
				break
			}
			b := *ev.Binding
			r.bindings[b.ID] = &b
		case "binding_delete":
			var ev bindingDeleteEvent
			if json.Unmarshal([]byte(line), &ev) != nil {
				break
			}
			delete(r.bindings, ev.ID)
		default:
			break
		}
	}
	return nil
}

func (r *BindingRegistry) persist(line string) error {
	return appendLine(r.path, line)
}

// Put inserts or fully replaces a record (one journal line, full record).
func (r *BindingRegistry) Put(b *Binding) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.putLocked(b); err != nil {
		return err
	}
	cp := *b
	r.bindings[b.ID] = &cp
	return nil
}

func (r *BindingRegistry) putLocked(b *Binding) error {
	data, err := json.Marshal(bindingPutEvent{T: "binding_put", Binding: b})
	if err != nil {
		return err
	}
	return r.persist(string(data))
}

// SaveState replaces the channel-managed state blob of a record.
func (r *BindingRegistry) SaveState(id string, state json.RawMessage) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.bindings[id]
	if !ok {
		return fmt.Errorf("no such binding %s", id)
	}
	b.State = append(json.RawMessage(nil), state...)
	return r.putLocked(b)
}

// Delete removes a record.
func (r *BindingRegistry) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.bindings[id]; !ok {
		return fmt.Errorf("no such binding %s", id)
	}
	data, err := json.Marshal(bindingDeleteEvent{T: "binding_delete", ID: id})
	if err != nil {
		return err
	}
	if err := r.persist(string(data)); err != nil {
		return err
	}
	delete(r.bindings, id)
	return nil
}

// Get returns a copy, or nil.
func (r *BindingRegistry) Get(id string) *Binding {
	r.mu.Lock()
	defer r.mu.Unlock()
	if b, ok := r.bindings[id]; ok {
		cp := *b
		cp.Config = append(json.RawMessage(nil), b.Config...)
		cp.State = append(json.RawMessage(nil), b.State...)
		cp.Targets = append([]string(nil), b.Targets...)
		cp.Lost = append([]string(nil), b.Lost...)
		return &cp
	}
	return nil
}

// All returns copies of every record (sorted by id for stable listings).
func (r *BindingRegistry) All() []*Binding {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*Binding, 0, len(r.bindings))
	for _, b := range r.bindings {
		cp := *b
		cp.Config = append(json.RawMessage(nil), b.Config...)
		cp.State = append(json.RawMessage(nil), b.State...)
		cp.Targets = append([]string(nil), b.Targets...)
		cp.Lost = append([]string(nil), b.Lost...)
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ForOwner returns copies of one project's bindings.
func (r *BindingRegistry) ForOwner(owner string) []*Binding {
	var out []*Binding
	for _, b := range r.All() {
		if b.Owner == owner {
			out = append(out, b)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// ownership arbitration
// ---------------------------------------------------------------------------

// claimError carries a protocol error code for binding target claims.
type claimError struct {
	code    string
	message string
}

func (e *claimError) Error() string { return e.message }

// targetSpec is one target: the canonical identity plus the claimed spelling
// (display case), mirroring session claims.
type targetSpec struct {
	canonical string
	claimed   string
}

// claimTargets atomically claims mailboxes for a binding, under the project
// claim lock (serialized against session hellos). Rules:
//   - a target held by an ONLINE session       -> mailbox_in_use (refuse)
//   - a target held by another binding          -> mailbox_in_use (refuse)
//   - a target held by an OFFLINE session       -> name_held unless force
//   - a target already held by this binding     -> no-op
//   - a free target                             -> claim
//
// All-or-nothing: any refusal fails the whole call without side effects.
func (d *Daemon) claimTargets(proj *Project, bindingID string, targets []targetSpec, force bool) error {
	proj.claimMu.Lock()
	defer proj.claimMu.Unlock()

	var inUse, held []string
	toClaim := make([]targetSpec, 0, len(targets))
	for _, t := range targets {
		if online := proj.LookupOnline(t.canonical); online != nil {
			inUse = append(inUse, t.claimed)
			continue
		}
		origin := proj.Store.OriginOf(t.canonical)
		if origin == channelOrigin(bindingID) {
			continue // already ours
		}
		if otherID := bindingIDOfOrigin(origin); otherID != "" {
			if d.bindings.Get(otherID) != nil {
				inUse = append(inUse, fmt.Sprintf("%s (binding %s)", t.claimed, otherID))
				continue
			}
			// stale marker: the origin names a binding this daemon's journal
			// no longer knows (deleted journal, foreign daemon home). Treat it
			// as an offline holder — a confirmed force recovers the target
			// instead of wedging it forever.
			if !force {
				held = append(held, t.claimed)
				continue
			}
			toClaim = append(toClaim, t)
			continue
		}
		if origin != "" && !force {
			held = append(held, t.claimed)
			continue
		}
		toClaim = append(toClaim, t)
	}
	if len(inUse) > 0 {
		return &claimError{code: "mailbox_in_use",
			message: fmt.Sprintf("mailbox(es) held by an online holder, force cannot take them over: %s", strings.Join(inUse, ", "))}
	}
	if len(held) > 0 {
		return &claimError{code: "name_held",
			message: fmt.Sprintf("mailbox(es) held by another session (offline); retry with force to take them over: %s", strings.Join(held, ", "))}
	}
	for _, t := range toClaim {
		if err := proj.Store.EnsureSession(t.canonical); err != nil {
			return err
		}
		if err := proj.Store.UpdateMeta(t.canonical, map[string]string{
			"_named":  "1",
			"name":    t.claimed,
			"_case":   t.claimed,
			"_origin": channelOrigin(bindingID),
		}, nil); err != nil {
			return err
		}
		log.Printf("binding %s claimed mailbox %s", bindingID, t.canonical)
	}
	return nil
}

// releaseTargets clears this binding's ownership marker on the given
// mailboxes (keeping mails, name and display case). Idempotent.
func (d *Daemon) releaseTargets(proj *Project, bindingID string, targets []string) {
	proj.claimMu.Lock()
	defer proj.claimMu.Unlock()
	for _, t := range targets {
		if proj.Store.OriginOf(t) == channelOrigin(bindingID) {
			if err := proj.Store.UpdateMeta(t, nil, []string{"_origin"}); err != nil {
				log.Printf("binding %s release %s: %v", bindingID, t, err)
			} else {
				log.Printf("binding %s released mailbox %s", bindingID, t)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// daemon wiring
// ---------------------------------------------------------------------------

// bindingEnv implements ChannelEnv against the daemon's stores.
type bindingEnv struct {
	d         *Daemon
	bindingID string
}

func (e bindingEnv) project(projectID string) (*Project, error) {
	if p := e.d.projectByID(projectID); p != nil {
		return p, nil
	}
	return nil, fmt.Errorf("project %s not loaded", projectID)
}

func (e bindingEnv) FetchMails(project, mailbox string, ids []string) ([]MailRecord, error) {
	p, err := e.project(project)
	if err != nil {
		return nil, err
	}
	out := make([]MailRecord, 0, len(ids))
	for _, id := range ids {
		m, err := p.Store.Mail(mailbox, id)
		if err != nil {
			return nil, err
		}
		if m != nil {
			out = append(out, *m)
		}
	}
	return out, nil
}

func (e bindingEnv) ScanAfter(project, mailbox, afterID string) ([]MailRecord, error) {
	p, err := e.project(project)
	if err != nil {
		return nil, err
	}
	mails, err := p.Store.Inbox(mailbox) // newest first
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
	// keep strictly newer than the cursor (or everything when unknown),
	// then flip to oldest-first
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

func (e bindingEnv) UnreadCount(project, mailbox string) (int, error) {
	p, err := e.project(project)
	if err != nil {
		return 0, err
	}
	return p.Store.UnreadCount(mailbox)
}

func (e bindingEnv) SaveState(bindingID string, state json.RawMessage) error {
	return e.d.bindings.SaveState(bindingID, state)
}

func (e bindingEnv) Now() time.Time { return time.Now() }

// startChannels boots the binding layer: materialize owner projects, heal
// lost targets, start instances for enabled bindings.
func (d *Daemon) startChannels() {
	for _, b := range d.bindings.All() {
		d.ensureProjectForBinding(b)
		if !b.Enabled {
			continue
		}
		// boot-time heal: a target whose origin no longer marks us was
		// taken over before a crash could persist the loss
		changed := false
		healed := b
		for _, t := range b.Targets {
			if containsName(b.Lost, t) {
				continue
			}
			proj := d.projectByID(b.Owner)
			if proj == nil || proj.Store.OriginOf(t) != channelOrigin(b.ID) {
				healed.Lost = append(healed.Lost, t)
				changed = true
				log.Printf("binding %s: target %s lost (origin mismatch at boot)", b.ID, t)
			}
		}
		if changed {
			if err := d.bindings.Put(healed); err != nil {
				log.Printf("binding %s heal: %v", b.ID, err)
			}
			b = healed
		}
		d.startBindingInstance(b)
	}
}

// stopChannels flushes and tears down every live instance (shutdown path).
func (d *Daemon) stopChannels() {
	d.channelsMu.Lock()
	instances := make([]ChannelInstance, 0, len(d.channelInstances))
	for _, ch := range d.channelInstances {
		instances = append(instances, ch)
	}
	d.channelInstances = map[string]ChannelInstance{}
	d.channelsMu.Unlock()
	for _, ch := range instances {
		ch.Stop()
	}
}

// ensureProjectForBinding materializes the owner project at boot so the
// store (and cross-project sends to channel-owned mailboxes) work before
// any session from that project connects.
func (d *Daemon) ensureProjectForBinding(b *Binding) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.projects[b.Owner]; ok {
		return
	}
	var dir string
	if d.Remote {
		dir = filepath.Join(d.DataDir, b.Owner)
	} else {
		if b.OwnerRoot == "" {
			log.Printf("binding %s: no owner root recorded; project %s loads on first session", b.ID, b.Owner)
			return
		}
		dir = filepath.Join(b.OwnerRoot, ".pi", "mailbox")
	}
	store, err := NewStore(dir)
	if err != nil {
		log.Printf("binding %s project %s: %v", b.ID, b.Owner, err)
		return
	}
	p := &Project{ID: b.Owner, Store: store, online: map[string]*conn{}}
	if !d.Remote {
		p.RootPath = b.OwnerRoot
	}
	d.projects[b.Owner] = p
}

// startBindingInstance creates and starts the channel instance for a
// binding. The factory must exist (validated at add time; unknown types at
// boot — e.g. a future daemon downgrade — are skipped with a log).
func (d *Daemon) startBindingInstance(b *Binding) {
	ct, ok := channelTypes[b.Channel]
	if !ok {
		log.Printf("binding %s: unknown channel type %q; skipping", b.ID, b.Channel)
		return
	}
	inst := ct.NewInstance()
	env := bindingEnv{d: d, bindingID: b.ID}
	if err := inst.Start(env, bindingSnapshot(b)); err != nil {
		log.Printf("binding %s start: %v", b.ID, err)
		return
	}
	d.channelsMu.Lock()
	d.channelInstances[b.ID] = inst
	d.channelsMu.Unlock()
}

// stopBindingInstance stops the live instance for a binding, if any.
func (d *Daemon) stopBindingInstance(id string) {
	d.channelsMu.Lock()
	inst, ok := d.channelInstances[id]
	if ok {
		delete(d.channelInstances, id)
	}
	d.channelsMu.Unlock()
	if ok {
		inst.Stop()
	}
}

// channelInstance returns the live instance for a binding, or nil.
func (d *Daemon) channelInstance(id string) ChannelInstance {
	d.channelsMu.Lock()
	defer d.channelsMu.Unlock()
	return d.channelInstances[id]
}

// notifyBindingChannels hands a mail arrival to the owning channel
// instance. The store's _origin marker is authoritative; called after
// AppendSend, never blocking the send path.
func (d *Daemon) notifyBindingChannels(proj *Project, mailbox, mailID string) {
	if d.bindings == nil {
		return
	}
	bid := bindingIDOfOrigin(proj.Store.OriginOf(mailbox))
	if bid == "" {
		return
	}
	b := d.bindings.Get(bid)
	if b == nil || !b.Enabled || b.Owner != proj.ID || containsName(b.Lost, mailbox) {
		return
	}
	if inst := d.channelInstance(bid); inst != nil {
		inst.OnMailArrived(bindingSnapshot(b), mailbox, []string{mailID})
	}
}

// bindingOwnerLost marks a target lost after a session took it over and
// tells the live instance to drop it.
func (d *Daemon) bindingOwnerLost(proj *Project, bindingID, mailbox string) {
	b := d.bindings.Get(bindingID)
	if b == nil || b.Owner != proj.ID {
		return
	}
	if !containsName(b.Lost, mailbox) {
		b.Lost = append(b.Lost, mailbox)
		sort.Strings(b.Lost)
		if err := d.bindings.Put(b); err != nil {
			log.Printf("binding %s lost %s: %v", bindingID, mailbox, err)
		}
	}
	if inst := d.channelInstance(bindingID); inst != nil {
		inst.OnOwnerLost(bindingSnapshot(d.bindings.Get(bindingID)), mailbox)
	}
}

// anyEnabledBindings reports whether at least one enabled binding exists
// (the daemon must not idle-exit then: channels are consumers too).
func (d *Daemon) anyEnabledBindings() bool {
	if d.bindings == nil {
		return false
	}
	for _, b := range d.bindings.All() {
		if b.Enabled {
			return true
		}
	}
	return false
}

// daemonCaps is the capability list advertised in the welcome (additive;
// old clients ignore it, new clients gate binding features on it).
func (d *Daemon) daemonCaps() []string {
	caps := []string{"bindings"}
	for t := range channelTypes {
		caps = append(caps, "channel:"+t)
	}
	sort.Strings(caps)
	return caps
}

func containsName(list []string, name string) bool {
	for _, n := range list {
		if n == name {
			return true
		}
	}
	return false
}

// foldTargets validates and canonicalizes a target list: valid mailbox
// names, deduped by canonical identity, capped. Returns the specs plus the
// canonical list.
func foldTargets(targets []string) ([]targetSpec, []string, error) {
	if len(targets) == 0 {
		return nil, nil, &claimError{code: "bad_target", message: "at least one target is required"}
	}
	if len(targets) > 16 {
		return nil, nil, &claimError{code: "bad_target", message: "too many targets (max 16)"}
	}
	seen := map[string]bool{}
	var specs []targetSpec
	for _, t := range targets {
		t = strings.TrimSpace(t)
		if err := ValidateMailboxName(t); err != nil {
			return nil, nil, &claimError{code: "bad_target", message: fmt.Sprintf("invalid target %q: %v", t, err)}
		}
		canonical := strings.ToLower(t)
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		specs = append(specs, targetSpec{canonical: canonical, claimed: t})
	}
	canonicals := make([]string, len(specs))
	for i, s := range specs {
		canonicals[i] = s.canonical
	}
	return specs, canonicals, nil
}

// newBindingID returns a channel-agnostic binding id ("b" + 10 base36).
func newBindingID() string { return "b" + newShortID() }

// bindingInfoView is the redacted wire view of a binding (no config echo:
// Describe renders a channel-defined, secret-free summary).
type bindingInfoView struct {
	ID        string   `json:"id"`
	Owner     string   `json:"owner"`
	Channel   string   `json:"channel"`
	Targets   []string `json:"targets"`
	Lost      []string `json:"lost,omitempty"`
	Enabled   bool     `json:"enabled"`
	CreatedAt string   `json:"createdAt,omitempty"`
	Describe  string   `json:"describe,omitempty"`
}

func bindingInfoViews(bs []*Binding) []bindingInfoView {
	out := make([]bindingInfoView, 0, len(bs))
	for _, b := range bs {
		v := bindingInfoView{
			ID:        b.ID,
			Owner:     b.Owner,
			Channel:   b.Channel,
			Targets:   b.Targets,
			Lost:      b.Lost,
			Enabled:   b.Enabled,
			CreatedAt: b.CreatedAt,
		}
		if len(b.Targets) == 0 {
			v.Targets = []string{}
		}
		if ct, ok := channelTypes[b.Channel]; ok {
			v.Describe = ct.Describe(b.Config, b.State)
		}
		out = append(out, v)
	}
	return out
}

// httpPOSTHook exists so tests can intercept outbound webhook requests
// without a live network; nil in production.
var httpPOSTHook func(req *http.Request) (*http.Response, error)
