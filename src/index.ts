/**
 * pi-mailbox extension.
 *
 * /mailbox                 connect (host or client) and list this session's mail
 * /mailbox host:port       connect to a remote mailbox service
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
import { hostname, platform } from "node:os";
import { Type } from "typebox";
import { MailboxConnection } from "./client.ts";
import type { MailRecord, MailRef, SessionInfo } from "./protocol.ts";

const TOOL_NAMES = ["mailbox_list", "mailbox_read", "mailbox_send", "mailbox_sessions"] as const;

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
	if (sessions.length === 0) return "no online sessions";
	return sessions
		.map((s) => {
			const name = s.name ? `  name=${s.name}` : "";
			const tags = s.tags && s.tags.length > 0 ? `  tags=${s.tags.join(",")}` : "";
			const extra = Object.entries(s.meta ?? {})
				.filter(([k]) => k !== "name" && k !== "tags")
				.map(([k, v]) => `  ${k}=${v}`)
				.join("");
			return `${s.session}  ${s.agent}${name}${tags}${extra}`;
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
	if (mail.refs.length > 0) {
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
			? `[mailbox] 你有 ${unread} 封新邮件，请完成当前任务后再用 mailbox_list 查看。`
			: `[mailbox] 你有 ${unread} 封新邮件，可用 mailbox_list 查看。`;
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
		remoteUrl: string | null,
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
		if (!remoteUrl) {
			helloMeta._host = hostname();
			helloMeta._platform = platform();
		}
		if (ctx.model) helloMeta._model = `${ctx.model.provider}/${ctx.model.id}`;
		const connection = new MailboxConnection(
			remoteUrl ? "remote" : "local",
			ctx.sessionManager.getCwd(),
			remoteUrl,
			session,
			agent,
			{
				onNotify: inject,
				onConnected: () => activateTools(true),
				onDisconnected: () => activateTools(false),
			},
			{
				// session dir for orphan-mailbox GC (no effect when connecting as client)
				sessionsDir: ctx.sessionManager.getSessionDir(),
				helloMeta,
			},
		);
		conn = connection;
		await connection.start();
		return connection;
	}

	function requireConnection(): MailboxConnection {
		if (!conn?.connected) throw new Error("mailbox not connected; run /mailbox first");
		return conn;
	}

	// -----------------------------------------------------------------------
	// command
	// -----------------------------------------------------------------------

	pi.registerCommand("mailbox", {
		description: "Connect to the project mailbox, list mails, and manage the connection",
		handler: async (args, ctx) => {
			const arg = args.trim();

			if (arg === "off") {
				await conn?.stop();
				conn = null;
				activateTools(false);
				ctx.ui.notify("mailbox: disconnected", "info");
				return;
			}

			if (arg === "status") {
				if (!conn?.connected) {
					ctx.ui.notify("mailbox: disconnected", "info");
				} else {
					const role = conn.isHost ? "hosting" : "client";
					ctx.ui.notify(`mailbox: connected (${role}), project ${conn.mailbox.project}`, "info");
				}
				return;
			}

			let remoteUrl: string | null = null;
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
				arg === "list client"
			) {
				// show metadata / online sessions / inbox below; `list` defaults to mail
			} else if (arg !== "") {
				const m = /^([A-Za-z0-9.-]+):(\d+)$/.exec(arg);
				if (!m) {
					ctx.ui.notify(
						"Usage: /mailbox [list [client|mail] | meta | name <n> | tag <a,b> | set k=v | unset k | read <id> | more <cursor> | host:port | off | status]",
						"warning",
					);
					return;
				}
				remoteUrl = `ws://${m[1]}:${m[2]}`;
			}

			if (!remoteUrl && ctx.mode !== "tui" && ctx.mode !== "rpc") {
				ctx.ui.notify("mailbox: local hosting requires interactive mode; use /mailbox host:port", "warning");
				return;
			}

			try {
				// explicit host:port always (re)connects, even if already connected;
				// otherwise connect only when not yet connected
				if (!conn?.connected || remoteUrl) {
					const connection = await startConnection(ctx, remoteUrl);
					ctx.ui.notify(`mailbox: connected (${connection.isHost ? "hosting" : "client"})`, "info");
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
				if (arg === "list client") {
					const sessions = await c.mailbox.sessions();
					ctx.ui.notify(`mailbox: ${sessions.length} online\n${formatSessions(sessions)}`, "info");
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
				const { mails, nextCursor } = await c.mailbox.inbox(undefined, { cursor: moreCursor ?? undefined });
				const unread = mails.filter((m) => !m.readAt).length;
				const role = c.isHost ? " [server]" : "";
				const more = nextCursor ? `\n(older mails: /mailbox more ${nextCursor})` : "";
				ctx.ui.notify(
					`mailbox: 页内 ${unread} 未读 / 显示 ${mails.length} 封${role}\n${formatMailList(mails)}${more}`,
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
			"Send a mail to another session in this project. The target must be online " +
			"(use mailbox_sessions to find online sessions). Returns the new mail's triple. " +
			"Reply to a mail by including its triple in refs.",
		parameters: Type.Object({
			session: Type.String({ description: "Target session id (must be online)" }),
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
		name: "mailbox_sessions",
		label: "Mailbox sessions",
		description: "List sessions currently online in this project's mailbox, with their name, tags, and other meta (model, host, ...).",
		parameters: Type.Object({}),
		exposure: "deferred",
		async execute(_toolCallId) {
			const sessions = await requireConnection().mailbox.sessions();
			return {
				content: [{ type: "text", text: formatSessions(sessions) }],
				details: { sessions },
			};
		},
	});
}
