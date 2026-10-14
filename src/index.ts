/**
 * pi-mailbox extension.
 *
 * /mailbox                 connect (host or client) and list this session's mail
 * /mailbox host:port [t]    connect to a remote mailboxd (optional token)
 * /mailbox read <id>       view one mail
 * /mailbox name <name>     set display name (persists across reconnects)
 * /mailbox tag <a,b,...>   set tags
 * /mailbox set k=v ...     set meta values (cookie-like key/value)
 * /mailbox unset k ...     remove meta values
 * /mailbox view            print (and open) the daemon's read-only web UI
 * /mailbox off             disconnect
 * /mailbox status          connection status
 *
 * Agent tools (activated only while connected): mailbox_list, mailbox_read,
 * mailbox_send, mailbox_sessions.
 */

import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { isFatalLoginError, MailboxConnection, MailboxError, type RemoteTarget } from "./client.ts";
import { connectLocalDaemonIfRunning, deriveProjectId, fetchSessionsViaApi, findMailboxdBinary } from "./daemon.ts";
import { findLiveAgentPane, wakeOfflineSession } from "./herdr.ts";
import type { MailRecord, MailRef, SessionInfo } from "./protocol.ts";

const TOOL_NAMES = ["mailbox_list", "mailbox_read", "mailbox_send", "mailbox_reply", "mailbox_sessions"] as const;

/** Shared explanation of the external addressing format, embedded in tool output. */
const ADDRESS_FORMAT_DOC =
	"Addressing: a mailbox address is 'session@project'; a mail reference is 'session@project/mail' " +
	"(a bare mail id means your own mailbox). Use mailbox_sessions to list peer addresses. " +
	"Threading rule: start NEW topics with mailbox_send; answer any existing mail with " +
	"mailbox_reply ONLY (it references the original — a reply sent via mailbox_send breaks the thread).";

/** http base URL from host + port, bracketing IPv6 literals. */
function httpBase(host: string, port: number): string {
	const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	return `http://${h}:${port}`;
}

/** Best-effort browser open; detached, failures are ignored. */
function openBrowser(url: string): void {
	const plat = process.platform;
	const cmd = plat === "win32" ? "cmd" : plat === "darwin" ? "open" : "xdg-open";
	const args = plat === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		// best-effort; the URL is already shown to the user
	}
}

/** Parse "session" (own project) or "session@project" into an AgentRef. */
function parseAddress(addr: string, ownProject: string): { project: string; session: string } {
	const at = addr.indexOf("@");
	if (at === -1) return { project: ownProject, session: addr };
	return { project: addr.slice(at + 1), session: addr.slice(0, at) };
}

/**
 * Parse a mail reference: "session@project/mail" (full), "session@project"
 * is not valid here, or a bare mail id (own mailbox). Returns the MailRef.
 */
function parseMailRef(ref: string, own: { project: string; session: string }): { project: string; session: string; mail: string } {
	const slash = ref.lastIndexOf("/");
	if (slash === -1) return { ...own, mail: ref };
	const { project, session } = parseAddress(ref.slice(0, slash), own.project);
	return { project, session, mail: ref.slice(slash + 1) };
}

/** Render a mail ref in the external "session@project/mail" form. */
function formatMailRef(ref: { project: string; session: string; mail: string }): string {
	return `${ref.session}@${ref.project}/${ref.mail}`;
}

function formatMailList(mails: MailRecord[]): string {
	if (mails.length === 0) return "mailbox is empty";
	return mails
		.map((m) => {
			const read = m.readAt ? " " : "*";
			const from = `${m.from.session}@${m.from.project}`;
			return `[${read}] ${m.id}  from ${from}  ${m.subject}`;
		})
		.join("\n");
}

/** Render a sessions listing; `self` (own project + short session id) gets a "(you)" marker. */
function formatSessions(sessions: SessionInfo[], self?: { project: string; session: string }): string {
	if (sessions.length === 0) return "no sessions";
	return sessions
		.map((s) => {
			const mark = s.online ? "*" : "-";
			const isSelf =
				self !== undefined && s.session === self.session && (s.project === undefined || s.project === self.project);
			const address = s.project ? `${s.session}@${s.project}` : s.session;
			const you = isSelf ? " (you)" : "";
			const agent = s.agent ? `  ${s.agent}` : "";
			const name = s.name ? `  name=${s.name}` : "";
			const tags = s.tags && s.tags.length > 0 ? `  tags=${s.tags.join(",")}` : "";
			const extra = Object.entries(s.meta ?? {})
				.filter(([k]) => k !== "name" && k !== "tags" && k !== "_agent" && k !== "_origin" && k !== "_holds" && k !== "_named")
				.map(([k, v]) => `  ${k}=${v}`)
				.join("");
			return `[${mark}] ${address}${you}${agent}${name}${tags}${extra}`;
		})
		.join("\n");
}

function formatMail(mail: MailRecord, ref?: MailRef): string {
	const lines = [
		`subject: ${mail.subject}`,
		`from:    ${mail.from.session}@${mail.from.project}`,
		`date:    ${mail.createdAt}`,
		`read:    ${mail.readAt ?? "unread"}`,
	];
	if (ref) {
		lines.push(`ref:     ${formatMailRef(ref)}`);
	}
	if ((mail.refs ?? []).length > 0) {
		lines.push(`refs:    ${mail.refs.map((r) => `${r.session}@${r.project}/${r.mail}`).join(", ")}`);
	}
	lines.push("", mail.body);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	let conn: MailboxConnection | null = null;
	let busy = false;
	let interactive = true;
	/** ctx.ui captured at session_start; valid for this runtime's lifetime (re-captured after session replacement). */
	let uiApi: {
		setStatus(key: string, text: string | undefined): void;
		theme: { fg(style: string, text: string): string };
	} | null = null;

	/** Show the mailbox address in the footer (after the project path) while connected. */
	function updateFooterStatus(): void {
		if (!uiApi) return;
		try {
			uiApi.setStatus("mailbox", conn?.connected ? uiApi.theme.fg("dim", `mailbox ${conn.address ?? ""}`) : undefined);
		} catch {
			// stale-context race around session replacement; the next runtime re-sets it
		}
	}
	/** Set by session_shutdown: in-flight connects must not adopt the dead runtime. */
	let shuttingDown = false;

	pi.on("session_start", (event, ctx) => {
		interactive = ctx.mode === "tui" || ctx.mode === "rpc";
		uiApi = ctx.ui;
		updateFooterStatus();
		void autoConnect(event, ctx);
	});
	pi.on("agent_start", () => {
		busy = true;
	});
	const settle = (): void => {
		busy = false;
		// a notify held through the final settlement window has no turn_end
		// left to flush it; deliver it once the run has fully settled
		if (pendingUnread > 0) scheduleIdleFlush();
	};
	// agent_end closes one low-level run, but retries, compaction, and
	// follow-up work can still continue; agent_settled is the final
	// boundary. Both clear busy: sendUserMessage always passes
	// deliverAs:"steer" (see flushNotifications), which pi applies only
	// while streaming, so an early clear during the settlement window is
	// safe — and a missing agent_settled must never wedge notifications.
	pi.on("agent_end", settle);
	pi.on("agent_settled", settle);
	// turn boundary: steered messages are delivered right after turn_end
	// handlers run, so a notification flushed here is seen by the very next
	// LLM call — and everything that arrived during the finished turn is
	// coalesced into that single message
	pi.on("turn_end", async () => {
		if (pendingUnread > 0) await flushNotifications();
	});
	pi.on("session_shutdown", () => {
		shuttingDown = true;
		if (flushTimer !== null) clearTimeout(flushTimer);
		flushTimer = null;
		conn?.stop();
		conn = null;
	});

	function activateTools(active: boolean): void {
		const current = pi.getActiveTools();
		const next = active
			? [...current, ...TOOL_NAMES.filter((n) => !current.includes(n))]
			: current.filter((n) => !(TOOL_NAMES as readonly string[]).includes(n));
		pi.setActiveTools(next);
	}

	// -----------------------------------------------------------------------
	// new-mail notification: hold-and-flush at turn boundaries
	// -----------------------------------------------------------------------
	// Notifies are held while the agent runs and flushed as ONE coalesced
	// steer message at the next turn_end (the earliest moment a steered
	// message can be processed); while idle they go out directly after a
	// short debounce. The flushed message lists mail subjects, dedups
	// against already-announced mail ids, and gives mail from the web UI
	// 'user' session (the human operator) priority instructions.

	let pendingUnread = 0;
	let flushing = false;
	let flushTimer: NodeJS.Timeout | null = null;
	/** Mail ids already included in a notification (bounded). */
	let announced = new Set<string>();

	const SUBJECT_MAX = 80;

	function truncateSubject(s: string): string {
		// normalize whitespace: a subject containing newlines must not be able
		// to forge extra lines inside the injected notification
		const norm = s.replace(/\s+/g, " ").trim();
		if (norm.length === 0) return "(no subject)";
		return norm.length > SUBJECT_MAX ? `${norm.slice(0, SUBJECT_MAX - 1)}…` : norm;
	}

	function composeNotification(unread: number, fresh: MailRecord[]): string {
		const userMails = fresh.filter((m) => m.from.session === "user");
		const agentMails = fresh.filter((m) => m.from.session !== "user");
		const lines = [`[mailbox] You have ${unread} unread mail(s).`];
		if (userMails.length > 0) {
			lines.push("New mail from the user (your human operator):");
			for (const m of userMails) lines.push(`  * ${m.id}: ${truncateSubject(m.subject)}`);
			lines.push(
				"User mail takes priority: if it is quick to handle, do it now and reply with mailbox_reply; " +
					"if it is a large task, briefly acknowledge it now, finish your current work, then handle it and reply when done.",
			);
		}
		if (agentMails.length > 0) {
			lines.push("New mail:");
			for (const m of agentMails)
				lines.push(`  * ${m.id} from ${m.from.session}@${m.from.project}: ${truncateSubject(m.subject)}`);
		}
		lines.push(busy ? "Finish your current task, then check with mailbox_list." : "Use mailbox_list to read them.");
		return lines.join("\n");
	}

	function scheduleIdleFlush(): void {
		if (!interactive || flushTimer !== null) return;
		// short debounce: bursts of notifies while idle become one message
		flushTimer = setTimeout(() => {
			flushTimer = null;
			void flushNotifications();
		}, 300);
	}

	async function flushNotifications(): Promise<void> {
		if (flushing || !interactive) return;
		const c = conn;
		if (!c?.connected) {
			pendingUnread = 0;
			return;
		}
		flushing = true;
		try {
			const unread = pendingUnread;
			pendingUnread = 0;
			if (unread <= 0) return;
			// subjects + the authoritative unread count (reads do not emit
			// notifies, so the notify snapshot can be stale); on failure fall
			// back to the snapshot with a count-only text
			let mails: MailRecord[] = [];
			let count = unread;
			try {
				const reply = await c.mailbox.inbox({ unreadOnly: true }, { limit: 8 });
				mails = reply.mails;
				count = reply.totalUnread;
			} catch {
				// daemon hiccup: announce by count alone
			}
			const fresh = mails.filter((m) => !announced.has(m.id));
			if (count <= 0 && fresh.length === 0) return; // everything got read in the meantime
			// deliverAs "steer" is always safe: pi applies it only while
			// streaming (mid-run) and ignores it otherwise — so an injection
			// racing the settlement window steers instead of being rejected.
			// Note: sendUserMessage is fire-and-forget; a rejected injection
			// cannot be caught here, hence the unconditional steer.
			try {
				pi.sendUserMessage(composeNotification(count, fresh), { deliverAs: "steer" });
				for (const m of mails) announced.add(m.id);
				if (announced.size > 200) announced = new Set([...announced].slice(-200));
			} catch {
				// synchronous rejection: retry at the next boundary
				pendingUnread = count > 0 ? count : unread;
			}
		} finally {
			flushing = false;
			// a notify that arrived while this flush was in flight must not be
			// lost: re-arm the idle path (the busy path flushes at turn_end)
			if (pendingUnread > 0 && !busy) scheduleIdleFlush();
		}
	}

	/** Notify hook: hold while busy (flushed at turn_end), debounce while idle. */
	function handleNotify(unread: number): void {
		if (!interactive) return;
		pendingUnread = unread;
		if (!busy) scheduleIdleFlush();
	}

	// -----------------------------------------------------------------------
	// named-mailbox login binding (persisted in the pi session file)
	// -----------------------------------------------------------------------

	const LOGIN_ENTRY = "pi-mailbox-login";

	/** Read the stored login binding: the last pi-mailbox-login entry wins. */
	function readStoredLogin(ctx: {
		sessionManager: { getEntries?(): Array<{ type: string; customType?: string; data?: unknown }> };
	}): { as: string } | null {
		try {
			const entries = ctx.sessionManager.getEntries?.() ?? [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e.type === "custom" && e.customType === LOGIN_ENTRY) {
					const data = e.data as { name?: string | null } | undefined | null;
					return data?.name ? { as: data.name } : null;
				}
			}
		} catch {
			// entries unavailable (older pi): manual login only
		}
		return null;
	}

	/** Persist (or clear, name=null) the login binding in the session file. */
	function storeLogin(name: string | null): void {
		try {
				const api = pi as { appendEntry?: (t: string, data?: unknown) => void };
			api.appendEntry?.(LOGIN_ENTRY, { name });
		} catch {
			// best-effort: the login still works for this connection
		}
	}

	const WINDOWS_RESERVED = new Set([
		"con", "prn", "aux", "nul",
		"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
		"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
	]);

	/** Client-side mirror of the daemon's name grammar (early UX; the daemon is the authority). */
	function validMailboxName(name: string): boolean {
		return /^[a-z][a-z0-9_-]{2,31}$/.test(name) && !/^[0-9a-z]{10}$/.test(name) && name !== "user" && !WINDOWS_RESERVED.has(name);
	}

	// -----------------------------------------------------------------------
	// force gate: a forced takeover is only allowed right after a normal
	// attempt for the same name failed with name_held (anti-abuse; the
	// human-facing /mailbox login --force path bypasses this — typing the
	// flag IS the confirmation). Any non-forced explicit attempt sets the
	// gate, including a failed human /mailbox login — a conscious choice:
	// it still proves "normal was tried first".
	// -----------------------------------------------------------------------

	let lastHeld: { name: string; at: number } | null = null;
	const FORCE_GATE_TTL_MS = 5 * 60 * 1000;

	function gateAllowsForce(as: string): boolean {
		return lastHeld !== null && lastHeld.name === as && Date.now() - lastHeld.at <= FORCE_GATE_TTL_MS;
	}

	/** Consume the gate permission (single use). */
	function consumeForceGate(): void {
		lastHeld = null;
	}

	/**
	 * Silent auto-connect on startup: a session that has logged in before
	 * (a stored binding) reconnects automatically when the daemon is
	 * already running. Never spawns the daemon; stays silent on success
	 * and on transient failures — only permanent login rejections (e.g.
	 * the name was taken over) surface to the user.
	 */
	async function autoConnect(
		_event: unknown,
		ctx: {
			sessionManager: {
				getSessionId(): string;
				getCwd(): string;
				getSessionDir(): string;
				getEntries?(): Array<{ type: string; customType?: string; data?: unknown }>;
			};
			model?: { id: string; provider: string } | undefined;
		},
	): Promise<void> {
		try {
			if (shuttingDown || !interactive || conn?.connected) return;
			if (!readStoredLogin(ctx)) return; // never logged in: nothing to do
			const endpoint = await connectLocalDaemonIfRunning();
			if (shuttingDown) return; // session ended during the probe
			if (!endpoint) return; // daemon down: stay silent, no spawn
			await startConnection(ctx, null, false); // binding auto-applies
			// the runtime may have been torn down (resume/quit) while the
			// connect was in flight: do not leave an adopted orphan
			if (shuttingDown) {
				conn?.stop();
				conn = null;
				updateFooterStatus();
			}
		} catch (err) {
			// silent, except permanent login rejections — being displaced
			// from your name is something the user must learn about
			if (isFatalLoginError(err)) {
				try {
					pi.sendUserMessage(
						`[mailbox] auto-login failed: ${err instanceof Error ? err.message : String(err)}`,
						{ deliverAs: "steer" },
					);
				} catch {
					// injection races with run state; the next manual connect surfaces it
				}
			}
		}
	}

	async function startConnection(
		ctx: {
			sessionManager: {
				getSessionId(): string;
				getCwd(): string;
				getSessionDir(): string;
				getEntries?(): Array<{ type: string; customType?: string; data?: unknown }>;
			};
			model?: { id: string; provider: string } | undefined;
		},
		remote: RemoteTarget | null,
		canSpawn = false,
		login?: { as: string; tags?: string; force?: boolean } | null,
	): Promise<MailboxConnection> {
		// the previous connection is only torn down after the new one is
		// live: a rejected login must leave the previous identity connected
		const previous = conn;
		const session = ctx.sessionManager.getSessionId();
		// Stable agent kind: the session-id derivation and the wire identity
		// must never change. The user-renamable display name (/name) is meta
		// only — renaming a session must not move its mailbox.
		const agent = "pi";
		// registration-time auto meta: system keys (leading `_`) refresh on every
		// connect; they cannot be set manually. `_host`/`_platform` are local-only:
		// remote services should not learn machine details.
		const helloMeta: Record<string, string> = {
			_pi: VERSION,
		};
		const sessionName = pi.getSessionName();
		if (sessionName) helloMeta.name = sessionName;
		if (!remote) {
			helloMeta._host = hostname();
			helloMeta._platform = platform();
		}
		if (ctx.model) helloMeta._model = `${ctx.model.provider}/${ctx.model.id}`;
		// explicit login beats the stored binding; no explicit login falls
		// back to it (auto-login on resume/reconnect). A session with no
		// login at all is rejected: this project's mailboxes are named
		// accounts, not anonymous derived identities.
		const fromBinding = login === undefined;
		const effectiveLogin: { as: string; tags?: string; force?: boolean } | null =
			login != null ? { ...login } : readStoredLogin(ctx);
		if (!effectiveLogin) {
			throw new Error("mailbox: no login for this session — use /mailbox login <name> first (or mailbox_connect with as='<name>')");
		}
		if (effectiveLogin.force && fromBinding) {
			// a stored binding never carries force; only explicit calls may
			effectiveLogin.force = false;
		}
		const connection = new MailboxConnection(
			remote ? "remote" : "local",
			ctx.sessionManager.getCwd(),
			remote,
			session,
			agent,
			{
				onNotify: handleNotify,
				onConnected: () => {
					activateTools(true);
					updateFooterStatus();
				},
				onDisconnected: () => {
					activateTools(false);
					updateFooterStatus();
				},
			},
			{
				login: effectiveLogin ?? undefined,
				helloMeta,
				canSpawn,
			},
		);
		// the daemon's lifecycle GC needs the pi session directory (local mode)
		connection.sessionDirProvider = () => ctx.sessionManager.getSessionDir();
		conn = connection;
		try {
			await connection.start();
			lastHeld = null; // any success clears the force gate
		} catch (err) {
			// force-gate bookkeeping for explicit (non-binding) logins
			if (!fromBinding) {
				if (err instanceof MailboxError && err.code === "name_held" && !effectiveLogin.force) {
					lastHeld = { name: effectiveLogin.as, at: Date.now() };
				} else if (!(err instanceof MailboxError && err.code === "name_held" && effectiveLogin.force)) {
					lastHeld = null; // any other error code clears it
				}
			}
			if (previous?.connected) {
				// identity switch failed (rejected login, or a transient error
				// mid-switch): stay on the previous identity — no half-open
				// second connection, no retry loop; the user retries explicitly
				await connection.stop();
				conn = previous;
				activateTools(true);
			} else if (isFatalLoginError(err)) {
				// permanent login rejection on a fresh connection: no retry loop
				await connection.stop();
				conn = null;
				activateTools(false);
			} else {
				// first connection, transient failure: keep the retry loop armed
				// (a late-starting daemon is picked up automatically)
				activateTools(false);
			}
			// displaced from our stored binding: the name was taken over
			// (online or offline). Clear the binding so resumes do not die
			// on it forever, and say what happened. (Placed after the
			// identity handling above so it never depends on which branch
			// ran; fromBinding call sites never have a live previous anyway.)
			if (
				fromBinding &&
				err instanceof MailboxError &&
				(err.code === "mailbox_in_use" || err.code === "name_held")
			) {
				storeLogin(null);
				throw new MailboxError(
					err.code,
					`you were displaced from '${effectiveLogin.as}' by another session (${err.message}); ` +
						"log in again with /mailbox login <name> (add --force to take it back if the new holder is offline and the user confirms)",
				);
			}
			// the failed attempt's onDisconnected already cleared the footer;
			// every end state here (restored previous identity included) must
			// re-derive it from the final conn value
			updateFooterStatus();
			throw err;
		}
		await previous?.stop();
		return connection;
	}

	function requireConnection(): MailboxConnection {
		if (!conn?.connected) throw new Error("mailbox not connected; run /mailbox start service or the mailbox_connect tool first");
		return conn;
	}

	/**
	 * Best-effort herdr wake after a send to an offline target: resume the
	 * target's pi session in a herdr pane and prompt it to check its mail.
	 * Returns a suffix for the send reply (empty when not applicable).
	 * Never throws and never fails the send.
	 */
	async function maybeWake(c: MailboxConnection, target: { project: string; session: string }): Promise<string> {
		try {
			// cross-project targets: the target project's root is unknown here (v1)
			if (target.project !== c.mailbox.project) return "";
			const sessions = await c.mailbox.sessions(true);
			const info = sessions.find((s) => s.session === target.session);
			if (!info || info.online) return ""; // online: the daemon's notify covers it
			const meta = info.meta ?? {};
			// wake only same-host sessions (_host is set by local-mode connections)
			if (meta._host !== hostname()) return "";
			const origin = meta._origin;
			if (!origin) return ""; // e.g. the web UI 'user' mailbox: nothing to resume
			// legacy derived mailboxes are no longer woken: the current
			// extension cannot connect nameless, so a woken legacy session
			// could never see this mail
			if (/^[0-9a-z]{10}$/.test(target.session)) {
				return " (target offline — wake skipped: legacy derived mailbox, named login required)";
			}
			const result = await wakeOfflineSession({
				session: target.session,
				origin,
				projectRoot: c.projectDir,
				label: info.name,
				named: true,
				sessionDir: c.sessionDirProvider?.(),
			});
			if (result.ok) return ` (target offline — woke via herdr: ${result.detail})`;
			if (result.silent) return ""; // no herdr environment: behave as if wake were off
			return ` (target offline — herdr wake failed: ${result.reason})`;
		} catch {
			return ""; // wake is best-effort
		}
	}

	async function statusSummary(c: MailboxConnection): Promise<string> {
		const { total, totalUnread } = await c.mailbox.inbox();
		const identity = `as ${c.address}`;
		let onlinePart = "";
		try {
			const online = (await c.mailbox.sessions()).filter((s) => s.online).length;
			onlinePart = `, ${online} clients online`;
		} catch {
			// best-effort; keep the mail counts when the sessions query fails
		}
		return `${identity}: ${total} mails (${totalUnread} unread)${onlinePart}`;
	}

	// -----------------------------------------------------------------------
	// command
	// -----------------------------------------------------------------------

	pi.registerCommand("mailbox", {
		description: "Connect to the project mailbox, list mails, and manage the connection",
		handler: async (args, ctx) => {
			const arg = args.trim();

			if (arg === "start service") {
				try {
					if (conn?.connected) {
						ctx.ui.notify("mailbox: already connected", "info");
						return;
					}
					const connection = await startConnection(ctx, null, true);
					ctx.ui.notify(`mailbox: connected as ${connection.address}`, "info");
				} catch (err) {
					ctx.ui.notify(`mailbox: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (arg === "view") {
				try {
					let url: string;
					const remote = conn?.connected ? conn.remoteTarget : null;
					if (remote) {
						// remote daemon: not in this machine's registry; build
						// the URL from the live connection's target
						const base = httpBase(remote.host, remote.port);
						const resp = await fetch(`${base}/healthz`, {
							headers: remote.token ? { Authorization: `Bearer ${remote.token}` } : {},
							signal: AbortSignal.timeout(1_500),
						});
						if (resp.status === 401) throw new Error("unauthorized: daemon requires a token");
						if (!resp.ok) throw new Error(`daemon answered ${resp.status}`);
						url = `${base}/`;
					} else {
						// local: delegate to mailboxd view --json (single source of truth)
						const bin = findMailboxdBinary();
						if (!bin) throw new Error("mailboxd binary not found; cannot resolve the web UI address");
						const result = spawnSync(bin, ["view", "--json"], { encoding: "utf8", timeout: 10_000 });
						if (result.status !== 0) {
							throw new Error((result.stderr || result.stdout || "failed to resolve the web UI address").trim());
						}
						url = (JSON.parse(result.stdout) as { url: string }).url;
					}
					// open the full URL (token in the fragment for remote); show
					// the address without the token so it never lands in the
					// persistent session transcript
					const remote2 = conn?.connected ? conn.remoteTarget : null;
					const fullUrl = remote2?.token ? `${url}#t=${remote2.token}` : url;
					ctx.ui.notify(
						remote2?.token ? `mailbox: ${url} (token applied via URL fragment; omitted here)` : `mailbox: ${url}`,
						"info",
					);
					openBrowser(fullUrl);
				} catch (err) {
					ctx.ui.notify(`mailbox: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (arg === "resume" || arg.startsWith("resume ")) {
				const name = arg.slice(6).trim().toLowerCase();
				if (!name) {
					ctx.ui.notify("Usage: /mailbox resume <name>  (switch this terminal to the named mailbox's session)", "warning");
					return;
				}
				try {
					// resolve via the daemon's read-only HTTP API: resume must
					// not require this session to have a mailbox of its own
					const projectRoot = ctx.sessionManager.getCwd();
					const projectId = await deriveProjectId(projectRoot);
					const sessions = await fetchSessionsViaApi({ id: projectId, root: projectRoot });
					const info = sessions.find((s) => s.session === name && s.project === projectId);
					if (!info) {
						ctx.ui.notify(`mailbox: no such named mailbox '${name}' in this project`, "error");
						return;
					}
					if ((info.meta ?? {})._named !== "1") {
						ctx.ui.notify(`mailbox: '${name}' is not a named mailbox`, "error");
						return;
					}
					const origin = (info.meta ?? {})._origin;
					if (!origin) {
						ctx.ui.notify(`mailbox: '${name}' has no recorded session to resume`, "error");
						return;
					}
					// self-check FIRST: resuming your own name while connected
					// as it must say "already this session", not "holder
					// running elsewhere"
					if (origin === ctx.sessionManager.getSessionId()) {
						ctx.ui.notify(`mailbox: '${name}' is already this session`, "info");
						return;
					}
					if (info.online) {
						ctx.ui.notify(
							`mailbox: '${name}' is online — its holder session is running elsewhere; close it first (or send it a note instead)`,
							"error",
						);
						return;
					}
					// the session file must exist (switching to a dead id would
					// silently create an empty session)
					const sessionDir = ctx.sessionManager.getSessionDir();
					let sessionFile: string | null = null;
					try {
						for (const f of readdirSync(sessionDir)) {
							if (f.endsWith(`_${origin}.jsonl`)) sessionFile = join(sessionDir, f);
						}
					} catch { /* dir missing */ }
					if (!sessionFile) {
						ctx.ui.notify(
							`mailbox: the session behind '${name}' is gone (file deleted); claim the name with /mailbox login ${name} [--force] instead`,
							"error",
						);
						return;
					}
					// a live-but-disconnected pi on that session file would now be
					// doubled; detect it through herdr when available
					const livePane = await findLiveAgentPane(origin);
					if (livePane) {
						ctx.ui.notify(
							`mailbox: the session behind '${name}' is still running in herdr pane ${livePane}; close it first`,
							"error",
						);
						return;
					}
					// switch this terminal to the target session in place;
					// session_shutdown (reason "resume") stops our mailbox
					// connection on the way. Its stored binding auto-logins
					// it as '<name>' on startup. On a vetoed switch the
					// connection is untouched.
					const { cancelled } = await ctx.switchSession(sessionFile);
					if (cancelled) ctx.ui.notify("mailbox: resume cancelled (still connected as before)", "warning");
				} catch (err) {
					ctx.ui.notify(`mailbox: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (arg === "list client" || arg === "list client all") {
				try {
					const includeOffline = arg === "list client all";
					let sessions: SessionInfo[];
					let self: { project: string; session: string } | undefined;
					if (conn?.connected) {
						sessions = await conn.mailbox.sessions(includeOffline);
						self = { project: conn.mailbox.project!, session: conn.mailboxId };
					} else {
						// read-only HTTP API: the listing works without a
						// mailbox of one's own — a fresh, not-yet-logged-in
						// session can still browse names
						const projectRoot = ctx.sessionManager.getCwd();
						const projectId = await deriveProjectId(projectRoot);
						sessions = (await fetchSessionsViaApi({ id: projectId, root: projectRoot })).filter(
							(s) => s.project === projectId && (includeOffline || s.online),
						);
					}
					const online = sessions.filter((s) => s.online).length;
					const scope = includeOffline ? `${online} online / ${sessions.length} total` : `${online} online`;
					const note = conn?.connected ? "" : " (not connected — read-only view; /mailbox to connect)";
					ctx.ui.notify(`mailbox: ${scope}${note}\n${formatSessions(sessions, self)}`, "info");
				} catch (err) {
					ctx.ui.notify(`mailbox: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (arg === "login" || arg.startsWith("login ")) {
				const rest = arg.slice(5).trim();
				if (!rest) {
					ctx.ui.notify("Usage: /mailbox login <name> [tags=a,b,...] [--force]  (log in to a named mailbox)", "warning");
					return;
				}
				const forceFlag = /(^|\s)--force(\s|$)/.test(rest);
				const restClean = rest.replace(/(^|\s)--force(\s|$)/, " ").trim();
				const m = /^(\S+)(?:\s+(\S.*))?$/.exec(restClean);
				const name = (m?.[1] ?? "").toLowerCase();
				let tags: string | undefined;
				if (m?.[2]) {
					const tm = /^tags=(.*)$/.exec(m[2].trim());
					if (!tm) {
						ctx.ui.notify("Usage: /mailbox login <name> [tags=a,b,...] [--force]", "warning");
						return;
					}
					tags = tm[1];
				}
				if (!validMailboxName(name)) {
					ctx.ui.notify(
						"mailbox: invalid name (3-32 chars, lowercase [a-z0-9_-], not a derived-id shape, 'user' reserved)",
						"warning",
					);
					return;
				}
				try {
					// reconnect under the new identity (same-origin relogin
					// replaces; a held name rejects with name_held /
					// mailbox_in_use and we stay on the previous identity).
					// --force is the human's confirmation for an offline
					// takeover, so this path bypasses the agent-side gate.
					const prev = conn?.connected ? conn.address : null;
					const connection = await startConnection(ctx, null, true, { as: name, tags, force: forceFlag });
					storeLogin(name);
					const meta = connection.mailbox.sessionMeta ?? {};
					const inherited = tags ? "" : ` (tags inherited: ${meta.tags ?? "(none)"})`;
					ctx.ui.notify(
						`mailbox: logged in as ${connection.address}${inherited}${prev ? `; was ${prev}` : ""}`,
						"info",
					);
				} catch (err) {
					ctx.ui.notify(`mailbox: login failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (arg === "logout" || arg === "off") {
				await conn?.stop();
				conn = null;
				activateTools(false);
				updateFooterStatus(); // stop() suppresses onDisconnected: refresh manually
				storeLogin(null); // release the binding: resumes no longer auto-login
				ctx.ui.notify("mailbox: logged out (daemon keeps running)", "info");
				return;
			}

			if (arg === "stop service") {
				try {
					await conn?.stop();
					conn = null;
					activateTools(false);
					updateFooterStatus(); // stop() suppresses onDisconnected: refresh manually
					// gracefully stop the daemon via the shutdown protocol
					const bin = findMailboxdBinary();
					if (bin) {
						const result = spawnSync(bin, ["stop"], {
							env: { ...process.env },
							encoding: "utf8",
							timeout: 10_000,
						});
						if (result.status === 0) {
							ctx.ui.notify("mailbox: daemon stopped", "info");
						} else {
							ctx.ui.notify(
								`mailbox: daemon stop: ${result.stderr?.trim() || result.stdout?.trim() || "failed"}`,
								"warning",
							);
						}
					} else {
						ctx.ui.notify("mailbox: disconnected (mailboxd binary not found for stop)", "warning");
					}
				} catch (err) {
					ctx.ui.notify(`mailbox: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (arg === "restart service") {
				try {
					await conn?.stop();
					conn = null;
					activateTools(false);
					updateFooterStatus(); // stop() suppresses onDisconnected: refresh manually
					const bin = findMailboxdBinary();
					if (bin) {
						const result = spawnSync(bin, ["stop"], {
							env: { ...process.env },
							encoding: "utf8",
							timeout: 10_000,
						});
						if (result.status !== 0) {
							ctx.ui.notify(
								`mailbox: daemon stop failed: ${result.stderr?.trim() || result.stdout?.trim() || "unknown error"}`,
								"warning",
							);
						}
					} else {
						ctx.ui.notify("mailbox: mailboxd binary not found; cannot stop daemon", "warning");
					}
					// wait briefly for the daemon to release the lock
					await new Promise((resolve) => setTimeout(resolve, 500));
					const connection = await startConnection(ctx, null, true);
					ctx.ui.notify(`mailbox: restarted as ${connection.address}`, "info");
				} catch (err) {
					ctx.ui.notify(`mailbox: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			let remote: RemoteTarget | null = null;
			let readId: string | null = null;
			let moreCursor: string | null = null;
			let metaUpdate: { set?: Record<string, string>; unset?: string[] } | null = null;
			if (arg.startsWith("read ")) {
				readId = arg.slice(5).trim();
			} else if (arg.startsWith("more ")) {
				moreCursor = arg.slice(5).trim();
			} else if (arg.startsWith("name ")) {
				metaUpdate = { set: { name: arg.slice(5).trim() } };
			} else if (arg.startsWith("tag ")) {
				const tags = arg
					.slice(4)
					.split(",")
					.map((t) => t.trim())
					.filter((t) => t.length > 0);
				metaUpdate = { set: { tags: tags.join(",") } };
			} else if (arg.startsWith("set ")) {
				const set: Record<string, string> = {};
				for (const pair of arg.slice(4).trim().split(/\s+/)) {
					const eq = pair.indexOf("=");
					if (eq <= 0) {
						ctx.ui.notify("Usage: /mailbox set k=v [k2=v2 ...]", "warning");
						return;
					}
					const key = pair.slice(0, eq);
					if (key.startsWith("_")) {
						ctx.ui.notify("mailbox: keys starting with _ are system-reserved", "warning");
						return;
					}
					set[key] = pair.slice(eq + 1);
				}
				metaUpdate = { set };
			} else if (arg.startsWith("unset ")) {
				const keys = arg
					.slice(6)
					.trim()
					.split(/\s+/)
					.filter((k) => k.length > 0);
				if (keys.length === 0) {
					ctx.ui.notify("Usage: /mailbox unset k [k2 ...]", "warning");
					return;
				}
				if (keys.some((k) => k.startsWith("_"))) {
					ctx.ui.notify("mailbox: keys starting with _ are system-reserved", "warning");
					return;
				}
				metaUpdate = { unset: keys };
			} else if (
				arg === "name" ||
				arg === "tag" ||
				arg === "meta" ||
				arg === "list" ||
				arg === "list mail"
			) {
				// show metadata / sessions / inbox below; `list` defaults to mail
			} else if (arg !== "") {
				const m = /^([A-Za-z0-9.-]+):(\d+)(?:\s+(\S+))?$/.exec(arg);
				if (!m) {
					ctx.ui.notify(
						"Usage: /mailbox [login <name> [tags=a,b] [--force] | logout | resume <name> | start service | stop service | restart service | view | status | list [client [all]|mail] | meta | name <n> | tag <a,b> | set k=v | unset k | read <mail-ref> | more <cursor> | host:port [token]]",
						"warning",
					);
					return;
				}
				remote = { host: m[1], port: Number(m[2]), token: m[3] };
			}

			try {
				// host:port always (re)connects; otherwise connect only when
				// the daemon is already running (never spawn — use
				// /mailbox start service to start the daemon)
				if (remote) {
					const connection = await startConnection(ctx, remote);
					ctx.ui.notify(`mailbox: connected`, "info");
				} else if (!conn?.connected) {
					const endpoint = await connectLocalDaemonIfRunning();
					if (endpoint) {
						const connection = await startConnection(ctx, null);
						ctx.ui.notify(`mailbox: connected`, "info");
					}
				}
				const c = requireConnection();
				if (metaUpdate) {
					await c.mailbox.setMeta(metaUpdate);
					const desc = metaUpdate.set
						? Object.entries(metaUpdate.set)
								.map(([k, v]) => `${k} = ${v || "(empty)"}`)
								.join(", ")
						: `unset ${metaUpdate.unset!.join(", ")}`;
					ctx.ui.notify(`mailbox: ${desc}`, "info");
					return;
				}
				if (arg === "name" || arg === "tag" || arg === "meta") {
					const meta = c.mailbox.sessionMeta ?? {};
					const text =
						Object.keys(meta).length === 0
							? "mailbox: no meta set"
							: `mailbox: ${Object.entries(meta)
									.map(([k, v]) => `${k}=${v}`)
									.join("\n         ")}`;
					ctx.ui.notify(text, "info");
					return;
				}
				if (readId) {
					const own = { project: c.mailbox.project!, session: c.mailboxId };
					const ref = parseMailRef(readId, own);
					const mail = await c.mailbox.read(ref);
					if (!mail) {
						ctx.ui.notify(`mailbox: mail ${readId} not found`, "warning");
					} else {
						ctx.ui.notify(formatMail(mail, ref), "info");
					}
					return;
				}
				const showList = arg === "list" || arg === "list mail" || moreCursor !== null;
				const { mails, nextCursor } = await c.mailbox.inbox(undefined, { cursor: moreCursor ?? undefined });
				const unread = mails.filter((m) => !m.readAt).length;
				if (!showList) {
					// plain /mailbox (or a fresh host:port connect): one status line
					ctx.ui.notify(`mailbox: ${await statusSummary(c)} — /mailbox list to view`, "info");
					return;
				}
				const more = nextCursor ? `
(older mails: /mailbox more ${nextCursor})` : "";
				ctx.ui.notify(
					`mailbox: page: ${unread} unread / ${mails.length} shown
${formatMailList(mails)}${more}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`mailbox: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// -----------------------------------------------------------------------
	// agent tools (deferred; activated while connected)
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "mailbox_connect",
		label: "Mailbox connect",
		description:
			"Connect this session to the project's mailbox (the daemon must already be " +
			"running; ask the user to run /mailbox start service if it is not) and " +
			"(mailbox_list, mailbox_read, mailbox_send, mailbox_reply, mailbox_sessions). Use this " +
			"when you need to communicate with other Pi agent sessions in this project: send or " +
			"reply to mail, check your inbox, or discover peer sessions. After connecting, incoming " +
			"mail is announced as notifications and the other mailbox tools become available. " +
			"'as' logs in to a named mailbox (a persistent, human-named identity that survives " +
			"sessions, e.g. as='reviewer') with optional 'tags' overwrite; it is REQUIRED unless " +
			"this session already logged in before (a stored binding auto-applies). A held name " +
			"rejects with mailbox_in_use; a session may hold only one name (session_bound). " +
			"Returns a status summary (mail counts, online clients, this session's address).",
		parameters: Type.Object({
			as: Type.Optional(
				Type.String({
					description:
						"Log in to this named mailbox (3-32 chars, lowercase [a-z0-9_-]) instead of the derived session id; inherits its mails and tags",
				}),
			),
			tags: Type.Optional(
				Type.String({ description: "Login-time tags overwrite as a comma-separated list; omit to inherit the mailbox's existing tags" }),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"Take over the name from an OFFLINE holder. Only valid right after a normal attempt for the same name failed with name_held AND the user confirmed the takeover; never displaces an online holder",
				}),
			),
		}),
		// default exposure (direct, active): the model must see this tool so it
		// can enable the mailbox on its own; it is not part of TOOL_NAMES, so
		// activation toggling never withdraws it
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.as !== undefined && !validMailboxName(params.as.toLowerCase())) {
				throw new Error(
					"mailbox: invalid name (3-32 chars, lowercase [a-z0-9_-], not a derived-id shape, 'user' reserved)",
				);
			}
			const login =
				params.as !== undefined
					? { as: params.as.toLowerCase(), tags: params.tags, force: params.force === true }
					: undefined;
			if (login?.force) {
				// anti-abuse gate: force is only allowed right after a normal
				// attempt for the same name failed with name_held
				if (!gateAllowsForce(login.as)) {
					lastHeld = null;
					throw new Error(
						"mailbox: force_not_allowed: attempted force before a normal login — call mailbox_connect without force first, and only use force after the user confirms the name is taken",
					);
				}
				consumeForceGate();
			}
			if (conn?.connected && login === undefined) {
				const summary = await statusSummary(conn);
				return {
					content: [{ type: "text", text: `mailbox already connected: ${summary}. ${ADDRESS_FORMAT_DOC}` }],
					details: { alreadyConnected: true },
				};
			}
			// connect only if the daemon is already running; never spawn it
			const endpoint = await connectLocalDaemonIfRunning();
			if (!endpoint) {
				throw new Error(
					"mailbox: no running mailboxd daemon found. Ask the user to run `/mailbox start service` to start it.",
				);
			}
			const connection = await startConnection(ctx, null, false, login);
			if (login) storeLogin(login.as); // persist: resumes auto-login
			const summary = await statusSummary(connection);
			return {
				content: [
					{
						type: "text",
						text: `mailbox connected: ${summary}. Your address: ${connection.address}. ${ADDRESS_FORMAT_DOC}`,
					},
				],
				details: { alreadyConnected: false },
			};
		},
	});

	pi.registerTool({
		name: "mailbox_list",
		label: "Mailbox list",
		description:
			"List mails in this session's mailbox, newest first, paginated. Reading a mail with " +
			"mailbox_read marks it read. Optional: unreadOnly, since (ISO timestamp, only mails " +
			"created after it), limit (page size, default 20, max 100), cursor (continuation " +
			"token from a previous call to fetch older mails).",
		parameters: Type.Object({
			unreadOnly: Type.Optional(Type.Boolean({ description: "Only list unread mails" })),
			since: Type.Optional(Type.String({ description: "ISO timestamp; only mails created strictly after it" })),
			limit: Type.Optional(Type.Number({ description: "Page size (default 20, max 100)" })),
			cursor: Type.Optional(Type.String({ description: "Continuation token from a previous mailbox_list result" })),
		}),
		exposure: "deferred",
		async execute(_toolCallId, params) {
			const { mails, nextCursor } = await requireConnection().mailbox.inbox(
				{ unreadOnly: params.unreadOnly, since: params.since },
				{ limit: params.limit, cursor: params.cursor },
			);
			const more = nextCursor ? `\n(more: pass cursor=${nextCursor})` : "";
			return {
				content: [{ type: "text", text: formatMailList(mails) + more }],
				details: { mails, nextCursor },
			};
		},
	});

	pi.registerTool({
		name: "mailbox_read",
		label: "Mailbox read",
		description:
			"Read a mail. A mail is referenced as 'session@project/mail' (the mailbox " +
			"address plus the mail id); a bare mail id means this session's own mailbox. " +
			"Reading own mail marks it read. Use mailbox_list first to get ids.",
		parameters: Type.Object({
			mail: Type.String({ description: "Mail reference 'session@project/mail'; a bare mail id means your own mailbox" }),
		}),
		exposure: "deferred",
		async execute(_toolCallId, params) {
			const c = requireConnection();
			const own = { project: c.mailbox.project!, session: c.mailboxId };
			const ref = parseMailRef(params.mail, own);
			const mail = await c.mailbox.read(ref);
			if (!mail) throw new Error(`mail ${params.mail} not found`);
			return {
				content: [{ type: "text", text: formatMail(mail, ref) }],
				details: { mail, ref },
			};
		},
	});

	pi.registerTool({
		name: "mailbox_send",
		label: "Mailbox send",
		description:
			"Start a NEW conversation thread: send a mail to another session, addressed " +
			"as 'session@project' (a bare session id means this project). This tool " +
			"never references a prior mail, so the result is a new thread root — use " +
			"it only for new topics. To answer, comment on, or follow up ANY existing " +
			"mail, ALWAYS use mailbox_reply instead: it references the original, and a " +
			"'Re:'-style reply sent through mailbox_send breaks the thread chain. The " +
			"target must have registered at least once (its mailbox exists); it does " +
			"not need to be online — offline mail is delivered as unread on its next " +
			"connection (use mailbox_sessions to find sessions). When the target is " +
			"offline, runs on this machine, and herdr is available, it is woken by " +
			"resuming its pi session in a herdr pane and prompted to handle this mail " +
			"(disable with wake: false).",
		parameters: Type.Object({
			address: Type.String({ description: "Target mailbox address 'session@project'; a bare session id means this project. The session must have registered once (see mailbox_sessions)" }),
			subject: Type.String({ description: "Subject line" }),
			body: Type.Optional(Type.String({ description: "Mail body" })),
			refs: Type.Optional(
				Type.Array(
					Type.String(),
					{ description: "Referenced mails as 'session@project/mail' (a bare mail id means your own mailbox)" },
				),
			),
			wake: Type.Optional(
				Type.Boolean({
					description:
					"When the target is offline and herdr is running on this machine, resume its pi session in a herdr pane and prompt it to handle this mail (default true)",
				}),
			),
		}),
		exposure: "deferred",
		async execute(_toolCallId, params) {
			const c = requireConnection();
			const own = { project: c.mailbox.project!, session: c.mailboxId };
			const target = parseAddress(params.address, own.project);
			const refs = params.refs?.map((r) => parseMailRef(r, own));
			const ref = await c.mailbox.sendMail(target, params.subject, params.body ?? "", refs);
			const wakeNote = params.wake === false ? "" : await maybeWake(c, target);
			return {
				content: [{ type: "text", text: `sent: ${formatMailRef(ref)}${wakeNote}` }],
				details: { ref },
			};
		},
	});

	pi.registerTool({
		name: "mailbox_reply",
		label: "Mailbox reply",
		description:
			"Reply to a mail: sends a new mail to the original sender, referencing the " +
			"original (subject 'Re: <original subject>') so the reply joins its thread. " +
			"ALWAYS use this — never mailbox_send — when answering, commenting on, or " +
			"following up any existing mail; unreferenced replies break the thread chain.",
		parameters: Type.Object({
			mail: Type.String({ description: "Mail being replied to: 'session@project/mail'; a bare mail id means your own mailbox" }),
			body: Type.String({ description: "Reply body" }),
			subject: Type.Optional(Type.String({ description: "Override the 'Re: <subject>' default" })),
			wake: Type.Optional(
				Type.Boolean({
					description:
					"When the original sender is offline and herdr is running on this machine, resume its pi session in a herdr pane and prompt it to handle this reply (default true)",
				}),
			),
		}),
		exposure: "deferred",
		async execute(_toolCallId, params) {
			const c = requireConnection();
			const own = { project: c.mailbox.project!, session: c.mailboxId };
			const ref = parseMailRef(params.mail, own);
			const original = await c.mailbox.read(ref);
			if (!original) throw new Error(`mail ${params.mail} not found`);
			let subject = params.subject ?? original.subject;
			if (!params.subject && !/^Re: /u.test(subject)) subject = `Re: ${subject}`;
			subject = subject.slice(0, 256);
			const sent = await c.mailbox.sendMail(original.from, subject, params.body, [ref]);
			const wakeNote = params.wake === false ? "" : await maybeWake(c, original.from);
			return {
				content: [{ type: "text", text: `replied: ${formatMailRef(sent)}${wakeNote}` }],
				details: { ref: sent },
			};
		},
	});

	pi.registerTool({
		name: "mailbox_sessions",
		label: "Mailbox sessions",
		description:
			"List sessions in this project's mailbox with their name, tags, and other " +
			"meta (model, host, ...). Your own session is marked '(you)'. By default only " +
			"online sessions; set includeOffline to also list sessions that registered " +
			"before but are currently disconnected (marked '-' vs '*').",
		parameters: Type.Object({
			includeOffline: Type.Optional(Type.Boolean({ description: "Also list offline (registered but disconnected) sessions" })),
		}),
		exposure: "deferred",
		async execute(_toolCallId, params) {
			const c = requireConnection();
			const sessions = await c.mailbox.sessions(params.includeOffline);
			return {
				content: [
					{ type: "text", text: formatSessions(sessions, { project: c.mailbox.project!, session: c.mailboxId }) },
				],
				details: { sessions },
			};
		},
	});
}
