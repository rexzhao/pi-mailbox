/**
 * Mailbox service: WebSocket server hosting one project's mailboxes.
 * Runs inside the pi process of whichever session won leader election.
 */

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
	SESSION_ID_RE,
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
				this.reply(ws, {
					t: "welcome",
					rid: msg.rid,
					project: this.projectId,
					instanceId: this.instanceId,
				});
				// backfill: report unread count immediately after registration
				const inbox = await this.store.inbox(msg.session);
				const unread = MailStore.unreadCount(inbox);
				if (unread > 0) this.reply(ws, { t: "notify", unread });
				return;
			}

			case "sessions": {
				const sessions: SessionInfo[] = [];
				for (const [session, connWs] of this.online) {
					if (connWs.readyState !== WebSocket.OPEN) continue;
					const info = this.conns.get(connWs);
					if (!info) continue;
					const state = await this.store.state(session);
					sessions.push({
						session,
						agent: info.agent,
						name: state.meta.name,
						tags: state.meta.tags,
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
				const update: { name?: string | null; tags?: string[] } = {};
				if (msg.name !== undefined) {
						if (msg.name !== null && (typeof msg.name !== "string" || msg.name.length > 128)) {
							this.reply(ws, { t: "error", rid: msg.rid, code: "bad_meta", message: "invalid name" });
							return;
					}
					update.name = msg.name;
				}
				if (msg.tags !== undefined) {
						if (
							!Array.isArray(msg.tags) ||
							msg.tags.length > 32 ||
							msg.tags.some((tag) => typeof tag !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(tag))
						) {
							this.reply(ws, { t: "error", rid: msg.rid, code: "bad_meta", message: "invalid tags" });
							return;
						}
						update.tags = msg.tags;
					}
					if (update.name === undefined && update.tags === undefined) {
						this.reply(ws, { t: "error", rid: msg.rid, code: "bad_meta", message: "nothing to update" });
						return;
					}
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
				const targetWs = this.online.get(msg.target.session);
				if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
					this.reply(ws, {
						t: "error",
						rid: msg.rid,
						code: "offline",
						message: `target session ${msg.target.session} is not online`,
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
				// push updated unread count to the recipient
				const inbox = await this.store.inbox(msg.target.session);
				this.reply(targetWs, { t: "notify", unread: MailStore.unreadCount(inbox) });
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

				// cursor: position after which to continue (exclusive), newest first
				let start = 0;
				if (msg.cursor !== undefined) {
					const cursor = parseInboxCursor(msg.cursor);
					if (!cursor) {
						this.reply(ws, { t: "error", rid: msg.rid, code: "bad_cursor", message: "invalid cursor" });
						return;
					}
					const idx = mails.findIndex((m) => m.createdAt === cursor.createdAt && m.id === cursor.id);
					start = idx >= 0 ? idx + 1 : 0;
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
