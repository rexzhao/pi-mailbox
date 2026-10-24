/**
 * MailboxController: the host-agnostic core of pi-mailbox.
 *
 * One controller per SESSION (one pi session / one hosted agent identity).
 * It manages the session's mailbox presence end to end: any number of
 * named logins (multi-login — each name is its own connection; a name is
 * still held by at most one session), auto-reconnect, the hold-and-flush
 * notification pipeline, the force gate, the deferred release (model E),
 * the agent tools, and the /mailbox command. The host injects every
 * environment dependency through MailboxHost; the controller has NO
 * module-level mutable state, so many controllers (different identities)
 * can coexist in one process without interference.
 *
 * Lifecycle: the controller stops ONLY when the host calls stop() (the pi
 * extension wires it to session_shutdown); silence on the event entry
 * points never disconnects anything. deliver() may be async — the flush
 * pipeline awaits it and re-arms on failure, so a host that opens a
 * session on demand can deliver late.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isFatalLoginError, MailboxConnection, MailboxError, type RemoteTarget } from "../client.ts";
import {
	connectLocalDaemonIfRunning,
	deleteMailboxViaApi,
	deriveProjectId,
	fetchSessionsViaApi,
	findMailboxdBinary,
	mailboxTotalsViaApi,
	resolveLocalDaemon,
} from "../daemon.ts";
import type { BindingInfo, MailRecord } from "../protocol.ts";
import type { LoginBinding } from "./login-binding.ts";
import { httpBase } from "./format.ts";
import { validMailboxName } from "./names.ts";
import type { DeleteOutcome } from "./types.ts";
import { executeMailboxCommand, mailboxArgumentCompletions } from "./command.ts";
import { buildToolDefinitions } from "./tools.ts";

// ---------------------------------------------------------------------------
// host interface
// ---------------------------------------------------------------------------

/** The session identity a controller acts as. Read live per use. */
export interface MailboxIdentity {
	/** Stable agent kind (session-id derivation input; e.g. "pi"). */
	agent: string;
	/** The full session id (the mailbox `_origin`). */
	sessionId: string;
	/** Project root directory (mailbox project derivation input). */
	cwd: string;
}

/** The persisted login state (the plugin shells it with session entries). */
export interface MailboxLoginStore {
	/** All held names plus the current identity; null = logged out. */
	readLogin(): LoginBinding | null;
	/** Persist (or clear with null) the binding. */
	writeLogin(binding: LoginBinding | null): void;
	/** Names with a pending deferred release (logout that could not reach the daemon). */
	readRelease(): string[];
	/** Queue releases, or clear the pending set with null. */
	writeRelease(names: string[] | null): void;
}

/** What a wake provider receives (structurally herdr's WakeTarget). */
export interface WakeTarget {
	session: string;
	origin: string;
	projectRoot: string;
	label?: string;
	named?: boolean;
	sessionDir?: string;
}

/** ok:false with silent:true = no wake environment: skip without reporting. */
export type WakeResult =
	| { ok: true; detail: string; paneId?: string }
	| { ok: false; reason: string; silent?: boolean };

export type NotifyLevel = "info" | "warning" | "error";

/**
 * Everything the core needs from its environment. Optional members have
 * defaults; a host that omits them simply loses the corresponding feature
 * (wake, resume, view's browser open) instead of failing.
 */
export interface MailboxHost {
	identity: MailboxIdentity;
	loginStore: MailboxLoginStore;
	/** Deliver a composed notification into the agent's input stream (pi: sendUserMessage steer). May be async. */
	deliver(text: string): void | Promise<void>;
	/** True while the agent is running (holds notifications until a turn boundary). */
	isBusy(): boolean;
	/**
	 * While busy: deliver held notices after this debounce instead of waiting
	 * for the turn boundary. null/undefined keeps the historical hold-until-
	 * turn-end behavior; the host is responsible for making such a delivery
	 * land at a step boundary (pi: steer, DSH: agent.steer).
	 */
	busyFlushDelayMs?(): number | null;
	/** While busy: minimum gap between delivered notices (default 0). */
	busyFlushCooldownMs?(): number;
	/**
	 * True when the host flushes held notices at step boundaries by calling
	 * onStepBoundary(); while set, arrival does not schedule a busy timer.
	 */
	flushAtStepBoundary?(): boolean;
	/** Notification gate (pi json mode is a pure event stream); default true. */
	canDeliver?(): boolean;
	/** Human-facing notices (/mailbox command output, warnings). */
	notify?(message: string, level?: NotifyLevel): void;
	/** Unread badge: total plus per-identity detail. null = disconnected. */
	setUnread?(total: number | null, byName?: Record<string, number> | null): void;
	/** Connection state changed (repaint footers, toggle tool activation). */
	onConnectionChanged?(): void;
	/** Registration-time hello meta (system keys like _pi/_host/_model; local-only keys gated by opts.remote). */
	helloMeta?(opts: { remote: boolean }): Record<string, string>;
	/** Wake an offline target (the plugin injects herdr; default: no wake). */
	wake?(target: WakeTarget): Promise<WakeResult>;
	/** Is a live-but-disconnected process still running on this origin? (/mailbox resume double-open check; e.g. herdr pane id). */
	findLiveSession?(origin: string): Promise<string | null>;
	/** Switch the host's terminal/session to another session file (/mailbox resume). */
	switchSession?(sessionFile: string): Promise<{ cancelled: boolean }>;
	/** Open a URL in a browser (/mailbox view). */
	openUrl?(url: string): void;
	/** The pi session directory (session file lookup for resume and wake). */
	sessionDir?(): string | undefined;
}

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

const FORCE_GATE_TTL_MS = 5 * 60 * 1000;
const SUBJECT_MAX = 80;

export interface ConnectionStatus {
	address: string;
	mails: { total: number; unread: number };
	// null when the sessions query failed; counted from the same
	// SessionInfo.online field the sessions tool exposes
	onlineClients: number | null;
}

export class MailboxController {
	private readonly host: MailboxHost;
	/** Canonical (lowercase) name -> its connection. */
	private readonly connections = new Map<string, MailboxConnection>();
	/** The current identity (last successful login), canonical. */
	private current: string | null = null;
	/** Set by stop(): in-flight connects must not adopt the dead runtime. */
	private stopped = false;
	/** Remote target for future connects (/mailbox host:port), else local. */
	private remote: RemoteTarget | null = null;

	// notification pipeline state
	private readonly pendingUnread = new Map<string, number>();
	private readonly unreadByConn = new Map<string, number>();
	private flushing = false;
	private flushTimer: NodeJS.Timeout | null = null;
	/** When the last composed notice was handed to the host (busy cooldown). */
	private lastDeliveredAt = 0;
	/** Mail ids already included in a notification (bounded). */
	private announced = new Set<string>();

	// force gate: forced takeover is only allowed right after a normal
	// attempt for the same name failed with name_held (anti-abuse; the
	// human-facing /mailbox login --force path bypasses this — typing the
	// flag IS the confirmation)
	private lastHeld: { name: string; at: number } | null = null;

	/** Rename-login in flight: a second rename while the first attempt is
	 * still settling is ignored. */
	private renameLoginInFlight = false;

	private readonly toolDefs: ReturnType<typeof buildToolDefinitions>;

	constructor(host: MailboxHost) {
		this.host = host;
		this.toolDefs = buildToolDefinitions(this);
	}

	// -- state ------------------------------------------------------------

	/** True when the current identity's connection is live. */
	get connected(): boolean {
		return this.connOf(this.current)?.connected ?? false;
	}

	/** The current identity's full address (claimed spelling), or null. */
	get address(): string | null {
		return this.connOf(this.current)?.address ?? null;
	}

	/** The current identity's canonical name, or null when holding none. */
	get currentName(): string | null {
		return this.current;
	}

	/** All held names (canonical), insertion order. */
	get heldNames(): string[] {
		return [...this.connections.keys()];
	}

	/**
	 * All held identities with their CLAIMED spellings: live connections
	 * (mailboxId carries the claimed case) plus any bound-but-disconnected
	 * names still in the persisted binding. Completion surfaces use this.
	 */
	get heldIdentities(): Array<{ canonical: string; claimed: string }> {
		const byCanonical = new Map<string, string>();
		for (const [canonical, c] of this.connections) byCanonical.set(canonical, c.mailboxId);
		for (const n of this.host.loginStore.readLogin()?.names ?? []) {
			const canonical = n.toLowerCase();
			if (!byCanonical.has(canonical)) byCanonical.set(canonical, n);
		}
		return [...byCanonical.entries()].map(([canonical, claimed]) => ({ canonical, claimed }));
	}

	/** The current identity's canonical name, falling back to the persisted binding's current (claimed, folded) when disconnected. */
	get currentIdentity(): string | null {
		if (this.current !== null) return this.current;
		return this.host.loginStore.readLogin()?.current.toLowerCase() ?? null;
	}

	/** The remote target in use (null = local daemon). */
	get remoteTarget(): RemoteTarget | null {
		return this.remote;
	}

	/** Set the remote target for subsequent connects (/mailbox host:port). */
	setRemote(remote: RemoteTarget | null): void {
		this.remote = remote;
	}

	/** The host (command/tool internal use). */
	get hostRef(): MailboxHost {
		return this.host;
	}

	private connOf(name: string | null | undefined): MailboxConnection | undefined {
		if (name === null || name === undefined) return undefined;
		return this.connections.get(name);
	}

	/** Command output channel (the /mailbox command's notify funnel). */
	hostNotify(message: string, level: NotifyLevel): void {
		this.host.notify?.(message, level);
	}

	/** True when this session currently holds (is connected as) the name. */
	isHeld(name: string): boolean {
		return this.connections.get(name.toLowerCase())?.connected ?? false;
	}

	/**
	 * The connection for an identity: the named one when `as` is given
	 * (must be logged in), else the current one (must be connected).
	 */
	requireConnection(as?: string): MailboxConnection {
		if (as !== undefined) {
			const name = as.toLowerCase();
			const c = this.connections.get(name);
			if (!c?.connected) {
				const held = this.heldNames.join(", ");
				throw new Error(
					`mailbox '${name}' is not logged in on this session${held ? ` (holding: ${held})` : ""}; connect with mailbox_connect as='${name}' first`,
				);
			}
			return c;
		}
		const c = this.connOf(this.current);
		if (!c?.connected) throw new Error("mailbox not connected; run /mailbox start service or the mailbox_connect tool first");
		return c;
	}

	// -- lifecycle events --------------------------------------------------

	onAgentStart(): void {
		// busy state is read live from host.isBusy(); nothing to track
	}

	private settle(): void {
		// a notify held through the final settlement window has no turn_end
		// left to flush it; deliver it once the run has fully settled
		if (this.pendingUnread.size > 0) this.scheduleIdleFlush();
	}

	// agent_end closes one low-level run, but retries, compaction, and
	// follow-up work can still continue; agent_settled is the final
	// boundary. Both clear busy (read live from the host): deliverAs
	// "steer" is only applied while streaming, so an early clear during
	// the settlement window is safe — and a missing agent_settled must
	// never wedge notifications.
	onAgentEnd(): void {
		this.settle();
	}

	onAgentSettled(): void {
		this.settle();
	}

	/**
	 * Step boundary: the host calls this after each step settles. With the
	 * flushAtStepBoundary policy, everything that arrived during the step is
	 * coalesced into ONE notice and steered before the next model call.
	 */
	async onStepBoundary(): Promise<void> {
		if (this.host.flushAtStepBoundary?.() !== true) return;
		if (this.pendingUnread.size === 0) return;
		if (!this.host.isBusy()) {
			this.scheduleIdleFlush();
			return;
		}
		await this.flushNotifications();
	}

	// turn boundary: steered messages are delivered right after turn_end
	// handlers run, so a notification flushed here is seen by the very next
	// LLM call — and everything that arrived during the finished turn is
	// coalesced into that single message
	async onTurnEnd(): Promise<void> {
		if (this.pendingUnread.size > 0) await this.flushNotifications();
	}

	/** Stop every connection and timer. Idempotent; the ONLY permanent stop. */
	stop(): void {
		this.stopped = true;
		if (this.flushTimer !== null) clearTimeout(this.flushTimer);
		this.flushTimer = null;
		for (const c of this.connections.values()) void c.stop();
		this.connections.clear();
		this.current = null;
		this.pushUnread();
	}

	/** Alias of stop() (the pi extension wires this to session_shutdown). */
	onShutdown(): void {
		this.stop();
	}

	// -- auto-connect / rename login ----------------------------------------

	/**
	 * Silent auto-connect on startup: a session that has logged in before
	 * (a stored binding) reconnects ALL its held names automatically when
	 * the daemon is already running. Never spawns the daemon; stays silent
	 * on success and transient failures — only permanent login rejections
	 * (e.g. a name was taken over) surface to the user.
	 */
	async autoConnect(): Promise<void> {
		try {
			if (this.stopped || !this.canDeliver() || this.anyConnected()) return;
			const binding = this.host.loginStore.readLogin();
			if (!binding || binding.names.length === 0) return; // never logged in: nothing to do
			const endpoint = await connectLocalDaemonIfRunning();
			if (this.stopped) return; // session ended during the probe
			if (!endpoint) return; // daemon down: stay silent, no spawn
			await this.connectBinding(); // binding auto-applies
			if (this.stopped) await this.disconnectAll(); // runtime torn down mid-connect
		} catch (err) {
			// silent, except permanent login rejections — being displaced
			// from your name is something the user must learn about
			if (isFatalLoginError(err)) {
				try {
					await this.host.deliver(`[mailbox] auto-login failed: ${err instanceof Error ? err.message : String(err)}`);
				} catch {
					// injection races with run state; the next manual connect surfaces it
				}
			}
		}
	}

	/**
	 * Auto-login from a session rename: fires only when the session holds
	 * NO identity yet (nothing connected, no stored binding) and the new
	 * name is a VALID mailbox name (strict grammar — anything else is just
	 * a display name, not a login attempt). Requires a running daemon (no
	 * spawn); failures surface as a notice, never a force.
	 */
	async onSessionNameChanged(name: string | undefined): Promise<void> {
		if (name === undefined) return; // name cleared
		if (this.anyConnected()) return; // already connected under an identity
		if (this.host.loginStore.readLogin()) return; // has a login binding: renaming does not re-login
		if (!validMailboxName(name)) return; // not mailbox-name-shaped: just a display name
		if (this.renameLoginInFlight) return; // a rename-login is still settling
		this.renameLoginInFlight = true;
		try {
			await this.loginFromSessionName(name);
		} finally {
			this.renameLoginInFlight = false;
		}
	}

	private async loginFromSessionName(name: string): Promise<void> {
		const endpoint = await connectLocalDaemonIfRunning();
		if (!endpoint) {
			this.host.notify?.(
				`mailbox: session name '${name}' is a valid mailbox name, but the daemon is not running — run /mailbox start service, then /mailbox login ${name}`,
				"info",
			);
			return;
		}
		try {
			const connection = await this.login({ as: name });
			this.host.notify?.(`mailbox: logged in as ${connection.address} (from the session name)`, "info");
		} catch (err) {
			this.host.notify?.(
				`mailbox: auto-login from the session name failed: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	}

	// -- login / logout ------------------------------------------------------

	/**
	 * Log in to a named mailbox, ADDING it to the session's held names
	 * (multi-login) and making it the current identity. A held name
	 * rejects with name_held / mailbox_in_use; a same-name re-login
	 * replaces the session's own previous connection for that name. On
	 * failure the previous state is restored (identity-checked rollback).
	 */
	async login(opts: { as: string; tags?: string; force?: boolean; fromBinding?: boolean }): Promise<MailboxConnection> {
		if (this.stopped) throw new Error("mailbox: controller stopped");
		const name = opts.as.toLowerCase();
		const fromBinding = opts.fromBinding === true;
		const effective: { as: string; tags?: string; force?: boolean } = { as: opts.as, tags: opts.tags };
		if (opts.force === true && !fromBinding) effective.force = true;
		// the previous connection for THIS name is only torn down after the
		// new one is live: a rejected login must leave it connected
		const previous = this.connections.get(name);
		const identity = this.host.identity;
		const helloMeta: Record<string, string> = { ...(this.host.helloMeta?.({ remote: this.remote !== null }) ?? {}) };
		const pendingRelease = this.host.loginStore.readRelease();
		const connection = new MailboxConnection(
			this.remote ? "remote" : "local",
			identity.cwd,
			this.remote,
			identity.sessionId,
			identity.agent,
			{
				onNotify: (unread) => this.handleNotify(unread, name),
				onConnected: () => {
					this.host.onConnectionChanged?.();
					void this.refreshUnread(name);
					// clear the pending release ONLY when the daemon acked it
					// (welcome.released === true). An old daemon that ignores
					// the release field must leave it pending so the next
					// hello retries.
					if (connection.releaseAcked === true && this.host.loginStore.readRelease().length > 0) {
						this.host.loginStore.writeRelease(null);
					}
				},
				onDisconnected: () => {
					// replaced-signal: another live connection for THIS name
					// took over (typically the same session open in two
					// agents). The connection has stood down (no retry loop —
					// retrying would ping-pong forever); say so once. Self-
					// switches (login replacing our own previous connection
					// for the name) do not land here: the map already points
					// at the new connection when the old one's close fires.
					const c = this.connections.get(name);
					if (c === connection && connection.replaced && !connection.connected) {
						this.connections.delete(name);
						if (this.current === name) this.current = this.firstConnectedName();
						this.persistBinding();
						this.host.notify?.(
							"mailbox: this session's mailbox was taken over by another connection — is this session open in two places? Close the other one, then reconnect with /mailbox start service",
							"warning",
						);
					}
					this.pushUnread();
					this.host.onConnectionChanged?.();
				},
			},
			{
				login: effective,
				release: pendingRelease.length > 0 ? pendingRelease.join(",") : undefined,
				helloMeta,
			},
		);
		// the wake path needs the pi session directory (not the hello)
		connection.sessionDirProvider = () => this.host.sessionDir?.();
		this.connections.set(name, connection);
		try {
			await connection.start();
			this.lastHeld = null; // any success clears the force gate
			this.current = name;
			this.persistBinding();
		} catch (err) {
			// force-gate bookkeeping for explicit (non-binding) logins
			if (!fromBinding) {
				if (err instanceof MailboxError && err.code === "name_held" && !effective.force) {
					this.lastHeld = { name, at: Date.now() };
				} else if (!(err instanceof MailboxError && err.code === "name_held" && effective.force)) {
					this.lastHeld = null; // any other error code clears it
				}
			}
			// failure rollback — OWNERSHIP-CHECKED: only undo THIS call's own
			// assignment. Two overlapping login calls for the same name race
			// (A assigns and is still inside start(); B's prologue overwrites
			// the slot); whichever settles first must neither clobber nor
			// delete the other's assignment. The loser restores what was
			// there before IT — restoring a still-starting previous is safe:
			// it settles itself. With no racing call, previous is the
			// pre-prologue value, so single-call semantics are identical.
			if (previous?.connected || isFatalLoginError(err)) {
				// identity switch failed (rejected login, or a transient error
				// mid-switch), or a permanent login rejection on a fresh slot:
				// no half-open second connection, no retry loop; restore the
				// previous occupant (a dead one simply reads as disconnected;
				// an empty slot is deleted)
				await connection.stop();
				if (this.connections.get(name) === connection) {
					if (previous !== undefined) this.connections.set(name, previous);
					else this.connections.delete(name);
				}
				if (this.current === name) this.current = this.firstConnectedName();
			} else {
				// first connection (or a dead previous), transient failure:
				// keep the retry loop armed (a late-starting daemon is picked
				// up automatically) — the entry stays in the map but is not
				// the current identity
				if (this.current === name) this.current = this.firstConnectedName();
			}
			// displaced from our stored binding: the name was taken over
			// (online or offline). Remove it from the binding so resumes do
			// not die on it forever, and say what happened.
			if (fromBinding && err instanceof MailboxError && (err.code === "mailbox_in_use" || err.code === "name_held")) {
				this.removeFromBinding(name);
				throw new MailboxError(
					err.code,
					`you were displaced from '${opts.as}' by another session (${err.message}); ` +
						"log in again with /mailbox login <name> (add --force to take it back if the new holder is offline and the user confirms)",
				);
			}
			// every end state here (restored previous identity included) must
			// repaint, which reads the final state live
			this.host.onConnectionChanged?.();
			throw err;
		}
		await previous?.stop();
		return connection;
	}

	/**
	 * Log out of one held name (deferred release rides the next hello), or
	 * of ALL held names when no name is given.
	 */
	async logout(name?: string | null): Promise<void> {
		if (name === undefined || name === null) {
			// all: disconnect everything, queue one release per held name
			// (plus names that are only in the binding), clear the binding
			const held = [...new Set([...this.host.loginStore.readRelease(), ...this.heldNames, ...this.bindingFallbackNames()])];
			if (held.length > 0) this.host.loginStore.writeRelease(held);
			await this.disconnectAll();
			this.host.loginStore.writeLogin(null); // resumes no longer auto-login
			this.host.notify?.(
				`mailbox: logged out (daemon keeps running)${held.length > 0 ? ` — ${held.join(", ")} will be released on next connect` : ""}`,
				"info",
			);
			return;
		}
		const canonical = name.toLowerCase();
		const conn = this.connections.get(canonical);
		const binding = this.host.loginStore.readLogin();
		const wasHeld = conn !== undefined || (binding?.names.includes(canonical) ?? false);
		if (!wasHeld) {
			this.host.notify?.(`mailbox: not logged in as '${canonical}'`, "warning");
			return;
		}
		// model E: record the pending release so it rides the next hello
		// (survives daemon downtime and pi restarts); the daemon clears the
		// _holds marker when it processes the hello
		this.host.loginStore.writeRelease([...new Set([...this.host.loginStore.readRelease(), canonical])]);
		if (conn) {
			await conn.stop();
			this.connections.delete(canonical);
		}
		if (this.current === canonical) this.current = this.firstConnectedName();
		this.removeFromBinding(canonical);
		this.pushUnread();
		this.host.onConnectionChanged?.();
		this.host.notify?.(
			`mailbox: logged out of '${canonical}' (daemon keeps running) — it will be released on next connect`,
			"info",
		);
	}

	/**
	 * Stop every connection WITHOUT the permanent stop flag (logout /
	 * stop service / restart service): the controller stays usable and a
	 * later login reconnects normally. stop() (session shutdown) is the
	 * only permanent path.
	 */
	async disconnectAll(): Promise<void> {
		for (const c of this.connections.values()) await c.stop();
		this.connections.clear();
		this.current = null;
		this.host.onConnectionChanged?.();
		this.pushUnread();
	}

	private bindingFallbackNames(): string[] {
		const binding = this.host.loginStore.readLogin();
		return binding ? binding.names : [];
	}

	/**
	 * Connect every name in the stored binding (auto-login on resume /
	 * service start). The binding's current identity wins when it
	 * connects; otherwise the first live connection becomes current.
	 */
	async connectBinding(): Promise<MailboxConnection> {
		const binding = this.host.loginStore.readLogin();
		if (!binding || binding.names.length === 0) {
			throw new Error("mailbox: no login for this session — use /mailbox login <name> first (or mailbox_connect with as='<name>')");
		}
		let lastErr: unknown = null;
		let firstLive: MailboxConnection | null = null;
		for (const claimed of binding.names) {
			const name = claimed.toLowerCase(); // binding spellings are claimed; fold
			const existing = this.connections.get(name);
			if (existing?.connected) {
				if (!firstLive) firstLive = existing;
				continue;
			}
			try {
				const c = await this.login({ as: claimed, fromBinding: true });
				if (!firstLive) firstLive = c;
			} catch (err) {
				lastErr = err;
				if (!isFatalLoginError(err)) {
					// transient: the connection stays armed in the map; it is
					// a live login attempt, just not yet connected
					const armed = this.connections.get(name);
					if (armed && !firstLive) firstLive = armed;
				}
			}
		}
		if (!firstLive?.connected) {
			// nothing came up: propagate the last failure (fatal displaced
			// errors already carry the take-it-back instructions)
			throw lastErr instanceof Error ? lastErr : new Error("mailbox: no connection could be established");
		}
		// prefer the binding's current identity when it is live
		const wanted = binding.current.toLowerCase();
		if (this.connOf(wanted)?.connected) this.current = wanted;
		else if (!this.connOf(this.current)?.connected) this.current = this.firstConnectedName();
		this.persistBinding();
		return this.connOf(this.current)!;
	}

	private anyConnected(): boolean {
		for (const c of this.connections.values()) if (c.connected) return true;
		return false;
	}

	private firstConnectedName(): string | null {
		for (const [name, c] of this.connections) if (c.connected) return name;
		return null;
	}

	private persistBinding(): void {
		if (this.connections.size === 0) {
			this.host.loginStore.writeLogin(null);
			return;
		}
		// CLAIMED spellings (each connection's mailboxId): the daemon keeps
		// the display case in _case; persisting lowercase here would lose it
		// across restarts. Comparisons always fold.
		const names = [...this.connections.values()].map((c) => c.mailboxId);
		const current = this.connOf(this.current)?.mailboxId ?? names[0] ?? "";
		this.host.loginStore.writeLogin({ names, current });
	}

	private removeFromBinding(name: string): void {
		const binding = this.host.loginStore.readLogin();
		if (!binding) return;
		const canonical = name.toLowerCase();
		const names = binding.names.filter((n) => n.toLowerCase() !== canonical);
		if (names.length === 0) {
			this.host.loginStore.writeLogin(null);
			return;
		}
		this.host.loginStore.writeLogin({ names, current: binding.current.toLowerCase() === canonical ? names[0] ?? "" : binding.current });
	}

	// -- force gate ----------------------------------------------------------

	gateAllowsForce(as: string): boolean {
		// names are case-insensitive: compare canonically
		return this.lastHeld !== null && this.lastHeld.name.toLowerCase() === as.toLowerCase() && Date.now() - this.lastHeld.at <= FORCE_GATE_TTL_MS;
	}

	/** Consume the gate permission (single use). */
	consumeForceGate(): void {
		this.lastHeld = null;
	}

	// -- unread / notifications ----------------------------------------------

	/** Authoritative unread badge state, pushed to the host. */
	private pushUnread(): void {
		if (!this.anyConnected()) {
			this.host.setUnread?.(null, null);
			return;
		}
		let total = 0;
		const byName: Record<string, number> = {};
		for (const [name, c] of this.connections) {
			if (!c.connected) continue;
			const n = this.unreadByConn.get(name) ?? 0;
			byName[name] = n;
			total += n;
		}
		this.host.setUnread?.(total, byName);
	}

	/** Fetch the authoritative unread count for one identity and push the badge. */
	async refreshUnread(name?: string): Promise<void> {
		const target = name ?? this.current;
		if (target === null) return;
		const c = this.connOf(target);
		if (!c?.connected) return;
		try {
			const { totalUnread } = await c.mailbox.inbox();
			if (this.connOf(target) !== c) return; // replaced mid-flight: not our count
			this.unreadByConn.set(target, totalUnread);
		} catch {
			return; // transient failure: keep the last known count
		}
		this.pushUnread();
	}

	/** Notify hook: hold while busy (flushed at turn_end), debounce while idle. */
	private handleNotify(unread: number, name: string): void {
		this.unreadByConn.set(name, unread); // authoritative: the daemon's own count
		this.pushUnread();
		if (!this.canDeliver()) return;
		this.pendingUnread.set(name, unread);
		if (!this.host.isBusy()) {
			this.scheduleIdleFlush();
			return;
		}
		if (this.host.flushAtStepBoundary?.() === true) return; // the boundary will flush
		const busyDelay = this.nextBusyDelay();
		if (busyDelay !== null) this.scheduleFlush(busyDelay);
	}

	private canDeliver(): boolean {
		return this.host.canDeliver?.() ?? true;
	}

	private scheduleIdleFlush(): void {
		// short debounce: bursts of notifies while idle become one message
		this.scheduleFlush(300);
	}

	private scheduleFlush(delayMs: number): void {
		if (!this.canDeliver() || this.flushTimer !== null) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flushNotifications();
		}, Math.max(0, delayMs));
	}

	/** Busy-time flush delay, or null to hold until the turn boundary. */
	private nextBusyDelay(): number | null {
		const window = this.host.busyFlushDelayMs?.();
		if (window === undefined || window === null) return null;
		const cooldown = this.host.busyFlushCooldownMs?.() ?? 0;
		return Math.max(0, Math.max(window, cooldown - (Date.now() - this.lastDeliveredAt)));
	}

	async flushNotifications(): Promise<void> {
		if (this.flushing || !this.canDeliver()) return;
		if (this.pendingUnread.size === 0) return;
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.flushing = true;
		try {
			const pending = new Map(this.pendingUnread);
			this.pendingUnread.clear();
			interface Section {
				name: string;
				count: number;
				snapshot: number;
				// only the not-yet-announced mails: the announcement lists
				// fresh arrivals, never re-lists already-announced ones (the
				// single-identity byte contract), while `count` stays the
				// authoritative totalUnread
				fresh: MailRecord[];
			}
			const sections: Section[] = [];
			for (const [name, snapshot] of pending) {
				const c = this.connections.get(name);
				if (!c?.connected) continue; // dropped mid-burst: not deliverable now
				// subjects + the authoritative unread count (reads do not emit
				// notifies, so the notify snapshot can be stale); on failure fall
				// back to the snapshot with a count-only text
				let mails: MailRecord[] = [];
				let count = snapshot;
				try {
					const reply = await c.mailbox.inbox({ unreadOnly: true }, { limit: 8 });
					mails = reply.mails;
					count = reply.totalUnread;
				} catch {
					// daemon hiccup: announce by count alone
				}
				const fresh = mails.filter((m) => !this.announced.has(m.id));
				if (count <= 0 && fresh.length === 0) continue; // everything got read in the meantime
				sections.push({ name, count, snapshot, fresh });
			}
			if (sections.length === 0) return;
			// deliverAs "steer" is always safe (the pi host applies it only
			// while streaming and ignores it otherwise); a host's async
			// deliver (opening a session on demand) is awaited here
			try {
				await this.host.deliver(this.composeNotification(sections));
				// Only busy-time deliveries start the cooldown: an idle notice is its
				// own turn and must not delay the next in-turn notice.
				if (this.host.isBusy()) this.lastDeliveredAt = Date.now();
				for (const s of sections) for (const m of s.fresh) this.announced.add(m.id);
				if (this.announced.size > 200) this.announced = new Set([...this.announced].slice(-200));
			} catch {
				// delivery failed (sync throw or async reject): keep the
				// undelivered counts for the next boundary
				for (const s of sections) this.pendingUnread.set(s.name, s.count > 0 ? s.count : s.snapshot);
			}
		} finally {
			this.flushing = false;
			// a notify that arrived while this flush was in flight must not be
			// lost: re-arm by the same policy that governs new arrivals
			if (this.pendingUnread.size > 0) {
				if (!this.host.isBusy()) {
					this.scheduleIdleFlush();
				} else if (this.host.flushAtStepBoundary?.() !== true) {
					const delay = this.nextBusyDelay();
					if (delay !== null) this.scheduleFlush(delay);
				}
			}
		}
	}

	private static truncateSubject(s: string): string {
		// normalize whitespace: a subject containing newlines must not be able
		// to forge extra lines inside the injected notification
		const norm = s.replace(/\s+/g, " ").trim();
		if (norm.length === 0) return "(no subject)";
		return norm.length > SUBJECT_MAX ? `${norm.slice(0, SUBJECT_MAX - 1)}…` : norm;
	}

	/**
	 * Compose the injected notification. A single identity renders in the
	 * historical byte-identical format; multiple identities group their
	 * unread under per-mailbox headings.
	 */
	private composeNotification(sections: Array<{ name: string; count: number; fresh: MailRecord[] }>): string {
		const totalUnread = sections.reduce((n, s) => n + s.count, 0);
		const busy = this.host.isBusy();
		const tail = busy ? "Finish your current task, then check with mailbox_list." : "Use mailbox_list to read them.";
		const renderMails = (fresh: MailRecord[]): string[] => {
			const userMails = fresh.filter((m) => m.from.session === "user");
			const agentMails = fresh.filter((m) => m.from.session !== "user");
			const lines: string[] = [];
			if (userMails.length > 0) {
				lines.push("New mail from the user (your human operator):");
				for (const m of userMails) lines.push(`  * ${m.id}: ${MailboxController.truncateSubject(m.subject)}`);
				lines.push(
					"User mail takes priority: if it is quick to handle, do it now and reply with mailbox_reply; " +
						"if it is a large task, briefly acknowledge it now, finish your current work, then handle it and reply when done.",
				);
			}
			if (agentMails.length > 0) {
				lines.push("New mail:");
				for (const m of agentMails) lines.push(`  * ${m.id} from ${m.from.session}@${m.from.project}: ${MailboxController.truncateSubject(m.subject)}`);
			}
			return lines;
		};
		if (sections.length === 1) {
			const s = sections[0]!;
			return [`[mailbox] You have ${s.count} unread mail(s).`, ...renderMails(s.fresh), tail].join("\n");
		}
		const lines = [`[mailbox] You have ${totalUnread} unread mail(s) across ${sections.length} mailboxes.`];
		for (const s of sections) {
			lines.push(`In '${s.name}' (${s.count} unread):`);
			lines.push(...renderMails(s.fresh));
		}
		lines.push(tail);
		return lines.join("\n");
	}

	// -- wake -------------------------------------------------------------------

	/**
	 * Best-effort wake after a send to an offline target: hand the target
	 * to the host's wake provider (the plugin injects herdr). Returns a
	 * suffix for the send reply (empty when not applicable). Never throws
	 * and never fails the send.
	 */
	async maybeWake(c: MailboxConnection, target: { project: string; session: string }): Promise<string> {
		try {
			const wake = this.host.wake;
			if (!wake) return ""; // no wake provider: behave as if wake were off
			// cross-project targets: the target project's root is unknown here (v1)
			if (target.project !== c.mailbox.project) return "";
			// the sessions listing is canonical (lowercase); the target may
			// arrive in claimed spelling — fold before comparing
			const targetSession = target.session.toLowerCase();
			const sessions = await c.mailbox.sessions(true);
			const info = sessions.find((s) => s.session === targetSession);
			if (!info || info.online) return ""; // online: the daemon's notify covers it
			const meta = info.meta ?? {};
			// wake only same-host sessions (_host is set by local-mode connections)
			if (meta._host !== hostname()) return "";
			const origin = meta._origin;
			if (!origin) return ""; // e.g. the web UI 'user' mailbox: nothing to resume
			// legacy derived mailboxes are not woken: the current client
			// cannot connect nameless, so a woken legacy session could never
			// see this mail
			if (/^[0-9a-z]{10}$/.test(targetSession)) {
				return " (target offline — wake skipped: legacy derived mailbox, named login required)";
			}
			const result = await wake({
				session: targetSession,
				origin,
				projectRoot: c.projectDir,
				label: info.name,
				named: true,
				sessionDir: this.host.sessionDir?.(),
			});
			if (result.ok) return ` (target offline — woke via herdr: ${result.detail})`;
			if (result.silent) return ""; // no wake environment: behave as if wake were off
			return ` (target offline — wake failed: ${result.reason})`;
		} catch {
			return ""; // wake is best-effort
		}
	}

	// -- status -----------------------------------------------------------------

	/**
	 * Status snapshot for connect results: built once from one connection
	 * (passed explicitly — never re-read from live state across an await),
	 * with text rendered from the structure so the two cannot diverge.
	 * `mails` is NOT wrapped: an inbox failure propagates and fails the whole
	 * connect call — announcing "connected" without mail counts misleads
	 * (deliberate asymmetry with the best-effort sessions query).
	 */
	async connectionStatus(c: MailboxConnection): Promise<ConnectionStatus> {
		const address = c.address;
		if (address === null) throw new Error("mailbox: connection has no address (not registered)");
		const { total, totalUnread } = await c.mailbox.inbox();
		let onlineClients: number | null = null;
		try {
			onlineClients = (await c.mailbox.sessions()).filter((s) => s.online).length;
		} catch {
			// best-effort: keep the mail counts, report null (not 0)
		}
		return { address, mails: { total, unread: totalUnread }, onlineClients };
	}

	/** Render a ConnectionStatus as the historical summary text (byte-identical). */
	renderStatus(s: ConnectionStatus): string {
		const identity = `as ${s.address}`;
		const onlinePart = s.onlineClients === null ? "" : `, ${s.onlineClients} clients online`;
		return `${identity}: ${s.mails.total} mails (${s.mails.unread} unread)${onlinePart}`;
	}

	async statusSummary(c: MailboxConnection): Promise<string> {
		return this.renderStatus(await this.connectionStatus(c));
	}

	// -- channel bindings ---------------------------------------------------------

	/** True when any connected daemon advertised the "bindings" capability. */
	get supportsBindings(): boolean {
		for (const c of this.connections.values()) {
			if (c.connected && c.mailbox.hasCap("bindings")) return true;
		}
		return false;
	}

	/** Channel types the daemon advertised ("channel:webhook" -> "webhook"); empty when unsupported. */
	supportedChannels(): string[] {
		for (const c of this.connections.values()) {
			if (!c.connected) continue;
			const caps = c.mailbox.caps ?? [];
			return caps.filter((x) => x.startsWith("channel:")).map((x) => x.slice("channel:".length));
		}
		return [];
	}

	bindingAdd(opts: { channel: string; config?: unknown; targets: string[]; force?: boolean }): Promise<BindingInfo> {
		return this.requireConnection().mailbox.bindingAdd(opts);
	}

	bindingList(): Promise<BindingInfo[]> {
		return this.requireConnection().mailbox.bindings();
	}

	bindingUpdate(opts: { id: string; config?: unknown; targets?: string[]; enabled?: boolean; force?: boolean }): Promise<BindingInfo> {
		return this.requireConnection().mailbox.bindingUpdate(opts);
	}

	bindingDelete(id: string): Promise<BindingInfo> {
		return this.requireConnection().mailbox.bindingDelete(id);
	}

	// -- tools & command ----------------------------------------------------------

	/** The 7 mailbox tool definitions (see tools.ts), bound to this controller. */
	get tools(): ReturnType<typeof buildToolDefinitions> {
		return this.toolDefs;
	}

	/** Execute a /mailbox command line (output through host.notify). */
	async executeCommand(arg: string): Promise<void> {
		await executeMailboxCommand(this, arg);
	}

	/** Argument completions for the /mailbox command. */
	async completeCommand(argumentPrefix: string): Promise<Array<{ value: string; label: string; description?: string }> | null> {
		return mailboxArgumentCompletions(this, argumentPrefix);
	}

	// -- helpers shared with command.ts -----------------------------------------

	/** Resolve the web UI URL (/mailbox view): remote target or mailboxd view --json. */
	async resolveViewUrl(): Promise<string> {
		const remote = this.remote;
		if (remote) {
			// remote daemon: not in this machine's registry; build the URL
			// from the live connection's target
			const base = httpBase(remote.host, remote.port);
			const resp = await fetch(`${base}/healthz`, {
				headers: remote.token ? { Authorization: `Bearer ${remote.token}` } : {},
				signal: AbortSignal.timeout(1_500),
			});
			if (resp.status === 401) throw new Error("unauthorized: daemon requires a token");
			if (!resp.ok) throw new Error(`daemon answered ${resp.status}`);
			return `${base}/`;
		}
		// local: delegate to mailboxd view --json (single source of truth)
		const bin = findMailboxdBinary();
		if (!bin) throw new Error("mailboxd binary not found; cannot resolve the web UI address");
		const result = spawnSync(bin, ["view", "--json"], { encoding: "utf8", timeout: 10_000 });
		if (result.status !== 0) {
			throw new Error((result.stderr || result.stdout || "failed to resolve the web UI address").trim());
		}
		return (JSON.parse(result.stdout) as { url: string }).url;
	}

	/** Mailbox totals through the read-only HTTP API (delete reports). */
	async mailboxTotals(name: string): Promise<{ total: number; totalUnread: number } | null> {
		const projectId = await deriveProjectId(this.host.identity.cwd);
		return mailboxTotalsViaApi(projectId, name);
	}

	/** Hard-delete one offline mailbox through the daemon's HTTP API. */
	async deleteMailbox(name: string): Promise<void> {
		const projectId = await deriveProjectId(this.host.identity.cwd);
		await deleteMailboxViaApi(projectId, name);
	}

	/** Hard-delete mailboxes through the daemon's HTTP API (/mailbox delete, batch). */
	async deleteMailboxes(names: string[]): Promise<DeleteOutcome> {
		if (this.remote) {
			throw new Error("delete is local-mode only (the local daemon's project)");
		}
		const projectRoot = this.host.identity.cwd;
		const projectId = await deriveProjectId(projectRoot);
		const sessions = await fetchSessionsViaApi({ id: projectId, root: projectRoot });
		const withTotals = names.length <= 10;
		const outcome: DeleteOutcome = {
			deleted: [],
			skipped: [],
			failed: [],
			// emitted only when every deleted name's totals were actually
			// fetched — a null-tolerant fetch must not report misleading
			// zeros (the N=1 rule, extended)
			withTotals: false,
			totalMails: 0,
			totalUnread: 0,
		};
		let totalsFetched = 0;
		for (const name of names) {
			const info = sessions.find((s) => s.session === name && s.project === projectId);
			if (!info) {
				outcome.skipped.push({ name, reason: `no such mailbox '${name}' in this project` });
				continue;
			}
			if (info.online) {
				// a held name of ours is canonical in the map — direct compare
				const own = this.connections.get(name)?.connected ?? false;
				outcome.skipped.push({
					name,
					reason: own ? "own current login (logout first)" : "online",
				});
				continue;
			}
			try {
				const totals = withTotals ? await mailboxTotalsViaApi(projectId, name) : null;
				await deleteMailboxViaApi(projectId, name);
				outcome.deleted.push(name);
				if (totals) {
					outcome.totalMails += totals.total;
					outcome.totalUnread += totals.totalUnread;
					totalsFetched++;
				}
			} catch (err) {
				outcome.failed.push({ name, error: err instanceof Error ? err.message : String(err) });
			}
		}
		outcome.withTotals = totalsFetched === outcome.deleted.length;
		return outcome;
	}

	/** Find the session file for an origin id inside the pi session directory. */
	findSessionFile(origin: string): string | null {
		const sessionDir = this.host.sessionDir?.();
		if (!sessionDir) return null;
		let sessionFile: string | null = null;
		try {
			for (const f of readdirSync(sessionDir)) {
				if (f.endsWith(`_${origin}.jsonl`)) sessionFile = join(sessionDir, f);
			}
		} catch {
			// dir missing
		}
		return sessionFile;
	}

	/** Best-effort daemon probe that never spawns (login/connect paths). */
	async probeRunningDaemon(): Promise<boolean> {
		return (await connectLocalDaemonIfRunning()) !== null;
	}

	/** The only spawn path: /mailbox start service / restart service. */
	async ensureDaemon(): Promise<void> {
		await resolveLocalDaemon();
	}
}
