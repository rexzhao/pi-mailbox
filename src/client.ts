/**
 * Mailbox client: WebSocket connection to a mailbox service, with
 * request/response correlation and reconnect logic.
 *
 * `MailboxConnection` is the high-level object used by the extension:
 * - local mode: participates in leader election, may host the service, and
 *   re-elects on connection loss
 * - remote mode: plain client with backoff reconnect to a fixed address
 */

import { WebSocket } from "ws";
import {
	isServerMsg,
	type AgentRef,
	type ClientMsg,
	type InboxFilter,
	type MailRecord,
	type MailRef,
	type ServerMsg,
	type SessionInfo,
} from "./protocol.ts";
import { ensureService } from "./registry.ts";
import type { ServiceHandle } from "./service.ts";

const REQUEST_TIMEOUT_MS = 5_000;

export class MailboxClient {
	private ws: WebSocket | null = null;
	private nextRid = 1;
	private readonly pending = new Map<number, { resolve: (msg: ServerMsg) => void; reject: (err: Error) => void }>();
	/** This session's full meta as of the last successful registration (from the welcome reply). */
	sessionMeta: Record<string, string> | null = null;
	/** Project UUID, learned from the welcome reply. */
	project: string | null = null;
	/** Set when closed on purpose; suppresses reconnect handling in the caller. */
	closed = false;

	private readonly url: string;
	private readonly session: string;
	private readonly agent: string;
	private readonly helloMeta: Record<string, string> | undefined;
	private readonly onNotify: (unread: number) => void;
	private readonly onUnexpectedClose: () => void;

	constructor(
		url: string,
		session: string,
		agent: string,
		onNotify: (unread: number) => void,
		onUnexpectedClose: () => void,
		helloMeta?: Record<string, string>,
	) {
		this.url = url;
		this.session = session;
		this.agent = agent;
		this.helloMeta = helloMeta;
		this.onNotify = onNotify;
		this.onUnexpectedClose = onUnexpectedClose;
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.url);
			this.ws = ws;
			ws.on("open", () => {
				void this.hello().then(resolve, reject);
			});
			ws.on("message", (data) => this.dispatch(String(data)));
			ws.on("error", (err) => {
				reject(err);
				if (!this.closed) this.onUnexpectedClose();
			});
			ws.on("close", () => {
				if (!this.closed) this.onUnexpectedClose();
			});
		});
	}

	private dispatch(raw: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (!isServerMsg(msg)) return;
		if (msg.t === "notify") {
			this.onNotify(msg.unread);
			return;
		}
		if (typeof msg.rid === "number") {
			const entry = this.pending.get(msg.rid);
			if (entry) {
				this.pending.delete(msg.rid);
				entry.resolve(msg);
			}
		}
	}

	private post(msg: ClientMsg): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("mailbox: not connected");
		this.ws.send(JSON.stringify(msg));
	}

	private request<T>(msg: ClientMsg): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(msg.rid);
				reject(new Error(`mailbox: request timed out (${msg.t})`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(msg.rid, {
				resolve: (reply) => {
					clearTimeout(timer);
					if (reply.t === "error") {
						reject(new Error(`mailbox: ${reply.code}: ${reply.message}`));
					} else {
						resolve(reply as T);
					}
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});
			try {
				this.post(msg);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(msg.rid);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private hello(): Promise<void> {
		return this.request<{ project: string; meta?: Record<string, string> }>({
			t: "hello",
			rid: this.nextRid++,
			session: this.session,
			agent: this.agent,
			meta: this.helloMeta,
		}).then((reply) => {
			this.project = reply.project;
			this.sessionMeta = reply.meta ?? null;
		});
	}

	get isOpen(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	close(): void {
		this.closed = true;
		for (const entry of this.pending.values()) entry.reject(new Error("mailbox: closed"));
		this.pending.clear();
		this.ws?.close(1000);
		this.ws = null;
	}

	sessions(includeOffline?: boolean): Promise<SessionInfo[]> {
		return this.request<{ sessions: SessionInfo[] }>({
			t: "sessions",
			rid: this.nextRid++,
			includeOffline,
		}).then((reply) => reply.sessions);
	}

	setMeta(update: { set?: Record<string, string>; unset?: string[] }): Promise<void> {
		return this.request<unknown>({
			t: "meta",
			rid: this.nextRid++,
			set: update.set,
			unset: update.unset,
		}).then(() => {
			// keep the local view in sync so /mailbox meta reflects changes
			// without a reconnect
			if (this.sessionMeta) {
				if (update.set) {
					for (const [key, value] of Object.entries(update.set)) {
						this.sessionMeta[key] = value;
					}
				}
				if (update.unset) {
					for (const key of update.unset) {
						delete this.sessionMeta[key];
					}
				}
			}
		});
	}

	sendMail(target: AgentRef, subject: string, body: string, refs?: MailRef[]): Promise<MailRef> {
		return this.request<{ mail: MailRef }>({
			t: "send",
			rid: this.nextRid++,
			target,
			subject,
			body,
			refs,
		}).then((reply) => reply.mail);
	}

	inbox(
		filter?: InboxFilter,
		opts?: { limit?: number; cursor?: string },
	): Promise<{ mails: MailRecord[]; nextCursor?: string; total: number; totalUnread: number }> {
		return this.request<{ mails: MailRecord[]; nextCursor?: string; total: number; totalUnread: number }>({
			t: "inbox",
			rid: this.nextRid++,
			filter,
			limit: opts?.limit,
			cursor: opts?.cursor,
		}).then((reply) => ({
			mails: reply.mails,
			nextCursor: reply.nextCursor,
			total: reply.total,
			totalUnread: reply.totalUnread,
		}));
	}

	read(mail: MailRef): Promise<MailRecord | null> {
		return this.request<{ mail: MailRecord | null }>({
			t: "read",
			rid: this.nextRid++,
			mail,
		}).then((reply) => reply.mail);
	}
}

// ---------------------------------------------------------------------------
// connection manager
// ---------------------------------------------------------------------------

export type ConnectionMode = "local" | "remote";

export interface ConnectionEvents {
	onNotify: (unread: number) => void;
	/** Connection dropped or was never established. */
	onDisconnected: () => void;
	/** Connection (re)established and registered. */
	onConnected: () => void;
}

export interface ConnectionOptions {
	/** pi session directory for this cwd; enables orphan-mailbox GC when hosting. */
	sessionsDir?: string;
	/** GC tuning (tests); see ServiceOptions. */
	gcDelayMs?: number;
	gcGraceMs?: number;
	/** Registration-time meta defaults: system keys (`_`-prefixed) refresh on every connect; user keys apply only when absent. */
	helloMeta?: Record<string, string>;
}

export class MailboxConnection {
	private client: MailboxClient | null = null;
	private hosted: ServiceHandle | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private stopped = false;
	/** Bumped on every drop so stale reconnect loops stop. */
	private generation = 0;

	private readonly mode: ConnectionMode;
	private readonly projectDir: string;
	private readonly remoteUrl: string | null;
	private readonly options: ConnectionOptions | undefined;
	readonly session: string;
	private readonly agent: string;
	private readonly events: ConnectionEvents;

	constructor(
		mode: ConnectionMode,
		projectDir: string,
		remoteUrl: string | null,
		session: string,
		agent: string,
		events: ConnectionEvents,
		options?: ConnectionOptions,
	) {
		this.mode = mode;
		this.projectDir = projectDir;
		this.remoteUrl = remoteUrl;
		this.options = options;
		this.session = session;
		this.agent = agent;
		this.events = events;
	}

	get connected(): boolean {
		return this.client?.isOpen ?? false;
	}

	get isHost(): boolean {
		return this.hosted !== null;
	}

	async start(): Promise<void> {
		this.stopped = false;
		// initial attempt throws so callers can report connection failures,
		// but also schedules a retry so a late-starting service is picked up
		try {
			await this.attempt();
		} catch (err) {
			this.events.onDisconnected();
			this.scheduleReconnect(this.generation);
			throw err;
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.generation++;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.client?.close();
		this.client = null;
		if (this.hosted) {
			const hosted = this.hosted;
			this.hosted = null;
			await hosted.stop();
		}
	}

	private scheduleReconnect(generation: number): void {
		if (this.stopped || generation !== this.generation) return;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		const delay = 200 + Math.floor(Math.random() * 800); // stagger competing re-elections
		this.reconnectTimer = setTimeout(() => {
			void this.connectOnce(generation);
		}, delay);
	}

	private async connectOnce(generation = this.generation): Promise<void> {
		if (this.stopped || generation !== this.generation) return;
		try {
			await this.attempt(generation);
		} catch {
			this.events.onDisconnected();
			this.scheduleReconnect(generation);
		}
	}

	private async attempt(generation = this.generation): Promise<void> {
		if (this.stopped || generation !== this.generation) return;
		let url: string;
		const existing = this.hosted; // read once; assigned below without re-reading
		if (this.mode === "local") {
			if (existing) {
				// fast path: we already lead — talk to our own service directly.
				// (ensureService would always see our own flock as held.)
				try {
					url = `ws://127.0.0.1:${existing.port}`;
					await this.openClient(url);
					this.events.onConnected();
					return;
				} catch {
					// our own service died outside handle.stop: stop the handle
					// (releasing the leader lock) and re-elect below
					this.hosted = null;
					await existing.stop().catch(() => undefined);
				}
			}
			// re-election: try to become the leader via the flock; otherwise
			// connect to the registered leader (throws while it is unreachable,
			// the reconnect loop retries)
			const election = await ensureService(this.projectDir, this.options);
			if (election.hosted) {
				if (existing && existing.instanceId !== election.hosted.instanceId) {
					// an unexpected second service won the election; stop ours
					// instead of leaking the handle
					this.hosted = election.hosted;
					await existing.stop().catch(() => undefined);
				} else {
					this.hosted = election.hosted;
				}
			} else if (existing && existing.instanceId !== election.instanceId) {
				// another instance took over; our old service is dead or orphaned —
				// release it so stop() does not leak the http server
				this.hosted = null;
				await existing.stop().catch(() => undefined);
			} else {
				// probe found our own live service; keep the handle
			}
			url = `ws://127.0.0.1:${election.port}`;
		} else {
			url = this.remoteUrl!;
		}
		await this.openClient(url);
		this.events.onConnected();
	}

	private async openClient(url: string): Promise<void> {
		this.client?.close();
		const client = new MailboxClient(
			url,
			this.session,
			this.agent,
			(unread) => this.events.onNotify(unread),
			() => {
				// unexpected close: if we were hosting, drop the handle so the
				// next connectOnce re-runs the election instead of trusting a
				// dead server we still believe we own
				if (this.client === client) {
					this.client = null;
					this.events.onDisconnected();
					this.scheduleReconnect(this.generation);
				}
			},
			this.options?.helloMeta,
		);
		await client.connect();
		this.client = client;
	}

	/** Connected client; throws when disconnected. */
	get mailbox(): MailboxClient {
		if (!this.client?.isOpen) throw new Error("mailbox: not connected");
		return this.client;
	}
}
