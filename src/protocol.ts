/**
 * Wire protocol between mailbox clients (pi sessions) and the mailbox service.
 *
 * All messages are JSON objects with a `t` discriminator. Client requests carry
 * a `rid` (request id); the server replies with the same `rid` so responses can
 * be correlated. Unsolicited server pushes (`notify`) have no `rid`.
 */

/** Identity of an agent session: project id + session id (short base36 ids; see daemon.ts for the scheme). */
export interface AgentRef {
	project: string;
	session: string;
}

/** Pointer to a mail: project + owner session + mail id. Knowing the triple is the capability to read it. */
export interface MailRef extends AgentRef {
	mail: string;
}

/** Immutable mail record. The owner is implied by which session file it lives in. */
export interface MailRecord {
	id: string;
	from: AgentRef;
	subject: string;
	body: string;
	refs: MailRef[];
	createdAt: string;
	readAt: string | null;
}

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------

/** Handshake + registration. One connection per session; a second hello for the same session replaces the first connection. */
export const PROTOCOL_VERSION = 2;

export interface HelloMsg {
	t: "hello";
	rid: number;
	/** Project id (short base36, derived from host id + project path). */
	project: string;
	/** Absolute project root; local-mode daemons store data under its .pi/mailbox. */
	projectRoot?: string;
	/** pi session directory for this cwd; enables the daemon's lifecycle GC in local mode. */
	sessionDir?: string;
	/** Session id (short base36, derived from agent + pi session id); the mailbox is keyed by this. */
	session: string;
	/** Login: claim this named mailbox instead of the derived session id. Rejected with mailbox_in_use while a different origin holds it; same-origin reconnection replaces the previous connection. */
	as?: string;
	/** Login-time tags overwrite (comma-separated); omitted keeps the named mailbox's existing tags. */
	tags?: string;
	/** Take over a name whose holder is OFFLINE and foreign. Online holders are never displaced; free names and same-origin reconnects never need it. */
	force?: boolean;
	/** Full pi session id; persisted as the `_origin` system meta for the lifecycle GC. */
	origin?: string;
	agent: string;
	/** Connection token (remote-mode daemons require it). */
	token?: string;
	/** Registration-time meta defaults, best-effort per key: system keys (leading `_`) refresh on every hello; user keys apply only when absent; invalid entries are skipped individually. */
	meta?: Record<string, string>;
}

/** Pre-hello liveness probe used by leader election. */
export interface PingMsg {
	t: "ping";
	rid: number;
}

export interface SessionsMsg {
	t: "sessions";
	rid: number;
	/** Include offline mailboxes (sessions that registered at least once). */
	includeOffline?: boolean;
}

/** Update this session's meta (key/value, cookie-like). System keys (leading `_`) cannot be set here. */
export interface MetaMsg {
	t: "meta";
	rid: number;
	set?: Record<string, string>;
	unset?: string[];
}

export interface SendMsg {
	t: "send";
	rid: number;
	target: AgentRef;
	subject: string;
	body: string;
	refs?: MailRef[];
}

export interface InboxFilter {
	unreadOnly?: boolean;
	/** ISO timestamp; only mails created strictly after this are returned. */
	since?: string;
}

export interface InboxMsg {
	t: "inbox";
	rid: number;
	filter?: InboxFilter;
	/** Max mails to return (default 20, max 100). */
	limit?: number;
	/** Opaque continuation token from a previous reply; fetches older mails. */
	cursor?: string;
}

/** Read any mail by triple. Only mails owned by the reading session get `readAt` set. */
export interface ReadMsg {
	t: "read";
	rid: number;
	mail: MailRef;
}

export type ClientMsg = HelloMsg | PingMsg | SessionsMsg | MetaMsg | SendMsg | InboxMsg | ReadMsg;

// ---------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------

export interface WelcomeMsg {
	t: "welcome";
	rid: number;
	project: string;
	/** Effective mailbox id (the login name when hello carried `as`, else the session id); clients verify their login was applied. */
	mailbox?: string;
	instanceId: string;
	protocolVersion?: number;
	/** This session's full meta after the registration merge. */
	meta?: Record<string, string>;
}

export interface PongMsg {
	t: "pong";
	rid: number;
	project: string;
	instanceId: string;
}

export interface SessionInfo {
	session: string;
	/** Owning project id, so listings render full session@project addresses. */
	project?: string;
	/** pi session display name; absent for offline sessions that never set `_agent`. */
	agent?: string;
	/** True when currently connected. */
	online: boolean;
	/** Convenience views of the reserved meta keys. */
	name?: string;
	tags?: string[];
	/** Full key/value meta map. */
	meta?: Record<string, string>;
}

export interface SessionsReply {
	t: "sessions";
	rid: number;
	sessions: SessionInfo[];
}

export interface MetaReply {
	t: "meta";
	rid: number;
}

export interface SentReply {
	t: "sent";
	rid: number;
	mail: MailRef;
}

export interface InboxReply {
	t: "inbox";
	rid: number;
	mails: MailRecord[];
	/** Present when more (older) mails are available. Pass back as `cursor`. */
	nextCursor?: string;
	/** Total mails in the mailbox (unfiltered, not page-scoped). */
	total: number;
	/** Total unread mails in the mailbox. */
	totalUnread: number;
}

export interface MailReply {
	t: "mail";
	rid: number;
	mail: MailRecord | null;
}

export interface ErrorReply {
	t: "error";
	rid?: number;
	code: string;
	message: string;
}

/** Pushed whenever the unread count of a registered session changes (new mail arrives). */
export interface NotifyMsg {
	t: "notify";
	unread: number;
}

export type ServerMsg =
	| WelcomeMsg
	| PongMsg
	| SessionsReply
	| MetaReply
	| SentReply
	| InboxReply
	| MailReply
	| ErrorReply
	| NotifyMsg;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Meta keys are cookie-like: short identifiers. Keys starting with `_` are system-reserved. */
export const META_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/;
export const META_VALUE_MAX = 512;
/** Cap for user-controlled meta keys per session. */
export const META_MAX_KEYS = 32;
/** Separate cap for system keys (`_`-prefixed) set at registration time. */
export const META_MAX_SYSTEM_KEYS = 8;
export const TAG_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function isServerMsg(value: unknown): value is ServerMsg {
	return typeof value === "object" && value !== null && typeof (value as { t?: unknown }).t === "string";
}
