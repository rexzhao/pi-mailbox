/**
 * The DSH-side manager: one long-lived instance owns a MailboxController
 * for every live root agent.
 *
 * This is the piece pi cannot have: pi loads one extension per session
 * process, while a DSH host is one Cordis process holding N agents. The
 * manager attaches on agent/created, detaches on agent/disposed, and keeps
 * the persisted login binding so a resumed session re-claims its names.
 * Nothing here is visible to the session itself: it sees ordinary tools and
 * ordinary user-role messages.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFERRED_TOOL_NAMES, MailboxController, type MailboxToolDefinition, type NotifyLevel } from "../core/index.ts";
import { mailboxTotalsViaApi } from "../daemon.ts";
import type { SessionInfo } from "../protocol.ts";
import type {
	DshAgent,
	DshCommandDefinition,
	DshCommandResult,
	DshContext,
	DshMailboxConfig,
	DshSession,
	DshWakeOutcome,
} from "./types.ts";
import { createMailboxHost } from "./host.ts";
import { FileLoginStore } from "./store.ts";
import { toDshTool } from "./tools.ts";

interface Notice {
	message: string;
	level: NotifyLevel;
}

/** One held identity inside a session row (multi-login). */
interface MailboxIdentityRow {
	name: string;
	address: string | null;
	connected: boolean;
	unread: number | null;
}

/** One session's mailbox row: the current identity plus every held identity. */
interface MailboxRow {
	sessionId: string;
	name: string;
	address: string | null;
	connected: boolean;
	unread: number | null;
	archived: boolean;
	identities: MailboxIdentityRow[];
}

interface Binding {
	agent: DshAgent;
	controller: MailboxController;
	/** mailbox_connect: always visible, unwinds with the agent scope. */
	baseTools: Array<() => void>;
	/** The deferred set: registered while connected only. */
	deferredTools: Array<() => void>;
	connectedTools: boolean;
	/** Command output sink while a /mailbox invocation runs. */
	capture: Notice[] | null;
	/** Last unread total reported by the core; null until known. */
	unread: number | null;
	/** Per-identity unread for multi-login (canonical name -> unread). */
	unreadByName: Record<string, number>;
	/** The session is in the workspace archive set: never connected, never delivered. */
	archived: boolean;
	/** A reconcile transition is in flight for this binding. */
	archiveBusy: boolean;
}

type LogLevel = "info" | "warn" | "error";
type LogFn = (message: string) => void;
interface Logger {
	info?: LogFn;
	warn?: LogFn;
	error?: LogFn;
}

function resolveLogger(ctx: DshContext): Logger | undefined {
	const factory = ctx.logger as unknown;
	if (typeof factory !== "function") return undefined;
	try {
		const scoped = (factory as (name: string) => unknown)("dsh-mailbox");
		return typeof scoped === "object" && scoped !== null ? (scoped as Logger) : undefined;
	} catch {
		return undefined;
	}
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isDeferred(name: string): boolean {
	return (DEFERRED_TOOL_NAMES as readonly string[]).includes(name);
}

export class MailboxManager {
	private readonly ctx: DshContext;
	private readonly stateDir: string;
	private readonly rootsOnly: boolean;
	private readonly autoConnect: boolean;
	private readonly sourceKind: string;
	private readonly wakeOnMail: boolean;
	private readonly busyFlush: { delayMs: number; cooldownMs: number } | null;
	private readonly logger: Logger | undefined;
	private readonly bindings = new Map<string, Binding>();
	private readonly disposers: Array<() => void> = [];
	private disposed = false;
	private archiveTimer: NodeJS.Timeout | null = null;
	/** Offline unread lookups, keyed "name@project"; avoids one HTTP call per poll. */
	private readonly unreadCache = new Map<string, { unread: number; at: number }>();

	constructor(ctx: DshContext, config: DshMailboxConfig = {}) {
		this.ctx = ctx;
		this.stateDir =
			config.stateDir?.trim() || join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "storages", "mailbox");
		this.rootsOnly = config.rootsOnly ?? true;
		this.autoConnect = config.autoConnect ?? true;
		this.sourceKind = config.sourceKind?.trim() || "mailbox";
		this.wakeOnMail = config.wakeOnMail === true;
		this.busyFlush =
			(config.notifyWhileBusy ?? true)
				? {
						delayMs: Math.max(0, config.notifyWindowMs ?? 1500),
						cooldownMs: Math.max(0, config.notifyCooldownMs ?? 10000),
					}
				: null;
		this.logger = resolveLogger(ctx);
	}

	/** Adopt every live agent and subscribe to the host lifecycle. */
	start(): void {
		for (const agent of this.ctx.agents.list()) this.adopt(agent);
		this.disposers.push(
			this.ctx.on("agent/created", ({ agent }) => this.adopt(agent)),
			this.ctx.on("agent/disposed", ({ agent }) => this.release(agent)),
			this.ctx.on("session/event", (session, event) => {
				if (event.type !== "turn/end") return;
				const binding = this.bindings.get(session.id);
				if (binding === undefined) return;
				void binding.controller.onTurnEnd().catch((err) => {
					this.log("warn", `turn-end flush failed for ${session.id}: ${describeError(err)}`);
				});
			}),
		);
		this.disposers.push(this.ctx.commands.register(this.command()));
		// The status route is optional: a host without an HTTP carrier (a
		// headless CLI run) simply serves no bar data.
		this.ctx.inject?.(["webServer"], (webCtx) => this.serveStatus(webCtx));
		// Archived sessions must not stay connected: the daemon would deliver
		// mail into a session whose steps the archive gate rejects, and the
		// mail would never reach the model. The workspace registry has no
		// change event, so reconcile the durable set on a timer.
		if (this.service("workspaceRegistry") !== undefined) {
			this.archiveTimer = setInterval(() => this.reconcileArchive(), 2000);
			this.archiveTimer.unref();
		}
	}

	/** Stop every controller and drop every registration. Idempotent. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.archiveTimer !== null) {
			clearInterval(this.archiveTimer);
			this.archiveTimer = null;
		}
		for (const dispose of this.disposers.splice(0)) dispose();
		for (const sessionId of [...this.bindings.keys()]) {
			const binding = this.bindings.get(sessionId);
			if (binding === undefined) continue;
			this.bindings.delete(sessionId);
			this.dropBinding(binding);
		}
	}

	private adopt(agent: DshAgent): void {
		if (this.disposed) return;
		const session = agent.session;
		const sessionId = session?.id;
		const projectRoot = this.projectDirectory(agent);
		if (typeof sessionId !== "string" || projectRoot === undefined) {
			this.log("warn", `skipping session ${String(sessionId)}: no project directory`);
			return;
		}
		if (this.bindings.has(sessionId)) return;
		if (this.rootsOnly && session.header.origin === "subagent") return;

		let store: FileLoginStore;
		let controller: MailboxController;
		let binding: Binding;
		try {
			store = new FileLoginStore(join(this.stateDir, `${sessionId}.json`));
			store.readLogin(); // a corrupt binding file must fail here, not mid-delivery
			controller = new MailboxController(
				createMailboxHost({
					agent,
					projectRoot,
					store,
					sourceKind: this.sourceKind,
					notify: (message, level) => this.notify(binding, message, level),
					onConnectionChanged: () => this.syncTools(binding),
					onUnread: (total, byName) => {
						binding.unread = total;
						binding.unreadByName = byName ?? {};
					},
					busyFlush: this.busyFlush,
					canDeliver: () => !binding.archived,
					wake: this.wakeOnMail ? (origin) => this.wake(origin) : undefined,
				}),
			);
			binding = {
				agent,
				controller,
				baseTools: [],
				deferredTools: [],
				connectedTools: controller.connected,
				capture: null,
				unread: null,
				unreadByName: {},
				archived: this.isArchived(sessionId),
				archiveBusy: false,
			};
		} catch (err) {
			this.log("warn", `cannot attach mailbox to session ${sessionId}: ${describeError(err)}`);
			return;
		}

		this.bindings.set(sessionId, binding);
		for (const definition of controller.tools) {
			if (isDeferred(definition.name)) continue;
			this.registerTool(binding, definition, binding.baseTools);
		}
		this.syncTools(binding);

		if (!binding.archived && this.autoConnect) {
			void controller
				.autoConnect()
				.then(() => this.syncTools(binding))
				.catch((err) => {
					this.log("warn", `auto-connect failed for ${sessionId}: ${describeError(err)}`);
				});
		}
	}

	/**
	 * Register one mailbox tool on the agent scope and re-sync the deferred
	 * set after it runs: a successful mailbox_connect must make the rest of
	 * the tools visible for the very next model request.
	 */
	private registerTool(binding: Binding, definition: MailboxToolDefinition, into: Array<() => void>): void {
		const tool = toDshTool(definition);
		const execute = tool.execute;
		tool.execute = async (args, exec) => {
			try {
				return await execute(args, exec);
			} finally {
				this.syncTools(binding);
			}
		};
		into.push(binding.agent.ctx.tools.register(tool));
	}

	/** Toggle the deferred tool set with the connection state. */
	private syncTools(binding: Binding): void {
		if (this.disposed) return;
		const connected = binding.controller.connected;
		if (binding.connectedTools === connected) return;
		binding.connectedTools = connected;
		if (!connected) {
			for (const dispose of binding.deferredTools.splice(0)) dispose();
			return;
		}
		for (const definition of binding.controller.tools) {
			if (!isDeferred(definition.name)) continue;
			this.registerTool(binding, definition, binding.deferredTools);
		}
	}

	/**
	 * The mailbox project directory: the session's effective working directory
	 * (the header records only the ORIGINAL project; a session may have moved),
	 * pinned once at adoption so later directory changes never move the mailbox.
	 */
	private projectDirectory(agent: DshAgent): string | undefined {
		const working = this.ctx.get?.("workingDirectory") as
			| { get(session: DshSession): string | null }
			| undefined;
		try {
			const effective = working?.get?.(agent.session);
			if (typeof effective === "string" && effective.length > 0) return effective;
		} catch {
			// service present but not ready: fall back to the recorded project
		}
		const recorded = agent.session.header.cwd;
		return typeof recorded === "string" && recorded.length > 0 ? recorded : undefined;
	}

	private release(agent: DshAgent): void {
		const sessionId = agent.session?.id;
		if (typeof sessionId !== "string") return;
		const binding = this.bindings.get(sessionId);
		if (binding === undefined) return;
		this.bindings.delete(sessionId);
		this.dropBinding(binding);
	}

	private dropBinding(binding: Binding): void {
		binding.controller.stop();
		for (const dispose of [...binding.baseTools, ...binding.deferredTools]) dispose();
		binding.baseTools = [];
		binding.deferredTools = [];
	}

	private notify(binding: Binding, message: string, level: NotifyLevel): void {
		if (binding.capture !== null) {
			binding.capture.push({ message, level });
			return;
		}
		this.log(level === "error" ? "error" : level === "warning" ? "warn" : "info", message);
	}

	/** Keep every binding's connection in step with the durable archive set. */
	private reconcileArchive(): void {
		if (this.disposed) return;
		const registry = this.service<{ archivedSessionIds?: readonly string[] }>("workspaceRegistry");
		if (registry === undefined) return;
		let archived: readonly string[];
		try {
			archived = registry.archivedSessionIds ?? [];
		} catch {
			return; // storage not ready: retry on the next tick
		}
		const set = new Set(archived);
		for (const binding of this.bindings.values()) {
			const want = set.has(binding.agent.session.id);
			if (binding.archiveBusy || binding.archived === want) continue;
			binding.archiveBusy = true;
			void this.applyArchive(binding, want).finally(() => {
				binding.archiveBusy = false;
			});
		}
	}

	/**
	 * Disconnect an archived session from the mailbox (its mail then waits in
	 * the daemon) and reconnect it once it is restored. Errors are logged and
	 * retried by the next tick.
	 */
	private async applyArchive(binding: Binding, archived: boolean): Promise<void> {
		const sessionId = binding.agent.session.id;
		try {
			if (archived) {
				await binding.controller.disconnectAll();
				binding.archived = true;
				binding.unread = null;
				this.log("info", `session ${sessionId} archived: mailbox disconnected`);
			} else {
				binding.archived = false;
				await binding.controller.autoConnect();
				this.log("info", `session ${sessionId} unarchived: mailbox reconnected`);
			}
		} catch (err) {
			this.log("warn", `archive reconcile failed for ${sessionId}: ${describeError(err)}`);
		}
	}

	/**
	 * Wake an offline session so it can connect and the unread backfill delivers
	 * the waiting mail. Archived sessions are never woken: they are hidden from
	 * every grouping surface and their mail waits for an explicit unarchive.
	 * A session that is still live but disconnected only needs a reconnect.
	 */
	private async wake(origin: string): Promise<DshWakeOutcome> {
		// Archived is not a failure: there is simply no wake for this session.
		if (this.isArchived(origin)) return { ok: false, reason: "session is archived", silent: true };
		const local = this.bindings.get(origin);
		if (local !== undefined) {
			await local.controller.autoConnect();
			return local.controller.connected
				? { ok: true }
				: { ok: false, reason: "the session did not reconnect" };
		}
		// ctx.get() is the inject-free read: the WakeTarget arrives from the daemon on
		// a connection callback, where a declared-service property access is refused.
		const sessions = this.service<{
			resolveAgent(sessionId: string): Promise<{ agent?: DshAgent; error?: unknown }>;
		}>("sessionController");
		if (sessions === undefined) return { ok: false, reason: "no session controller", silent: true };
		const resolved = await sessions.resolveAgent(origin);
		if (resolved.agent === undefined) {
			throw new Error(`cannot resume session ${origin}: ${describeError(resolved.error)}`);
		}
		return { ok: true };
	}

	/**
	 * The workspace registry owns the durable archive set. A missing registry
	 * (headless compositions without dsh-workspace) means there is no archive
	 * concept; a registry that cannot be read counts as archived so an
	 * unproven wake never disturbs a hidden session.
	 */
	private isArchived(sessionId: string): boolean {
		const registry = this.service<{ archivedSessionIds?: readonly string[] }>("workspaceRegistry");
		if (registry === undefined) return false;
		try {
			return registry.archivedSessionIds?.includes(sessionId) === true;
		} catch (err) {
			this.log("warn", `cannot read the archive set, not waking ${sessionId}: ${describeError(err)}`);
			return true;
		}
	}

	/**
	 * Serve GET /dsh-mailbox/status for the browser-side status bar: one row per
	 * managed session with its live address, connection state, and the last
	 * unread total the core reported.
	 */
	private serveStatus(webCtx: DshContext): void {
		const webServer = webCtx.webServer;
		if (webServer === undefined) return;
		webServer.register({
			kind: "exact",
			path: "/dsh-mailbox/status",
			handler: async (_req, res) => {
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
				});
				res.end(JSON.stringify(await this.status()));
			},
		});
	}

	/**
	 * One row per known mailbox: live bindings plus sessions that have a stored
	 * login binding but no agent right now. A row carries every identity the
	 * session holds (multi-login), each with its own address, connection state,
	 * and unread count.
	 */
	private async status(): Promise<{
		generatedAt: string;
		totalUnread: number;
		mailboxes: MailboxRow[];
	}> {
		const rows = new Map<string, MailboxRow>();
		for (const binding of this.bindings.values()) {
			const sessionId = binding.agent.session.id;
			const current = binding.controller.currentName;
			if (current === null) continue;
			const identities: MailboxIdentityRow[] = binding.controller.heldIdentities.map(({ canonical, claimed }) => ({
				name: claimed,
				address: claimed === current ? binding.controller.address : null,
				connected: binding.controller.isHeld(claimed),
				unread: binding.unreadByName[canonical] ?? null,
			}));
			rows.set(sessionId, {
				sessionId,
				name: current,
				address: binding.controller.address,
				connected: binding.controller.connected,
				unread: binding.unread,
				archived: binding.archived,
				identities,
			});
		}
		for (const file of this.storedBindingFiles()) {
			const sessionId = file.slice(0, -".json".length);
			if (rows.has(sessionId)) continue;
			const stored = this.storedBinding(file);
			if (stored === undefined || stored.names.length === 0) continue;
			const current = stored.current ?? stored.names[0];
			rows.set(sessionId, {
				sessionId,
				name: current,
				address: null,
				connected: false,
				unread: null,
				archived: this.isArchived(sessionId),
				identities: stored.names.map((name) => ({ name, address: null, connected: false, unread: null })),
			});
		}
		const infos = await this.daemonSessions();
		const byName = new Map(infos.map((info) => [info.session, info]));
		for (const row of rows.values()) {
			let total = 0;
			let anyOnline = false;
			for (const identity of row.identities) {
				const info = byName.get(identity.name.toLowerCase());
				if (info !== undefined) {
					if (identity.address === null) identity.address = info.session + "@" + (info.project ?? "");
					if (info.online) {
						identity.connected = true;
						anyOnline = true;
					}
					if (identity.unread === null || !info.online) identity.unread = await this.unreadFor(info.project, info.session);
				}
				total += identity.unread ?? 0;
			}
			if (row.connected || anyOnline) row.connected = true;
			if (row.unread === null) row.unread = total;
		}
		const mailboxes = [...rows.values()];
		return {
			generatedAt: new Date().toISOString(),
			totalUnread: mailboxes.reduce((total, row) => total + (row.unread ?? 0), 0),
			mailboxes,
		};
	}

	/** Binding files are the only identity source for a closed session. */
	private storedBindingFiles(): string[] {
		try {
			return readdirSync(this.stateDir).filter((file) => file.endsWith(".json"));
		} catch {
			return [];
		}
	}

	/** All identities stored for one closed session (multi-login aware). */
	private storedBinding(file: string): { current?: string; names: string[] } | undefined {
		try {
			const parsed = JSON.parse(readFileSync(join(this.stateDir, file), "utf8")) as {
				login?: { current?: unknown; names?: unknown } | null;
			};
			const login = parsed.login;
			if (login === null || login === undefined) return undefined;
			const names = Array.isArray(login.names)
				? login.names.filter((name): name is string => typeof name === "string" && name.length > 0)
				: [];
			const current =
				typeof login.current === "string" && login.current.length > 0 ? login.current : undefined;
			if (names.length === 0 && current === undefined) return undefined;
			return {
				current,
				names: names.length > 0 ? names : current === undefined ? [] : [current],
			};
		} catch {
			return undefined;
		}
	}

	/** Any connected controller can list every mailbox the daemon serves. */
	private async daemonSessions(): Promise<SessionInfo[]> {
		for (const binding of this.bindings.values()) {
			if (!binding.controller.connected) continue;
			try {
				return await binding.controller.requireConnection().mailbox.sessions(true);
			} catch {
				// try the next connection
			}
		}
		return [];
	}

	/** Unread for an offline mailbox, cached briefly: the bar polls every 3s. */
	private async unreadFor(project: string | undefined, name: string): Promise<number | null> {
		if (project === undefined) return null;
		const key = name + "@" + project;
		const cached = this.unreadCache.get(key);
		if (cached !== undefined && Date.now() - cached.at < 5000) return cached.unread;
		const totals = await mailboxTotalsViaApi(project, name);
		if (totals === null) return cached?.unread ?? null;
		this.unreadCache.set(key, { unread: totals.totalUnread, at: Date.now() });
		return totals.totalUnread;
	}

	private command(): DshCommandDefinition {
		return {
			name: "mailbox",
			description: "Connect to the project mailbox, list mails, and manage the connection",
			input: { hint: "list | login <name> | read <id> | send <session> <subject> [body]" },
			handler: async (invocation): Promise<DshCommandResult> => {
				const binding = this.bindings.get(invocation.agent.session.id);
				if (binding === undefined) {
					return {
						kind: "error",
						text: "mailbox: this session has no mailbox (subagent sessions and sessions without a project directory are not managed)",
					};
				}
				const capture: Notice[] = [];
				binding.capture = capture;
				try {
					await binding.controller.executeCommand(invocation.rawInput);
				} finally {
					binding.capture = null;
				}
				this.syncTools(binding);
				const text = capture.map((notice) => notice.message).join("\n");
				if (capture.some((notice) => notice.level === "error") && text.length > 0) {
					return { kind: "error", text };
				}
				return { kind: "success", text: text.length > 0 ? text : "mailbox: ok" };
			},
		};
	}

	/** Read an optional service without declaring it on the plugin inject list. */
	private service<T>(name: string): T | undefined {
		try {
			return this.ctx.get?.(name) as T | undefined;
		} catch {
			return undefined;
		}
	}

	private log(level: LogLevel, message: string): void {
		const logger = this.logger;
		const write = logger?.[level];
		if (write !== undefined) {
			write.call(logger, message);
			return;
		}
		if (level === "error") console.error(`[dsh-mailbox] ${message}`);
		else if (level === "warn") console.warn(`[dsh-mailbox] ${message}`);
		else console.log(`[dsh-mailbox] ${message}`);
	}
}
