/**
 * Mailbox client: WebSocket connection to a mailboxd daemon, with
 * request/response correlation and reconnect logic.
 *
 * There is no in-process service anymore: every connection targets the
 * standalone Go daemon. Local mode resolves (and spawns) the daemon on every
 * attempt, so a restarted daemon on a new port is picked up automatically;
 * remote mode retries a fixed URL with a token.
 */

import { WebSocket } from "ws";
import {
	PROTOCOL_VERSION,
	isServerMsg,
	type AgentRef,
	type ClientMsg,
	type InboxFilter,
	type MailRecord,
	type MailRef,
	type ServerMsg,
	type SessionInfo,
} from "./protocol.ts";
import { deriveProjectId, deriveSessionId, resolveLocalDaemon, connectLocalDaemonIfRunning } from "./daemon.ts";

const REQUEST_TIMEOUT_MS = 5_000;

/** Error carrying the daemon's error code (also embedded in the message). */
export class MailboxError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`mailbox: ${code}: ${message}`);
		this.name = "MailboxError";
		this.code = code;
	}
}

/**
 * Login rejections that retrying can never fix: a held name, an invalid
 * name, or a daemon that ignored the login (old daemon). These stop the
 * reconnect loop instead of hammering the daemon with a doomed hello.
 */
const FATAL_LOGIN_CODES = new Set(["mailbox_in_use", "bad_name", "login_failed"]);

export function isFatalLoginError(err: unknown): boolean {
	return err instanceof MailboxError && FATAL_LOGIN_CODES.has(err.code);
}

export class MailboxClient {
	private ws: WebSocket | null = null;
	private nextRid = 1;
	private readonly pending = new Map<number, { resolve: (msg: ServerMsg) => void; reject: (err: Error) => void }>();
	/** Project UUID, learned from the welcome reply. */
	project: string | null = null;
	/** This session's full meta as of the last successful registration (from the welcome reply). */
	sessionMeta: Record<string, string> | null = null;
	/** Set when closed on purpose; suppresses reconnect handling in the caller. */
	closed = false;

	private readonly url: string;
	private readonly hello: {
		project: string;
		projectRoot?: string;
		sessionDir?: string;
		session: string;
		as?: string;
		tags?: string;
		origin?: string;
		agent: string;
		token?: string;
		meta?: Record<string, string>;
	};
	private readonly onNotify: (unread: number) => void;
	private readonly onUnexpectedClose: () => void;

	constructor(
		url: string,
		hello: {
			project: string;
			projectRoot?: string;
			sessionDir?: string;
			session: string;
			as?: string;
			tags?: string;
			origin?: string;
			agent: string;
			token?: string;
			meta?: Record<string, string>;
		},
		onNotify: (unread: number) => void,
		onUnexpectedClose: () => void,
	) {
		this.url = url;
		this.hello = hello;
		this.onNotify = onNotify;
		this.onUnexpectedClose = onUnexpectedClose;
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.url);
			this.ws = ws;
			ws.on("open", () => {
				void this.handshake().then(resolve, reject);
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
						reject(new MailboxError(reply.code, reply.message));
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

	private handshake(): Promise<void> {
		return this.request<{ project: string; mailbox?: string; meta?: Record<string, string>; protocolVersion?: number }>({
			t: "hello",
			rid: this.nextRid++,
			...this.hello,
		}).then(
			(reply) => {
				if (reply.protocolVersion !== undefined && reply.protocolVersion !== PROTOCOL_VERSION) {
					this.ws?.terminate();
					throw new Error(
						`mailbox: protocol version mismatch (daemon ${reply.protocolVersion}, client ${PROTOCOL_VERSION})`,
					);
				}
				// verify the login was applied, but only when one was
				// requested: an old daemon never echoes `mailbox`, and
				// non-login connections to it must stay compatible. With a
				// login, a missing or wrong echo means the daemon ignored
				// or mis-applied the claim.
				if (this.hello.as !== undefined) {
					const expected = this.hello.as;
					if (reply.mailbox !== expected) {
						this.ws?.terminate();
						throw new MailboxError(
							"login_failed",
							reply.mailbox === undefined
								? `daemon did not confirm the login as '${expected}' (old daemon?)`
								: `daemon registered us as ${reply.mailbox}, expected ${expected}`,
						);
					}
				}
				this.project = reply.project;
				this.sessionMeta = reply.meta ?? null;
			},
			(err) => {
				// close the socket on handshake failure so it is not leaked
				this.ws?.terminate();
				throw err;
			},
		);
	}

	get isOpen(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	close(): void {
		this.closed = true;
		for (const entry of this.pending.values()) entry.reject(new Error("mailbox: closed"));
		this.pending.clear();
		this.ws?.terminate();
		this.ws = null;
	}

	sessions(includeOffline?: boolean): Promise<SessionInfo[]> {
		return this.request<{ sessions: SessionInfo[] }>({
			t: "sessions",
			rid: this.nextRid++,
			includeOffline,
		}).then((reply) => reply.sessions ?? []);
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
		return this.request<{
			mails?: MailRecord[];
			nextCursor?: string;
			total: number;
			totalUnread: number;
		}>({
			t: "inbox",
			rid: this.nextRid++,
			filter,
			limit: opts?.limit,
			cursor: opts?.cursor,
		}).then((reply) => ({
			mails: reply.mails ?? [],
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
		}).then((reply) => reply.mail ?? null);
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
}

// ---------------------------------------------------------------------------
// connection manager
// ---------------------------------------------------------------------------

export type ConnectionMode = "local" | "remote";

export interface ConnectionOptions {
	/** Named-mailbox login: claim this name instead of the derived session id. */
	login?: { as: string; tags?: string };
	/** Registration-time meta defaults: system keys (`_`-prefixed) refresh on every connect; user keys apply only when absent. */
	helloMeta?: Record<string, string>;
	/** When true, the connection may spawn a new daemon when none is running. Only /mailbox start service sets this. */
	canSpawn?: boolean;
}

export interface ConnectionEvents {
	onNotify: (unread: number) => void;
	/** Connection dropped or was never established. */
	onDisconnected: () => void;
	/** Connection (re)established and registered. */
	onConnected: () => void;
}

export interface RemoteTarget {
	host: string;
	port: number;
	token?: string;
}

export class MailboxConnection {
	private client: MailboxClient | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private stopped = false;
	/** True when the last failure was a permanent login rejection (no retry). */
	get loginRejected(): boolean {
		return this.loginRejectedFlag;
	}
	private loginRejectedFlag = false;
	/** Bumped on every drop so stale reconnect loops stop. */
	private generation = 0;

	private readonly mode: ConnectionMode;
	/** Project root directory (workspace cwd for the herdr wake). */
	readonly projectDir: string;
	/** Remote target this connection dials (null in local mode). */
	get remoteTarget(): RemoteTarget | null {
		return this.remote;
	}
	private readonly remote: RemoteTarget | null;
	readonly session: string;
	/** Short mailbox session id (derived from agent + session). This is the wire identity. */
	readonly shortSession: string;
	private readonly agent: string;
	private readonly events: ConnectionEvents;
	private readonly options: ConnectionOptions;

	constructor(
		mode: ConnectionMode,
		projectDir: string,
		remote: RemoteTarget | null,
		session: string,
		agent: string,
		events: ConnectionEvents,
		options?: ConnectionOptions,
	) {
		this.mode = mode;
		this.projectDir = projectDir;
		this.remote = remote;
		this.session = session;
		this.shortSession = deriveSessionId(agent, session);
		this.agent = agent;
		this.events = events;
		this.options = options ?? {};
	}

	get connected(): boolean {
		return this.client?.isOpen ?? false;
	}

	/** The effective mailbox id: the login name when logged in, else the derived session id. */
	get mailboxId(): string {
		return this.options.login?.as ?? this.shortSession;
	}

	/** This session's mailbox address, `mailbox@project`, once registered (the login name when logged in). */
	get address(): string | null {
		if (!this.client?.project) return null;
		return `${this.mailboxId}@${this.client.project}`;
	}

	async start(): Promise<void> {
		this.stopped = false;
		// initial attempt throws so callers can report connection failures,
		// but also schedules a retry so a late-starting daemon is picked up
		try {
			await this.attempt();
		} catch (err) {
			this.events.onDisconnected();
			if (isFatalLoginError(err)) {
				this.stopped = true; // permanent: no reconnect loop
				this.loginRejectedFlag = true;
			} else {
				this.scheduleReconnect(this.generation);
			}
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
	}

	private scheduleReconnect(generation: number): void {
		if (this.stopped || generation !== this.generation) return;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		const delay = 200 + Math.floor(Math.random() * 800); // stagger retries
		this.reconnectTimer = setTimeout(() => {
			void this.connectOnce(generation);
		}, delay);
	}

	private async connectOnce(generation = this.generation): Promise<void> {
		if (this.stopped || generation !== this.generation) return;
		try {
			await this.attempt();
		} catch (err) {
			this.events.onDisconnected();
			// login rejections are permanent: retrying the same doomed
			// hello forever would hammer the daemon
			if (isFatalLoginError(err)) {
				this.stopped = true;
				this.loginRejectedFlag = true;
				return;
			}
			this.scheduleReconnect(generation);
		}
	}

	private async attempt(): Promise<void> {
		if (this.stopped) return;
		const generation = this.generation;
		let url: string;
		const hello: {
			project: string;
			projectRoot?: string;
			sessionDir?: string;
			session: string;
			as?: string;
			tags?: string;
			origin: string;
			agent: string;
			token?: string;
			meta?: Record<string, string>;
		} = {
			project: await deriveProjectId(this.projectDir),
			session: this.shortSession,
			as: this.options.login?.as,
			tags: this.options.login?.tags,
			origin: this.session,
			agent: this.agent,
			meta: this.options.helloMeta,
		};
		if (this.mode === "local") {
			let endpoint;
			if (this.options.canSpawn) {
				endpoint = await resolveLocalDaemon();
			} else {
				const running = await connectLocalDaemonIfRunning();
				if (!running) {
					throw new Error("mailbox: daemon not running; run /mailbox start service");
				}
				endpoint = running;
			}
			url = endpoint.url;
			hello.projectRoot = this.projectDir;
			hello.sessionDir = this.sessionDirProvider?.();
		} else {
			url = `ws://${this.remote!.host}:${this.remote!.port}`;
			hello.token = this.remote!.token;
		}
		// stop() may have run during the async resolution above (up to 10s
		// for a daemon spawn); bail instead of opening a post-stop connection
		if (this.stopped || generation !== this.generation) return;
		await this.openClient(url, hello);
		this.events.onConnected();
	}

	/** pi session directory provider (set by the extension for the lifecycle GC). */
	sessionDirProvider: (() => string | undefined) | null = null;

	private async openClient(
		url: string,
		hello: {
			project: string;
			projectRoot?: string;
			sessionDir?: string;
			session: string;
			as?: string;
			tags?: string;
			origin?: string;
			agent: string;
			token?: string;
			meta?: Record<string, string>;
		},
	): Promise<void> {
		this.client?.close();
		const client = new MailboxClient(
			url,
			hello,
			(unread) => this.events.onNotify(unread),
			() => {
				if (this.client === client) {
					this.client = null;
					this.events.onDisconnected();
					this.scheduleReconnect(this.generation);
				}
			},
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
