/**
 * pi-mailbox extension — a thin TUI shell around the host-agnostic core
 * (src/core): the shell builds a MailboxHost from the pi extension API
 * (session entries for the login store, sendUserMessage for delivery,
 * the footer for the unread badge, herdr for wake) and forwards pi's
 * lifecycle events into the controller. All behavior lives in the core.
 *
 * /mailbox                 connect (host or client) and list this session's mail
 * /mailbox host:port [t]    connect to a remote mailboxd (optional token)
 * /mailbox login <name>     log in to a named mailbox (repeat to hold several)
 * /mailbox logout [<name>]  log out of one held name, or all of them
 * /mailbox read <id>       view one mail
 * /mailbox name <name>     set display name (persists across reconnects)
 * /mailbox tag <a,b,...>   set tags
 * /mailbox set k=v ...     set meta values (cookie-like key/value)
 * /mailbox unset k ...     remove meta values
 * /mailbox view            print (and open) the daemon's read-only web UI
 * /mailbox off             disconnect (all identities)
 * /mailbox status          connection status
 *
 * Agent tools (activated only while connected): mailbox_list, mailbox_read,
 * mailbox_send, mailbox_reply, mailbox_sessions.
 */

import {
	FooterComponent,
	VERSION,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { hostname, platform } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MailboxController, type MailboxHost } from "./core/controller.ts";
import { bindingFromEntries, LOGIN_ENTRY, RELEASE_ENTRY, type LoginBinding, type SessionEntry } from "./core/login-binding.ts";
import { DEFERRED_TOOL_NAMES } from "./core/tools.ts";
import { findLiveAgentPane, wakeOfflineSession } from "./herdr.ts";

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

/** pi's home-shortening for the footer's first line (cwd -> ~/...), copied
 *  from its non-exported formatCwdForFooter so logged-in and logged-out
 *  frames shorten identically (relative() + isAbsolute, not startsWith). */
function shortCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	if (rel === "") return "~";
	if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return `~${sep}${rel}`;
	return cwd;
}

/** Visual width in terminal columns: East Asian Wide/Fullwidth and emoji
 *  ranges count as 2 (a UTF-16 .length check would clip mid-wide-char). */
function visualWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		const cp = ch.codePointAt(0) ?? 0;
		const wide =
			(cp >= 0x1100 && cp <= 0x115f) ||
			(cp >= 0x2e80 && cp <= 0xa4cf) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe30 && cp <= 0xfe4f) ||
			(cp >= 0xff00 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1f300 && cp <= 0x1f64f) ||
			(cp >= 0x1f900 && cp <= 0x1f9ff);
		w += wide ? 2 : 1;
	}
	return w;
}

/** Truncate to a visual width with an ellipsis (plain text only, pre-styling). */
function truncateVisual(s: string, width: number): string {
	if (visualWidth(s) <= width) return s;
	let w = 0;
	let out = "";
	for (const ch of s) {
		const cw = visualWidth(ch);
		if (w + cw > width - 1) return `${out}…`;
		out += ch;
		w += cw;
	}
	return out;
}

type FooterSession = ConstructorParameters<typeof FooterComponent>[0];
type FooterData = ConstructorParameters<typeof FooterComponent>[1];

/**
 * The default pi footer with the session's mailbox address riding on the
 * FIRST line, AFTER the session name — no extra footer height. The
 * stats line and any extension statuses render unchanged through
 * super.render(); only line 1 is recomposed (cwd (branch) • sessionName
 * <address>, truncated before styling so ANSI codes stay intact). The
 * name keeps pi's default position, so connection transitions only
 * append/remove the trailing address instead of relocating the name.
 */
class MailboxFooterComponent extends FooterComponent {
	private readonly footerTheme: { fg(style: string, text: string): string };
	private readonly dataRef: FooterData;
	private readonly sessionRef: FooterSession;
	private readonly getAddress: () => string | null;
	private readonly getUnread: () => number | null;

	constructor(
		session: FooterSession,
		footerData: FooterData,
		theme: { fg(style: string, text: string): string },
		getAddress: () => string | null,
		getUnread: () => number | null,
	) {
		super(session, footerData);
		this.footerTheme = theme;
		this.dataRef = footerData;
		this.sessionRef = session;
		this.getAddress = getAddress;
		this.getUnread = getUnread;
	}

	render(width: number): string[] {
		// containment: a pi upgrade reading a proxy field we do not have, or
		// a frame against an invalidated context, must degrade to our own
		// line 1 (or to whatever super produced) rather than take the footer
		// or the frame down
		let lines: string[] = [];
		try {
			lines = super.render(width);
		} catch {
			// proxy/pi drift: compose what we can below
		}
		try {
			const address = this.getAddress();
			if (!address && lines.length > 0) return lines; // byte-identical default
			let line = shortCwd(this.sessionRef.sessionManager.getCwd());
			const branch = this.dataRef.getGitBranch();
			if (branch) line += ` (${branch})`;
			// session name FIRST (byte-identical position to pi's default
			// footer), mail address AFTER it: connected/disconnected transitions
			// then only append/remove the trailing address instead of moving
			// the name around (which read as flicker), and truncation eats the
			// address before the name
			const sessionName = this.sessionRef.sessionManager.getSessionName();
			if (sessionName) line += ` • ${sessionName}`;
			if (address) line += ` ${address}`;
			// unread badge after the address: only while connected and only
			// when there is something unread (U+2709, visual width 1)
			const unread = this.getUnread();
			if (address && unread !== null && unread > 0) line += ` ✉${unread}`;
			const styled = this.footerTheme.fg("dim", truncateVisual(line, width));
			if (lines.length === 0) return [styled]; // degraded: at least line 1
			lines[0] = styled;
			return lines;
		} catch {
			return lines; // even the composition failed: super's output stands
		}
	}
}

/** The pi-side session context shape the shell reads (captured on events). */
interface ShellCtx {
	sessionManager: {
		getSessionId(): string;
		getCwd(): string;
		getSessionDir(): string;
		getEntries?(): Array<{ type: string; customType?: string; data?: unknown }>;
	};
	model?: { id: string; provider: string } | undefined;
	ui?: { notify(message: string, kind?: string): void };
	switchSession?(sessionFile: string): Promise<{ cancelled: boolean }>;
	getContextUsage?(): { contextWindow?: number; percent?: number | null } | undefined;
	thinkingLevel?: string;
}

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// session context: the extension loads before session_start delivers a
	// context, and the smoke harness swaps command contexts per call, so
	// the shell keeps a mutable reference updated on every event/command.
	// In a real pi session all of these are the same sessionManager.
	// -----------------------------------------------------------------------
	let interactive = true;
	let busy = false;
	let liveCtx: ShellCtx | null = null;

	// -----------------------------------------------------------------------
	// footer: the mailbox address on line 1, right after the git branch
	// (a custom footer component subclassing pi's default; no extra height)
	// -----------------------------------------------------------------------

	/** Captured at session_start; the footer's session proxy reads it lazily on every render. */
	let sessCtx: ShellCtx | null = null;
	/** The tui from the footer factory; used to refresh on connection changes. */
	let footerTui: { requestRender(force?: boolean): void } | null = null;

	/** Repaint the footer (the address is read live, but idle frames need a nudge). */
	function refreshFooter(): void {
		try {
			footerTui?.requestRender();
		} catch {
			// footer not installed (non-interactive) or already disposed
		}
	}

	/** Unread total for the footer badge; null = unknown/disconnected (no badge). */
	let footerUnread: number | null = null;

	function installFooter(ui: { setFooter(factory: unknown): void }): void {
		ui.setFooter((
			tui: { requestRender(force?: boolean): void },
			theme: { fg(style: string, text: string): string },
			footerData: FooterData,
		) => {
			footerTui = tui;
			// A minimal stand-in for the AgentSession the default footer
			// expects. Everything it reads is available from the extension
			// context, except modelRuntime.isUsingSubscription (stubbed:
			// subscription users lose the "(sub)" cost suffix) and
			// routedModel (falls back to the model). Fields are read lazily
			// per render through the current sessCtx.
			const proxySession = {
				get sessionManager() {
					return sessCtx!.sessionManager;
				},
				get model() {
					return sessCtx?.model;
				},
				routedModel: undefined,
				get state() {
					return {
						get model() {
							return sessCtx?.model;
						},
						get thinkingLevel() {
							return sessCtx?.thinkingLevel;
						},
					};
				},
				getContextUsage: () => sessCtx?.getContextUsage?.(),
				modelRuntime: { isUsingSubscription: () => false },
			} as unknown as FooterSession;
			return new MailboxFooterComponent(
				proxySession,
				footerData,
				theme,
				() => {
					if (!controller.connected) return null;
					const address = controller.address;
					if (address === null) return null;
					// multi-login: the current address plus a "+N" marker for
					// the additional held identities
					const extra = controller.heldNames.length - 1;
					return extra > 0 ? `${address} +${extra}` : address;
				},
				() => (controller.connected ? footerUnread : null),
			);
		});
	}

	// -----------------------------------------------------------------------
	// tools: activate the deferred set while any identity is connected
	// (mailbox_connect is default-exposure and never toggled)
	// -----------------------------------------------------------------------

	function activateTools(active: boolean): void {
		const current = pi.getActiveTools();
		const next = active
			? [...current, ...DEFERRED_TOOL_NAMES.filter((n) => !current.includes(n))]
			: current.filter((n) => !(DEFERRED_TOOL_NAMES as readonly string[]).includes(n));
		pi.setActiveTools(next);
	}

	// -----------------------------------------------------------------------
	// the host: pi-flavored implementations of the core's dependencies
	// -----------------------------------------------------------------------

	const entriesOf = (): SessionEntry[] => {
		try {
			return (liveCtx?.sessionManager.getEntries?.() ?? []) as SessionEntry[];
		} catch {
			return []; // entries unavailable (older pi): manual login only
		}
	};

	const host: MailboxHost = {
		identity: {
			agent: "pi",
			// Stable agent kind: the session-id derivation and the wire identity
			// must never change. The user-renamable display name (/name) is meta
			// only — renaming a session must not move its mailbox.
			get sessionId() {
				return liveCtx!.sessionManager.getSessionId();
			},
			get cwd() {
				return liveCtx!.sessionManager.getCwd();
			},
		},
		loginStore: {
			readLogin(): LoginBinding | null {
				return bindingFromEntries(entriesOf()).login;
			},
			writeLogin(binding: LoginBinding | null): void {
				try {
					const api = pi as { appendEntry?: (t: string, data?: unknown) => void };
					api.appendEntry?.(LOGIN_ENTRY, binding ? { name: binding.current, names: binding.names } : { name: null });
				} catch {
					// best-effort: the login still works for this connection
				}
			},
			readRelease(): string[] {
				return bindingFromEntries(entriesOf()).releases;
			},
			writeRelease(names: string[] | null): void {
				try {
					const api = pi as { appendEntry?: (t: string, data?: unknown) => void };
					api.appendEntry?.(RELEASE_ENTRY, names ? { names } : { names: null });
				} catch {
					// best-effort: without the entry, the release only works while connected
				}
			},
		},
		// deliverAs "steer" is always safe: pi applies it only while
		// streaming (mid-run) and ignores it otherwise — so an injection
		// racing the settlement window steers instead of being rejected.
		// sendUserMessage is fire-and-forget; a rejected injection
		// propagates synchronously and the core re-arms.
		deliver: (text: string) => {
			pi.sendUserMessage(text, { deliverAs: "steer" });
		},
		isBusy: () => busy,
		canDeliver: () => interactive,
		notify: (message: string, level?: "info" | "warning" | "error") => {
			liveCtx?.ui?.notify(message, level ?? "info");
		},
		setUnread: (total: number | null) => {
			footerUnread = total;
			refreshFooter();
		},
		onConnectionChanged: () => {
			activateTools(controller.connected);
			refreshFooter();
		},
		// registration-time auto meta: system keys (leading `_`) refresh on
		// every connect; they cannot be set manually. `_host`/`_platform` are
		// local-only: remote services should not learn machine details.
		helloMeta: ({ remote }) => {
			const meta: Record<string, string> = { _pi: VERSION };
			const sessionName = pi.getSessionName();
			if (sessionName) meta.name = sessionName;
			if (!remote) {
				meta._host = hostname();
				meta._platform = platform();
			}
			const model = liveCtx?.model;
			if (model) meta._model = `${model.provider}/${model.id}`;
			return meta;
		},
		wake: (target) => wakeOfflineSession(target),
		findLiveSession: (origin) => findLiveAgentPane(origin),
		switchSession: (sessionFile) => {
			if (!liveCtx?.switchSession) {
				return Promise.resolve({ cancelled: true });
			}
			return liveCtx.switchSession(sessionFile);
		},
		openUrl: (url) => openBrowser(url),
		sessionDir: () => liveCtx?.sessionManager.getSessionDir(),
	};

	const controller = new MailboxController(host);

	// -----------------------------------------------------------------------
	// registration: tools, command, events — thin forwarding into the core
	// -----------------------------------------------------------------------

	for (const def of controller.tools) {
		pi.registerTool({
			...def,
			// the core's execute is host-agnostic; pi passes its own ctx last
			execute: (toolCallId: string, params: never, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, _ctx: unknown) =>
				def.execute(toolCallId, params as Record<string, unknown>, signal, onUpdate),
		} as Parameters<typeof pi.registerTool>[0]);
	}

	pi.registerCommand("mailbox", {
		description: "Connect to the project mailbox, list mails, and manage the connection",
		getArgumentCompletions: (argumentPrefix: string) => controller.completeCommand(argumentPrefix),
		handler: (args: string, ctx: unknown) => {
			liveCtx = ctx as ShellCtx;
			return controller.executeCommand(args);
		},
	});

	pi.on("session_start", (event, ctx) => {
		// json is a pure event stream (stdout carries only JSON records consumed
		// by a client), so injecting user messages is meaningless there; every
		// other mode can receive sendUserMessage injections. Notably print
		// (SDK hosts, bindExtensions({ mode: "print" })) DOES receive them:
		// AgentSession.sendUserMessage -> prompt() starts a normal run when
		// idle — headless services must still get new-mail notifications.
		// Side effect: print hosts also silently auto-connect on resume now
		// (autoConnect gates on interactive); a one-shot "pi -p" run connects,
		// announces nothing unless mail arrives, and exits — harmless.
		interactive = ctx.mode !== "json";
		sessCtx = ctx;
		liveCtx = ctx;
		installFooter(ctx.ui); // replaces the default footer with the address-aware one
		refreshFooter();
		// one pi process hosts many sessions: a previous session's shutdown
		// stopped the shared controller (terminal until revived). The next
		// session brings the mailbox back — same identity, silent reconnect
		// from the stored binding.
		if (controller.isStopped) void controller.restart();
		else void controller.autoConnect();
	});

	// renaming the session to a name that is a valid mailbox name, when
	// this session holds no identity yet, logs in to that mailbox — the
	// same effect as /mailbox login <name> (never forces a takeover)
	pi.on("session_info_changed", (event, ctx) => {
		liveCtx = ctx as ShellCtx;
		void controller.onSessionNameChanged(event.name);
	});

	pi.on("agent_start", () => {
		busy = true;
		controller.onAgentStart();
	});
	const settle = (): void => {
		busy = false;
		// agent_end closes one low-level run, but retries, compaction, and
		// follow-up work can still continue; agent_settled is the final
		// boundary. Both clear busy: the core reads it live (isBusy), so an
		// early clear during the settlement window is safe — and a missing
		// agent_settled must never wedge notifications.
		controller.onAgentEnd();
	};
	pi.on("agent_end", settle);
	pi.on("agent_settled", settle);
	// turn boundary: the core flushes held notifications here. The handler
	// RETURNS the flush promise (never `void` it): pi awaits event handlers,
	// so the agent loop stays inside its turn_end emit until the notice is
	// composed (one daemon round-trip) AND steered — the loop's steering
	// drain, which runs right after the emit, then picks it up and the very
	// next LLM call sees it. A fire-and-forget flush races past that drain
	// into the settlement window, where a queued steer is orphaned (a
	// pending "Steering:" line in the UI until the next run). Aborted turns
	// skip the flush instead: that path has neither a drain point nor the
	// queued-message rescue, so the core leaves the notices to the settle
	// path's idle flush (a fresh turn once the run has wound down).
	pi.on("turn_end", (event) => {
		const message = (event as { message?: { stopReason?: string } } | undefined)?.message;
		return controller.onTurnEnd({ aborted: message?.stopReason === "aborted" });
	});
	pi.on("session_shutdown", () => {
		controller.onShutdown();
	});
}
