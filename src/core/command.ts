/**
 * The /mailbox command as a host-agnostic handler: the host registers
 * `mailbox` with its own command system and forwards the raw argument
 * string; all output goes through host.notify. Subcommand behavior and
 * wording match the historical pi extension (multi-login adds: login
 * accumulates identities, logout takes an optional name).
 */
import { spawnSync } from "node:child_process";
import { MailboxError, type RemoteTarget } from "../client.ts";
import { connectLocalDaemonIfRunning, deriveProjectId, fetchSessionsViaApi, findMailboxdBinary } from "../daemon.ts";
import type { SessionInfo } from "../protocol.ts";
import type { MailboxController } from "./controller.ts";
import { formatDeleteSummary, formatMail, formatMailList, formatSessions, parseMailRef } from "./format.ts";
import { validMailboxName } from "./names.ts";

type Level = "info" | "warning" | "error";

/** All command output funnels through the host's notify. */
function out(controller: MailboxController, msg: string, level: Level = "info"): void {
	controller.hostNotify(msg, level);
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function executeMailboxCommand(controller: MailboxController, rawArg: string): Promise<void> {
	const arg = rawArg.trim();
	const host = controller.hostRef;

	if (arg === "start service") {
		try {
			if (controller.connected) {
				out(controller, "mailbox: already connected", "info");
				return;
			}
			// starting the SERVICE is decoupled from the named-account
			// connect policy: a session that never logged in can still
			// bring the daemon up. This command is the ONLY spawn path
			// (connections never spawn): bring the daemon up explicitly,
			// then connect when a stored binding exists.
			const wasRunning = await controller.probeRunningDaemon();
			await controller.ensureDaemon(); // spawn if dead; resolve if alive
			const binding = host.loginStore.readLogin();
			if (binding && binding.names.length > 0) {
				const connection = await controller.connectBinding();
				out(controller, `mailbox: connected as ${connection.address}`, "info");
			} else {
				out(
					controller,
					wasRunning
						? "mailbox: service already running — run /mailbox login <name> to connect"
						: "mailbox: service started — run /mailbox login <name> to connect",
					"info",
				);
			}
		} catch (err) {
			out(controller, `mailbox: ${errMsg(err)}`, "error");
		}
		return;
	}

	if (arg === "view") {
		try {
			const url = await controller.resolveViewUrl();
			// open the full URL (token in the fragment for remote); show
			// the address without the token so it never lands in the
			// persistent session transcript
			const remote = controller.remoteTarget;
			const fullUrl = remote?.token ? `${url}#t=${remote.token}` : url;
			out(
				controller,
				remote?.token ? `mailbox: ${url} (token applied via URL fragment; omitted here)` : `mailbox: ${url}`,
				"info",
			);
			host.openUrl?.(fullUrl);
		} catch (err) {
			out(controller, `mailbox: ${errMsg(err)}`, "error");
		}
		return;
	}

	if (arg === "resume" || arg.startsWith("resume ")) {
		const name = arg.slice(6).trim().toLowerCase();
		if (!name) {
			out(controller, "Usage: /mailbox resume <name>  (switch this terminal to the named mailbox's session)", "warning");
			return;
		}
		try {
			if (!host.switchSession) {
				out(controller, "mailbox: resume is not supported by this host (no session switching)", "error");
				return;
			}
			// resolve via the daemon's read-only HTTP API: resume must
			// not require this session to have a mailbox of its own
			const projectRoot = host.identity.cwd;
			const projectId = await deriveProjectId(projectRoot);
			const sessions = await fetchSessionsViaApi({ id: projectId, root: projectRoot });
			const info = sessions.find((s) => s.session === name && s.project === projectId);
			if (!info) {
				out(controller, `mailbox: no such named mailbox '${name}' in this project`, "error");
				return;
			}
			if ((info.meta ?? {})._named !== "1") {
				out(controller, `mailbox: '${name}' is not a named mailbox`, "error");
				return;
			}
			const origin = (info.meta ?? {})._origin;
			if (!origin) {
				out(controller, `mailbox: '${name}' has no recorded session to resume`, "error");
				return;
			}
			// self-check FIRST: resuming your own name while connected
			// as it must say "already this session", not "holder
			// running elsewhere"
			if (origin === host.identity.sessionId) {
				out(controller, `mailbox: '${name}' is already this session`, "info");
				return;
			}
			if (info.online) {
				out(
					controller,
					`mailbox: '${name}' is online — its holder session is running elsewhere; close it first (or send it a note instead)`,
					"error",
				);
				return;
			}
			// the session file must exist (switching to a dead id would
			// silently create an empty session)
			const sessionFile = controller.findSessionFile(origin);
			if (!sessionFile) {
				out(
					controller,
					`mailbox: the session behind '${name}' is gone (file deleted); claim the name with /mailbox login ${name} [--force] instead`,
					"error",
				);
				return;
			}
			// a live-but-disconnected pi on that session file would now be
			// doubled; detect it through the host (herdr pane) when available
			const livePane = (await host.findLiveSession?.(origin)) ?? null;
			if (livePane) {
				out(
					controller,
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
			const { cancelled } = await host.switchSession(sessionFile);
			if (cancelled) out(controller, "mailbox: resume cancelled (still connected as before)", "warning");
		} catch (err) {
			out(controller, `mailbox: ${errMsg(err)}`, "error");
		}
		return;
	}

	if (arg === "delete" || arg.startsWith("delete ")) {
		// whitespace-separated names (the grammar has no spaces), lowercased, deduped
		const names = [...new Set(arg.slice(7).trim().split(/\s+/).filter(Boolean).map((n) => n.toLowerCase()))];
		if (names.length === 0) {
			out(controller, "Usage: /mailbox delete <name> [<name> ...]  (hard-delete mailboxes in this project: mails, meta, registration)", "warning");
			return;
		}
		try {
			if (names.length === 1) {
				const name = names[0]!;
				const projectRoot = host.identity.cwd;
				const projectId = await deriveProjectId(projectRoot);
				const sessions = await fetchSessionsViaApi({ id: projectId, root: projectRoot });
				const info = sessions.find((s) => s.session === name && s.project === projectId);
				if (!info) {
					out(controller, `mailbox: no such mailbox '${name}' in this project`, "error");
					return;
				}
				// online mailboxes are never deleted — the daemon refuses a
				// live mailbox, and that includes one's own current login:
				// log out explicitly first, then delete (the owner's
				// decision: no implicit disconnect inside delete)
				if (info.online) {
					// the held name is canonical; fold for the comparison
					const own = controller.isHeld(name);
					out(
						controller,
						own
							? `mailbox: '${name}' is your own current login — run /mailbox logout first, then delete`
							: `mailbox: '${name}' is online — its holder must disconnect first (the daemon refuses to delete a live mailbox)`,
						"error",
					);
					return;
				}
				const totals = await controller.mailboxTotals(name);
				await controller.deleteMailbox(name);
				out(
					controller,
					`mailbox: deleted '${name}'${totals ? ` (${totals.total} mails, ${totals.totalUnread} unread)` : ""} — irreversibly`,
					"info",
				);
				return;
			}
			// batch: best-effort in the order given; a per-name outcome
			// never aborts the batch.
			const outcome = await controller.deleteMailboxes(names);
			const summary = formatDeleteSummary(outcome);
			out(controller, summary.text, summary.level);
		} catch (err) {
			out(controller, `mailbox: delete failed: ${errMsg(err)}`, "error");
		}
		return;
	}

	if (arg === "binding" || arg.startsWith("binding ")) {
		await executeBindingCommand(controller, arg.slice("binding".length).trim());
		return;
	}

	if (arg === "list client" || arg === "list client all") {
		try {
			const includeOffline = arg === "list client all";
			let sessions: SessionInfo[];
			let self: { project: string; sessions: string[] } | undefined;
			if (controller.connected) {
				const c = controller.requireConnection();
				sessions = await c.mailbox.sessions(includeOffline);
				self = { project: c.mailbox.project!, sessions: controller.heldNames };
			} else {
				// read-only HTTP API: the listing works without a
				// mailbox of one's own — a fresh, not-yet-logged-in
				// session can still browse names
				const projectRoot = host.identity.cwd;
				const projectId = await deriveProjectId(projectRoot);
				sessions = (await fetchSessionsViaApi({ id: projectId, root: projectRoot })).filter(
					(s) => s.project === projectId && (includeOffline || s.online),
				);
			}
			const online = sessions.filter((s) => s.online).length;
			const scope = includeOffline ? `${online} online / ${sessions.length} total` : `${online} online`;
			const note = controller.connected ? "" : " (not connected — read-only view; /mailbox to connect)";
			out(controller, `mailbox: ${scope}${note}
${formatSessions(sessions, self)}`, "info");
		} catch (err) {
			out(controller, `mailbox: ${errMsg(err)}`, "error");
		}
		return;
	}

	if (arg === "login" || arg.startsWith("login ")) {
		const rest = arg.slice(5).trim();
		if (!rest) {
			out(controller, "Usage: /mailbox login <name> [tags=a,b,...] [--force]  (log in to a named mailbox; repeat to hold several)", "warning");
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
				out(controller, "Usage: /mailbox login <name> [tags=a,b,...] [--force]", "warning");
				return;
			}
			tags = tm[1];
		}
		if (!validMailboxName(name)) {
			out(
				controller,
				"mailbox: invalid name (1-255 chars, letter first, [A-Za-z0-9_-], not a derived-id shape, 'user' reserved)",
				"warning",
			);
			return;
		}
		try {
			// multi-login: an explicit login ADDS the name to the held set
			// (a held name still rejects with name_held / mailbox_in_use).
			// --force is the human's confirmation for an offline takeover,
			// so this path bypasses the agent-side gate.
			const prev = controller.connected ? controller.address : null;
			const connection = await controller.login({ as: name, tags, force: forceFlag });
			const meta = connection.mailbox.sessionMeta ?? {};
			const inherited = tags ? "" : ` (tags inherited: ${meta.tags ?? "(none)"})`;
			const holding = controller.heldNames;
			const holdingNote = holding.length > 1 ? ` — holding: ${holding.join(", ")}` : "";
			out(
				controller,
				`mailbox: logged in as ${connection.address}${inherited}${holdingNote}${prev && holding.length === 1 ? `; was ${prev}` : ""}`,
				"info",
			);
		} catch (err) {
			out(controller, `mailbox: login failed: ${errMsg(err)}`, "error");
		}
		return;
	}

	if (arg === "logout" || arg === "off" || arg.startsWith("logout ")) {
		// logout with no name (or "off"): disconnect and release ALL held
		// names; "logout <name>": release just that one
		const name = arg.startsWith("logout ") ? arg.slice(7).trim().toLowerCase() : null;
		if (name !== null && !name) {
			out(controller, "Usage: /mailbox logout [<name>]  (no name: log out of every held mailbox)", "warning");
			return;
		}
		try {
			await controller.logout(name);
		} catch (err) {
			out(controller, `mailbox: ${errMsg(err)}`, "error");
		}
		return;
	}

	if (arg === "stop service") {
		try {
			await controller.disconnectAll();
			// gracefully stop the daemon via the shutdown protocol
			const bin = findMailboxdBinary();
			if (bin) {
				const result = spawnSync(bin, ["stop"], {
					env: { ...process.env },
					encoding: "utf8",
					timeout: 10_000,
				});
				if (result.status === 0) {
					out(controller, "mailbox: daemon stopped", "info");
				} else {
					out(
						controller,
						`mailbox: daemon stop: ${result.stderr?.trim() || result.stdout?.trim() || "failed"}`,
						"warning",
					);
				}
			} else {
				out(controller, "mailbox: disconnected (mailboxd binary not found for stop)", "warning");
			}
		} catch (err) {
			out(controller, `mailbox: ${errMsg(err)}`, "error");
		}
		return;
	}

	if (arg === "restart service") {
		try {
			await controller.disconnectAll();
			const bin = findMailboxdBinary();
			if (bin) {
				const result = spawnSync(bin, ["stop"], {
					env: { ...process.env },
					encoding: "utf8",
					timeout: 10_000,
				});
				if (result.status !== 0) {
					out(
						controller,
						`mailbox: daemon stop failed: ${result.stderr?.trim() || result.stdout?.trim() || "unknown error"}`,
						"warning",
					);
				}
			} else {
				out(controller, "mailbox: mailboxd binary not found; cannot stop daemon", "warning");
			}
			// wait briefly for the daemon to release the lock
			await new Promise((resolve) => setTimeout(resolve, 500));
			// same decoupling as start service, and the same rule: the
			// explicit command is the only spawn path (stop + start);
			// reconnect only with a stored binding
			await controller.ensureDaemon();
			const binding = host.loginStore.readLogin();
			if (binding && binding.names.length > 0) {
				const connection = await controller.connectBinding();
				out(controller, `mailbox: restarted as ${connection.address}`, "info");
			} else {
				out(controller, "mailbox: service restarted — run /mailbox login <name> to connect", "info");
			}
		} catch (err) {
			out(controller, `mailbox: ${errMsg(err)}`, "error");
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
				out(controller, "Usage: /mailbox set k=v [k2=v2 ...]", "warning");
				return;
			}
			const key = pair.slice(0, eq);
			if (key.startsWith("_")) {
				out(controller, "mailbox: keys starting with _ are system-reserved", "warning");
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
			out(controller, "Usage: /mailbox unset k [k2 ...]", "warning");
			return;
		}
		if (keys.some((k) => k.startsWith("_"))) {
			out(controller, "mailbox: keys starting with _ are system-reserved", "warning");
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
			out(
				controller,
				"Usage: /mailbox [login <name> [tags=a,b] [--force] | logout [<name>] | resume <name> | delete <name> [<name> ...] | start service | stop service | restart service | view | status | list [client [all]|mail] | meta | name <n> | tag <a,b> | set k=v | unset k | read <mail-ref> | more <cursor> | host:port [token]]",
				"warning",
			);
			return;
		}
		remote = { host: m[1]!, port: Number(m[2]), token: m[3] };
	}

	try {
		// host:port always (re)connects; otherwise connect only when
		// the daemon is already running (never spawn — use
		// /mailbox start service to start the daemon)
		if (remote) {
			controller.setRemote(remote);
			await controller.connectBinding();
			out(controller, "mailbox: connected", "info");
		} else if (!controller.connected) {
			const endpoint = await connectLocalDaemonIfRunning();
			if (endpoint) {
				await controller.connectBinding();
				out(controller, "mailbox: connected", "info");
			}
		}
		const c = controller.requireConnection();
		if (metaUpdate) {
			await c.mailbox.setMeta(metaUpdate);
			const desc = metaUpdate.set
				? Object.entries(metaUpdate.set)
						.map(([k, v]) => `${k} = ${v || "(empty)"}`)
						.join(", ")
				: `unset ${metaUpdate.unset!.join(", ")}`;
			out(controller, `mailbox: ${desc}`, "info");
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
			out(controller, text, "info");
			return;
		}
		if (readId) {
			const own = { project: c.mailbox.project!, session: c.mailboxId };
			const ref = parseMailRef(readId, own);
			const mail = await c.mailbox.read(ref);
			if (mail) void controller.refreshUnread(); // reading own mail marks it read
			if (!mail) {
				out(controller, `mailbox: mail ${readId} not found`, "warning");
			} else {
				out(controller, formatMail(mail, ref), "info");
			}
			return;
		}
		const showList = arg === "list" || arg === "list mail" || moreCursor !== null;
		const { mails, nextCursor } = await c.mailbox.inbox(undefined, { cursor: moreCursor ?? undefined });
		const unread = mails.filter((m) => !m.readAt).length;
		if (!showList) {
			// plain /mailbox (or a fresh host:port connect): one status line
			out(controller, `mailbox: ${await controller.statusSummary(c)} — /mailbox list to view`, "info");
			return;
		}
		const more = nextCursor ? `
(older mails: /mailbox more ${nextCursor})` : "";
		out(
			controller,
			`mailbox: page: ${unread} unread / ${mails.length} shown
${formatMailList(mails)}${more}`,
			"info",
		);
	} catch (err) {
		out(controller, `mailbox: ${errMsg(err)}`, "error");
	}
}

/**
 * /mailbox argument completions (pi's RegisteredCommand hook shape): the
 * provider receives everything after the command name, filters itself,
 * and returns items whose value carries a trailing space so the cursor
 * advances past the word.
 *
 * First argument: subcommands with descriptions. "login"/"resume
 * <name>": known mailbox names (live query, connected only — never
 * spawns). "delete <name>": offline names only (online holders cannot
 * be deleted). Everything else: null (no suggestions).
 */
/** /mailbox binding <sub> — channel binding management (CRUD). */
async function executeBindingCommand(controller: MailboxController, rest: string): Promise<void> {
	if (!rest || rest === "list") {
		try {
			requireBindings(controller);
			const bindings = await controller.bindingList();
			out(
				controller,
				bindings.length === 0
					? "mailbox: no channel bindings in this project"
					: bindings.map((b) => `${b.id} ${b.channel} -> ${b.targets.join(", ")}${b.lost?.length ? ` [lost: ${b.lost.join(", ")}]` : ""} (${b.enabled ? "enabled" : "disabled"})${b.describe ? ` — ${b.describe}` : ""}`).join("\n"),
				"info",
			);
		} catch (err) {
			out(controller, `mailbox: ${errMsg(err)}`, "error");
		}
		return;
	}
	const parts = rest.split(/\s+/);
	const sub = parts[0];
	try {
		requireBindings(controller);
		if (sub === "add") {
			// binding add <channel> <targets a,b,...> <config json (rest of line)>
			if (parts.length < 4) {
				out(controller, 'Usage: /mailbox binding add <channel> <targets a,b,...> <config-json> [--force]\nExample: /mailbox binding add webhook qclaw,grok2 {"url":"https://bot.example/hook","secret":"..."}', "warning");
				return;
			}
			const channel = parts[1]!;
			const force = parts.includes("--force");
			const bodyParts = parts.slice(2).filter((p) => p !== "--force");
			const targets = (bodyParts[0] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
			const configRaw = bodyParts.slice(1).join(" ");
			if (targets.length === 0 || !configRaw) {
				out(controller, "mailbox: add needs targets and a config JSON (see /mailbox binding add usage)", "warning");
				return;
			}
			let config: unknown;
			try {
				config = JSON.parse(configRaw);
			} catch (err) {
				out(controller, `mailbox: config is not valid JSON: ${errMsg(err)}`, "error");
				return;
			}
			const b = await controller.bindingAdd({ channel, config, targets, force });
			out(controller, `mailbox: binding ${b.id} created (${b.channel} -> ${b.targets.join(", ")})`, "info");
			return;
		}
		if (sub === "update") {
			// binding update <id> [--config <json rest>] [--targets a,b] [--enabled on|off] [--force]
			const id = parts[1];
			if (!id) {
				out(controller, "Usage: /mailbox binding update <id> [--config <json>] [--targets a,b,...] [--enabled on|off] [--force]", "warning");
				return;
			}
			let config: unknown;
			let targets: string[] | undefined;
			let enabled: boolean | undefined;
			let force = false;
			for (let i = 2; i < parts.length; i++) {
				const flag = parts[i];
				if (flag === "--force") {
					force = true;
				} else if (flag === "--config") {
					config = JSON.parse(parts.slice(i + 1).join(" "));
					i = parts.length;
				} else if (flag === "--targets") {
					targets = (parts[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
					i++;
				} else if (flag === "--enabled") {
					const v = parts[i + 1];
					if (v !== "on" && v !== "off") {
						out(controller, "mailbox: --enabled takes 'on' or 'off'", "error");
						return;
					}
					enabled = v === "on";
					i++;
				} else {
					out(controller, `mailbox: unknown flag '${flag}'`, "error");
					return;
				}
			}
			if (config === undefined && targets === undefined && enabled === undefined && !force) {
				out(controller, "mailbox: nothing to update (--config / --targets / --enabled / --force)", "warning");
				return;
			}
			const b = await controller.bindingUpdate({ id, config, targets, enabled, force });
			out(controller, `mailbox: binding ${b.id} updated (${b.enabled ? "enabled" : "disabled"}, targets: ${b.targets.join(", ")}${b.lost?.length ? `, lost: ${b.lost.join(", ")}` : ""})`, "info");
			return;
		}
		if (sub === "delete") {
			const id = parts[1];
			if (!id) {
				out(controller, "Usage: /mailbox binding delete <id>", "warning");
				return;
			}
			const b = await controller.bindingDelete(id);
			out(controller, `mailbox: binding ${b.id} deleted (targets released)`, "info");
			return;
		}
		out(controller, `mailbox: unknown binding subcommand '${sub}' (list / add / update / delete)`, "error");
	} catch (err) {
		out(controller, `mailbox: ${errMsg(err)}`, "error");
	}
}

/** Gate binding commands on the daemon capability, with a helpful error. */
function requireBindings(controller: MailboxController): void {
	if (!controller.supportsBindings) {
		throw new Error("the daemon does not support channel bindings (old daemon? restart it with a current build)");
	}
}

export async function mailboxArgumentCompletions(
	controller: MailboxController,
	argumentPrefix: string,
): Promise<Array<{ value: string; label: string; description?: string }> | null> {
	// [value (what gets typed), label (what gets shown), description]
	const subs: Array<[string, string, string]> = [
		["login", "login <name>", "log in to a named mailbox (repeat to hold several)"],
		["logout", "logout [<name>]", "disconnect and clear the binding"],
		["resume", "resume <name>", "resume a named mailbox's session"],
		["delete", "delete <name>", "delete an offline named mailbox"],
		["start service", "start service", "start the daemon (the only spawn path)"],
		["stop service", "stop service", "stop the daemon"],
		["restart service", "restart service", "restart the daemon"],
		["view", "view", "open the daemon's web UI"],
		["status", "status", "connection status"],
		["list", "list", "list this session's mail"],
		["meta", "meta", "show this session's meta"],
		["name", "name <n>", "set the display name meta"],
		["tag", "tag <a,b>", "set the tags meta"],
		["set", "set k=v", "set meta values"],
		["unset", "unset k", "remove meta values"],
		["read", "read <mail-ref>", "read one mail"],
		["more", "more <cursor>", "next page of mail"],
		["binding", "binding <sub>", "manage channel bindings (webhook delivery)"],
	];
	const parts = argumentPrefix.trimStart().split(/\s+/);
	if (parts.length === 1) {
		const typed = parts[0] ?? "";
		const items = subs
			.filter(([value]) => value.startsWith(typed))
			.map(([value, label, desc]) => ({ value: value + " ", label, description: desc }));
		return items.length > 0 ? items : null;
	}
	const action = parts[0];
	const typed = parts[1] ?? "";

	// /mailbox binding [sub] [arg] — subcommands, channel names (add),
	// binding ids (update/delete); the id/channel queries are live and
	// connected-only. NOTE: "binding " splits to ["binding", ""], and
	// "binding add " to three parts — this branch must run BEFORE the
	// generic parts.length > 2 bail-out below.
	if (action === "binding") {
		if (parts.length === 1) return null; // covered by the top-level subcommand list
		const sub = typed;
		if (parts.length === 2) {
			const subs: Array<[string, string, string]> = [
				["list", "list", "list this project's channel bindings"],
				["add", "add <channel> <targets> <config-json>", "create a binding (claims its targets)"],
				["update", "update <id> [--flags]", "update config / targets / enabled"],
				["delete", "delete <id>", "delete a binding (releases targets)"],
			];
			const items = subs
				.filter(([value]) => value.startsWith(sub))
				.map(([value, label, desc]) => ({ value: `binding ${value} `, label, description: desc }));
			return items.length > 0 ? items : null;
		}
		if (parts.length === 3 && (sub === "add" || sub === "update" || sub === "delete")) {
			if (!controller.connected) return null;
			const argTyped = parts[2] ?? "";
			if (sub === "add") {
				// channel names from the daemon's advertised caps
				const items = controller
					.supportedChannels()
					.filter((c) => c.startsWith(argTyped))
					.map((c) => ({ value: `binding add ${c} `, label: c, description: "channel type" }));
				return items.length > 0 ? items : null;
			}
			let bindings: Awaited<ReturnType<MailboxController["bindingList"]>>;
			try {
				bindings = await controller.bindingList();
			} catch {
				return null; // transient daemon hiccup: no suggestions
			}
			const items = bindings
				.filter((b) => b.id.startsWith(argTyped))
				.map((b) => ({
					value: `binding ${sub} ${b.id} `,
					label: b.id,
					description: `${b.channel} -> ${b.targets.join(",")}${b.enabled ? "" : " (disabled)"}`,
				}));
			return items.length > 0 ? items : null;
		}
		return null;
	}

	if (parts.length > 2) return null;
	if (action !== "login" && action !== "resume" && action !== "delete" && action !== "logout") return null;

	// this session's OWN names (canonical): live connections plus anything
	// still in the persisted binding
	const ownNames = new Set(controller.heldNames.map((n) => n.toLowerCase()));
	for (const n of controller.hostRef.loginStore.readLogin()?.names ?? []) ownNames.add(n.toLowerCase());

	// logout: ONLY the session's own names are valid targets — never the
	// whole project. Works disconnected too (a binding-only name still
	// queues a deferred release). Matching is case-folded on BOTH the
	// canonical and the claimed spelling (like the other name commands),
	// and labels carry the claimed spelling; the current-identity marker
	// falls back to the persisted binding while disconnected.
	if (action === "logout") {
		const typedFolded = typed.toLowerCase();
		const current = controller.currentIdentity;
		const items = controller.heldIdentities
			.filter(({ canonical, claimed }) => canonical.startsWith(typedFolded) || claimed.toLowerCase().startsWith(typedFolded))
			.sort((a, b) => a.canonical.localeCompare(b.canonical))
			.map(({ canonical, claimed }) => ({
				// the value REPLACES the whole argument string (pi's completion
				// convention — see its MCP extension): keep the typed action
				value: `${action} ${canonical} `,
				label: claimed,
				description: canonical === current ? "current identity" : "held",
			}));
		return items.length > 0 ? items : null;
	}

	// login / resume / delete: live query through the connected session
	// only (never spawns; daemon down -> no suggestions)
	if (!controller.connected) return null;
	let sessions: SessionInfo[];
	try {
		sessions = await controller.requireConnection().mailbox.sessions(true);
	} catch {
		return null; // transient daemon hiccup: no suggestions
	}
	// validMailboxName encodes exactly the exclusions (user, derived
	// shape) plus the full grammar — DRY over an inline re-implementation
	const named = sessions.filter((s) => validMailboxName(s.session));
	const deletable = action === "delete";
	const items = named
		// login/resume: own names are excluded from the SUGGESTIONS (re-login
		// replaces, resume-own errors "already this session" — both remain
		// valid to type, just not hinted); delete: offline holders only
		.filter((s) => (deletable ? !s.online : !ownNames.has(s.session)))
		.filter((s) => s.session.startsWith(typed) || ((s.meta ?? {})._case ?? "").startsWith(typed))
		.map((s) => ({
			// the value REPLACES the whole argument string (pi's completion
			// convention — see its MCP extension): keep the typed action
			value: `${action} ${s.session} `,
			label: (s.meta ?? {})._case ?? s.session,
			description: s.online ? "online" : "offline",
		}));
	return items.length > 0 ? items : null;
}

// MailboxError is re-exported for the shell's fatal-error surfacing.
export { MailboxError };
