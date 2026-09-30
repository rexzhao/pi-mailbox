/**
 * Wire protocol between mailbox clients (pi sessions) and the mailbox service.
 *
 * All messages are JSON objects with a `t` discriminator. Client requests carry
 * a `rid` (request id); the server replies with the same `rid` so responses can
 * be correlated. Unsolicited server pushes (`notify`) have no `rid`.
 */

/** Identity of an agent session: project UUID + pi session id. */
export interface AgentRef {
	project: string;
	session: string;
}

/** Pointer to a mail: project + owner session + mail UUID. Knowing the triple is the capability to read it. */
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
export interface HelloMsg {
	t: "hello";
	rid: number;
	session: string;
	agent: string;
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
	instanceId: string;
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
	agent: string;
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
