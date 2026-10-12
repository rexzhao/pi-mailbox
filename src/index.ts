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
import { hostname, platform } from "node:os";
import { Type } from "typebox";
import { MailboxConnection, type RemoteTarget } from "./client.ts";
import { connectLocalDaemonIfRunning, findMailboxdBinary } from "./daemon.ts";
import { wakeOfflineSession } from "./herdr.ts";
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

function formatSessions(sessions: SessionInfo[]): string {
	if (sessions.length === 0) return "no sessions";
	return sessions
		.map((s) => {
			const mark = s.online ? "*" : "-";
			const address = s.project ? `${s.session}@${s.project}` : s.session;
			const agent = s.agent ? `  ${s.agent}` : "";
			const name = s.name ? `  name=${s.name}` : "";
			const tags = s.tags && s.tags.length > 0 ? `  tags=${s.tags.join(",")}` : "";
			const extra = Object.entries(s.meta ?? {})
				.filter(([k]) => k !== "name" && k !== "tags" && k !== "_agent" && k !== "_origin")
				.map(([k, v]) => `  ${k}=${v}`)
				.join("");
			return `[${mark}] ${address}${agent}${name}${tags}${extra}`;
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

	pi.on("session_start", (_event, ctx) => {
		interactive = ctx.mode === "tui" || ctx.mode === "rpc";
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
	pi.on("session_shutdown", async () => {
		if (flushTimer !== null) clearTimeout(flushTimer);
		flushTimer = null;
		await conn?.stop();
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

	async function startConnection(
		ctx: {
			sessionManager: { getSessionId(): string; getCwd(): string; getSessionDir(): string };
			model?: { id: string; provider: string } | undefined;
		},
		remote: RemoteTarget | null,
		canSpawn = false,
	): Promise<MailboxConnection> {
		await conn?.stop();
		conn = null;
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
		const connection = new MailboxConnection(
			remote ? "remote" : "local",
			ctx.sessionManager.getCwd(),
			remote,
			session,
			agent,
			{
				onNotify: handleNotify,
				onConnected: () => activateTools(true),
				onDisconnected: () => activateTools(false),
			},
			{
				helloMeta,
				canSpawn,
			},
		);
		// the daemon's lifecycle GC needs the pi session directory (local mode)
		connection.sessionDirProvider = () => ctx.sessionManager.getSessionDir();
		conn = connection;
		await connection.start();
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
			const result = await wakeOfflineSession({
				session: target.session,
				origin,
				projectRoot: c.projectDir,
				label: info.name,
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
		let onlinePart = "";
		try {
			const online = (await c.mailbox.sessions()).filter((s) => s.online).length;
			onlinePart = `, ${online} clients online`;
		} catch {
			// best-effort; keep the mail counts when the sessions query fails
		}
		return `${total} mails (${totalUnread} unread)${onlinePart}`;
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

			if (arg === "off") {
				await conn?.stop();
				conn = null;
				activateTools(false);
				ctx.ui.notify("mailbox: disconnected (daemon keeps running)", "info");
				return;
			}

			if (arg === "stop service") {
				try {
					await conn?.stop();
					conn = null;
					activateTools(false);
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
				arg === "list mail" ||
				arg === "list client" ||
				arg === "list client all"
			) {
				// show metadata / sessions / inbox below; `list` defaults to mail
			} else if (arg !== "") {
				const m = /^([A-Za-z0-9.-]+):(\d+)(?:\s+(\S+))?$/.exec(arg);
				if (!m) {
					ctx.ui.notify(
						"Usage: /mailbox [start service | stop service | restart service | view | off | status | list [client [all]|mail] | meta | name <n> | tag <a,b> | set k=v | unset k | read <mail-ref> | more <cursor> | host:port [token]]",
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
				if (arg === "list client" || arg === "list client all") {
					const sessions = await c.mailbox.sessions(arg === "list client all");
					const online = sessions.filter((s) => s.online).length;
					const scope =
						arg === "list client all" ? `${online} online / ${sessions.length} total` : `${online} online`;
					ctx.ui.notify(`mailbox: ${scope}\n${formatSessions(sessions)}`, "info");
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
					const own = { project: c.mailbox.project!, session: c.shortSession };
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
			"Returns a status summary (mail counts, online clients, this session's address).",
		parameters: Type.Object({}),
		// default exposure (direct, active): the model must see this tool so it
		// can enable the mailbox on its own; it is not part of TOOL_NAMES, so
		// activation toggling never withdraws it
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (conn?.connected) {
				const summary = await statusSummary(conn);
				return {
					content: [{ type: "text", text: `mailbox already connected: ${summary}. Your address: ${conn.address}. ${ADDRESS_FORMAT_DOC}` }],
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
			const connection = await startConnection(ctx, null);
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
			const own = { project: c.mailbox.project!, session: c.shortSession };
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
			const own = { project: c.mailbox.project!, session: c.shortSession };
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
			const own = { project: c.mailbox.project!, session: c.shortSession };
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
			"meta (model, host, ...). By default only online sessions; set " +
			"includeOffline to also list sessions that registered before but are " +
			"currently disconnected (marked '-' vs '*').",
		parameters: Type.Object({
			includeOffline: Type.Optional(Type.Boolean({ description: "Also list offline (registered but disconnected) sessions" })),
		}),
		exposure: "deferred",
		async execute(_toolCallId, params) {
			const sessions = await requireConnection().mailbox.sessions(params.includeOffline);
			return {
				content: [{ type: "text", text: formatSessions(sessions) }],
				details: { sessions },
			};
		},
	});
}
