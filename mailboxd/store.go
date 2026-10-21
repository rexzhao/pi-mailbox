package main

// Per-session JSONL mail storage, mirroring pi-mailbox's src/store.ts.
//
// Local mode: files live in <projectRoot>/.pi/mailbox/<sessionId>.jsonl.
// Remote mode: files live in <dataDir>/<projectId>/<sessionId>.jsonl.
// Event types: send / read / meta. Files are lazily loaded on first access
// and cached.
//
// Concurrency: all SessionState access happens under Store.mu. Public
// methods return deep copies; nothing outside this file ever sees the
// internal maps, so there is no read path that can race a write.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// mailboxNameRe is the grammar for named mailboxes (login names): 1-32
// chars, letter first, no dots (filename safety). Case is DISPLAY-only:
// the canonical identity (store keys, registration, comparisons) is the
// lowercased name; the claimed spelling rides the _case system meta.
var mailboxNameRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,31}$`)

// derivedIDRe is the shape of client-derived session ids (10 base36 chars);
// login names must not collide with it so addresses stay unambiguous.
var derivedIDRe = regexp.MustCompile(`^[0-9a-z]{10}$`)

// windowsReserved lists filenames Windows treats as devices; a mailbox
// file must never be named after one.
var windowsReserved = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// ValidateMailboxName checks a login name: grammar, no collision with the
// derived-id shape, no reserved ids (case-insensitively — the canonical
// identity is lowercase). Returns a user-facing reason.
func ValidateMailboxName(name string) error {
	if !mailboxNameRe.MatchString(name) {
		return fmt.Errorf("name must match [A-Za-z][A-Za-z0-9_-]{0,31} (1-32 chars, letter first)")
	}
	if derivedIDRe.MatchString(name) {
		return fmt.Errorf("name must not be 10 lowercase alphanumerics (reserved for derived session ids)")
	}
	if lower := strings.ToLower(name); lower == webUserSession || windowsReserved[lower] {
		return fmt.Errorf("name %q is reserved", name)
	}
	return nil
}

// globalNSMu/globalMaxNS make assigned mail timestamps strictly increasing
// across ALL mailboxes in this daemon: per-state monotonicity only breaks
// ties within one mailbox, and cross-mailbox ties (same clock tick) made
// thread/list ordering random.
var (
	globalNSMu  sync.Mutex
	globalMaxNS int64
)

func nextGlobalNS(now int64) int64 {
	globalNSMu.Lock()
	defer globalNSMu.Unlock()
	if now <= globalMaxNS {
		now = globalMaxNS + 1
	}
	globalMaxNS = now
	return now
}

// Claim carries login-time overrides for a named-mailbox registration.
type Claim struct {
	Name string // the mailbox name being claimed
	Tags string // comma-separated; empty keeps the existing tags
}

// webUserSession is the session id of the human user in the web UI. It is
// reserved: WS hello rejects it, and the lifecycle GC never collects it
// (it has no pi session file to check). Mail from the browser is written
// with this identity; agents can send and reply to it like any session.
const webUserSession = "user"

// timeStampLayout is fixed-width so lexicographic comparison matches
// chronological order for strings this daemon writes (RFC3339Nano trims
// trailing zeros and misorders). Historical TS records use millisecond
// precision; parse with time.RFC3339Nano, which accepts both.
const timeStampLayout = "2006-01-02T15:04:05.000000000Z07:00"

// nsMinTime/nsMaxTime bound the int64 UnixNano range (~1678-2262); outside
// it UnixNano overflows and comparisons invert.
var (
	nsMinTime = time.Date(1678, 1, 1, 0, 0, 0, 0, time.UTC)
	nsMaxTime = time.Date(2262, 1, 1, 0, 0, 0, 0, time.UTC)
)

// parseCreatedAt parses both the fixed-width nanosecond layout and the TS
// millisecond layout (time.RFC3339Nano accepts variable fractions).
// Timestamps outside the int64 nanosecond range are rejected.
func parseCreatedAt(s string) (int64, bool) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0, false
	}
	if t.Before(nsMinTime) || t.After(nsMaxTime) {
		return 0, false
	}
	return t.UnixNano(), true
}

type sendEvent struct {
	T    string      `json:"t"`
	Mail *MailRecord `json:"mail"`
}

type readEvent struct {
	T    string `json:"t"`
	Mail string `json:"mail"`
	At   string `json:"at"`
}

type metaEvent struct {
	T     string            `json:"t"`
	Set   map[string]string `json:"set"`
	Unset []string          `json:"unset"`
}

// SessionState is the in-memory state of one session's mailbox.
type SessionState struct {
	Mails map[string]*MailRecord
	// order preserves mail insertion order (mirrors JS Map insertion order)
	order []string
	// maxNS is the newest assigned createdAt (unix nanoseconds): new mails
	// get a strictly greater stamp, so createdAt alone is a total order
	maxNS int64
	Meta  map[string]string
}

// Store is the JSONL store for one project.
type Store struct {
	Dir string

	mu sync.Mutex
	// states is the in-memory mailbox state; ephemeral marks records that
	// never touch disk — with nameless logins rejected, that is exactly the
	// derived record of a named login (the _holds marker): its events apply
	// to the in-memory state only, and a daemon restart clears it.
	states    map[string]*SessionState
	ephemeral map[string]bool
}

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{Dir: dir, states: map[string]*SessionState{}, ephemeral: map[string]bool{}}, nil
}

func (s *Store) sessionFile(sessionID string) (string, error) {
	if !sessionIDRe.MatchString(sessionID) {
		return "", fmt.Errorf("invalid session id: %q", sessionID)
	}
	return filepath.Join(s.Dir, sessionID+".jsonl"), nil
}

func (st *SessionState) ensureLoaded(s *Store, sessionID string) error {
	if _, ok := s.states[sessionID]; ok {
		return nil
	}
	path, err := s.sessionFile(sessionID)
	if err != nil {
		return err
	}
	st.Mails = map[string]*MailRecord{}
	st.Meta = map[string]string{}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			s.states[sessionID] = st
			return nil
		}
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if !replayLine(st, line) {
			continue // tolerate torn last line
		}
	}
	s.states[sessionID] = st
	return nil
}

// state returns the (cached) state for a session, loading it if needed.
// Callers must hold s.mu. The returned state is only safe under s.mu.
func (s *Store) state(sessionID string) (*SessionState, error) {
	if st, ok := s.states[sessionID]; ok {
		return st, nil
	}
	st := &SessionState{}
	if err := st.ensureLoaded(s, sessionID); err != nil {
		return nil, err
	}
	return s.states[sessionID], nil
}

// MarkEphemeral flags a mailbox as never-persisted: every event for it
// applies to the in-memory state only (no JSONL, no file creation). Used
// for unnamed (derived) mailboxes — they die with the connection.
func (s *Store) MarkEphemeral(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ephemeral[sessionID] = true
}

// IsDerivedRecord reports whether the id resolves to a derived record:
// a state with _origin but no _named marker — the in-memory _holds
// bookkeeping of a named login, or a legacy pre-nameless file. Such a
// record is not a mailbox: nothing would ever read mail sent to it.
func (s *Store) IsDerivedRecord(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state(sessionID)
	if err != nil {
		return false
	}
	return st.Meta["_origin"] != "" && st.Meta["_named"] == ""
}

// persistLine appends an event line unless the mailbox is ephemeral.
// Callers must hold s.mu (same contract as the state accessors).
func (s *Store) persistLine(sessionID, path, line string) error {
	if s.ephemeral[sessionID] {
		return nil
	}
	return appendLine(path, line)
}

func applyMeta(st *SessionState, set map[string]string, unset []string) {
	for k, v := range set {
		st.Meta[k] = v
	}
	for _, k := range unset {
		delete(st.Meta, k)
	}
}

func appendLine(path, line string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(line + "\n")
	return err
}

// copyMail deep-copies a mail record.
func copyMail(m *MailRecord) *MailRecord {
	out := *m
	if m.ReadAt != nil {
		at := *m.ReadAt
		out.ReadAt = &at
	}
	if m.Refs != nil {
		out.Refs = make([]MailRef, len(m.Refs))
		copy(out.Refs, m.Refs)
	}
	return &out
}

// AppendSend stores a mail for the target session, stamping it with a
// strictly monotonic createdAt (one tick past the newest mail in that
// mailbox when the clock did not advance).
func (s *Store) AppendSend(sessionID string, mail *MailRecord) error {
	path, err := s.sessionFile(sessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state(sessionID)
	if err != nil {
		return err
	}
	ns := nextGlobalNS(time.Now().UnixNano())
	if ns <= st.maxNS {
		ns = st.maxNS + 1
	}
	st.maxNS = ns
	mail.NS = ns
	mail.CreatedAt = time.Unix(0, ns).UTC().Format(timeStampLayout)
	if _, exists := st.Mails[mail.ID]; !exists {
		st.order = append(st.order, mail.ID)
	}
	st.Mails[mail.ID] = mail
	data, _ := json.Marshal(map[string]interface{}{"t": "send", "mail": mail})
	return s.persistLine(sessionID, path, string(data))
}

// AppendRead marks a mail read.
func (s *Store) AppendRead(sessionID, mailID, at string) error {
	path, err := s.sessionFile(sessionID)
	if err != nil {
		return err
	}
	data, _ := json.Marshal(map[string]interface{}{"t": "read", "mail": mailID, "at": at})
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.persistLine(sessionID, path, string(data)); err != nil {
		return err
	}
	st, err := s.state(sessionID)
	if err != nil {
		return err
	}
	if m, ok := st.Mails[mailID]; ok && m.ReadAt == nil {
		m.ReadAt = &at
	}
	return nil
}

// ErrTooManyMetaKeys is returned when a meta update would grow the user-key
// set beyond the cap.
var ErrTooManyMetaKeys = fmt.Errorf("too many meta keys")

// UpdateMeta validates caps against the current state and applies a meta
// update atomically (under the store lock).
func (s *Store) UpdateMeta(sessionID string, set map[string]string, unset []string) error {
	path, err := s.sessionFile(sessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state(sessionID)
	if err != nil {
		return err
	}
	// reject only when the update would grow beyond the cap (user keys only)
	next := map[string]bool{}
	for k := range st.Meta {
		if !strings.HasPrefix(k, "_") {
			next[k] = true
		}
	}
	for k := range set {
		if !strings.HasPrefix(k, "_") {
			next[k] = true
		}
	}
	for _, k := range unset {
		delete(next, k)
	}
	current := 0
	for k := range st.Meta {
		if !strings.HasPrefix(k, "_") {
			current++
		}
	}
	if len(next) > metaMaxKeys && len(next) > current {
		return ErrTooManyMetaKeys
	}
	ev := map[string]interface{}{"t": "meta"}
	if set != nil {
		ev["set"] = set
	}
	if unset != nil {
		ev["unset"] = unset
	}
	data, _ := json.Marshal(ev)
	if err := s.persistLine(sessionID, path, string(data)); err != nil {
		return err
	}
	applyMeta(st, set, unset)
	return nil
}

// HelloMerge applies the registration-time meta merge (mirroring the TS
// implementation) and returns the resulting meta snapshot:
//   - `_agent` is first in the source map (cap-proof) and re-assigned after
//     the client merge (unspoofable); `_origin` (the client's full session
//     id, from hello.origin) follows the same rules
//   - system keys refresh only when the value changed
//   - user keys apply only when absent
//   - separate caps: user keys, system keys
//   - stored system keys absent from the accepted set are unset
func (s *Store) HelloMerge(sessionID, agent, origin string, meta map[string]string, claim *Claim) (map[string]string, error) {
	path, err := s.sessionFile(sessionID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state(sessionID)
	if err != nil {
		return nil, err
	}
	metaSource := map[string]string{"_agent": agent}
	if origin != "" {
		metaSource["_origin"] = origin
	}
	for k, v := range meta {
		// _named, _holds and _case are server-owned: only the claim path
		// may set them, so a client cannot forge a name binding or the
		// display case
		if k == "_named" || k == "_holds" || k == "_case" {
			continue
		}
		metaSource[k] = v
	}
	metaSource["_agent"] = agent
	if origin != "" {
		metaSource["_origin"] = origin
	}
	if claim != nil {
		// login semantics: identity overwrites beat the cookie-like merge
		metaSource["name"] = claim.Name
		metaSource["_named"] = "1"
		// the claimed spelling is display-only; the canonical identity is
		// lowercase. Last claim wins the display case.
		metaSource["_case"] = claim.Name
		if claim.Tags != "" {
			metaSource["tags"] = claim.Tags
		}
	}

	var set map[string]string
	sysKept := map[string]bool{}
	sysCount := 0
	for k, v := range metaSource {
		if !metaKeyRe.MatchString(k) || len(v) > metaValueMax {
			continue
		}
		if strings.HasPrefix(k, "_") {
			if sysCount >= metaMaxSystemKeys {
				continue
			}
			sysCount++
			sysKept[k] = true
			if st.Meta[k] != v {
				if set == nil {
					set = map[string]string{}
				}
				set[k] = v
			}
		} else if _, exists := st.Meta[k]; !exists || (claim != nil && (k == "name" || (k == "tags" && claim.Tags != ""))) {
			// user keys apply only when absent — except the login-time
			// identity overwrites (name always, tags when provided)
			if set == nil {
				set = map[string]string{}
			}
			set[k] = v
		}
	}
	// user-key cap: if the merged user keyset would exceed the cap, drop all
	// user keys from this hello
	userCount := 0
	for k := range st.Meta {
		if !strings.HasPrefix(k, "_") {
			userCount++
		}
	}
	for k := range set {
		if !strings.HasPrefix(k, "_") {
			userCount++
		}
	}
	if userCount > metaMaxKeys {
		for k := range set {
			if !strings.HasPrefix(k, "_") {
				delete(set, k)
			}
		}
	}
	// authoritative unset: stored system keys not kept by this hello.
	// _holds is exempt: it is the session's name binding, managed only by
	// the claim path (BindName/UnbindName) — a plain re-hello must not
	// wash it away. _case is claim-managed too, but it IS refreshed by
	// every claim (the welcome's mailbox field matches), so it needs no
	// exemption: an unset only happens if no claim occurs, which is
	// impossible (nameless hellos are rejected).
	sysKept["_holds"] = true
	var unset []string
	for k := range st.Meta {
		if strings.HasPrefix(k, "_") && !sysKept[k] {
			unset = append(unset, k)
		}
	}
	if len(set) > 0 || len(unset) > 0 {
		ev := map[string]interface{}{"t": "meta"}
		if set != nil {
			ev["set"] = set
		}
		if unset != nil {
			ev["unset"] = unset
		}
		data, _ := json.Marshal(ev)
		if err := s.persistLine(sessionID, path, string(data)); err != nil {
			return nil, err
		}
		applyMeta(st, set, unset)
	}
	return copyMeta(st.Meta), nil
}

func copyMeta(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// HasMailbox reports whether the session registered at least once.
func (s *Store) HasMailbox(sessionID string) bool {
	path, err := s.sessionFile(sessionID)
	if err != nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// in-memory states count (ephemeral mailboxes have no file but exist
	// while their session is connected)
	if _, ok := s.states[sessionID]; ok {
		return true
	}
	_, err = os.Stat(path)
	return err == nil
}

// EnsureSession creates the session file on first registration. Ephemeral
// mailboxes never get a file.
func (s *Store) EnsureSession(sessionID string) error {
	s.mu.Lock()
	eph := s.ephemeral[sessionID]
	s.mu.Unlock()
	if eph {
		return nil
	}
	path, err := s.sessionFile(sessionID)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	return f.Close()
}

// AllSessionIDs returns every mailbox id the store knows: file-backed
// (persisted, named accounts) plus in-memory-only ones (ephemeral unnamed
// mailboxes of connected sessions). Iteration order is unspecified.
func (s *Store) AllSessionIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := map[string]bool{}
	ids := make([]string, 0, len(s.states))
	for id := range s.states {
		seen[id] = true
		ids = append(ids, id)
	}
	for _, id := range s.ListSessionIDs() {
		if !seen[id] {
			ids = append(ids, id)
		}
	}
	return ids
}

// ListSessionIDs returns every session id with a mailbox file.
func (s *Store) ListSessionIDs() []string {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		return nil
	}
	var ids []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		id := strings.TrimSuffix(name, ".jsonl")
		if sessionIDRe.MatchString(id) {
			ids = append(ids, id)
		}
	}
	return ids
}

// Inbox returns deep copies of the session's mails, newest first, ordered
// by the parsed createdAt (works for both timestamp formats).
func (s *Store) Inbox(sessionID string) ([]*MailRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state(sessionID)
	if err != nil {
		return nil, err
	}
	mails := make([]*MailRecord, 0, len(st.order))
	for _, id := range st.order {
		if m, ok := st.Mails[id]; ok {
			mails = append(mails, copyMail(m))
		}
	}
	sort.SliceStable(mails, func(i, j int) bool {
		if mails[i].NS != mails[j].NS {
			return mails[i].NS > mails[j].NS
		}
		return mails[i].ID > mails[j].ID
	})
	return mails, nil
}

// Mail returns a deep copy of one mail, or nil when absent.
func (s *Store) Mail(sessionID, mailID string) (*MailRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state(sessionID)
	if err != nil {
		return nil, err
	}
	if m, ok := st.Mails[mailID]; ok {
		return copyMail(m), nil
	}
	return nil, nil
}

// MetaSnapshot returns a copy of the session's meta.
func (s *Store) MetaSnapshot(sessionID string) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state(sessionID)
	if err != nil {
		return nil, err
	}
	return copyMeta(st.Meta), nil
}

// HoldsOf returns the name this session's derived mailbox is bound to
// (the _holds marker); empty when it holds none.
func (s *Store) HoldsOf(sessionID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state(sessionID)
	if err != nil {
		return ""
	}
	return st.Meta["_holds"]
}

// BindName records the reverse login marker on the session's own derived
// mailbox: _holds (the claimed name) plus _origin (so the lifecycle GC keeps
// the record alive while the pi session lives). name == "" unbinds.
func (s *Store) BindName(sessionID, origin, name string) error {
	path, err := s.sessionFile(sessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state(sessionID)
	if err != nil {
		return err
	}
	// _holds is a canonical (lowercase) binding: names are case-insensitive
	name = strings.ToLower(name)
	set := map[string]string{}
	unset := []string{}
	if name != "" {
		if st.Meta["_holds"] != name {
			set["_holds"] = name
		}
		if origin != "" && st.Meta["_origin"] != origin {
			set["_origin"] = origin
		}
	} else if st.Meta["_holds"] != "" {
		unset = append(unset, "_holds")
	}
	if len(set) == 0 && len(unset) == 0 {
		return nil
	}
	ev := map[string]interface{}{"t": "meta"}
	if len(set) > 0 {
		ev["set"] = set
	}
	if len(unset) > 0 {
		ev["unset"] = unset
	}
	data, _ := json.Marshal(ev)
	if err := s.persistLine(sessionID, path, string(data)); err != nil {
		return err
	}
	applyMeta(st, set, unset)
	return nil
}

// OriginOf returns the stored _origin meta (the last holder's full session
// id); empty when the mailbox has none.
func (s *Store) OriginOf(sessionID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state(sessionID)
	if err != nil {
		return ""
	}
	return st.Meta["_origin"]
}

func (s *Store) UnreadCount(sessionID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state(sessionID)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, m := range st.Mails {
		if m.ReadAt == nil {
			n++
		}
	}
	return n, nil
}

// replayLine applies one JSONL event line to the state; returns false when
// the line is unparsable.
func replayLine(st *SessionState, line string) bool {
	var envelope struct {
		T string `json:"t"`
	}
	if json.Unmarshal([]byte(line), &envelope) != nil {
		return false
	}
	switch envelope.T {
	case "send":
		var ev sendEvent
		if json.Unmarshal([]byte(line), &ev) != nil || ev.Mail == nil {
			return false
		}
		if _, exists := st.Mails[ev.Mail.ID]; !exists {
			st.order = append(st.order, ev.Mail.ID)
			if ns, ok := parseCreatedAt(ev.Mail.CreatedAt); ok && ns > st.maxNS {
				st.maxNS = ns
			}
		}
		if ns, ok := parseCreatedAt(ev.Mail.CreatedAt); ok {
			ev.Mail.NS = ns
		}
		st.Mails[ev.Mail.ID] = ev.Mail
	case "read":
		var ev readEvent
		if json.Unmarshal([]byte(line), &ev) != nil {
			return false
		}
		if m, ok := st.Mails[ev.Mail]; ok {
			at := ev.At
			m.ReadAt = &at
		}
	case "meta":
		var ev metaEvent
		if json.Unmarshal([]byte(line), &ev) != nil {
			return false
		}
		applyMeta(st, ev.Set, ev.Unset)
	default:
		return false
	}
	return true
}

// DeleteMailbox removes a session's mailbox entirely: mails, meta, and the
// registration (ListSessionIDs is file-based, so the session disappears from
// listings). The file is hard-deleted on request; the pi session file in the
// session directory is never touched. Mails in other mailboxes keep their
// refs; those refs simply no longer resolve (they surface as orphan roots
// in thread listings).
func (s *Store) DeleteMailbox(sessionID string) error {
	path, err := s.sessionFile(sessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("no such mailbox")
		}
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	delete(s.states, sessionID)
	return nil
}
