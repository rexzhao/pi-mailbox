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

	mu     sync.Mutex
	states map[string]*SessionState
}

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{Dir: dir, states: map[string]*SessionState{}}, nil
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
	ns := time.Now().UnixNano()
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
	return appendLine(path, string(data))
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
	if err := appendLine(path, string(data)); err != nil {
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
	if err := appendLine(path, string(data)); err != nil {
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
func (s *Store) HelloMerge(sessionID, agent, origin string, meta map[string]string) (map[string]string, error) {
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
		metaSource[k] = v
	}
	metaSource["_agent"] = agent
	if origin != "" {
		metaSource["_origin"] = origin
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
		} else if _, exists := st.Meta[k]; !exists {
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
	// authoritative unset: stored system keys not kept by this hello
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
		if err := appendLine(path, string(data)); err != nil {
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
	_, err = os.Stat(path)
	return err == nil
}

// EnsureSession creates the session file on first registration.
func (s *Store) EnsureSession(sessionID string) error {
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

// GCOrphans moves mailbox files of sessions whose pi session file no longer
// exists into .trash/. The online set is snapshotted by the caller before
// taking the store lock, so no lock-order inversion is possible.
func (s *Store) GCOrphans(sessionDir string, grace time.Duration, onlineSnapshot map[string]bool) (int, error) {
	if sessionDir == "" {
		return 0, nil
	}
	sessionEntries, err := os.ReadDir(sessionDir)
	if err != nil {
		return 0, nil
	}
	var sessionFiles []string
	for _, e := range sessionEntries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			sessionFiles = append(sessionFiles, e.Name())
		}
	}
	if len(sessionFiles) == 0 {
		return 0, nil
	}
	alive := func(sessionID string) bool {
		// resolve the mailbox's origin (the client's full session id) for
		// the session-file check; fall back to the mailbox filename for
		// legacy/origin-less mailboxes
		origin := sessionID
		if st, err := s.state(sessionID); err == nil {
			if o := st.Meta["_origin"]; o != "" {
				origin = o
			}
		}
		suffix := "_" + origin + ".jsonl"
		for _, f := range sessionFiles {
			if strings.HasSuffix(f, suffix) {
				return true
			}
		}
		return false
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	files, err := os.ReadDir(s.Dir)
	if err != nil {
		return 0, err
	}
	moved := 0
	for _, entry := range files {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		sessionID := strings.TrimSuffix(name, ".jsonl")
		if onlineSnapshot[sessionID] || alive(sessionID) {
			continue
		}
		info, err := entry.Info()
		if err != nil || time.Since(info.ModTime()) < grace {
			continue
		}
		trashDir := filepath.Join(s.Dir, ".trash")
		if err := os.MkdirAll(trashDir, 0o755); err != nil {
			return moved, err
		}
		stamp := time.Now().UTC().Format("2006-01-02T15-04-05.000")
		dst := filepath.Join(trashDir, stamp+"_"+name)
		if err := os.Rename(filepath.Join(s.Dir, name), dst); err != nil {
			continue
		}
		delete(s.states, sessionID)
		moved++
	}
	return moved, nil
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
