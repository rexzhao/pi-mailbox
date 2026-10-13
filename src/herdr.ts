/**
 * herdr integration: wake an offline mailbox session by resuming its pi
 * session in a fresh herdr pane and prompting it to check its mailbox.
 *
 * Everything goes through the herdr CLI, which talks to the local herdr
 * server socket (HERDR_SOCKET_PATH when running inside a pane, otherwise
 * the default session socket). Each command prints one JSON response:
 * {"id":..., "result":...} on success, or an {"error":{code,message}}
 * object (stdout on success, stderr on failure).
 *
 * Wake flow:
 *   1. `agent list`: a live agent already running this pi session (e.g.
 *      running but mailbox-disconnected, or a previous wake still working)
 *      is just prompted in place.
 *   2. Otherwise locate the project workspace via pane cwds (`pane list`),
 *      creating it when absent (`workspace create`); get a fresh shell pane
 *      from a new tab (`tab create`, root pane of a workspace just created).
 *      The pane cwd is pinned to the project root: pi derives both its
 *      session directory and its mailbox identity from cwd.
 *   3. `agent start --kind pi -- --session-id <origin>` resumes the exact
 *      pi session (same session id -> same mailbox identity), then
 *      `agent prompt` tells it to connect and handle its mail.
 *
 * The whole wake runs under a wall-clock budget (WAKE_BUDGET_MS; the
 * worst case lands slightly above it because herdr requires a minimum
 * agent-start timeout) so a best-effort wake never stalls the sending
 * tool for long.
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

interface HerdrResponse {
	id?: string;
	result?: unknown;
	error?: { code?: string; message?: string };
}

/** Error carrying the herdr error code, so callers can match on it. */
export class HerdrError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

function herdrBinary(): string {
	const env = process.env.HERDR_BIN_PATH;
	return env && env.length > 0 ? env : "herdr";
}

/** Parse one herdr CLI response, tolerating extra non-JSON output lines. */
function parseResponse(s: string): HerdrResponse | null {
	try {
		return JSON.parse(s) as HerdrResponse;
	} catch {
		// scan for the last line that looks like a response object
		for (const line of s.split(/\r?\n/).reverse()) {
			const t = line.trim();
			if (!t.startsWith("{")) continue;
			try {
				const v = JSON.parse(t) as HerdrResponse;
				if (v && (v.result !== undefined || v.error !== undefined)) return v;
			} catch {
				// keep scanning
			}
		}
		return null;
	}
}

/** Run one herdr CLI command; resolves with its `result` object. */
function runHerdr(args: string[], timeoutMs: number): Promise<unknown> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(herdrBinary(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (err: Error | null, result?: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) rejectPromise(err);
			else resolvePromise(result);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error(`herdr ${args[0]} timed out (the command may still have been applied)`));
		}, timeoutMs);
		child.on("error", (err) => finish(new Error(`herdr not available: ${err.message}`)));
		child.stdout?.on("data", (d) => (stdout += String(d)));
		child.stderr?.on("data", (d) => (stderr += String(d)));
		child.on("close", (code) => {
			const resp = parseResponse(stdout) ?? parseResponse(stderr);
			if (resp?.error) {
				finish(new HerdrError(resp.error.code ?? "error", resp.error.message ?? `herdr ${args[0]} failed`));
				return;
			}
			if (code !== 0) {
				finish(new Error(stderr.trim() || stdout.trim() || `herdr ${args[0]} exited with ${code}`));
				return;
			}
			if (!resp || resp.result === undefined) {
				finish(new Error(`herdr ${args[0]}: unexpected output`));
				return;
			}
			finish(null, resp.result);
		});
	});
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/** Case-insensitive, slash-normalized path equality (Windows-safe). */
function pathsEqual(a: string, b: string): boolean {
	const norm = (p: string) =>
		resolve(p)
			.replace(/\\/g, "/")
			.replace(/\/+$/, "")
			.toLowerCase();
	return norm(a) === norm(b);
}

/** herdr agent name from a mailbox session id: [a-z][a-z0-9_-]{0,31}. */
function agentName(session: string): string {
	let n = `m${session}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
	if (!/^[a-z]/.test(n)) n = `a${n}`;
	return n.slice(0, 32);
}

/** Does a herdr agent_session value reference this pi session? */
function referencesOrigin(value: string, origin: string): boolean {
	// kind "path": .../sessions/<slug>/<ts>_<origin>.jsonl; kind "id": the id itself
	return value === origin || value.endsWith(`_${origin}.jsonl`);
}

export interface WakeTarget {
	/** Mailbox id of the offline target: a derived session id, or a named-mailbox login name. */
	session: string;
	/** Full pi session id (the mailbox `_origin` meta) used to resume. */
	origin: string;
	/** Project root directory: the workspace cwd to match or create. */
	projectRoot: string;
	/** Human-readable label for the created tab (defaults to the session id). */
	label?: string;
	/** True when `session` is a named mailbox: the prompt carries the name so the woken agent claims it. */
	named?: boolean;
	/** pi session directory (the project's), to verify the last holder's session file exists before resuming. */
	sessionDir?: string;
	/** Prompt override for the woken agent: undefined = the built-in mail prompt, null = no prompt (e.g. /mailbox open), string = custom. */
	prompt?: string | null;
}

/**
 * ok:false with silent:true means herdr is unavailable (no binary / server
 * not running) — callers should skip without reporting anything, as if the
 * wake feature were off. Other failures are genuine wake attempts gone wrong.
 */
export type WakeResult =
	| { ok: true; detail: string; paneId?: string }
	| { ok: false; reason: string; silent?: boolean };

/** Prompt for the woken agent: derived mailboxes just connect; named mailboxes must be claimed (the binding may be stale or absent on a fresh session), with an explicit exit when the claim loses a race. */
function wakePrompt(target: WakeTarget): string {
	if (!target.named) {
		return (
			"You have new mail in your project mailbox. Use the mailbox_connect tool to connect, " +
			"then read the new mail with mailbox_list and handle what it asks."
		);
	}
	return (
		`You have new mail in the named mailbox '${target.session}' of this project. ` +
		`Log in to it with the mailbox_connect tool (as='${target.session}'); ` +
		"if your mailbox address is not that name you must claim it first. " +
		"If the login fails because the mailbox is held by another session, stop and state that in your final response. " +
		"Then read the new mail with mailbox_list and handle what it asks."
	);
}

/** The effective prompt: override, the built-in, or none. */
function effectivePrompt(target: WakeTarget): string | null {
	if (target.prompt === null) return null;
	if (target.prompt !== undefined) return target.prompt;
	return wakePrompt(target);
}

/** Does the pi session directory still hold the last holder's session file? */
function sessionFileExists(sessionDir: string, origin: string): boolean {
	try {
		for (const f of readdirSync(sessionDir)) {
			if (f.endsWith(`_${origin}.jsonl`)) return true;
		}
	} catch {
		// directory missing entirely: no sessions ever ran here
	}
	return false;
}

/** Wall-clock budget for one wake so the sending tool stays responsive. */
const WAKE_BUDGET_MS = 15_000;
/** Reserve for the final prompt when sizing the agent-start timeout. */
const PROMPT_RESERVE_MS = 6_000;

/**
 * Best-effort wake. Never throws: failures come back as {ok: false}.
 */
export async function wakeOfflineSession(target: WakeTarget): Promise<WakeResult> {
	const name = agentName(target.session);
	const tabLabel = `mail ${target.label ?? target.session}`;
	const deadline = Date.now() + WAKE_BUDGET_MS;
	/** Planned command timeout clamped to the remaining budget. */
	const cap = (planned: number): number => Math.max(500, Math.min(planned, deadline - Date.now()));

	// 1. live agent already running this pi session? prompt it in place.
	//    This doubles as the availability probe: any failure here (no binary,
	//    server down, timeout) means there is no usable herdr environment.
	let agents: unknown[] = [];
	try {
		const listResult = await runHerdr(["agent", "list"], cap(2_500));
		agents = isRecord(listResult) && Array.isArray(listResult.agents) ? listResult.agents : [];
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err), silent: true };
	}
	// room for the remaining steps (pane list + workspace/tab create + a
	// minimal agent start + prompt); bail instead of spawning past the budget
	if (deadline - Date.now() < 8_000) return { ok: false, reason: "wake budget exhausted before locating a pane" };

	// resume-only wake: the last holder's pi session must still exist.
	// (pi --session-id would silently create a fresh empty session for a
	// dead id — an identity-less shell that never sees the mail.) Checked
	// before any tab is created so a failure leaks nothing.
	if (target.sessionDir !== undefined && !sessionFileExists(target.sessionDir, target.origin)) {
		return {
			ok: false,
			reason: "the last holder's session file is gone; the mailbox can only be claimed manually (/mailbox login)",
		};
	}
	try {
		for (const a of agents) {
			if (!isRecord(a)) continue;
			const sess = isRecord(a.agent_session) && typeof a.agent_session.value === "string" ? a.agent_session.value : null;
			if (sess && referencesOrigin(sess, target.origin) && typeof a.pane_id === "string") {
				const p = effectivePrompt(target);
				if (p !== null) await runHerdr(["agent", "prompt", a.pane_id, p], cap(6_000));
				return { ok: true, detail: `already running in pane ${a.pane_id}${p === null ? "" : "; prompt sent"}`, paneId: a.pane_id };
			}
		}

		// 2. locate (or create) the project workspace; get a fresh shell pane
		//    with its cwd pinned to the project root (a new tab otherwise
		//    inherits the workspace cwd, which may differ from the project's)
		let paneId: string | null = null;
		const paneList = await runHerdr(["pane", "list"], cap(2_500));
		const panes = isRecord(paneList) && Array.isArray(paneList.panes) ? paneList.panes : [];
		let workspaceId: string | null = null;
		for (const p of panes) {
			if (isRecord(p) && typeof p.cwd === "string" && pathsEqual(p.cwd, target.projectRoot) && typeof p.workspace_id === "string") {
				workspaceId = p.workspace_id;
				break;
			}
		}
		const testEnv: string[] = [];
		// test-only escape hatch: env vars for the wake's tab, so live
		// tests can point the woken pi at an isolated daemon (never set in
		// production); format: KEY=VALUE;KEY=VALUE
		const envSpec = process.env.PI_MAILBOX_TEST_TAB_ENV;
		if (envSpec && envSpec.length > 0) {
			for (const kv of envSpec.split(";").filter(Boolean)) testEnv.push("--env", kv);
		}
		if (workspaceId !== null) {
			const tab = await runHerdr(
				["tab", "create", "--workspace", workspaceId, "--cwd", target.projectRoot, "--label", tabLabel, ...testEnv],
				cap(6_000),
			);
			paneId =
				isRecord(tab) && isRecord(tab.root_pane) && typeof tab.root_pane.pane_id === "string"
					? tab.root_pane.pane_id
					: null;
		} else {
			const ws = await runHerdr(
				["workspace", "create", "--cwd", target.projectRoot, "--label", basename(target.projectRoot), "--no-focus", ...testEnv],
				cap(9_000),
			);
			paneId =
				isRecord(ws) && isRecord(ws.root_pane) && typeof ws.root_pane.pane_id === "string" ? ws.root_pane.pane_id : null;
		}
		if (paneId === null) return { ok: false, reason: "could not resolve a fresh pane for the project" };
		// herdr requires --timeout > 3000; a start below this remaining
		// budget would blow past the deadline
		if (deadline - Date.now() < 5_000) return { ok: false, reason: "wake budget exhausted before agent start" };

		// 3. resume the pi session in that pane (retrying once under a
		//    different name when a leftover live agent holds ours), then
		//    prompt it. agent start requires --timeout in (3000, 300000].
		const startTimeout = Math.min(12_000, Math.max(3_001, deadline - Date.now() - PROMPT_RESERVE_MS));
		let usedName = name;
		let started = false;
		let startErr: unknown = null;
		// a retry only makes sense while the pane could still be at its
		// prompt and there is budget for another attempt + prompt
		const candidates = deadline - Date.now() > 9_000 ? [name, `${name.slice(0, 31)}2`] : [name];
		for (const candidate of candidates) {
			try {
				const args = ["agent", "start", candidate, "--kind", "pi", "--pane", paneId, "--timeout", String(startTimeout)];
				// everything after "--" is passed unchanged to pi; the extra args
				// (test-only escape hatch pointing the woken pi at a working-tree
				// extension, never set in production) must land after it too, or
				// herdr parses them as its own options
				const piArgs: string[] = ["--session-id", target.origin];
				const extra = process.env.PI_MAILBOX_TEST_PI_ARGS;
				if (extra && extra.length > 0) piArgs.push(...extra.split(/\s+/).filter(Boolean));
				if (piArgs.length > 0) args.push("--", ...piArgs);
				await runHerdr(args, cap(startTimeout + 4_000));
				usedName = candidate;
				started = true;
				break;
			} catch (err) {
				startErr = err;
			}
		}
		if (!started) {
			// readiness detection can lag the launch; the prompt still lands
			// if the agent came up despite the detection failure
			const p = effectivePrompt(target);
			if (p !== null) {
				try {
					await runHerdr(["agent", "prompt", paneId, p], cap(6_000));
					return { ok: true, detail: `pi agent resumed in pane ${paneId} (detection lagged); prompt sent`, paneId };
				} catch {
					// detection lagged AND the prompt failed: treat as failed
				}
			}
			return { ok: false, reason: startErr instanceof Error ? startErr.message : String(startErr) };
		}
		const p = effectivePrompt(target);
		if (p === null) {
			return { ok: true, detail: `pi agent resumed as '${usedName}' in pane ${paneId}`, paneId };
		}
		try {
			await runHerdr(["agent", "prompt", paneId, p], cap(6_000));
		} catch (err) {
			// the session is up; without the prompt it just sits idle — a
			// later send re-prompts it via the live-agent branch
			return {
				ok: true,
				detail: `pi session resumed as '${usedName}' in pane ${paneId}, but the prompt was not delivered (${
					err instanceof Error ? err.message : String(err)
				})`,
				paneId,
			};
		}
		return { ok: true, detail: `pi agent resumed as '${usedName}' in pane ${paneId}; prompt sent`, paneId };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}
