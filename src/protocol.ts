/**
 * Wire protocol between mailbox clients (pi sessions) and the mailbox service.
 *
 * All messages are JSON objects with a `t` discriminator. Client requests carry
 * a `rid` (request id); the server replies with the same `rid` so responses can
 * be correlated. Unsolicited server pushes (`notify`) have no `rid`.
 */

/** Identity of an agent session: project id + session id (short base36 ids; see daemon.ts for the scheme). */
export type AgentRef = {
	project: string;
	session: string;
};

/**
 * Pointer to a mail: project + owner session + mail id. Knowing the triple is the capability to read it.
 * Spelled out (not AgentRef & {...}) and declared as a type alias so instances
 * satisfy pi's JsonValue (implicit index signature): these records are passed
 * as tool `structuredContent` unchanged.
 */
export type MailRef = {
	project: string;
	session: string;
	mail: string;
};

/**
 * Immutable mail record. The owner is implied by which session file it lives in.
 * A type alias (not an interface) so instances satisfy pi's JsonValue: they are
 * passed as tool `structuredContent` unchanged.
 */
export type MailRecord = {
	id: string;
	from: AgentRef;
	subject: string;
	body: string;
	// The daemon has no omitempty on refs and converts empty to nil, so the
	// wire form is an array or JSON null (never a missing key).
	refs: MailRef[] | null;
	createdAt: string;
	// *string daemon-side: null for unread, never missing.
	readAt: string | null;
};

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
	/** Deferred release (model E): the name whose _holds binding to clear on this hello. Independent of `as`. */
	release?: string;
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
	/** True when the hello carried a release field and the daemon processed it. Any welcome = delivered (applied or no-op). */
	released?: boolean;
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

/**
 * A session's listing entry. A type alias (not an interface) so instances
 * satisfy pi's JsonValue: they are passed as tool `structuredContent` unchanged.
 */
export type SessionInfo = {
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
};

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

// ---------------------------------------------------------------------------
// output schemas (TypeBox)
//
// Declared as `outputSchema` by the mailbox tools so codemode scripts receive
// typed `structuredContent` instead of parsing the text content. pi does not
// validate structuredContent against the schema at runtime — the schema is a
// declaration to programmatic callers — so the drift guards at the bottom of
// this section bind each schema to its wire interface at compile time.
// ---------------------------------------------------------------------------

import { type Static, Type } from "typebox";

export const AgentRefSchema = Type.Object({
	project: Type.String(),
	session: Type.String(),
});

export const MailRefSchema = Type.Object({
	...AgentRefSchema.properties,
	mail: Type.String(),
});

export const MailRecordSchema = Type.Object({
	id: Type.String(),
	from: AgentRefSchema,
	subject: Type.String(),
	body: Type.String(),
	// nullable, not optional: the daemon marshals a nil slice as JSON null
	refs: Type.Union([Type.Array(MailRefSchema), Type.Null()]),
	createdAt: Type.String(),
	// nullable, not optional: *string daemon-side
	readAt: Type.Union([Type.String(), Type.Null()]),
});

// open by design: `meta` carries evolving system keys (_host, _model, _pi,
// _platform, ...), so a closed shape would force a schema edit per key
export const SessionInfoSchema = Type.Object({
	session: Type.String(),
	online: Type.Boolean(),
	project: Type.Optional(Type.String()),
	agent: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	tags: Type.Optional(Type.Array(Type.String())),
	meta: Type.Optional(Type.Record(Type.String(), Type.String())),
});

// tool result shapes (the structuredContent of each mailbox tool)
export const MailboxListOutputSchema = Type.Object({
	mails: Type.Array(MailRecordSchema),
	total: Type.Integer(),
	totalUnread: Type.Integer(),
	// absent at the end of pagination (omitempty daemon-side)
	nextCursor: Type.Optional(Type.String()),
});

export const MailboxReadOutputSchema = Type.Object({
	mail: MailRecordSchema,
	// the resolved full "session@project/mail" ref (a bare id input is
	// expanded to the caller's own mailbox; the owner cannot be inferred
	// from `from`)
	ref: Type.String(),
});

export const MailboxSentOutputSchema = Type.Object({
	ref: Type.String(),
});

export const MailboxSessionsOutputSchema = Type.Object({
	sessions: Type.Array(SessionInfoSchema),
});

/** Mail counts for status summaries (connect results). */
export const MailCountsSchema = Type.Object({
	total: Type.Integer(),
	unread: Type.Integer(),
});

export const MailboxConnectOutputSchema = Type.Object({
	/** This connection's full "session@project" address. */
	address: Type.String(),
	alreadyConnected: Type.Boolean(),
	mails: MailCountsSchema,
	// null when the sessions query failed — never flattened to 0 (a script
	// would conclude "no peers online" and take a wrong branch), never
	// omitted. The text renders the failure as an omitted clause.
	onlineClients: Type.Union([Type.Integer(), Type.Null()]),
});

// Compile-time drift guards (bidirectional assignability; never read at
// runtime). Changing a wire interface without its schema — or vice versa —
// fails `npm run check` here, because nothing validates structuredContent
// against outputSchema when the tools run.
const _agentRefGuardA: AgentRef = null as unknown as Static<typeof AgentRefSchema>;
const _agentRefGuardB: Static<typeof AgentRefSchema> = null as unknown as AgentRef;
const _mailRefGuardA: MailRef = null as unknown as Static<typeof MailRefSchema>;
const _mailRefGuardB: Static<typeof MailRefSchema> = null as unknown as MailRef;
const _mailRecordGuardA: MailRecord = null as unknown as Static<typeof MailRecordSchema>;
const _mailRecordGuardB: Static<typeof MailRecordSchema> = null as unknown as MailRecord;
const _sessionInfoGuardA: SessionInfo = null as unknown as Static<typeof SessionInfoSchema>;
const _sessionInfoGuardB: Static<typeof SessionInfoSchema> = null as unknown as SessionInfo;
void _agentRefGuardA;
void _agentRefGuardB;
void _mailRefGuardA;
void _mailRefGuardB;
void _mailRecordGuardA;
void _mailRecordGuardB;
void _sessionInfoGuardA;
void _sessionInfoGuardB;

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
