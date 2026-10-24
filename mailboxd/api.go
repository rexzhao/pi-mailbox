package main

// api.go serves the read-only web UI and its JSON API on the daemon's HTTP
// port (the same server as the WebSocket protocol).
//
// Security model:
//   - With a token configured (remote mode, or an explicitly tokened local
//     daemon) every data endpoint requires "Authorization: Bearer <token>".
//     The token is the only defense needed: a DNS-rebinding attacker cannot
//     read the URL fragment that carries the token.
//   - Without a token (local loopback trust) the Host allowlist blocks DNS
//     rebinding (the attacker's domain never matches), and an Origin header
//     that disagrees with the Host is rejected.
//   - The static page itself is always served without a token: the browser
//     cannot send Authorization headers on a plain navigation, so the token
//     travels in the URL fragment and the page's JS moves it into headers.
//
// All handlers are strictly read-only: they never append events, so reading
// a mailbox through the API never marks mails as read.

import (
	"embed"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

//go:embed web
var webFS embed.FS

func (d *Daemon) serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	switch {
	case r.URL.Path == "/healthz":
		if !d.authorize(w, r) {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"t":               "healthz",
			"protocolVersion": ProtocolVersion,
			"instanceId":      d.instanceID,
		})
	case r.URL.Path == "/" || strings.HasPrefix(r.URL.Path, "/assets/"):
		d.serveStatic(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/"):
		if !d.authorize(w, r) {
			return
		}
		d.serveAPI(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

func (d *Daemon) serveStatic(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'")
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		http.Error(w, "embedded assets missing", http.StatusInternalServerError)
		return
	}
	http.FileServer(http.FS(sub)).ServeHTTP(w, r)
}

// authorize gates the data endpoints (/healthz and /api/*).
func (d *Daemon) authorize(w http.ResponseWriter, r *http.Request) bool {
	if d.AuthToken != "" {
		const prefix = "Bearer "
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, prefix) || !secureTokenEqual(strings.TrimPrefix(auth, prefix), d.AuthToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return false
		}
		return true
	}
	if !d.hostAllowed(hostOnly(r.Host)) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "host not allowed"})
		return false
	}
	return true
}

func (d *Daemon) serveAPI(w http.ResponseWriter, r *http.Request) {
	// the API is read-only with narrow exceptions: the web UI's own
	// sends/deletes, and the binding admin endpoints (same rules as the WS
	// protocol, another entry point)
	if r.Method != http.MethodGet &&
		!(r.Method == http.MethodPost && (r.URL.Path == "/api/send" || r.URL.Path == "/api/delete" ||
			r.URL.Path == "/api/bindings" || r.URL.Path == "/api/binding-add" ||
			r.URL.Path == "/api/binding-update" || r.URL.Path == "/api/binding-delete")) {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET only (POST /api/send, /api/delete, /api/binding-* excepted)"})
		return
	}
	// cross-site requests: an Origin that disagrees with the Host is rejected
	if origin := r.Header.Get("Origin"); origin != "" {
		rest := strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://")
		if rest != r.Host {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-origin rejected"})
			return
		}
	}
	switch {
	case r.URL.Path == "/api/info":
		d.apiInfo(w, r)
	case r.URL.Path == "/api/sessions":
		d.apiSessions(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/mailbox/"):
		d.apiMailbox(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/mail/"):
		d.apiMail(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/thread/"):
		d.apiThread(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/threads/"):
		d.apiThreads(w, r)
	case r.URL.Path == "/api/send":
		d.apiSend(w, r)
	case r.URL.Path == "/api/delete":
		d.apiDelete(w, r)
	case r.URL.Path == "/api/bindings" && r.Method == http.MethodPost:
		d.apiBindingsList(w, r)
	case r.URL.Path == "/api/binding-add" && r.Method == http.MethodPost:
		d.apiBindingAdd(w, r)
	case r.URL.Path == "/api/binding-update" && r.Method == http.MethodPost:
		d.apiBindingUpdate(w, r)
	case r.URL.Path == "/api/binding-delete" && r.Method == http.MethodPost:
		d.apiBindingDelete(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/binding"):
		// the admin endpoints exist, but not for this method (e.g. GET)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

// ---- binding admin endpoints -------------------------------------------------
//
// The same operations as the WS protocol's binding_* messages, through the
// same shared ops (bindingAddOp/...): management is entry-point agnostic.
// Auth follows the web API model (Bearer token when the daemon has one,
// loopback + Host allowlist otherwise); the "caller is the project" proof
// is the request's project id plus, in local mode, its project root — the
// same material a hello carries.

// bindingAdminRequest is the shared body shape of the four endpoints.
type bindingAdminRequest struct {
	Project     string          `json:"project"`
	ProjectRoot string          `json:"projectRoot,omitempty"`
	Channel     string          `json:"channel,omitempty"`
	Config      json.RawMessage `json:"config,omitempty"`
	Targets     []string        `json:"targets,omitempty"`
	ID          string          `json:"id,omitempty"`
	Enabled     *bool           `json:"enabled,omitempty"`
	Force       bool            `json:"force,omitempty"`
}

// decodeBindingAdmin parses the request body.
func decodeBindingAdmin(w http.ResponseWriter, r *http.Request) (*bindingAdminRequest, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "unreadable body"})
		return nil, false
	}
	var req bindingAdminRequest
	if json.Unmarshal(body, &req) != nil || req.Project == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "project is required"})
		return nil, false
	}
	return &req, true
}

// resolveAdminProject materializes the request's project (same rules as a
// hello: absolute root required in local mode; remote uses the data dir).
func (d *Daemon) resolveAdminProject(w http.ResponseWriter, req *bindingAdminRequest) (*Project, bool) {
	proj, err := d.project(HelloMsg{Project: req.Project, ProjectRoot: req.ProjectRoot})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_project", "message": err.Error()})
		return nil, false
	}
	return proj, true
}

// writeBindingOpError maps the shared ops' coded errors to HTTP responses.
func writeBindingOpError(w http.ResponseWriter, err error) {
	ce, ok := err.(*claimError)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal", "message": err.Error()})
		return
	}
	status := http.StatusBadRequest
	switch ce.code {
	case "mailbox_in_use", "name_held":
		status = http.StatusConflict
	case "not_found":
		status = http.StatusNotFound
	case "not_owner":
		status = http.StatusForbidden
	}
	writeJSON(w, status, map[string]string{"error": ce.code, "message": ce.message})
}

func (d *Daemon) apiBindingsList(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeBindingAdmin(w, r)
	if !ok {
		return
	}
	proj, ok := d.resolveAdminProject(w, req)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bindings": bindingInfoViews(d.bindings.ForOwner(proj.ID))})
}

func (d *Daemon) apiBindingAdd(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeBindingAdmin(w, r)
	if !ok {
		return
	}
	proj, ok := d.resolveAdminProject(w, req)
	if !ok {
		return
	}
	b, err := d.bindingAddOp(proj, req.Channel, req.Config, req.Targets, req.Force)
	if err != nil {
		writeBindingOpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"binding": bindingInfoViews([]*Binding{b})[0]})
}

func (d *Daemon) apiBindingUpdate(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeBindingAdmin(w, r)
	if !ok {
		return
	}
	proj, ok := d.resolveAdminProject(w, req)
	if !ok {
		return
	}
	b, err := d.bindingUpdateOp(proj, req.ID, req.Config, req.Targets, req.Enabled, req.Force)
	if err != nil {
		writeBindingOpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"binding": bindingInfoViews([]*Binding{b})[0]})
}

func (d *Daemon) apiBindingDelete(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeBindingAdmin(w, r)
	if !ok {
		return
	}
	proj, ok := d.resolveAdminProject(w, req)
	if !ok {
		return
	}
	b, err := d.bindingDeleteOp(proj, req.ID)
	if err != nil {
		writeBindingOpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"binding": bindingInfoViews([]*Binding{b})[0]})
}

func (d *Daemon) apiInfo(w http.ResponseWriter, _ *http.Request) {
	d.mu.Lock()
	projects := make([]*Project, 0, len(d.projects))
	for _, p := range d.projects {
		projects = append(projects, p)
	}
	d.mu.Unlock()
	sort.Slice(projects, func(i, j int) bool { return projects[i].ID < projects[j].ID })
	type webProject struct {
		ID   string `json:"id"`
		Host string `json:"host,omitempty"` // daemon hostname (local mode only)
		Path string `json:"path,omitempty"` // local mode only
	}
	out := make([]webProject, 0, len(projects))
	for _, p := range projects {
		wp := webProject{ID: p.ID}
		if p.RootPath != "" {
			wp.Host = d.host
			wp.Path = p.RootPath
		}
		out = append(out, wp)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"protocolVersion": ProtocolVersion,
		"instanceId":      d.instanceID,
		"remote":          d.Remote,
		"projects":        out,
	})
}

func (d *Daemon) apiSessions(w http.ResponseWriter, r *http.Request) {
	includeOffline := r.URL.Query().Get("includeOffline") == "1"
	// local mode: allow on-demand project loading, so identity-less
	// lookups (e.g. pi's /mailbox resume) work against a freshly spawned
	// daemon that no client has hello'd yet — the project's mailbox files
	// exist on disk but are not registered in memory. Loading only builds
	// the in-memory store from disk: no mailbox is created, nothing is
	// registered. Remote mode never trusts client paths.
	// When the project parameter is honored, the RESPONSE is also scoped
	// to it: the caller named a project, so returning every other
	// project's sessions is both surprising and a needless information
	// exposure. No parameter = all projects (the web UI, aggregation).
	// "project means what it says": scope whenever the project is KNOWN
	// (in memory — with or without a root supplied); projectRoot only
	// matters for the on-demand load of a project not yet in memory. An
	// unknown project whose load failed must NOT turn into "no sessions"
	// — the response falls back to unscoped rather than silently empty.
	filterProject := ""
	if !d.Remote {
		if pid := r.URL.Query().Get("project"); pid != "" && projectIDRe.MatchString(pid) {
			if root := r.URL.Query().Get("projectRoot"); root != "" {
				if _, err := d.project(HelloMsg{Project: pid, ProjectRoot: root}); err != nil {
					log.Printf("on-demand load of project %s: %v", pid, err)
				}
			}
			d.mu.Lock()
			_, known := d.projects[pid]
			d.mu.Unlock()
			if known {
				filterProject = pid
			}
		}
	}
	d.mu.Lock()
	projects := make([]*Project, 0, len(d.projects))
	for _, p := range d.projects {
		projects = append(projects, p)
	}
	d.mu.Unlock()
	sort.Slice(projects, func(i, j int) bool { return projects[i].ID < projects[j].ID })

	sessions := []SessionInfo{}
	for _, p := range projects {
		if filterProject != "" && p.ID != filterProject {
			continue
		}
		onlineAgents := p.OnlineSnapshot()
		ids := map[string]bool{}
		for sid := range onlineAgents {
			ids[sid] = true
		}
		if includeOffline {
			for _, id := range p.Store.ListSessionIDs() {
				ids[id] = true
			}
		}
		for sid := range ids {
			meta, err := p.Store.MetaSnapshot(sid)
			if err != nil {
				continue
			}
			agent, online := onlineAgents[sid]
			info := SessionInfo{
				Session: sid,
				Project: p.ID,
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
	}
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].Project != sessions[j].Project {
			return sessions[i].Project < sessions[j].Project
		}
		return sessions[i].Session < sessions[j].Session
	})
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

// parseSessionRef splits "<session>@<project>" (the external address
// form). The session part is folded to lowercase: addresses are
// case-insensitive and the canonical identity is lowercase.
func parseSessionRef(ref string) (session, project string, ok bool) {
	at := strings.Index(ref, "@")
	if at <= 0 || at == len(ref)-1 {
		return "", "", false
	}
	return strings.ToLower(ref[:at]), ref[at+1:], true
}

func (d *Daemon) apiMailbox(w http.ResponseWriter, r *http.Request) {
	ref := strings.TrimPrefix(r.URL.Path, "/api/mailbox/")
	session, projectID, ok := parseSessionRef(ref)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expected <session>@<project>"})
		return
	}
	proj := d.projectByID(projectID)
	if proj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown project"})
		return
	}
	if !proj.Store.HasMailbox(session) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no mailbox"})
		return
	}
	mails, err := proj.Store.Inbox(session)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	total := len(mails)
	totalUnread := 0
	for _, m := range mails {
		if m.ReadAt == nil {
			totalUnread++
		}
	}
	// position-based cursor continuation (mirrors the WS inbox handler)
	start := 0
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		cur := parseInboxCursor(cursor)
		if cur == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid cursor"})
			return
		}
		for start < len(mails) && sortsAtOrNewerThan(mails[start], cur) {
			start++
		}
	}
	limit := defaultInboxLimit
	if s := r.URL.Query().Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			limit = n
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > maxInboxLimit {
		limit = maxInboxLimit
	}
	end := start + limit
	if end > len(mails) {
		end = len(mails)
	}
	page := mails[start:end]
	nextCursor := ""
	if start+limit < len(mails) && len(page) > 0 {
		nextCursor = encodeInboxCursor(page[len(page)-1])
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"mails":       page,
		"total":       total,
		"totalUnread": totalUnread,
		"nextCursor":  nextCursor,
	})
}

func (d *Daemon) apiMail(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/mail/")
	slash := strings.Index(rest, "/")
	if slash <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expected <session>@<project>/<mailId>"})
		return
	}
	session, projectID, ok := parseSessionRef(rest[:slash])
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expected <session>@<project>/<mailId>"})
		return
	}
	mailID := rest[slash+1:]
	proj := d.projectByID(projectID)
	if proj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown project"})
		return
	}
	mail, err := proj.Store.Mail(session, mailID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if mail == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such mail"})
		return
	}
	writeJSON(w, http.StatusOK, mail)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// hostOnly strips the port from a Host header value.
func hostOnly(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		return strings.Trim(h, "[]")
	}
	return strings.Trim(host, "[]")
}

// hostAllowed is the DNS-rebinding defense for the tokenless local mode:
// only loopback names and the exact --listen host are accepted.
func (d *Daemon) hostAllowed(host string) bool {
	switch host {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	if lh, _, err := net.SplitHostPort(d.ListenAddr); err == nil {
		lh = strings.Trim(lh, "[]")
		if lh != "" && lh != "0.0.0.0" && strings.EqualFold(lh, host) {
			return true
		}
	}
	return false
}

// threadEntry is one mail in a thread, annotated with the address of the
// mailbox holding it (a mail's owner is otherwise only implied by the file
// it is stored in, and the UI needs it to navigate).
type threadEntry struct {
	Mail  MailRecord `json:"mail"`
	Owner string     `json:"owner"` // session@project
	// internal: owning project/session ids (not serialized)
	project string
	session string
}

// mailGraph is the daemon-wide ref graph: every mail keyed by its ref, plus
// the reverse edges (which mails reference a given mail).
type mailGraph struct {
	byRef    map[string]*threadEntry
	children map[string][]*threadEntry // parent refKey -> mails referencing it
}

func refKey(project, session, mail string) string {
	return project + "\x00" + session + "\x00" + mail
}

// buildMailGraph loads every mail on the daemon (all projects, all
// mailboxes) and indexes it for thread traversal.
func (d *Daemon) buildMailGraph() *mailGraph {
	d.mu.Lock()
	projects := make([]*Project, 0, len(d.projects))
	for _, p := range d.projects {
		projects = append(projects, p)
	}
	d.mu.Unlock()

	g := &mailGraph{
		byRef:    map[string]*threadEntry{},
		children: map[string][]*threadEntry{},
	}
	for _, p := range projects {
		for _, sid := range p.Store.AllSessionIDs() {
			mails, err := p.Store.Inbox(sid)
			if err != nil {
				continue
			}
			for _, m := range mails {
				e := &threadEntry{Mail: *m, Owner: sid + "@" + p.ID, project: p.ID, session: sid}
				g.byRef[refKey(p.ID, sid, m.ID)] = e
				for _, ref := range m.Refs {
					g.children[refKey(ref.Project, ref.Session, ref.Mail)] = append(
						g.children[refKey(ref.Project, ref.Session, ref.Mail)], e)
				}
			}
		}
	}
	return g
}

// threadOf walks the transitive reply chain of one mail, oldest first.
func (g *mailGraph) threadOf(rootKey string) []*threadEntry {
	visited := map[string]bool{rootKey: true}
	frontier := []string{rootKey}
	replies := []*threadEntry{}
	for len(frontier) > 0 {
		var next []string
		for _, key := range frontier {
			for _, child := range g.children[key] {
				ck := refKey(child.project, child.session, child.Mail.ID)
				if visited[ck] {
					continue
				}
				visited[ck] = true
				replies = append(replies, child)
				next = append(next, ck)
			}
		}
		frontier = next
	}
	sort.SliceStable(replies, func(i, j int) bool {
		if replies[i].Mail.NS != replies[j].Mail.NS {
			return replies[i].Mail.NS < replies[j].Mail.NS // oldest first
		}
		return replies[i].Mail.ID < replies[j].Mail.ID
	})
	return replies
}

// apiThread returns a mail plus every mail that (transitively) references
// it, oldest first — the forum-style reply chain.
func (d *Daemon) apiThread(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/thread/")
	slash := strings.Index(rest, "/")
	if slash <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expected <session>@<project>/<mailId>"})
		return
	}
	session, projectID, ok := parseSessionRef(rest[:slash])
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expected <session>@<project>/<mailId>"})
		return
	}
	mailID := rest[slash+1:]
	proj := d.projectByID(projectID)
	if proj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown project"})
		return
	}
	root, err := proj.Store.Mail(session, mailID)
	if err != nil || root == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such mail"})
		return
	}
	g := d.buildMailGraph()
	replies := g.threadOf(refKey(projectID, session, mailID))
	out := make([]threadEntry, 0, len(replies))
	for _, e := range replies {
		out = append(out, *e)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"mail":    root,
		"owner":   session + "@" + projectID,
		"replies": out,
	})
}

// threadSummary is one conversation root in a project's thread listing.
type threadSummary struct {
	Mail        MailRecord `json:"mail"`
	Owner       string     `json:"owner"` // session@project
	Replies     int        `json:"replies"`
	LastReplyAt string     `json:"lastReplyAt,omitempty"` // newest reply createdAt, if any

	activityNS int64 // LastReplyAt or Mail createdAt, for the sort (internal)
}

// apiThreads lists a project's conversation roots: mails with no refs —
// or whose refs resolve to nothing on this daemon (orphaned replies whose
// parent mailboxes were cleaned up) — each with reply statistics computed
// over the daemon-wide ref graph. Sorted by last activity, newest first.
func (d *Daemon) apiThreads(w http.ResponseWriter, r *http.Request) {
	projectID := strings.TrimPrefix(r.URL.Path, "/api/threads/")
	if projectID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expected <project>"})
		return
	}
	if d.projectByID(projectID) == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown project"})
		return
	}
	g := d.buildMailGraph()
	threads := []threadSummary{}
	for key, e := range g.byRef {
		if e.project != projectID {
			continue
		}
		// a root has no refs at all, or no ref that resolves on this daemon
		resolvable := false
		for _, ref := range e.Mail.Refs {
			if _, ok := g.byRef[refKey(ref.Project, ref.Session, ref.Mail)]; ok {
				resolvable = true
				break
			}
		}
		if len(e.Mail.Refs) > 0 && resolvable {
			continue
		}
		replies := g.threadOf(key)
		ts := threadSummary{Mail: e.Mail, Owner: e.Owner, Replies: len(replies), activityNS: e.Mail.NS}
		if len(replies) > 0 {
			last := replies[len(replies)-1].Mail
			ts.LastReplyAt = last.CreatedAt
			ts.activityNS = last.NS
		}
		threads = append(threads, ts)
	}
	sort.SliceStable(threads, func(i, j int) bool {
		if threads[i].activityNS != threads[j].activityNS {
			return threads[i].activityNS > threads[j].activityNS // newest activity first
		}
		return threads[i].Mail.ID > threads[j].Mail.ID
	})
	writeJSON(w, http.StatusOK, map[string]any{"threads": threads})
}

// apiSend lets the web UI user send mail as user@<project> — the single
// write endpoint of the web API. The first send implicitly registers the
// user's mailbox in the target project so that agent replies and
// agent-initiated mail can be delivered offline.
func (d *Daemon) apiSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	var msg struct {
		To      string   `json:"to"` // session@project
		Subject string   `json:"subject"`
		Body    string   `json:"body"`
		Refs    []string `json:"refs"` // session@project/mailId
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256*1024)
	if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unparsable body"})
		return
	}
	if len(msg.Subject) > subjectMax {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "subject too long"})
		return
	}
	if len(msg.Body) > bodyMax {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body too large"})
		return
	}
	if len(msg.Refs) > refsMax {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too many refs"})
		return
	}
	session, projectID, ok := parseSessionRef(msg.To)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expected <session>@<project>"})
		return
	}
	proj := d.projectByID(projectID)
	if proj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown project"})
		return
	}
	if !proj.Store.HasMailbox(session) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no mailbox"})
		return
	}
	refs := []MailRef{}
	for _, s := range msg.Refs {
		// "session@project/mailId": split the mail id off first
		slash := strings.LastIndex(s, "/")
		if slash <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid ref: " + s})
			return
		}
		rs, rp, ok := parseSessionRef(s[:slash])
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid ref: " + s})
			return
		}
		mailID := s[slash+1:]
		if rs == "" || rp == "" || mailID == "" ||
			len(rs) > 128 || len(rp) > 128 || len(mailID) > 128 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid ref: " + s})
			return
		}
		refs = append(refs, MailRef{Project: rp, Session: rs, Mail: mailID})
	}
	// ensure the user's mailbox exists in this project so replies (and
	// agent-initiated mail) can be delivered
	if !proj.Store.HasMailbox(webUserSession) {
		if _, err := proj.Store.HelloMerge(webUserSession, "user-web", "", nil, nil); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	mail := &MailRecord{
		ID:      newShortID(),
		From:    AgentRef{Project: projectID, Session: webUserSession},
		Subject: msg.Subject,
		Body:    msg.Body,
		Refs:    refsOrNil(refs),
	}
	if err := proj.Store.AppendSend(session, mail); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// push updated unread count to the recipient (only when online)
	if tc := proj.lookupOnline(session); tc != nil {
		if unread, err := proj.Store.UnreadCount(session); err == nil {
			tc.send(NotifyMsg{T: "notify", Unread: unread})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ref":  session + "@" + projectID + "/" + mail.ID,
		"mail": mail,
	})
}

// apiDelete removes a session's mailbox entirely (mails, meta, registration)
// at the user's request. Online sessions are refused — the connection would
// recreate state immediately; disconnect first. The pi session file is never
// touched.
func (d *Daemon) apiDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	var msg struct {
		Address string `json:"address"` // session@project
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unparsable body"})
		return
	}
	session, projectID, ok := parseSessionRef(msg.Address)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expected <session>@<project>"})
		return
	}
	proj := d.projectByID(projectID)
	if proj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown project"})
		return
	}
	if err := proj.DeleteMailboxIfOffline(session); err != nil {
		if errors.Is(err, errSessionOnline) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "session is online; it would recreate its mailbox — disconnect first"})
			return
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": msg.Address})
}
