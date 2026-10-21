package main

// Wire protocol (v2), mirroring pi-mailbox's src/protocol.ts.
//
// All messages are JSON objects with a "t" discriminator. Client requests
// carry a "rid"; the server replies with the same "rid". "notify" is the only
// unsolicited push.

import "encoding/json"

const (
	defaultInboxLimit = 20
	maxInboxLimit     = 100
	metaValueMax      = 512
	metaMaxKeys       = 32
	metaMaxSystemKeys = 8
	subjectMax        = 256
	bodyMax           = 64 * 1024
	refsMax           = 16
)

// ---- client -> server ----

type PingMsg struct {
	T   string `json:"t"`
	Rid int    `json:"rid"`
}

type HelloMsg struct {
	T           string `json:"t"`
	Rid         int    `json:"rid"`
	Project     string `json:"project"`
	ProjectRoot string `json:"projectRoot,omitempty"`
	// Session is the short mailbox session id the mailbox is keyed by.
	Session string `json:"session"`
	// As optionally logs in to a named mailbox: the connection is then keyed
	// by that name instead of Session, inheriting the named mailbox's mails
	// and meta. Rejected with mailbox_in_use while another origin holds it.
	As string `json:"as,omitempty"`
	// Tags optionally overwrites the named mailbox's tags at login time
	// (comma-separated). Empty keeps the existing tags.
	Tags string `json:"tags,omitempty"`
	// Force allows taking over a name whose holder is OFFLINE and foreign.
	// Online holders are never displaced; same-origin reconnects and free
	// names never need it. Strictly per-hello, never persisted.
	Force bool `json:"force,omitempty"`
	// Release carries the name (or comma-separated list of names) whose
	// _holds binding the caller is owed a release for (the daemon-side
	// half of /mailbox logout, deferred to the next hello so it survives
	// daemon downtime). Only the caller's own derived record is touched,
	// and only names still in its _holds set are removed.
	Release string `json:"release,omitempty"`
	// Origin is the client's full session id (e.g. the pi session UUID);
	// persisted as the _origin system meta, used by the lifecycle GC to
	// match the client's session file. May be empty for non-pi agents.
	Origin string            `json:"origin,omitempty"`
	Agent  string            `json:"agent"`
	Token  string            `json:"token,omitempty"`
	Meta   map[string]string `json:"meta,omitempty"`
}

type SessionsMsg struct {
	T              string `json:"t"`
	Rid            int    `json:"rid"`
	IncludeOffline bool   `json:"includeOffline,omitempty"`
}

type MetaMsg struct {
	T     string            `json:"t"`
	Rid   int               `json:"rid"`
	Set   map[string]string `json:"set,omitempty"`
	Unset []string          `json:"unset,omitempty"`
}

type AgentRef struct {
	Project string `json:"project"`
	Session string `json:"session"`
}

type MailRef struct {
	Project string `json:"project"`
	Session string `json:"session"`
	Mail    string `json:"mail"`
}

type SendMsg struct {
	T       string    `json:"t"`
	Rid     int       `json:"rid"`
	Target  AgentRef  `json:"target"`
	Subject string    `json:"subject"`
	Body    string    `json:"body"`
	Refs    []MailRef `json:"refs,omitempty"`
}

type InboxFilter struct {
	UnreadOnly bool   `json:"unreadOnly,omitempty"`
	Since      string `json:"since,omitempty"`
}

type InboxMsg struct {
	T      string       `json:"t"`
	Rid    int          `json:"rid"`
	Filter *InboxFilter `json:"filter,omitempty"`
	Limit  int          `json:"limit,omitempty"`
	Cursor string       `json:"cursor,omitempty"`
}

type ReadMsg struct {
	T    string  `json:"t"`
	Rid  int     `json:"rid"`
	Mail MailRef `json:"mail"`
}

type ShutdownMsg struct {
	T     string `json:"t"`
	Rid   int    `json:"rid"`
	Token string `json:"token,omitempty"`
}

type ShutdownAck struct {
	T   string `json:"t"`
	Rid int    `json:"rid"`
}

// ---- server -> client ----

type PongMsg struct {
	T               string `json:"t"`
	Rid             int    `json:"rid"`
	Project         string `json:"project,omitempty"`
	InstanceID      string `json:"instanceId"`
	ProtocolVersion int    `json:"protocolVersion"`
}

type WelcomeMsg struct {
	T       string `json:"t"`
	Rid     int    `json:"rid"`
	Project string `json:"project"`
	// Mailbox is the effective mailbox id the connection is keyed by
	// (the login name when hello carried "as", else Session). Clients
	// verify their login was applied by comparing against the expectation.
	Mailbox string `json:"mailbox,omitempty"`
	// Released is true when the hello carried a release field and the
	// daemon processed it (applied or no-op). Any welcome means the
	// release was delivered; the client clears its pending flag.
	Released        bool              `json:"released,omitempty"`
	InstanceID      string            `json:"instanceId"`
	ProtocolVersion int               `json:"protocolVersion"`
	Meta            map[string]string `json:"meta,omitempty"`
}

type SessionInfo struct {
	Session string `json:"session"`
	/** Owning project id, so listings render full session@project addresses. */
	Project string            `json:"project,omitempty"`
	Agent   string            `json:"agent,omitempty"`
	Online  bool              `json:"online"`
	Name    string            `json:"name,omitempty"`
	Tags    []string          `json:"tags,omitempty"`
	Meta    map[string]string `json:"meta,omitempty"`
}

type SessionsReply struct {
	T        string        `json:"t"`
	Rid      int           `json:"rid"`
	Sessions []SessionInfo `json:"sessions"`
}

type MetaReply struct {
	T   string `json:"t"`
	Rid int    `json:"rid"`
}

type SentReply struct {
	T    string  `json:"t"`
	Rid  int     `json:"rid"`
	Mail MailRef `json:"mail"`
}

type MailRecord struct {
	ID        string    `json:"id"`
	From      AgentRef  `json:"from"`
	Subject   string    `json:"subject"`
	Body      string    `json:"body"`
	Refs      []MailRef `json:"refs"`
	CreatedAt string    `json:"createdAt"`
	ReadAt    *string   `json:"readAt"`
	// NS is the parsed createdAt (unix nanoseconds), used for ordering.
	// It accepts both the fixed-width nanosecond layout this daemon writes
	// and the millisecond layout the TS implementation wrote. Never sent.
	NS int64 `json:"-"`
}

type InboxReply struct {
	T           string       `json:"t"`
	Rid         int          `json:"rid"`
	Mails       []MailRecord `json:"mails"`
	NextCursor  string       `json:"nextCursor,omitempty"`
	Total       int          `json:"total"`
	TotalUnread int          `json:"totalUnread"`
}

type MailReply struct {
	T    string      `json:"t"`
	Rid  int         `json:"rid"`
	Mail *MailRecord `json:"mail"`
}

type ErrorReply struct {
	T       string `json:"t"`
	Rid     *int   `json:"rid,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type NotifyMsg struct {
	T      string `json:"t"`
	Unread int    `json:"unread"`
}

func encodeMsg(v interface{}) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"t":"error","code":"internal","message":"encode failed"}`)
	}
	return data
}

// rawMsg is used for dispatch before full decoding.
type rawMsg struct {
	T   string          `json:"t"`
	Rid int             `json:"rid"`
	Raw json.RawMessage `json:"-"`
}
