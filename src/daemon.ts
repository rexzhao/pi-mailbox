/**
 * Client-side mailboxd integration: resolve the local daemon (spawn it if
 * needed), and maintain the per-project UUID registry.
 *
 * The in-process TS service is gone; the Go daemon is the only service.
 * Local flow: read the daemon registry (~/.pi/mailboxd.json, or
 * $PI_MAILBOXD_DIR/mailboxd.json), probe it, spawn mailboxd when dead, then
 * connect as a plain client. Remote flow is a fixed URL with a token.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "./protocol.ts";

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

// ---------------------------------------------------------------------------
// per-project identity
// ---------------------------------------------------------------------------

interface ProjectRegistry {
	projectId: string;
}

function projectRegistryPath(projectDir: string): string {
	return join(projectDir, ".pi", "mailbox.json");
}

function projectLockPath(projectDir: string): string {
	return join(projectDir, ".pi", "mailbox.project.lock");
}

/**
 * Read (or create once) the project UUID. Creation races between sessions
 * are serialized with a mkdir lock (a few-millisecond critical section, not
 * a crash-safe lease — a stale lock directory is simply stolen after a
 * short timeout). The file also used to carry the old in-process service
 * entry, which is ignored.
 */
const LOCK_STALE_MS = 60_000;

export async function readProjectId(projectDir: string): Promise<string> {
	const existing = await readProjectRegistry(projectDir);
	if (existing) return existing;
	await mkdir(join(projectDir, ".pi"), { recursive: true });
	const lockPath = projectLockPath(projectDir);
	// serialize first-time creation across sessions
	for (let attempt = 0; ; attempt++) {
		let acquired = false;
		try {
			await mkdir(lockPath);
			acquired = true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// stale lock: the creating process died mid-critical-section
			let age = 0;
			try {
				age = Date.now() - (await stat(lockPath)).mtimeMs;
			} catch {
				// lock was released between EEXIST and stat: retry immediately
				continue;
			}
			if (age > LOCK_STALE_MS) {
				await rm(lockPath, { recursive: true, force: true });
				continue;
			}
			if (attempt > 600) throw new Error("mailbox project-id lock contention timeout");
			await new Promise((resolve) => setTimeout(resolve, 100));
			continue;
		}
		if (acquired) {
			try {
				const again = await readProjectRegistry(projectDir);
				if (again) return again;
				const projectId = randomUUID();
				await atomicWrite(projectRegistryPath(projectDir), JSON.stringify({ projectId }, null, "\t") + "\n");
				return projectId;
			} finally {
				await rm(lockPath, { recursive: true, force: true });
			}
		}
	}
}

async function readProjectRegistry(projectDir: string): Promise<string | null> {
	try {
		const raw = await readFile(projectRegistryPath(projectDir), "utf8");
		const parsed = JSON.parse(raw) as ProjectRegistry;
		if (typeof parsed.projectId !== "string" || parsed.projectId.length === 0) return null;
		return parsed.projectId;
	} catch {
		return null;
	}
}

async function atomicWrite(path: string, content: string): Promise<void> {
	const tmp = `${path}.tmp`;
	await writeFile(tmp, content);
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(tmp, path);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if ((code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY") && attempt < 10) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				continue;
			}
			throw err;
		}
	}
}
