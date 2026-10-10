package main

// WebSocket connection handling and protocol operations, mirroring
// pi-mailbox's src/service.ts.

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

var gcGrace = time.Hour

// projectIDRe constrains project ids; the id becomes a directory name in
// remote mode, so it must not contain path separators or traversal.
var projectIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// secureTokenEqual compares tokens in constant time.
func secureTokenEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

type conn struct {
	daemon  *Daemon
	ws      *websocket.Conn
	writeMu sync.Mutex
	closeMu sync.Mutex
	closed  bool

	project *Project
	session string
	agent   string
}

func (c *conn) isOpen() bool {
	c.closeMu.Lock()
	defer c.closeMu.Unlock()
	return !c.closed
}

func (c *conn) send(v interface{}) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if !c.isOpen() {
		return
	}
	ctx, cancel := contextWithTimeout(5 * time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, encodeMsg(v)); err != nil {
		c.close()
	}
}

func (c *conn) close() {
	c.closeMu.Lock()
	defer c.closeMu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	// CloseNow: the close handshake would wait for the peer to echo the
	// close frame (up to seconds per connection); clients reconnect on TCP
	// close anyway
	c.ws.CloseNow()
}

// httpHandler dispatches between the WebSocket protocol and the read-only
// web UI (see api.go) on the same port.
func (d *Daemon) httpHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			d.serveHTTP(w, r)
			return
		}
		// browsers are not the client here; default origin policies are
		// irrelevant for non-browser WebSocket clients
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c := &conn{daemon: d, ws: ws}
		d.addConn(c)
		defer func() {
			d.removeConn(c)
			if c.project != nil {
				c.project.Unregister(c.session, c)
			}
			c.close()
		}()
		c.serveLoop()
	})
}

func (d *Daemon) addConn(c *conn) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.conns[c] = struct{}{}
}

func (d *Daemon) removeConn(c *conn) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.conns, c)
}

func (c *conn) serveLoop() {
	for {
		ctx, cancel := contextWithTimeout(24 * time.Hour)
		msgType, data, err := c.ws.Read(ctx)
		cancel()
		if err != nil {
			return
		}
		if msgType != websocket.MessageText {
			continue
		}
		var raw struct {
			T   string `json:"t"`
			Rid int    `json:"rid"`
		}
		if err := json.Unmarshal(data, &raw); err != nil {
			c.send(ErrorReply{T: "error", Code: "bad_json", Message: "unparsable message"})
			continue
		}
		if err := c.handleMessage(raw.T, raw.Rid, data); err != nil {
			rid := raw.Rid
			c.send(ErrorReply{T: "error", Rid: &rid, Code: "internal", Message: err.Error()})
		}
	}
}

func (c *conn) handleMessage(t string, rid int, data []byte) error {
	switch t {
	case "ping":
		c.send(PongMsg{T: "pong", Rid: rid, InstanceID: c.daemon.instanceID, ProtocolVersion: ProtocolVersion})
		return nil
	case "hello":
		return c.handleHello(rid, data)
	case "sessions":
		return c.handleSessions(rid, data)
	case "meta":
		return c.handleMeta(rid, data)
	case "send":
		return c.handleSend(rid, data)
	case "inbox":
		return c.handleInbox(rid, data)
	case "read":
		return c.handleRead(rid, data)
	case "cleanup":
		return c.handleCleanup(rid, data)
	case "shutdown":
		return c.handleShutdown(rid, data)
	default:
		ridCopy := rid
		c.send(ErrorReply{T: "error", Rid: &ridCopy, Code: "bad_msg", Message: "unknown message type"})
		return nil
	}
}

func (c *conn) handleHello(rid int, data []byte) error {
	var msg HelloMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		ridCopy := rid
		c.send(ErrorReply{T: "error", Rid: &ridCopy, Code: "bad_hello", Message: "unparsable hello"})
		return nil
	}
	if c.daemon.AuthToken != "" && !secureTokenEqual(msg.Token, c.daemon.AuthToken) {
		ridCopy := rid
		c.send(ErrorReply{T: "error", Rid: &ridCopy, Code: "unauthorized", Message: "invalid token"})
		c.close()
		return nil
	}
	if !sessionIDRe.MatchString(msg.Session) || !projectIDRe.MatchString(msg.Project) {
		ridCopy := rid
		c.send(ErrorReply{T: "error", Rid: &ridCopy, Code: "bad_hello", Message: "invalid project or session"})
		return nil
	}
	if msg.Session == webUserSession {
		ridCopy := rid
		c.send(ErrorReply{T: "error", Rid: &ridCopy, Code: "bad_hello", Message: "session id 'user' is reserved for the web UI"})
		return nil
	}

	proj, err := c.daemon.project(msg)
	if err != nil {
		ridCopy := rid
		c.send(ErrorReply{T: "error", Rid: &ridCopy, Code: "bad_project", Message: err.Error()})
		return nil
	}

	// same ws re-helloing as a different session: drop the old registration
	if c.project != nil && c.session != "" && c.session != msg.Session {
		c.project.Unregister(c.session, c)
	}
	c.project = proj
	c.session = msg.Session
	c.agent = msg.Agent
	if old := proj.Register(msg.Session, c); old != nil && old != c {
		// same session reconnected elsewhere: replace the old connection
		old.close()
	}

	// create the session file so offline delivery works from now on
	if err := proj.Store.EnsureSession(msg.Session); err != nil {
		log.Printf("ensure session %s: %v", msg.Session, err)
	}

	// registration-time meta merge happens atomically inside the store
	welcomeMeta, err := proj.Store.HelloMerge(msg.Session, msg.Agent, msg.Origin, msg.Meta)
	if err != nil {
		return err
	}

	welcome := WelcomeMsg{
		T:               "welcome",
		Rid:             rid,
		Project:         msg.Project,
		InstanceID:      c.daemon.instanceID,
		ProtocolVersion: ProtocolVersion,
		Meta:            welcomeMeta,
	}
	c.send(welcome)

	// backfill: report unread count immediately after registration
	if unread, err := proj.Store.UnreadCount(msg.Session); err == nil && unread > 0 {
		c.send(NotifyMsg{T: "notify", Unread: unread})
	}
	return nil
}

// project resolves (creating on first use) the project state for a hello.
func (d *Daemon) project(msg HelloMsg) (*Project, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if p, ok := d.projects[msg.Project]; ok {
		return p, nil
	}
	var dir string
	if d.Remote {
		// remote mode never trusts client-side paths: central storage only
		dir = filepath.Join(d.DataDir, msg.Project)
	} else {
		if msg.ProjectRoot == "" {
			return nil, fmt.Errorf("project root required in local mode")
		}
		if !filepath.IsAbs(msg.ProjectRoot) {
			return nil, fmt.Errorf("project root must be absolute")
		}
		dir = filepath.Join(msg.ProjectRoot, ".pi", "mailbox")
	}
	store, err := NewStore(dir)
	if err != nil {
		return nil, err
	}
	p := &Project{ID: msg.Project, Store: store, online: map[string]*conn{}}
	if !d.Remote {
		p.RootPath = msg.ProjectRoot
	}
	if !d.Remote && msg.SessionDir != "" {
		p.SessionDir = msg.SessionDir
	}
	d.projects[msg.Project] = p
	return p, nil
}

func (c *conn) requireRegistered() (*Project, error) {
	if c.project == nil {
		return nil, fmt.Errorf("hello first")
	}
	return c.project, nil
}

func (c *conn) handleSessions(rid int, data []byte) error {
	proj, err := c.requireRegistered()
	if err != nil {
		return c.errorReply(rid, "not_registered", err.Error())
	}
	var msg SessionsMsg
	json.Unmarshal(data, &msg)

	onlineAgents := proj.OnlineSnapshot()
	ids := map[string]bool{}
	for sid := range onlineAgents {
		ids[sid] = true
	}
	if msg.IncludeOffline {
		for _, id := range proj.Store.ListSessionIDs() {
			ids[id] = true
		}
	}
	var idList []string
	for sid := range ids {
		idList = append(idList, sid)
	}
	sort.Strings(idList) // deterministic output order
	sessions := []SessionInfo{}
	for _, sid := range idList {
		meta, err := proj.Store.MetaSnapshot(sid)
		if err != nil {
			continue
		}
		agent, online := onlineAgents[sid]
		info := SessionInfo{
			Session: sid,
			Project: proj.ID,
			Online:  online,
			Meta:    meta,
		}
		if online {
			info.Agent = agent
		} else {
			info.Agent = meta["_agent"]
		}
		if v, ok := meta["name"]; ok {
			info.Name = v
		}
		if v, ok := meta["tags"]; ok {
			if tags := parseTags(v, true); tags != nil {
				info.Tags = tags
			}
		}
		sessions = append(sessions, info)
	}
	c.send(SessionsReply{T: "sessions", Rid: rid, Sessions: sessions})
	return nil
}

func (c *conn) errorReply(rid int, code, message string) error {
	r := rid
	c.send(ErrorReply{T: "error", Rid: &r, Code: code, Message: message})
	return nil
}

func (c *conn) handleMeta(rid int, data []byte) error {
	proj, err := c.requireRegistered()
	if err != nil {
		return c.errorReply(rid, "not_registered", err.Error())
	}
	var msg MetaMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		return c.errorReply(rid, "bad_meta", "unparsable meta")
	}
	if msg.Set != nil && !validateMetaMap(msg.Set, false) {
		return c.errorReply(rid, "bad_meta", "invalid set")
	}
	if msg.Unset != nil {
		if len(msg.Unset) > metaMaxKeys {
			return c.errorReply(rid, "bad_meta", "invalid unset")
		}
		for _, k := range msg.Unset {
			if !metaKeyRe.MatchString(k) || strings.HasPrefix(k, "_") {
				return c.errorReply(rid, "bad_meta", "invalid unset")
			}
		}
	}
	if v, ok := msg.Set["tags"]; ok {
		if parseTags(v, true) == nil {
			return c.errorReply(rid, "bad_meta", "invalid tags value")
		}
	}
	setCount, unsetCount := len(msg.Set), len(msg.Unset)
	if setCount == 0 && unsetCount == 0 {
		return c.errorReply(rid, "bad_meta", "nothing to update")
	}
	var set map[string]string
	if setCount > 0 {
		set = msg.Set
	}
	var unset []string
	if unsetCount > 0 {
		unset = msg.Unset
	}
	if err := proj.Store.UpdateMeta(c.session, set, unset); err != nil {
		if err == ErrTooManyMetaKeys {
			return c.errorReply(rid, "bad_meta", fmt.Sprintf("too many meta keys (max %d)", metaMaxKeys))
		}
		return err
	}
	c.send(MetaReply{T: "meta", Rid: rid})
	return nil
}

func (c *conn) handleSend(rid int, data []byte) error {
	proj, err := c.requireRegistered()
	if err != nil {
		return c.errorReply(rid, "not_registered", err.Error())
	}
	var msg SendMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		return c.errorReply(rid, "bad_send", "unparsable send")
	}
	// message validity first (client-local properties); empty strings are
	// allowed, matching the TS implementation
	if len(msg.Subject) > subjectMax {
		return c.errorReply(rid, "bad_send", "subject too long")
	}
	if len(msg.Body) > bodyMax {
		return c.errorReply(rid, "bad_send", "body too large")
	}
	if msg.Refs != nil && len(msg.Refs) > refsMax {
		return c.errorReply(rid, "bad_send", "invalid refs")
	}
	for _, r := range msg.Refs {
		if r.Project == "" || r.Session == "" || r.Mail == "" ||
			len(r.Project) > 128 || len(r.Session) > 128 || len(r.Mail) > 128 {
			return c.errorReply(rid, "bad_send", "invalid refs")
		}
	}
	// target must be a registered project on this daemon; cross-project send
	// is allowed when the target project is also connected
	if !c.daemon.hasProject(msg.Target.Project) {
		return c.errorReply(rid, "external_target",
			fmt.Sprintf("target project %s is not served by this mailbox", msg.Target.Project))
	}
	targetProj := c.daemon.projectByID(msg.Target.Project)
	// offline delivery: the target's mailbox must exist
	if !targetProj.Store.HasMailbox(msg.Target.Session) {
		return c.errorReply(rid, "no_mailbox",
			fmt.Sprintf("target session %s has no mailbox (never registered)", msg.Target.Session))
	}
	mail := &MailRecord{
		ID:      newShortID(),
		From:    AgentRef{Project: proj.ID, Session: c.session},
		Subject: msg.Subject,
		Body:    msg.Body,
		Refs:    refsOrNil(msg.Refs),
	}
	if err := targetProj.Store.AppendSend(msg.Target.Session, mail); err != nil {
		return err
	}
	ref := MailRef{Project: msg.Target.Project, Session: msg.Target.Session, Mail: mail.ID}
	c.send(SentReply{T: "sent", Rid: rid, Mail: ref})
	// push updated unread count to the recipient (only when online)
	if tc := targetProj.lookupOnline(msg.Target.Session); tc != nil {
		if unread, err := targetProj.Store.UnreadCount(msg.Target.Session); err == nil {
			tc.send(NotifyMsg{T: "notify", Unread: unread})
		}
	}
	return nil
}

func (p *Project) lookupOnline(sessionID string) *conn {
	p.mu.Lock()
	defer p.mu.Unlock()
	c, ok := p.online[sessionID]
	if ok && c.isOpen() {
		return c
	}
	return nil
}

func (d *Daemon) hasProject(id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, ok := d.projects[id]
	return ok
}

func (d *Daemon) projectByID(id string) *Project {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.projects[id]
}

// inbox cursor: base64url({createdAt,id}), position-based continuation
type inboxCursor struct {
	CreatedAt string `json:"createdAt"`
	ID        string `json:"id"`
}

func encodeInboxCursor(m *MailRecord) string {
	data, _ := json.Marshal(inboxCursor{CreatedAt: m.CreatedAt, ID: m.ID})
	return base64.RawURLEncoding.EncodeToString(data)
}

func parseInboxCursor(s string) *inboxCursor {
	data, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil
	}
	var cur inboxCursor
	if json.Unmarshal(data, &cur) != nil || cur.ID == "" {
		return nil
	}
	if _, ok := parseCreatedAt(cur.CreatedAt); !ok {
		return nil // unparseable date: treat as an invalid cursor
	}
	return &cur
}

// sortsAtOrNewerThan: mail sorts at or newer than cursor in descending
// order, compared by parsed time so both timestamp formats order correctly.
func sortsAtOrNewerThan(m *MailRecord, cur *inboxCursor) bool {
	curNS, ok := parseCreatedAt(cur.CreatedAt)
	if !ok {
		return false
	}
	if m.NS != curNS {
		return m.NS > curNS
	}
	return m.ID >= cur.ID
}

func (c *conn) handleInbox(rid int, data []byte) error {
	proj, err := c.requireRegistered()
	if err != nil {
		return c.errorReply(rid, "not_registered", err.Error())
	}
	var msg InboxMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		return c.errorReply(rid, "bad_inbox", "unparsable inbox")
	}
	mails, err := proj.Store.Inbox(c.session)
	if err != nil {
		return err
	}
	// totals are mailbox-wide, before filtering
	total := len(mails)
	totalUnread := 0
	for _, m := range mails {
		if m.ReadAt == nil {
			totalUnread++
		}
	}
	filtered := mails
	if msg.Filter != nil {
		if msg.Filter.UnreadOnly {
			var out []*MailRecord
			for _, m := range filtered {
				if m.ReadAt == nil {
					out = append(out, m)
				}
			}
			filtered = out
		}
		if msg.Filter.Since != "" {
			if sinceNS, ok := parseCreatedAt(msg.Filter.Since); ok {
				var out []*MailRecord
				for _, m := range filtered {
					if m.NS > sinceNS {
						out = append(out, m)
					}
				}
				filtered = out
			}
		}
	}
	// position-based cursor continuation
	start := 0
	if msg.Cursor != "" {
		cur := parseInboxCursor(msg.Cursor)
		if cur == nil {
			return c.errorReply(rid, "bad_cursor", "invalid cursor")
		}
		for start < len(filtered) && sortsAtOrNewerThan(filtered[start], cur) {
			start++
		}
	}
	limit := msg.Limit
	if limit == 0 {
		limit = defaultInboxLimit
	} else if limit < 1 {
		limit = 1
	}
	if limit > maxInboxLimit {
		limit = maxInboxLimit
	}
	end := start + limit
	if end > len(filtered) {
		end = len(filtered)
	}
	page := filtered[start:end]
	reply := InboxReply{T: "inbox", Rid: rid, Total: total, TotalUnread: totalUnread, Mails: []MailRecord{}}
	for _, m := range page {
		reply.Mails = append(reply.Mails, *m)
	}
	if start+limit < len(filtered) && len(page) > 0 {
		reply.NextCursor = encodeInboxCursor(page[len(page)-1])
	}
	c.send(reply)
	return nil
}

// handleCleanup runs the orphan-mailbox GC on demand for the requested
// project (or all projects). Only local-mode projects with a session
// directory can be cleaned (remote mode has no pi session files to check).
func (c *conn) handleCleanup(rid int, data []byte) error {
	var msg CleanupMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		return c.errorReply(rid, "bad_cleanup", "unparsable cleanup")
	}
	if c.daemon.AuthToken != "" && !secureTokenEqual(msg.Token, c.daemon.AuthToken) {
		return c.errorReply(rid, "unauthorized", "invalid token")
	}

	results := []CleanupResult{}
	c.daemon.mu.Lock()
	projects := make([]*Project, 0, len(c.daemon.projects))
	for _, p := range c.daemon.projects {
		if msg.Project == "" || p.ID == msg.Project {
			projects = append(projects, p)
		}
	}
	c.daemon.mu.Unlock()

	for _, p := range projects {
		if p.SessionDir == "" {
			if msg.Project != "" {
				results = append(results, CleanupResult{Project: p.ID, Error: "no session directory (remote mode?)"})
			}
			continue
		}
		online := map[string]bool{}
		for sid := range p.OnlineSnapshot() {
			online[sid] = true
		}
		moved, err := p.Store.GCOrphans(p.SessionDir, gcGrace, online)
		result := CleanupResult{Project: p.ID, Moved: moved}
		if err != nil {
			result.Error = err.Error()
		}
		results = append(results, result)
		if moved > 0 {
			log.Printf("cleanup project %s: moved %d orphan mailbox(es)", p.ID, moved)
		}
	}
	c.send(CleanupReply{T: "cleanup", Rid: rid, Results: results})
	return nil
}

// handleShutdown gracefully stops the daemon: reply first, then cancel the
// run context so the unified cleanup path runs (close conns, clear registry,
// release the lock). Requires the token when the daemon has one.
func (c *conn) handleShutdown(rid int, data []byte) error {
	var msg ShutdownMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		return c.errorReply(rid, "bad_shutdown", "unparsable shutdown")
	}
	if c.daemon.AuthToken != "" && !secureTokenEqual(msg.Token, c.daemon.AuthToken) {
		return c.errorReply(rid, "unauthorized", "invalid token")
	}
	c.send(ShutdownAck{T: "shutdown_ack", Rid: rid})
	log.Printf("shutdown requested via protocol; stopping")
	c.daemon.shutdown()
	return nil
}

func (c *conn) handleRead(rid int, data []byte) error {
	_, err := c.requireRegistered()
	if err != nil {
		return c.errorReply(rid, "not_registered", err.Error())
	}
	var msg ReadMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		return c.errorReply(rid, "bad_read", "unparsable read")
	}
	if !c.daemon.hasProject(msg.Mail.Project) {
		return c.errorReply(rid, "external_target",
			fmt.Sprintf("mail %s belongs to another project", msg.Mail.Mail))
	}
	proj := c.daemon.projectByID(msg.Mail.Project)
	mail, err := proj.Store.Mail(msg.Mail.Session, msg.Mail.Mail)
	if err != nil {
		return err
	}
	if mail == nil {
		return c.errorReply(rid, "not_found", fmt.Sprintf("mail %s not found", msg.Mail.Mail))
	}
	// only the owner's read marks it read
	if msg.Mail.Session == c.session && mail.ReadAt == nil {
		at := time.Now().UTC().Format(timeStampLayout)
		if err := proj.Store.AppendRead(msg.Mail.Session, mail.ID, at); err != nil {
			return err
		}
		mail.ReadAt = &at // the copy was taken before the append
	}
	c.send(MailReply{T: "mail", Rid: rid, Mail: mail})
	return nil
}

func (d *Daemon) removeAllConns() {
	d.mu.Lock()
	conns := make([]*conn, 0, len(d.conns))
	for c := range d.conns {
		conns = append(conns, c)
	}
	d.mu.Unlock()
	for _, c := range conns {
		c.close()
	}
}

// contextWithTimeout is a small wrapper used by read/write deadlines.
func contextWithTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

// uuid ---------------------------------------------------------------------

func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// newShortID returns 10 random base36 chars. Mail ids only need uniqueness
// within one session mailbox, so random short ids suffice.
func newShortID() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}

// refsOrNil normalizes nil refs to an empty slice so the JSON wire format
// and the stored record always carry refs:[] (never null), matching the
// TS implementation's .
func refsOrNil(refs []MailRef) []MailRef {
	if refs == nil {
		return []MailRef{}
	}
	return refs
}
