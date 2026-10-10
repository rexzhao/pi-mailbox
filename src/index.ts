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
 * /mailbox off             disconnect
 * /mailbox status          connection status
 *
 * Agent tools (activated only while connected): mailbox_list, mailbox_read,
 * mailbox_send, mailbox_sessions.
 */

import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { hostname, platform } from "node:os";
import { Type } from "typebox";
import { MailboxConnection, type RemoteTarget } from "./client.ts";
import { connectLocalDaemonIfRunning, findMailboxdBinary } from "./daemon.ts";
import type { MailRecord, MailRef, SessionInfo } from "./protocol.ts";

const TOOL_NAMES = ["mailbox_list", "mailbox_read", "mailbox_send", "mailbox_reply", "mailbox_sessions"] as const;

function formatMailList(mails: MailRecord[]): string {
	if (mails.length === 0) return "mailbox is empty";
	return mails
		.map((m) => {
			const read = m.readAt ? " " : "*";
			const from = m.from.session.slice(0, 8);
			return `[${read}] ${m.id}  from ${from}  ${m.subject}`;
		})
		.join("\n");
}

function formatSessions(sessions: SessionInfo[]): string {
	if (sessions.length === 0) return "no sessions";
	return sessions
		.map((s) => {
			const mark = s.online ? "*" : "-";
			const agent = s.agent ? `  ${s.agent}` : "";
			const name = s.name ? `  name=${s.name}` : "";
			const tags = s.tags && s.tags.length > 0 ? `  tags=${s.tags.join(",")}` : "";
			const extra = Object.entries(s.meta ?? {})
				.filter(([k]) => k !== "name" && k !== "tags" && k !== "_agent")
				.map(([k, v]) => `  ${k}=${v}`)
				.join("");
			return `[${mark}] ${s.session}${agent}${name}${tags}${extra}`;
		})
		.join("\n");
}

function formatMail(mail: MailRecord): string {
	const lines = [
		`subject: ${mail.subject}`,
		`from:    ${mail.from.project}/${mail.from.session}`,
		`date:    ${mail.createdAt}`,
		`read:    ${mail.readAt ?? "unread"}`,
	];
	if ((mail.refs ?? []).length > 0) {
		lines.push(`refs:    ${mail.refs.map((r) => `${r.project}/${r.session}/${r.mail}`).join(", ")}`);
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
	pi.on("agent_end", () => {
		busy = false;
	});
	pi.on("session_shutdown", async () => {
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

	function inject(unread: number): void {
		if (!interactive) return;
		const text = busy
				? `[mailbox] You have ${unread} new mail(s). Finish your current task, then check with mailbox_list.`
				: `[mailbox] You have ${unread} new mail(s); use mailbox_list to read them.`
		try {
			pi.sendUserMessage(text, busy ? { deliverAs: "steer" } : undefined);
		} catch {
			// injection races with run state; the next notify will retry
		}
	}

	async function startConnection(
		ctx: {
			sessionManager: { getSessionId(): string; getCwd(): string; getSessionDir(): string };
			model?: { id: string; provider: string } | undefined;
		},
		remote: RemoteTarget | null,
	): Promise<MailboxConnection> {
		await conn?.stop();
		conn = null;
		const session = ctx.sessionManager.getSessionId();
		const agent = pi.getSessionName() ?? session.slice(0, 8);
		// registration-time auto meta: system keys (leading `_`) refresh on every
		// connect; they cannot be set manually. `_host`/`_platform` are local-only:
		// remote services should not learn machine details.
		const helloMeta: Record<string, string> = {
			_pi: VERSION,
		};
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
				onNotify: inject,
				onConnected: () => activateTools(true),
				onDisconnected: () => activateTools(false),
			},
			{
				helloMeta,
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
					const connection = await startConnection(ctx, null);
					ctx.ui.notify(`mailbox: connected, project ${connection.mailbox.project}`, "info");
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
						const result = spawnSync(bin, ["--stop"], {
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
						ctx.ui.notify("mailbox: disconnected (mailboxd binary not found for --stop)", "warning");
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
						const result = spawnSync(bin, ["--stop"], {
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
					const connection = await startConnection(ctx, null);
					ctx.ui.notify(`mailbox: restarted, project ${connection.mailbox.project}`, "info");
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
						"Usage: /mailbox [start service | stop service | restart service | off | status | list [client [all]|mail] | meta | name <n> | tag <a,b> | set k=v | unset k | read <id> | more <cursor> | host:port [token]]",
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
					const project = c.mailbox.project!;
					const session = ctx.sessionManager.getSessionId();
					const mail = await c.mailbox.read({ project, session, mail: readId });
					if (!mail) {
						ctx.ui.notify(`mailbox: mail ${readId} not found`, "warning");
					} else {
						ctx.ui.notify(formatMail(mail), "info");
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
			"Returns a status summary (mail counts, online clients).",
		parameters: Type.Object({}),
		// default exposure (direct, active): the model must see this tool so it
		// can enable the mailbox on its own; it is not part of TOOL_NAMES, so
		// activation toggling never withdraws it
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (conn?.connected) {
				const summary = await statusSummary(conn);
				return {
					content: [{ type: "text", text: `mailbox already connected: ${summary}` }],
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
						text: `mailbox connected: ${summary}. The mailbox tools (mailbox_list, mailbox_read, mailbox_send, mailbox_reply, mailbox_sessions) are now active.`,
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
			"Read a mail. A mail is addressed by (project, session, mail UUID); project and session " +
			"default to this session's own mailbox. Reading own mail marks it read. Use mailbox_list first " +
			"to get ids. Mails referenced by other mails can be read by their full triple.",
		parameters: Type.Object({
			mail: Type.String({ description: "Mail UUID" }),
			session: Type.Optional(Type.String({ description: "Owner session id (defaults to this session)" })),
			project: Type.Optional(Type.String({ description: "Project UUID (defaults to this project)" })),
		}),
		exposure: "deferred",
		async execute(_toolCallId, params) {
			const c = requireConnection();
			const own = { project: c.mailbox.project!, session: c.session };
			const ref: MailRef = {
				project: params.project ?? own.project,
				session: params.session ?? own.session,
				mail: params.mail,
			};
			const mail = await c.mailbox.read(ref);
			if (!mail) throw new Error(`mail ${params.mail} not found`);
			return {
				content: [{ type: "text", text: formatMail(mail) }],
				details: { mail },
			};
		},
	});

	pi.registerTool({
		name: "mailbox_send",
		label: "Mailbox send",
		description:
			"Send a mail to another session in this project. The target must have " +
			"registered at least once (its mailbox exists); it does not need to be " +
			"online — offline mail is delivered as unread on its next connection " +
			"(use mailbox_sessions to find sessions). Returns the new mail's triple. " +
			"To reply to a mail, prefer mailbox_reply.",
		parameters: Type.Object({
			session: Type.String({ description: "Target session id (must have registered once)" }),
			subject: Type.String({ description: "Subject line" }),
			body: Type.Optional(Type.String({ description: "Mail body" })),
			refs: Type.Optional(
				Type.Array(
					Type.Object({
						project: Type.String({ description: "Project UUID of the referenced mail" }),
						session: Type.String({ description: "Owner session of the referenced mail" }),
						mail: Type.String({ description: "Mail UUID of the referenced mail" }),
					}),
					{ description: "Mails this mail references (e.g. the mail being replied to)" },
				),
			),
		}),
		exposure: "deferred",
		async execute(_toolCallId, params) {
			const c = requireConnection();
			const target = { project: c.mailbox.project!, session: params.session };
			const ref = await c.mailbox.sendMail(target, params.subject, params.body ?? "", params.refs);
			return {
				content: [{ type: "text", text: `sent: ${ref.project}/${ref.session}/${ref.mail}` }],
				details: { ref },
			};
		},
	});

	pi.registerTool({
		name: "mailbox_reply",
		label: "Mailbox reply",
		description:
			"Reply to a mail: sends a new mail to the original sender, referencing the " +
			"original (subject 'Re: <original subject>'). Prefer this over mailbox_send " +
			"when answering a specific mail.",
		parameters: Type.Object({
			mail: Type.String({ description: "Mail UUID being replied to" }),
			body: Type.String({ description: "Reply body" }),
			session: Type.Optional(Type.String({ description: "Owner session of the mail (defaults to this session)" })),
			project: Type.Optional(Type.String({ description: "Project UUID (defaults to this project)" })),
			subject: Type.Optional(Type.String({ description: "Override the 'Re: <subject>' default" })),
		}),
		exposure: "deferred",
		async execute(_toolCallId, params) {
			const c = requireConnection();
			const own = { project: c.mailbox.project!, session: c.session };
			const ref: MailRef = {
				project: params.project ?? own.project,
				session: params.session ?? own.session,
				mail: params.mail,
			};
			const original = await c.mailbox.read(ref);
			if (!original) throw new Error(`mail ${params.mail} not found`);
			if (original.from.project !== own.project) {
				throw new Error("cannot reply across projects");
			}
			let subject = params.subject ?? original.subject;
			if (!params.subject && !/^Re: /u.test(subject)) subject = `Re: ${subject}`;
			subject = subject.slice(0, 256);
			const sent = await c.mailbox.sendMail(original.from, subject, params.body, [ref]);
			return {
				content: [{ type: "text", text: `replied: ${sent.project}/${sent.session}/${sent.mail}` }],
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
