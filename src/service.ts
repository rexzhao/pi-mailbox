/**
 * Mailbox service: WebSocket server hosting one project's mailboxes.
 * Runs inside the pi process of whichever session won leader election.
 */

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
	SESSION_ID_RE,
	META_KEY_RE,
	META_VALUE_MAX,
	META_MAX_KEYS,
	META_MAX_SYSTEM_KEYS,
	TAG_RE,
	type AgentRef,
	type ClientMsg,
	type MailRecord,
	type MailRef,
	type ServerMsg,
	type SessionInfo,
	type InboxReply,
} from "./protocol.ts";
import { MailStore } from "./store.ts";

const DEFAULT_INBOX_LIMIT = 20;
const MAX_INBOX_LIMIT = 100;

interface InboxCursor {
	createdAt: string;
	id: string;
}

function encodeInboxCursor(mail: { createdAt: string; id: string }): string {
	return Buffer.from(JSON.stringify({ createdAt: mail.createdAt, id: mail.id }), "utf8").toString("base64url");
}

function parseInboxCursor(cursor: string): InboxCursor | null {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as InboxCursor;
		if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

/** True when `mail` sorts at or newer than `cursor` in the descending inbox order. */
function sortsAtOrNewerThan(mail: { createdAt: string; id: string }, cursor: InboxCursor): boolean {
	if (mail.createdAt !== cursor.createdAt) return mail.createdAt > cursor.createdAt;
	return mail.id >= cursor.id;
}

/** Validate a meta map. `allowSystem` permits system keys (leading `_`), used for hello-time auto values. */
function validateMetaMap(map: Record<string, string>, allowSystem: boolean): boolean {
	if (typeof map !== "object" || map === null) return false;
	for (const [key, value] of Object.entries(map)) {
		if (!META_KEY_RE.test(key)) return false;
		if (key.startsWith("_") && !allowSystem) return false;
		if (typeof value !== "string" || value.length > META_VALUE_MAX) return false;
	}
	return true;
}

function validateUnset(keys: string[]): boolean {
	return (
		Array.isArray(keys) && keys.length <= META_MAX_KEYS && keys.every((key) => META_KEY_RE.test(key) && !key.startsWith("_"))
	);
}

/** Parse the reserved `tags` value (comma-separated). Returns null when absent or invalid. */
function parseTags(value: string | undefined): string[] | null {
	if (typeof value !== "string") return null;
	const tags = value
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	if (tags.length > 32 || tags.some((t) => !TAG_RE.test(t))) return null;
	return tags;
}

interface ConnInfo {
	session: string;
	agent: string;
}

export interface ServiceHandle {
	instanceId: string;
	port: number;
	stop: () => Promise<void>;
}

export interface ServiceOptions {
	/** pi session directory for this cwd; enables orphan-mailbox GC. */
	sessionsDir?: string;
	/** Delay before the first GC run, so reconnecting clients can re-register. */
	gcDelayMs?: number;
	/** Only mailbox files idle for at least this long are collected. */
	gcGraceMs?: number;
}

export class MailboxService {
	readonly instanceId = randomUUID();
	private readonly store: MailStore;
	private readonly projectId: string;
	private readonly sessionsDir: string | undefined;
	private readonly gcDelayMs: number;
	private readonly gcGraceMs: number;
	private gcTimer: NodeJS.Timeout | null = null;
	private stopped = false;
	private readonly conns = new Map<WebSocket, ConnInfo>();
	/** session id -> connection of the registered (online) session */
	private readonly online = new Map<string, WebSocket>();
	private server: Server | null = null;
	private wss: WebSocketServer | null = null;
	port = 0;

	constructor(projectDir: string, projectId: string, options?: ServiceOptions) {
		this.store = new MailStore(projectDir);
		this.projectId = projectId;
		this.sessionsDir = options?.sessionsDir;
		this.gcDelayMs = options?.gcDelayMs ?? 30_000;
		this.gcGraceMs = options?.gcGraceMs ?? 60 * 60 * 1000;
	}

	async start(): Promise<void> {
		await this.store.init();
		if (this.sessionsDir) {
			// deferred lifecycle GC: wait for clients to re-register, then drop
			// mailboxes of deleted pi sessions (online sessions are always kept)
			const sessionsDir = this.sessionsDir;
			this.gcTimer = setTimeout(() => {
				this.gcTimer = null;
				void this.store
					.gcOrphans(sessionsDir, this.gcGraceMs, (sessionId) => this.online.has(sessionId))
					.catch(() => undefined);
			}, this.gcDelayMs);
			this.gcTimer.unref?.();
		}
		this.server = createServer();
		this.wss = new WebSocketServer({ server: this.server });
		this.wss.on("connection", (ws) => this.handleConnection(ws));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(0, "127.0.0.1", () => resolve());
		});
		const addr = this.server!.address();
		if (addr === null || typeof addr === "string") throw new Error("unexpected listen address");
		this.port = addr.port;
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.gcTimer) {
			clearTimeout(this.gcTimer);
			this.gcTimer = null;
		}
		for (const ws of this.conns.keys()) {
			ws.close(1001, "server stopping");
		}
		this.conns.clear();
		this.online.clear();
		await new Promise<void>((resolve) => {
			this.wss?.close(() => resolve());
			if (!this.wss) resolve();
		});
		await new Promise<void>((resolve, reject) => {
			this.server?.close(() => resolve());
			this.server?.once("error", reject);
			if (!this.server) resolve();
		});
		this.wss = null;
		this.server = null;
	}

	private handleConnection(ws: WebSocket): void {
		ws.on("message", (data) => {
			let msg: ClientMsg;
			try {
				msg = JSON.parse(String(data)) as ClientMsg;
			} catch {
				this.reply(ws, { t: "error", code: "bad_json", message: "unparsable message" });
				return;
			}
			void this.handleMessage(ws, msg).catch((err) => {
				this.reply(ws, {
					t: "error",
					rid: typeof msg.rid === "number" ? msg.rid : undefined,
					code: "internal",
					message: err instanceof Error ? err.message : String(err),
				});
			});
		});
		ws.on("close", () => {
			const info = this.conns.get(ws);
			if (info && this.online.get(info.session) === ws) {
				this.online.delete(info.session);
			}
			this.conns.delete(ws);
		});
	}

	private reply(ws: WebSocket, msg: ServerMsg): void {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
	}

	private async handleMessage(ws: WebSocket, msg: ClientMsg): Promise<void> {
		switch (msg.t) {
			case "ping":
				this.reply(ws, {
					t: "pong",
					rid: msg.rid,
					project: this.projectId,
					instanceId: this.instanceId,
				});
				return;

			case "hello": {
				if (!SESSION_ID_RE.test(msg.session) || typeof msg.agent !== "string") {
					this.reply(ws, { t: "error", rid: msg.rid, code: "bad_hello", message: "invalid session or agent" });
					return;
				}
				const previous = this.online.get(msg.session);
				if (previous && previous !== ws) {
					// same session reconnected elsewhere: replace the old connection
					previous.close(4000, "replaced by newer connection");
				}
				// same ws re-helloing as a different session: drop the old registration
				// first, otherwise it lingers in `online` pointing at this ws
				const existing = this.conns.get(ws);
				if (existing && existing.session !== msg.session && this.online.get(existing.session) === ws) {
					this.online.delete(existing.session);
				}
				this.conns.set(ws, { session: msg.session, agent: msg.agent });
				this.online.set(msg.session, ws);
				// persist the agent identity and create the session file, so the
				// mailbox exists for offline delivery from now on
				await this.store.ensureSession(msg.session).catch(() => undefined);

				// merge registration-time meta (best-effort, per-key):
				// - invalid keys/values are skipped individually, not fatal
				// - system keys (leading `_`) refresh on every hello, but only
				//   when the value actually changed (avoids JSONL churn on reconnect)
				// - user keys only apply when absent (Object.hasOwn, so inherited
				//   Object.prototype members are not mistaken for existing values)
				// - caps are counted separately: user keys <= META_MAX_KEYS,
				//   system keys <= META_MAX_SYSTEM_KEYS
				// - the hello's system keyset is authoritative: stored system keys
				//   absent from this hello are unset (bounds accumulation)
				const state = await this.store.state(msg.session);
				// the agent identity is persisted as the `_agent` system key, so
				// offline mailbox listings can still show who a session is
				// `_agent` must be the first entry so the system-key cap can never
				// squeeze it out, and re-assigned after the spread so a client cannot
				// spoof it
				const metaSource: Record<string, unknown> = { _agent: msg.agent };
				if (typeof msg.meta === "object" && msg.meta !== null) {
					Object.assign(metaSource, msg.meta);
				}
				metaSource._agent = msg.agent;
				if (Object.keys(metaSource).length > 0) {
					const set: Record<string, string> = {};
					let sysCount = 0;
					const sysKept = new Set<string>();
					for (const [key, value] of Object.entries(metaSource)) {
						if (!META_KEY_RE.test(key)) continue;
						if (typeof value !== "string" || value.length > META_VALUE_MAX) continue;
						if (key.startsWith("_")) {
							if (sysCount >= META_MAX_SYSTEM_KEYS) continue;
							sysCount++;
							sysKept.add(key);
							if (state.meta.values[key] !== value) set[key] = value;
						} else if (!Object.hasOwn(state.meta.values, key)) {
							set[key] = value;
						}
					}
					const mergedUser = new Set(
							Object.keys(state.meta.values).filter((key) => !key.startsWith("_")),
						);
					for (const key of Object.keys(set)) {
							if (!key.startsWith("_")) mergedUser.add(key);
						}
					if (mergedUser.size > META_MAX_KEYS) {
						for (const key of Object.keys(set)) {
							if (!key.startsWith("_")) delete set[key];
						}
					}
					// authoritative unset: judged against the accepted system keyset
					// (sysKept), so keys truncated by the cap also converge away
					const unset = Object.keys(state.meta.values).filter(
						(key) => key.startsWith("_") && !sysKept.has(key),
					);
					if (Object.keys(set).length > 0 || unset.length > 0) {
						await this.store.appendMeta(msg.session, { set, unset });
					}
				}

				this.reply(ws, {
					t: "welcome",
					rid: msg.rid,
					project: this.projectId,
					instanceId: this.instanceId,
					meta: { ...state.meta.values },
				});
				// backfill: report unread count immediately after registration
				const inbox = state.mails;
				const unread = MailStore.unreadCount(inbox);
				if (unread > 0) this.reply(ws, { t: "notify", unread });
				return;
			}

			case "sessions": {
				const sessions: SessionInfo[] = [];
				const ids = new Set<string>(this.online.keys());
				if (msg.includeOffline) {
					// lazily enumerate every mailbox that ever registered; files are
					// loaded (and cached) on demand by this query
					for (const id of await this.store.listSessionIds()) ids.add(id);
				}
				for (const session of ids) {
					const connWs = this.online.get(session);
					const online = connWs !== undefined && connWs.readyState === WebSocket.OPEN;
					const info = online && connWs ? this.conns.get(connWs) : undefined;
					const state = await this.store.state(session);
					sessions.push({
						session,
						agent: info?.agent ?? state.meta.values._agent,
						online,
						name: state.meta.values.name,
						tags: state.meta.values.tags !== undefined ? (parseTags(state.meta.values.tags) ?? undefined) : undefined,
						meta: { ...state.meta.values },
					});
				}
				this.reply(ws, { t: "sessions", rid: msg.rid, sessions });
				return;
			}

			case "meta": {
				const from = this.conns.get(ws);
				if (!from) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "not_registered", message: "hello first" });
					return;
				}
				const update: { set?: Record<string, string>; unset?: string[] } = {};
				// user-facing op: system keys (leading `_`) cannot be written here
				if (msg.set !== undefined && !validateMetaMap(msg.set, false)) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "bad_meta", message: "invalid set" });
					return;
				}
				if (msg.unset !== undefined && !validateUnset(msg.unset)) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "bad_meta", message: "invalid unset" });
					return;
				}
				if (msg.set?.tags !== undefined && parseTags(msg.set.tags) === null) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "bad_meta", message: "invalid tags value" });
					return;
				}
				const setCount = msg.set ? Object.keys(msg.set).length : 0;
				const unsetCount = msg.unset ? msg.unset.length : 0;
				if (setCount === 0 && unsetCount === 0) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "bad_meta", message: "nothing to update" });
					return;
				}
				const state = await this.store.state(from.session);
				// the cap counts user keys only; system keys are bounded at
				// registration time (META_MAX_SYSTEM_KEYS)
				const currentCount = Object.keys(state.meta.values).filter((key) => !key.startsWith("_")).length;
				const nextKeys = new Set(
					Object.keys(state.meta.values).filter((key) => !key.startsWith("_")),
				);
				if (msg.set) for (const key of Object.keys(msg.set)) nextKeys.add(key);
				if (msg.unset) for (const key of msg.unset) nextKeys.delete(key);
				// reject only when the update would grow beyond the cap; shrinking
				// an over-cap state (e.g. written by an older version) stays allowed
				if (nextKeys.size > META_MAX_KEYS && nextKeys.size > currentCount) {
					this.reply(ws, {
						t: "error",
						rid: msg.rid,
						code: "bad_meta",
						message: `too many meta keys (max ${META_MAX_KEYS})`,
					});
					return;
				}
				if (setCount > 0) update.set = msg.set;
				if (unsetCount > 0) update.unset = msg.unset;
				await this.store.appendMeta(from.session, update);
				this.reply(ws, { t: "meta", rid: msg.rid });
				return;
			}

			case "send": {
				const from = this.conns.get(ws);
				if (!from) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "not_registered", message: "hello first" });
					return;
				}
				if (msg.target.project !== this.projectId) {
					this.reply(ws, {
						t: "error",
						rid: msg.rid,
						code: "external_target",
						message: `target project ${msg.target.project} is not served by this mailbox`,
					});
					return;
				}
				if (typeof msg.subject !== "string" || typeof msg.body !== "string" || msg.subject.length > 256) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "bad_send", message: "subject and body required" });
					return;
				}
				if (msg.body.length > 64 * 1024) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "bad_send", message: "body too large" });
					return;
				}
				const refs = msg.refs ?? [];
				if (
					msg.refs !== undefined &&
					!Array.isArray(msg.refs)
				) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "bad_send", message: "invalid refs" });
					return;
				}
				if (
					refs.length > 16 ||
					refs.some(
						(r) =>
							typeof r !== "object" ||
							r === null ||
							typeof r.project !== "string" ||
							typeof r.session !== "string" ||
							typeof r.mail !== "string" ||
							r.project.length > 128 ||
							r.session.length > 128 ||
							r.mail.length > 128,
					)
				) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "bad_send", message: "invalid refs" });
					return;
				}
				// offline delivery: the target's mailbox must exist (registered at
				// least once); if it is currently online, push an unread notify
				if (!(await this.store.hasMailbox(msg.target.session))) {
					this.reply(ws, {
						t: "error",
						rid: msg.rid,
						code: "no_mailbox",
						message: `target session ${msg.target.session} has no mailbox (never registered)`,
					});
					return;
				}
				const targetWs = this.online.get(msg.target.session);
				const mail: MailRecord = {
					id: randomUUID(),
					from: { project: this.projectId, session: from.session },
					subject: msg.subject,
					body: msg.body,
					refs,
					createdAt: new Date().toISOString(),
					readAt: null,
				};
				await this.store.appendSend(msg.target.session, mail);
				const ref: MailRef = { project: this.projectId, session: msg.target.session, mail: mail.id };
				this.reply(ws, { t: "sent", rid: msg.rid, mail: ref });
				// push updated unread count to the recipient (only when online;
				// offline recipients get the unread backfill on their next hello)
				if (targetWs && targetWs.readyState === WebSocket.OPEN) {
					const inbox = await this.store.inbox(msg.target.session);
					this.reply(targetWs, { t: "notify", unread: MailStore.unreadCount(inbox) });
				}
				return;
			}

			case "inbox": {
				const from = this.conns.get(ws);
				if (!from) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "not_registered", message: "hello first" });
					return;
				}
				const inbox = await this.store.inbox(from.session);
				let mails = [...inbox.values()];
				const filter = msg.filter;
				if (filter?.unreadOnly) mails = mails.filter((m) => !m.readAt);
				if (filter?.since) mails = mails.filter((m) => m.createdAt > filter.since!);
				// newest first; (createdAt, id) is a stable total order
				mails.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.id > b.id ? -1 : 1));

				// cursor: continue strictly after this position (exclusive), newest
				// first. Position-based, not identity-based: skip everything that
				// sorts at or newer than the cursor, so a cursor mail that has since
				// left the filtered set (e.g. marked read under unreadOnly) still
				// paginates without repeats or restarts.
				let start = 0;
				if (msg.cursor !== undefined) {
					const cursor = parseInboxCursor(msg.cursor);
					if (!cursor) {
						this.reply(ws, { t: "error", rid: msg.rid, code: "bad_cursor", message: "invalid cursor" });
						return;
					}
					while (start < mails.length && sortsAtOrNewerThan(mails[start], cursor)) start++;
				}

				const limit = Math.min(Math.max(1, msg.limit ?? DEFAULT_INBOX_LIMIT), MAX_INBOX_LIMIT);
				const page = mails.slice(start, start + limit);
				const reply: InboxReply = { t: "inbox", rid: msg.rid, mails: page };
				if (start + limit < mails.length && page.length > 0) {
					reply.nextCursor = encodeInboxCursor(page[page.length - 1]);
				}
				this.reply(ws, reply);
				return;
			}

			case "read": {
				const from = this.conns.get(ws);
				if (!from) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "not_registered", message: "hello first" });
					return;
				}
				if (msg.mail.project !== this.projectId) {
					this.reply(ws, {
						t: "error",
						rid: msg.rid,
						code: "external_target",
						message: `mail ${msg.mail.mail} belongs to another project`,
					});
					return;
				}
				const inbox = await this.store.inbox(msg.mail.session);
				const mail = inbox.get(msg.mail.mail) ?? null;
				if (!mail) {
					this.reply(ws, { t: "error", rid: msg.rid, code: "not_found", message: `mail ${msg.mail.mail} not found` });
					return;
				}
				// only the owner's read marks it read
				if (msg.mail.session === from.session && !mail.readAt) {
					await this.store.appendRead(msg.mail.session, mail.id, new Date().toISOString());
				}
				this.reply(ws, { t: "mail", rid: msg.rid, mail });
				return;
			}
		}
	}
}
