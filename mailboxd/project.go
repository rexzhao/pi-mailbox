package main

import (
	"errors"
	"regexp"
	"sync"
)

var (
	metaKeyRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$`)
	tagRe     = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
)

// Project is the isolated state of one project (identified by its UUID).
type Project struct {
	ID         string
	Store      *Store
	RootPath   string // absolute project root (local mode only; informational)
	SessionDir string // pi session directory, for the lifecycle GC (local mode)

	mu     sync.Mutex
	online map[string]*conn // session id -> registered connection
}

// errSessionOnline is returned by DeleteMailboxIfOffline.
var errSessionOnline = errors.New("session is online")

// DeleteMailboxIfOffline deletes the session's mailbox, refusing while the
// session is connected (it would recreate state immediately). The online
// check and the deletion form one critical section under the project lock;
// the store lock is always acquired after the project lock (never the
// reverse), so this nesting is safe.
func (p *Project) DeleteMailboxIfOffline(sessionID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if c, ok := p.online[sessionID]; ok && c.isOpen() {
		return errSessionOnline
	}
	return p.Store.DeleteMailbox(sessionID)
}

func (p *Project) IsOnline(sessionID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	c, ok := p.online[sessionID]
	return ok && c.isOpen()
}

// Register binds a session to a connection, replacing any previous one.
func (p *Project) Register(sessionID string, c *conn) *conn {
	p.mu.Lock()
	defer p.mu.Unlock()
	old := p.online[sessionID]
	p.online[sessionID] = c
	return old
}

// Unregister removes a session binding if it still points at c.
func (p *Project) Unregister(sessionID string, c *conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.online[sessionID] == c {
		delete(p.online, sessionID)
	}
}

func (p *Project) OnlineCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, c := range p.online {
		if c.isOpen() {
			n++
		}
	}
	return n
}

// OnlineSnapshot returns the online sessions with their agent names.
func (p *Project) OnlineSnapshot() map[string]string {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make(map[string]string, len(p.online))
	for sid, c := range p.online {
		if c.isOpen() {
			out[sid] = c.agent
		}
	}
	return out
}

// validateMetaMap checks key/value shape. allowSystem permits `_`-prefixed
// keys (hello-time auto values); the user-facing meta op rejects them.
func validateMetaMap(m map[string]string, allowSystem bool) bool {
	if m == nil {
		return false
	}
	for k, v := range m {
		if !metaKeyRe.MatchString(k) {
			return false
		}
		if !allowSystem && len(k) > 0 && k[0] == '_' {
			return false
		}
		if len(v) > metaValueMax {
			return false
		}
	}
	return true
}

// parseTags parses the reserved "tags" value (comma-separated); nil when
// invalid.
func parseTags(value string, present bool) []string {
	if !present {
		return nil
	}
	var tags []string
	for _, t := range stringsSplitComma(value) {
		if t == "" {
			continue
		}
		if !tagRe.MatchString(t) {
			return nil
		}
		tags = append(tags, t)
	}
	if len(tags) > 32 {
		return nil
	}
	return tags
}

func stringsSplitComma(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == ',' {
			out = append(out, trimASCIISpace(cur))
			cur = ""
		} else {
			cur += string(r)
		}
	}
	out = append(out, trimASCIISpace(cur))
	return out
}

func trimASCIISpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}
