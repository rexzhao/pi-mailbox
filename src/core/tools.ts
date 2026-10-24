/**
 * The mailbox agent tools as host-agnostic definitions. The shape is
 * contractual: names, descriptions, schemas, and output text match the
 * historical pi extension byte for byte (except the optional multi-login
 * `as` parameter added on list/read/send/reply). A host registers each
 * entry with its own tool system; execute acts on the controller the
 * definitions were built from.
 */
import { type Static, Type } from "typebox";
import type { MailboxConnection } from "../client.ts";
import { connectLocalDaemonIfRunning, fetchProjectsViaApi, fetchSessionsViaApi } from "../daemon.ts";
import {
	MailboxBindingsOutputSchema,
	MailboxConnectOutputSchema,
	MailboxListOutputSchema,
	MailboxProjectsOutputSchema,
	MailboxReadOutputSchema,
	MailboxSentOutputSchema,
	MailboxSessionsOutputSchema,
	type BindingInfo,
	type ProjectInfo,
} from "../protocol.ts";
import type { MailboxController } from "./controller.ts";
import {
	ADDRESS_FORMAT_DOC,
	asStructured,
	formatMail,
	formatMailList,
	formatMailRef,
	formatSessions,
	MAILBOX_NAMESPACE,
	parseAddress,
	parseMailRef,
	READ_ONLY,
} from "./format.ts";
import type { MailboxToolDefinition, MailboxToolResult } from "./types.ts";
import { validMailboxName } from "./names.ts";

/** The deferred tools whose activation toggles with the connection (mailbox_connect is default-exposure). */
export const DEFERRED_TOOL_NAMES = [
	"mailbox_list",
	"mailbox_read",
	"mailbox_send",
	"mailbox_reply",
	"mailbox_sessions",
	"mailbox_projects",
	"mailbox_bindings",
] as const;

/** Shared `as` parameter (multi-login identity selection). */
function asParam(extra: string): ReturnType<typeof Type.Optional> {
	return Type.Optional(
		Type.String({
			description:
				`Operate as this held mailbox identity instead of the current one (multi-login: a session may hold several names; ` +
				`the default is the last successful login). ${extra}`,
		}),
	);
}

export function buildToolDefinitions(controller: MailboxController): MailboxToolDefinition[] {
	/** Resolve the connection for an optional `as` and remember its canonical name. */
	function conn(as: string | undefined): { c: MailboxConnection; name: string } {
		const c = controller.requireConnection(as);
		// canonicalize for refreshUnread: as comes in claimed spelling
		return { c, name: (as ?? controller.currentName ?? c.mailboxId).toLowerCase() };
	}

	return [
		{
			name: "mailbox_connect",
			label: "Mailbox connect",
			namespace: MAILBOX_NAMESPACE,
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
				"rejects with mailbox_in_use; multi-login is supported: logging in with another name " +
				"ADDS it to the session's held names instead of switching. " +
				"Returns a status summary (mail counts, online clients, this session's address; the " +
				"address carries the claimed spelling — the canonical id is lowercase, and every " +
				"address use is case-insensitive). " +
				"Mail from 'user' is your human operator; all other senders are peer agents.",
			parameters: Type.Object({
				as: Type.Optional(
					Type.String({
						minLength: 1,
						maxLength: 255,
						// case is display-only: the daemon canonicalizes the identity
						// to lowercase, so "Reviewer" and "reviewer" are the same
						// mailbox
						pattern: "^[A-Za-z][A-Za-z0-9_-]{0,254}$",
						description:
							"Log in to this named mailbox instead of the derived session id; inherits its mails and tags " +
							"(case-insensitive; names are lowercase). The schema encodes the grammar only: the runtime " +
							"additionally rejects derived-id-shaped names (10 lowercase base36) and reserved names " +
							"(user, con, nul, com1-9, lpt1-9)",
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
			// can enable the mailbox on its own; it is not part of the deferred
			// set, so activation toggling never withdraws it
			outputSchema: MailboxConnectOutputSchema,
			async execute(_toolCallId, params): Promise<MailboxToolResult> {
				const as = params.as as string | undefined;
				if (as !== undefined && !validMailboxName(as)) {
					throw new Error(
						"mailbox: invalid name (1-255 chars, letter first, [A-Za-z0-9_-], not a derived-id shape, 'user' reserved)",
					);
				}
				// the claimed spelling is kept (display case); the daemon
				// canonicalizes the identity to lowercase
				const login =
					as !== undefined
						? { as, tags: params.tags as string | undefined, force: params.force === true }
						: undefined;
				if (login?.force) {
					// anti-abuse gate: force is only allowed right after a normal
					// attempt for the same name failed with name_held
					if (!controller.gateAllowsForce(login.as)) {
						controller.consumeForceGate();
						throw new Error(
							"mailbox: force_not_allowed: attempted force before a normal login — call mailbox_connect without force first, and only use force after the user confirms the name is taken",
						);
					}
					controller.consumeForceGate();
				}
				if (login === undefined && controller.connected) {
					// the connection is read once here and passed explicitly: the
					// builder must not re-read live state after its awaits (a
					// reconnect in between would mix addresses/counts from
					// different connections)
					const c = controller.requireConnection();
					const status = await controller.connectionStatus(c);
					return {
						content: [
							{ type: "text", text: `mailbox already connected: ${controller.renderStatus(status)}. ${ADDRESS_FORMAT_DOC}` },
						],
						details: { alreadyConnected: true },
						structuredContent: asStructured({
							address: status.address,
							alreadyConnected: true,
							mails: status.mails,
							onlineClients: status.onlineClients,
						} satisfies Static<typeof MailboxConnectOutputSchema>),
					};
				}
				// connect only if the daemon is already running; never spawn it
				const endpoint = await connectLocalDaemonIfRunning();
				if (!endpoint) {
					throw new Error(
						"mailbox: no running mailboxd daemon found. Ask the user to run `/mailbox start service` to start it.",
					);
				}
				const connection = login ? await controller.login(login) : await controller.connectBinding();
				const status = await controller.connectionStatus(connection);
				return {
					content: [
						{
							type: "text",
							text: `mailbox connected: ${controller.renderStatus(status)}. Your address: ${status.address}. ${ADDRESS_FORMAT_DOC}`,
						},
					],
					details: { alreadyConnected: false },
					structuredContent: asStructured({
						address: status.address,
						alreadyConnected: false,
						mails: status.mails,
						onlineClients: status.onlineClients,
					} satisfies Static<typeof MailboxConnectOutputSchema>),
				};
			},
		},
		{
			name: "mailbox_list",
			label: "Mailbox list",
			namespace: MAILBOX_NAMESPACE,
			annotations: READ_ONLY,
			description:
				"List mails in this session's mailbox, newest first, paginated. Reading a mail with " +
				"mailbox_read marks it read. Optional: unreadOnly, since (ISO timestamp, only mails " +
				"created after it), limit (page size, default 20, max 100), cursor (continuation " +
				"token from a previous call to fetch older mails), as (a held identity for multi-login).",
			parameters: Type.Object({
				unreadOnly: Type.Optional(Type.Boolean({ description: "Only list unread mails" })),
				since: Type.Optional(Type.String({ description: "ISO timestamp; only mails created strictly after it" })),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 100, default: 20, description: "Page size" }),
				),
				cursor: Type.Optional(Type.String({ description: "Continuation token from a previous mailbox_list result" })),
				as: asParam("The listed inbox is that identity's."),
			}),
			exposure: "deferred",
			outputSchema: MailboxListOutputSchema,
			async execute(_toolCallId, params): Promise<MailboxToolResult> {
				const { c } = conn(params.as as string | undefined);
				const { mails, nextCursor, total, totalUnread } = await c.mailbox.inbox(
					{ unreadOnly: params.unreadOnly as boolean | undefined, since: params.since as string | undefined },
					{ limit: params.limit as number | undefined, cursor: params.cursor as string | undefined },
				);
				const more = nextCursor ? `
(more: pass cursor=${nextCursor})` : "";
				return {
					content: [{ type: "text", text: formatMailList(mails) + more }],
					details: { mails, nextCursor },
					// nextCursor omitted (not undefined) at the end of pagination so the
					// serialized form matches the schema exactly; `satisfies` binds the
					// literal to the declared schema at compile time (a renamed key
					// fails tsc, closing the gap the identity cast alone would leave)
					structuredContent: asStructured(
						(nextCursor
							? { mails, nextCursor, total, totalUnread }
							: { mails, total, totalUnread }) satisfies Static<typeof MailboxListOutputSchema>,
					),
				};
			},
		},
		{
			name: "mailbox_read",
			label: "Mailbox read",
			namespace: MAILBOX_NAMESPACE,
			description:
				"Read a mail. A mail is referenced as 'session@project/mail' (the mailbox " +
				"address plus the mail id); a bare mail id means this session's own mailbox. " +
				"Reading own mail marks it read. Use mailbox_list first to get ids.",
			parameters: Type.Object({
				mail: Type.String({ description: "Mail reference 'session@project/mail'; a bare mail id means your own mailbox" }),
				as: asParam("Own-mail detection and read-marking apply to that identity's mailbox."),
			}),
			exposure: "deferred",
			outputSchema: MailboxReadOutputSchema,
			async execute(_toolCallId, params): Promise<MailboxToolResult> {
				const { c, name } = conn(params.as as string | undefined);
				const own = { project: c.mailbox.project!, session: c.mailboxId };
				const ref = parseMailRef(params.mail as string, own);
				const mail = await c.mailbox.read(ref);
				if (!mail) throw new Error(`mail ${params.mail as string} not found`);
				void controller.refreshUnread(name); // reading own mail marks it read
				return {
					content: [{ type: "text", text: formatMail(mail, ref) }],
					details: { mail, ref },
					// the resolved full ref (a bare id input was expanded to own)
					structuredContent: asStructured({
						mail,
						ref: formatMailRef(ref),
					} satisfies Static<typeof MailboxReadOutputSchema>),
				};
			},
		},
		{
			name: "mailbox_send",
			label: "Mailbox send",
			namespace: MAILBOX_NAMESPACE,
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
				subject: Type.String({ maxLength: 256, description: "Subject line" }),
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
				as: asParam("The mail is sent FROM that identity."),
			}),
			exposure: "deferred",
			outputSchema: MailboxSentOutputSchema,
			async execute(_toolCallId, params): Promise<MailboxToolResult> {
				const { c } = conn(params.as as string | undefined);
				const own = { project: c.mailbox.project!, session: c.mailboxId };
				const target = parseAddress(params.address as string, own.project);
				const refs = (params.refs as string[] | undefined)?.map((r) => parseMailRef(r, own));
				const ref = await c.mailbox.sendMail(target, params.subject as string, (params.body as string | undefined) ?? "", refs);
				const wakeNote = params.wake === false ? "" : await controller.maybeWake(c, target);
				return {
					content: [{ type: "text", text: `sent: ${formatMailRef(ref)}${wakeNote}` }],
					details: { ref },
					structuredContent: asStructured({
						ref: formatMailRef(ref),
					} satisfies Static<typeof MailboxSentOutputSchema>),
				};
			},
		},
		{
			name: "mailbox_reply",
			label: "Mailbox reply",
			namespace: MAILBOX_NAMESPACE,
			description:
				"Reply to a mail: sends a new mail to the original sender, referencing the " +
				"original (subject 'Re: <original subject>') so the reply joins its thread. " +
				"ALWAYS use this — never mailbox_send — when answering, commenting on, or " +
				"following up any existing mail; unreferenced replies break the thread chain.",
			parameters: Type.Object({
				mail: Type.String({ description: "Mail being replied to: 'session@project/mail'; a bare mail id means your own mailbox" }),
				body: Type.String({ description: "Reply body" }),
				subject: Type.Optional(Type.String({ maxLength: 256, description: "Override the 'Re: <subject>' default" })),
				wake: Type.Optional(
					Type.Boolean({
						description:
							"When the original sender is offline and herdr is running on this machine, resume its pi session in a herdr pane and prompt it to handle this reply (default true)",
					}),
				),
				as: asParam("The reply is sent FROM that identity."),
			}),
			exposure: "deferred",
			outputSchema: MailboxSentOutputSchema,
			async execute(_toolCallId, params): Promise<MailboxToolResult> {
				const { c } = conn(params.as as string | undefined);
				const own = { project: c.mailbox.project!, session: c.mailboxId };
				const ref = parseMailRef(params.mail as string, own);
				const original = await c.mailbox.read(ref);
				if (!original) throw new Error(`mail ${params.mail as string} not found`);
				let subject = (params.subject as string | undefined) ?? original.subject;
				if (params.subject === undefined && !/^Re: /u.test(subject)) subject = `Re: ${subject}`;
				subject = subject.slice(0, 256);
				const sent = await c.mailbox.sendMail(original.from, subject, params.body as string, [ref]);
				const wakeNote = params.wake === false ? "" : await controller.maybeWake(c, original.from);
				return {
					content: [{ type: "text", text: `replied: ${formatMailRef(sent)}${wakeNote}` }],
					details: { ref: sent },
					structuredContent: asStructured({
						ref: formatMailRef(sent),
					} satisfies Static<typeof MailboxSentOutputSchema>),
				};
			},
		},
		{
			name: "mailbox_projects",
			label: "Mailbox projects",
			namespace: MAILBOX_NAMESPACE,
			annotations: READ_ONLY,
			description:
				"List the projects this daemon currently knows: project id plus, in local mode, " +
				"the host and filesystem path of each project root. A project appears once a session " +
				"from it has connected since the daemon started — a project whose sessions are all " +
				"offline since the last daemon restart is not listed. Use this to discover which " +
				"project a peer lives in before cross-project mail (the target address is " +
				"'session@project'; mailbox_send accepts cross-project targets when the daemon " +
				"serves both). Optional: includeSessions adds per-project counts (total and online) " +
				"— counts are session records (a named mailbox plus its derived bookkeeping " +
				"record), not unique mailboxes. Local mode only — against a remote daemon this " +
				"tool errors (remote daemons do not expose the project listing).",
			parameters: Type.Object({
				includeSessions: Type.Optional(
					Type.Boolean({
						description:
							"Include per-project counts (total, online); session records, not unique mailboxes. Costs one extra daemon query",
					}),
				),
			}),
			exposure: "deferred",
			outputSchema: MailboxProjectsOutputSchema,
			async execute(_toolCallId, params): Promise<MailboxToolResult> {
				const c = controller.requireConnection();
				if (c.remoteTarget) {
					// the listing comes from the daemon's loopback HTTP API
					// (/api/info), which remote daemons do not expose
					throw new Error(
						"mailbox: mailbox_projects is local-mode only — remote daemons do not expose the project listing",
					);
				}
				const projects = await fetchProjectsViaApi();
				let list: ProjectInfo[] = projects;
				if (params.includeSessions === true) {
					// /api/sessions (no project filter) spans every project;
					// aggregate by project id
					const sessions = await fetchSessionsViaApi();
					const byProject = new Map<string, { total: number; online: number }>();
					for (const s of sessions) {
						if (!s.project) continue;
						const agg = byProject.get(s.project) ?? { total: 0, online: 0 };
						agg.total++;
						if (s.online) agg.online++;
						byProject.set(s.project, agg);
					}
					// counts default to 0 for projects with no session records:
					// "absent" and "0" read very differently to a model
					list = projects.map((p) => ({ ...p, ...(byProject.get(p.project) ?? { total: 0, online: 0 }) }));
				}
				const text =
					list.length === 0
						? "no projects known yet — a project appears once a session from it has connected"
						: list
								.map((p) => {
									const where = p.path ? ` ${p.path}` : "";
									const counts = p.total !== undefined ? ` (${p.total} sessions, ${p.online ?? 0} online)` : "";
									return `${p.project}${where}${counts}`;
								})
								.join("\n");
				return {
					content: [{ type: "text", text }],
					details: { projects: list },
					structuredContent: asStructured({ projects: list } satisfies Static<typeof MailboxProjectsOutputSchema>),
				};
			},
		},
		{
			name: "mailbox_sessions",
			label: "Mailbox sessions",
			namespace: MAILBOX_NAMESPACE,
			annotations: READ_ONLY,
			description:
				"List sessions in this project's mailbox with their name, tags, and other " +
				"meta (model, host, ...). Your own session is marked '(you)'. By default only " +
				"online sessions; set includeOffline to also list sessions that registered " +
				"before but are currently disconnected (marked '-' vs '*').",
			parameters: Type.Object({
				includeOffline: Type.Optional(Type.Boolean({ description: "Also list offline (registered but disconnected) sessions" })),
			}),
			exposure: "deferred",
			outputSchema: MailboxSessionsOutputSchema,
			async execute(_toolCallId, params): Promise<MailboxToolResult> {
				const c = controller.requireConnection();
				const sessions = await c.mailbox.sessions(params.includeOffline as boolean | undefined);
				return {
					content: [
						{ type: "text", text: formatSessions(sessions, { project: c.mailbox.project!, sessions: controller.heldNames }) },
					],
					details: { sessions },
					structuredContent: asStructured({
						sessions,
					} satisfies Static<typeof MailboxSessionsOutputSchema>),
				};
			},
		},
		{
			name: "mailbox_bindings",
			label: "Mailbox bindings",
			namespace: MAILBOX_NAMESPACE,
			description:
				"Manage this project's channel bindings: a binding ties mailboxes of this project " +
				"to a delivery channel (currently 'webhook'), which then acts as an independent " +
				"consumer of those mailboxes — mail arriving at a bound mailbox is delivered to the " +
				"channel (e.g. POSTed to a webhook URL) instead of waiting for a session. One mailbox " +
				"has one owner: a binding claims its targets; a session can always take a mailbox back " +
				"with a confirmed force login (the binding's target is then 'lost' until explicitly " +
				"re-claimed); bindings never displace online sessions. Actions: list / add / update / " +
				"delete. The channel config is channel-defined JSON (passed through to the daemon) — " +
				"for the 'webhook' channel: {url, secret, headers?, sign?} where url must be https " +
				"(http only for loopback/private targets), secret >= 8 chars, headers is an optional " +
				"map of static auth headers, sign (default true) toggles the X-Mailbox-Timestamp / " +
				"X-Mailbox-Signature HMAC-SHA256 pair. The webhook payload carries mail summaries " +
				"(id, from, subject, 200-char snippet) — never full bodies; the receiver reads back " +
				"via the daemon's read-only HTTP API. Errors: mailbox_in_use (target held online), " +
				"name_held (target held offline; retry with force after user confirmation), " +
				"invalid_config, unsupported_channel.",
			parameters: Type.Object({
				action: Type.String({
					description: "One of: list (this project's bindings, redacted), add, update, delete",
				}),
				channel: Type.Optional(
					Type.String({ description: "Channel type (add only); e.g. 'webhook'. See the daemon's caps for supported types" }),
				),
				config: Type.Optional(
					Type.String({
						description:
							"Channel-defined config as a JSON string (add; update replaces it). For webhook: " +
							'{"url":"https://...","secret":"...","headers":{...},"sign":true}',
					}),
				),
				targets: Type.Optional(
					Type.Array(Type.String(), {
						description: "Mailbox names in this project the channel claims (add; update replaces the set)",
					}),
				),
				id: Type.Optional(Type.String({ description: "Binding id (update / delete)" })),
				enabled: Type.Optional(Type.Boolean({ description: "Enable or disable (update); disabling releases all targets" })),
				force: Type.Optional(
					Type.Boolean({
						description: "Take over targets held by offline sessions (add / update). Only after user confirmation",
					}),
				),
			}),
			exposure: "deferred",
			outputSchema: MailboxBindingsOutputSchema,
			async execute(_toolCallId, params): Promise<MailboxToolResult> {
				if (!controller.supportsBindings) {
					throw new Error(
						"mailbox: the daemon does not support channel bindings (old daemon? restart it with a current build)",
					);
				}
				const action = String(params.action);
				if (action === "list") {
					const bindings = await controller.bindingList();
					const text =
						bindings.length === 0
							? "no channel bindings in this project"
							: bindings.map(formatBinding).join("\n");
						return {
							content: [{ type: "text", text }],
							details: { bindings },
							structuredContent: asStructured({ bindings } satisfies Static<typeof MailboxBindingsOutputSchema>),
						};
				}
				if (action === "add") {
					const channel = String(params.channel ?? "webhook");
					const config = params.config === undefined ? undefined : parseBindingConfig(params.config);
					const targets = params.targets;
					if (!Array.isArray(targets) || targets.length === 0) {
						throw new Error("mailbox: add requires targets (mailbox names in this project)");
					}
					const b = await controller.bindingAdd({
						channel,
						config,
						targets: targets.map(String),
						force: params.force === true,
					});
					return { content: [{ type: "text", text: `binding ${b.id} created: ${formatBinding(b)}` }] };
				}
				if (action === "update") {
					const id = params.id;
					if (typeof id !== "string" || id === "") throw new Error("mailbox: update requires id");
					const b = await controller.bindingUpdate({
						id,
						config: params.config === undefined ? undefined : parseBindingConfig(params.config),
						targets: Array.isArray(params.targets) ? params.targets.map(String) : undefined,
						enabled: typeof params.enabled === "boolean" ? params.enabled : undefined,
						force: params.force === true,
					});
					return { content: [{ type: "text", text: `binding ${b.id} updated: ${formatBinding(b)}` }] };
				}
				if (action === "delete") {
					const id = params.id;
					if (typeof id !== "string" || id === "") throw new Error("mailbox: delete requires id");
					const b = await controller.bindingDelete(id);
					return { content: [{ type: "text", text: `binding ${b.id} deleted (targets released)` }] };
				}
				throw new Error(`mailbox: unknown action '${action}' (list / add / update / delete)`);
			},
		},
	];
}

/** Render one binding line for tool/command output. */
function formatBinding(b: BindingInfo): string {
	const state = b.enabled ? (b.lost && b.lost.length > 0 ? "enabled, targets lost" : "enabled") : "disabled";
	const targets = b.targets.join(", ");
	const lost = b.lost && b.lost.length > 0 ? ` [lost: ${b.lost.join(", ")}]` : "";
	const desc = b.describe ? ` — ${b.describe}` : "";
	return `${b.id} ${b.channel} -> ${targets}${lost} (${state})${desc}`;
}

/** Parse a channel config JSON string (tool input); throws with context. */
function parseBindingConfig(raw: unknown): unknown {
	if (typeof raw !== "string") throw new Error("mailbox: config must be a JSON string");
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new Error(`mailbox: config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}
