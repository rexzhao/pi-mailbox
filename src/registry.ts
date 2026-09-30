/**
 * Leader election via a native OS file lock (@lickle/lock: `flock` on Unix,
 * `LockFileEx` on Windows).
 *
 * The leader holds an exclusive lock on `<project>/.pi/mailbox.leader` for
 * its service lifetime. The lock is tied to an open file handle, so the OS
 * releases it automatically when the process dies: leadership handover needs
 * no stale-timeout heuristics and no liveness inference, and a second
 * service can never exist while the leader lives (crash-safe lease).
 *
 * The registry file (`mailbox.json`) only tells clients where to connect;
 * only the lock holder writes it. A stale registry plus a free lock is
 * resolved by the next election winner overwriting the entry.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tryOpenLock, Lock } from "@lickle/lock";
import { WebSocket } from "ws";
import { MailboxService, type ServiceHandle } from "./service.ts";

export interface RegistryFile {
	projectId: string;
	service: { port: number; instanceId: string } | null;
}

const PROBE_TIMEOUT_MS = 1_500;

function registryPath(projectDir: string): string {
	return join(projectDir, ".pi", "mailbox.json");
}

function leaderLockPath(projectDir: string): string {
	return join(projectDir, ".pi", "mailbox.leader");
}

export async function readRegistry(projectDir: string): Promise<RegistryFile> {
	try {
		const raw = await readFile(registryPath(projectDir), "utf8");
		const parsed = JSON.parse(raw) as RegistryFile;
		if (typeof parsed.projectId !== "string") throw new Error("missing projectId");
		return { projectId: parsed.projectId, service: parsed.service ?? null };
	} catch {
		// missing or corrupt: treat as no registry. Writes are atomic (tmp +
		// rename), so corruption means manual editing; starting fresh self-heals.
		return { projectId: randomUUID(), service: null };
	}
}

/** Atomic (tmp + rename) registry write. Retries on Windows rename races. */
async function writeRegistry(projectDir: string, registry: RegistryFile): Promise<void> {
	const path = registryPath(projectDir);
	const tmp = `${path}.tmp`;
	await mkdir(join(projectDir, ".pi"), { recursive: true });
	await writeFile(tmp, JSON.stringify(registry, null, "\t") + "\n");
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(tmp, path);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if ((code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY") && attempt < 10) {
				await sleep(50);
				continue;
			}
			throw err;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe a claimed service address: true only when a mailbox service with the
 * expected instanceId answers. Used by clients to decide whether to connect;
 * election safety does not depend on it (the flock is the lease).
 */
async function probeService(port: number, expectedInstanceId: string): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// terminate, not close: during a pending handshake close() may leave
			// the underlying socket open, which keeps the remote server's
			// connections (and its close callback) alive forever
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
				const msg = JSON.parse(String(data)) as { t?: string; instanceId?: string };
				if (msg.t === "pong") finish(msg.instanceId === expectedInstanceId);
			} catch {
				finish(false);
			}
		});
		ws.on("error", () => finish(false));
		ws.on("close", () => finish(false));
	});
}

export interface ElectionResult {
	/** Service we are now hosting, if we won leadership. null for clients. */
	hosted: ServiceHandle | null;
	/** Address of the live service (ours or the existing leader's). */
	port: number;
	instanceId: string;
	projectId: string;
}

/**
 * Ensure a mailbox service exists for the project. Try to become the leader
 * via the flock; if another process leads, connect to its registered service.
 * Safe to call repeatedly (re-election). A held lock with an unreachable or
 * not-yet-registered service throws, so callers retry until the leader is
 * either reachable or dead. `options.sessionsDir` (pi session directory for
 * this cwd) enables orphan-mailbox GC when we host.
 */
export async function ensureService(
	projectDir: string,
	options?: { sessionsDir?: string; gcDelayMs?: number; gcGraceMs?: number },
): Promise<ElectionResult> {
	await mkdir(join(projectDir, ".pi"), { recursive: true });

	const guard = await tryOpenLock(leaderLockPath(projectDir), Lock.Exclusive);
	if (guard) {
		// we are the leader: host, then publish our address. The guard must be
		// released on every failure path — a leaked FileHandle keeps the lock
		// held forever (and Node terminates the process when GC finds it)
		const registry = await readRegistry(projectDir);
		let service: MailboxService | null = null;
		let committed = false;
		try {
			service = new MailboxService(projectDir, registry.projectId, options);
			await service.start();
			const started = service;
			const handle: ServiceHandle = {
				instanceId: started.instanceId,
				port: started.port,
				stop: async () => {
					// clear the registry while we still hold the lock (only the
					// lock holder writes it), then stop serving, then release
					// leadership — the lock is released even if stopping fails
					try {
						await clearService(projectDir, started.instanceId).catch(() => undefined);
						await started.stop();
					} finally {
						await guard.drop().catch(() => undefined);
					}
				},
			};
			await writeRegistry(projectDir, {
				projectId: registry.projectId,
				service: { port: started.port, instanceId: started.instanceId },
			});
			committed = true;
			return {
				hosted: handle,
				port: started.port,
				instanceId: started.instanceId,
				projectId: registry.projectId,
			};
		} finally {
			if (!committed) {
				try {
					await service?.stop();
				} catch {
					// best effort: the process is already in a failure path
				}
				await guard.drop().catch(() => undefined);
			}
		}
	}

	// another process leads: connect if its service is reachable
	const registry = await readRegistry(projectDir);
	if (registry.service && (await probeService(registry.service.port, registry.service.instanceId))) {
		return {
			hosted: null,
			port: registry.service.port,
			instanceId: registry.service.instanceId,
			projectId: registry.projectId,
		};
	}
	// leader may be mid-startup (registry not yet written) or busy; retry soon
	throw new Error("leader lock is held but the registered service is not reachable yet; retrying");
}

/**
 * Clear the service entry on graceful host shutdown — but only if it still
 * points at our instance (a new leader may have taken over already). Called
 * while the leader lock is still held, so no other writer can race.
 */
export async function clearService(projectDir: string, instanceId: string): Promise<void> {
	const registry = await readRegistry(projectDir);
	if (registry.service?.instanceId === instanceId) {
		await writeRegistry(projectDir, { projectId: registry.projectId, service: null });
	}
}
