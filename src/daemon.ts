/**
 * Client-side mailboxd integration: resolve the local daemon (spawn it if
 * needed), and derive the short mailbox ids.
 *
 * Id scheme (all base36, deterministic — no coordination needed):
 *   hostId    16 hex random, ~/.pi/mailbox-host-id, created once per machine
 *   project   base36(sha256(hostId + path))[0:8]        — globally unique
 *   session   base36(sha256(agent + sessionUuid))[0:10] — unique per project
 * The daemon treats ids as opaque strings; only this module knows the scheme.
 *
 * The in-process TS service is gone; the Go daemon is the only service.
 * Local flow: read the daemon registry (~/.pi/mailboxd.json, or
 * $PI_MAILBOXD_DIR/mailboxd.json), probe it, spawn mailboxd when dead, then
 * connect as a plain client. Remote flow is a fixed URL with a token.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, type SessionInfo } from "./protocol.ts";

const PROBE_TIMEOUT_MS = 1_500;
const SPAWN_WAIT_MS = 10_000;

/** Daemon config dir: ~/.pi, or $PI_MAILBOXD_DIR (tests / multi-instance). */
export function daemonHome(): string {
	const env = process.env.PI_MAILBOXD_DIR;
	if (env && env.length > 0) return env;
	return join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".pi");
}

export function daemonRegistryPath(): string {
	return join(daemonHome(), "mailboxd.json");
}

interface DaemonRegistry {
	port: number;
	instanceId: string;
	remote?: boolean;
	pid?: number;
}

async function readDaemonRegistry(): Promise<DaemonRegistry | null> {
	try {
		const raw = await readFile(daemonRegistryPath(), "utf8");
		const parsed = JSON.parse(raw) as DaemonRegistry;
		if (typeof parsed.port !== "number" || typeof parsed.instanceId !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Probe a daemon port: true when a mailboxd of the right protocol answers. */
async function probeDaemon(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				ws.terminate();
			} catch {
				// ignore
			}
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
		ws.on("open", () => {
			ws.send(JSON.stringify({ t: "ping", rid: 0 }));
		});
		ws.on("message", (data) => {
			try {
				const msg = JSON.parse(String(data)) as { t?: string; protocolVersion?: number };
				if (msg.t === "pong") {
					finish(msg.protocolVersion === undefined || msg.protocolVersion === PROTOCOL_VERSION);
				}
			} catch {
				finish(false);
			}
		});
		ws.on("error", () => finish(false));
		ws.on("close", () => finish(false));
	});
}

/** Locate the mailboxd binary: $PI_MAILBOXD, then next to this package. */
export function findMailboxdBinary(): string | null {
	const exe = process.platform === "win32" ? "mailboxd.exe" : "mailboxd";
	const envPath = process.env.PI_MAILBOXD;
	if (envPath && existsSync(envPath)) return envPath;
	try {
		// this file is <pkg>/src/daemon.ts; the daemon builds to <pkg>/mailboxd/
		const here = fileURLToPath(new URL(".", import.meta.url));
		const nextToPackage = join(here, "..", "mailboxd", exe);
		if (existsSync(nextToPackage)) return nextToPackage;
	} catch {
		// import.meta.url unavailable: fall through
	}
	return null;
}

function spawnMailboxd(): void {
	const bin = findMailboxdBinary();
	if (bin === null) {
		throw new Error(
			"mailboxd binary not found; set PI_MAILBOXD or build it with `go build` in mailboxd/",
		);
	}
	const child = spawn(bin, [], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
		windowsHide: true,
		env: { ...process.env },
	});
	// absorb spawn errors (ENOENT etc.) so they surface via the registry
	// timeout instead of crashing the pi process with an unhandled 'error'
	child.on("error", () => {
		// nothing to do here: resolveLocalDaemon will time out and report
	});
	// never keep the pi process alive for the daemon
	child.unref();
}

export interface LocalEndpoint {
	url: string;
	/** port, for diagnostics */
	port: number;
}

/**
 * Resolve the local daemon endpoint, spawning mailboxd when the registered
 * daemon is dead. Safe to call repeatedly.
 */
/** Connect to the daemon only if it's already running; never spawns. */
export async function connectLocalDaemonIfRunning(): Promise<LocalEndpoint | null> {
	const reg = await readDaemonRegistry();
	if (reg && (await probeDaemon(reg.port))) {
		return { url: `ws://127.0.0.1:${reg.port}`, port: reg.port };
	}
	return null;
}

export async function resolveLocalDaemon(): Promise<LocalEndpoint> {
	let reg = await readDaemonRegistry();
	if (reg && (await probeDaemon(reg.port))) {
		return { url: `ws://127.0.0.1:${reg.port}`, port: reg.port };
	}
	spawnMailboxd();
	const deadline = Date.now() + SPAWN_WAIT_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 200));
		reg = await readDaemonRegistry();
		if (reg && (await probeDaemon(reg.port))) {
			return { url: `ws://127.0.0.1:${reg.port}`, port: reg.port };
		}
	}
	throw new Error("mailboxd did not come up after spawning (see the daemon log)");
}

/**
 * Fetch every session (incl. offline mailboxes) through the daemon's
 * read-only HTTP API — the web UI's endpoint. Unlike a websocket hello,
 * this creates NO mailbox for the caller, so identity-less flows (e.g.
 * /mailbox resume resolving a name) can look names up without registering.
 * Spawns the daemon when none is running (like /mailbox login).
 */
export async function fetchSessionsViaApi(
	/** Own project id + absolute root: a freshly spawned daemon has no project in memory, so the API loads it on demand (local mode only; no mailbox is created). */
	project?: { id: string; root: string },
): Promise<Array<Pick<SessionInfo, "session" | "project" | "online" | "meta">>> {
	const endpoint = await resolveLocalDaemon();
	// local-mode daemon: loopback only by construction
	const query = new URLSearchParams({ includeOffline: "1" });
	if (project) {
		query.set("project", project.id);
		query.set("projectRoot", project.root);
	}
	const resp = await fetch(`http://127.0.0.1:${endpoint.port}/api/sessions?${query}`, {
		signal: AbortSignal.timeout(5_000),
	});
	if (!resp.ok) throw new Error(`daemon HTTP ${resp.status}`);
	const body = (await resp.json()) as { sessions?: Array<Pick<SessionInfo, "session" | "project" | "online" | "meta">> };
	return body.sessions ?? [];
}

// ---------------------------------------------------------------------------
// identity derivation
// ---------------------------------------------------------------------------

/** Project id: 8 base36 chars, deterministic per (host, normalized path). */
export async function deriveProjectId(projectDir: string): Promise<string> {
	const hostId = await readHostId();
	return shortHash(hostId + "\n" + normalizeProjectPath(projectDir), 8);
}

/** Session id: 10 base36 chars, deterministic per (agent, pi session id); unique within a project. */
export function deriveSessionId(agent: string, session: string): string {
	return shortHash(agent + "\n" + session, 10);
}

/**
 * Per-host random identity: 16 hex chars in ~/.pi/mailbox-host-id, created
 * once. Distinguishes projects on different machines that share a directory
 * path (remote mode) without unstable inputs like IPs or hostnames.
 */
export async function readHostId(): Promise<string> {
	const path = join(daemonHome(), "mailbox-host-id");
	const valid = (s: string) => /^[0-9a-f]{16}$/.test(s);
	const read = async () =>
		((await readFile(path, "utf8")).trim());
	try {
		const existing = await read();
		if (valid(existing)) return existing;
	} catch {
		// not created yet
	}
	await mkdir(daemonHome(), { recursive: true });
	const id = randomBytes(8).toString("hex");
	try {
		await writeFile(path, id + "\n", { flag: "wx" });
		return id;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		// another process created it, or the file exists with invalid content:
		// overwrite invalid content, then re-read so concurrent writers agree
		// on the final value (last write wins; all readers return that value)
		let existing: string;
		try {
			existing = await read();
		} catch {
			existing = "";
		}
		if (!valid(existing)) {
			await writeFile(path, id + "\n");
			return (await read()) || id;
		}
		return existing;
	}
}

/** First `len` base36 chars of the sha256 of `input` (zero-padded). */
function shortHash(input: string, len: number): string {
	const digest = createHash("sha256").update(input).digest("hex");
	return BigInt("0x" + digest).toString(36).slice(0, len).padStart(len, "0");
}

function normalizeProjectPath(dir: string): string {
	return resolve(dir).replace(/\\/g, "/");
}
