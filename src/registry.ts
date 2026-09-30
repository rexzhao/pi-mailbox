/**
 * Leader election and registry file management.
 *
 * `<project>/.pi/mailbox.json` holds the project UUID and the current service
 * address. The first connector binds a random port and writes the file under a
 * mkdir lock; later connectors probe the address and connect as clients. When
 * the hosting session exits, its socket closes and remaining clients re-run
 * the same election protocol.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { MailboxService, type ServiceHandle } from "./service.ts";

export interface RegistryFile {
	projectId: string;
	service: { port: number; instanceId: string } | null;
}

const LOCK_STALE_MS = 10_000;
const PROBE_TIMEOUT_MS = 1_500;

function registryPath(projectDir: string): string {
	return join(projectDir, ".pi", "mailbox.json");
}

function lockPath(projectDir: string): string {
	return join(projectDir, ".pi", "mailbox.lock");
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

/** Probe a claimed service address. Returns true if a matching mailbox service answers. */
async function probeService(port: number, expectedInstanceId: string): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				ws.close();
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

async function acquireLock(projectDir: string): Promise<string> {
	const ownerId = `${process.pid}-${randomUUID()}`;
	for (let attempt = 0; ; attempt++) {
		try {
			await mkdir(lockPath(projectDir), { recursive: true });
			// record ownership so a stale-holder's release cannot delete a newer lock
			await writeFile(join(lockPath(projectDir), "owner"), ownerId, "utf8");
			return ownerId;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// stale lock: hosting process died inside the critical section
			const age = Date.now() - (await stat(lockPath(projectDir))).mtimeMs;
			if (age > LOCK_STALE_MS) {
				await rm(lockPath(projectDir), { recursive: true, force: true });
				continue;
			}
			if (attempt > 20) throw new Error("mailbox lock contention timeout");
			await sleep(100 + Math.floor(Math.random() * 200));
		}
	}
}

async function releaseLock(projectDir: string, ownerId: string): Promise<void> {
	try {
		const current = await readFile(join(lockPath(projectDir), "owner"), "utf8");
		if (current.trim() !== ownerId) return; // lock was taken over; not ours
	} catch {
		// owner file unreadable (taker is mid-setup); do not touch the lock
		return;
	}
	await rm(lockPath(projectDir), { recursive: true, force: true });
}

export interface ElectionResult {
	/** Service we are now hosting, if we won the election. null for clients. */
	hosted: ServiceHandle | null;
	/** Address of the live service (ours or the existing one). */
	port: number;
	instanceId: string;
	projectId: string;
}

/**
 * Ensure a mailbox service exists for the project: connect to the live one, or
 * host it ourselves under the lock. Safe to call repeatedly (re-election).
 * `options.sessionsDir` (pi session directory for this cwd) enables
 * orphan-mailbox GC when we end up hosting; pass undefined to skip GC.
 */
export async function ensureService(
	projectDir: string,
	options?: { sessionsDir?: string; gcDelayMs?: number; gcGraceMs?: number },
): Promise<ElectionResult> {
	// fast path: probe without locking
	let registry = await readRegistry(projectDir);
	if (registry.service && (await probeService(registry.service.port, registry.service.instanceId))) {
		return {
			hosted: null,
			port: registry.service.port,
			instanceId: registry.service.instanceId,
			projectId: registry.projectId,
		};
	}

	const ownerId = await acquireLock(projectDir);
	try {
		// re-check under the lock: someone else may have won while we waited
		registry = await readRegistry(projectDir);
		if (registry.service && (await probeService(registry.service.port, registry.service.instanceId))) {
			return {
				hosted: null,
				port: registry.service.port,
				instanceId: registry.service.instanceId,
				projectId: registry.projectId,
			};
		}

		const service = new MailboxService(projectDir, registry.projectId, options);
		await service.start();
		const handle: ServiceHandle = {
			instanceId: service.instanceId,
			port: service.port,
			stop: () => service.stop(),
		};
		// we hold the lock, so the registry cannot have changed since we read it;
		// write the same projectId back alongside the new service entry
		await writeRegistry(projectDir, {
			projectId: registry.projectId,
			service: { port: service.port, instanceId: service.instanceId },
		});
		return {
			hosted: handle,
			port: service.port,
			instanceId: service.instanceId,
			projectId: registry.projectId,
		};
	} finally {
		await releaseLock(projectDir, ownerId);
	}
}

/**
 * Clear the service entry on graceful host shutdown — but only if it still
 * points at our instance. Between our server stopping and this call taking
 * the lock, another session may have won re-election and written its own
 * entry; clearing unconditionally would orphan that live service and cause
 * a split brain. Stale entries are harmless (election probes liveness).
 */
export async function clearService(projectDir: string, instanceId: string): Promise<void> {
	const ownerId = await acquireLock(projectDir);
	try {
		const registry = await readRegistry(projectDir);
		if (registry.service?.instanceId === instanceId) {
			await writeRegistry(projectDir, { projectId: registry.projectId, service: null });
		}
	} finally {
		await releaseLock(projectDir, ownerId);
	}
}
