/**
 * Per-session JSONL mail storage.
 *
 * Layout: `<project>/.pi/mailbox/<sessionId>.jsonl`
 * Event types: `send` (append a mail), `read` (mark a mail read), `meta`
 * (update session metadata: display name, tags).
 * Files are lazy-loaded on first access by their owning session and cached.
 */

import { appendFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { SESSION_ID_RE, type MailRecord } from "./protocol.ts";

export interface SendEvent {
	t: "send";
	mail: MailRecord;
}

export interface ReadEvent {
	t: "read";
	mail: string;
	at: string;
}

export interface MetaEvent {
	t: "meta";
	name?: string | null;
	tags?: string[];
}

export type StoreEvent = SendEvent | ReadEvent | MetaEvent;

export interface SessionMeta {
	name?: string;
	tags: string[];
}

export interface SessionState {
	mails: Map<string, MailRecord>;
	meta: SessionMeta;
}

function sessionFile(dir: string, sessionId: string): string {
	if (!SESSION_ID_RE.test(sessionId)) {
		throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
	}
	return join(dir, `${sessionId}.jsonl`);
}

export class MailStore {
	private readonly dir: string;
	private readonly cache = new Map<string, SessionState>();

	constructor(projectDir: string) {
		this.dir = join(projectDir, ".pi", "mailbox");
	}

	async init(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
	}

	/** Load (or return cached) state for a session: mails + metadata. */
	async state(sessionId: string): Promise<SessionState> {
		const cached = this.cache.get(sessionId);
		if (cached) return cached;

		const mails = new Map<string, MailRecord>();
		const meta: SessionMeta = { tags: [] };
		try {
			const raw = await readFile(sessionFile(this.dir, sessionId), "utf8");
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				let event: StoreEvent;
				try {
					event = JSON.parse(trimmed) as StoreEvent;
				} catch {
					continue; // tolerate torn last line
				}
				if (event.t === "send") {
					mails.set(event.mail.id, event.mail);
				} else if (event.t === "read") {
					const mail = mails.get(event.mail);
					if (mail) mail.readAt = event.at;
				} else if (event.t === "meta") {
					if (event.name !== undefined) {
						meta.name = event.name === null ? undefined : event.name;
					}
					if (event.tags !== undefined) {
						meta.tags = event.tags;
					}
				}
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		const entry: SessionState = { mails, meta };
		this.cache.set(sessionId, entry);
		return entry;
	}

	async inbox(sessionId: string): Promise<Map<string, MailRecord>> {
		return (await this.state(sessionId)).mails;
	}

	async appendSend(sessionId: string, mail: MailRecord): Promise<void> {
		await appendFile(sessionFile(this.dir, sessionId), JSON.stringify({ t: "send", mail }) + "\n");
		const state = await this.state(sessionId);
		state.mails.set(mail.id, mail);
	}

	async appendRead(sessionId: string, mailId: string, at: string): Promise<void> {
		await appendFile(sessionFile(this.dir, sessionId), JSON.stringify({ t: "read", mail: mailId, at }) + "\n");
		const state = await this.state(sessionId);
		const mail = state.mails.get(mailId);
		if (mail && !mail.readAt) mail.readAt = at;
	}

	async appendMeta(sessionId: string, update: { name?: string | null; tags?: string[] }): Promise<void> {
		await appendFile(sessionFile(this.dir, sessionId), JSON.stringify({ t: "meta", ...update }) + "\n");
		const state = await this.state(sessionId);
		if (update.name !== undefined) {
			state.meta.name = update.name === null ? undefined : update.name;
		}
		if (update.tags !== undefined) {
			state.meta.tags = update.tags;
		}
	}

	static unreadCount(mails: Map<string, MailRecord>): number {
		let n = 0;
		for (const mail of mails.values()) {
			if (!mail.readAt) n++;
		}
		return n;
	}

	/**
	 * Move mailbox files of sessions whose pi session file no longer exists
	 * into `.trash/` (deferred deletion).
	 *
	 * Safety layers (pi session files are lazily created, so an online session
	 * may have no file on disk yet):
	 * - runs delayed after service start, when reconnecting clients have
	 *   re-registered, and skips sessions that are currently online
	 * - only files idle for longer than `graceMs` are collected
	 * - skips entirely when the session directory is unreadable or contains no
	 *   session files at all (misconfigured path must not wipe the mailbox)
	 * Returns the number of orphaned files moved.
	 */
	async gcOrphans(sessionsDir: string, graceMs: number, isOnline: (sessionId: string) => boolean): Promise<number> {
		let sessionFiles: string[];
		try {
			sessionFiles = await readdir(sessionsDir);
		} catch {
			return 0;
		}
		const jsonl = sessionFiles.filter((f) => f.endsWith(".jsonl"));
		if (jsonl.length === 0) return 0;

		const entries = await readdir(this.dir, { withFileTypes: true });
		let moved = 0;
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const sessionId = entry.name.slice(0, -".jsonl".length);
			if (isOnline(sessionId)) continue;
			const alive = jsonl.some((f) => f.endsWith(`_${sessionId}.jsonl`));
			if (alive) continue;
			const info = await stat(join(this.dir, entry.name));
			if (Date.now() - info.mtimeMs < graceMs) continue;
			await mkdir(join(this.dir, ".trash"), { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			await rename(join(this.dir, entry.name), join(this.dir, ".trash", `${stamp}_${entry.name}`));
			this.cache.delete(sessionId);
			moved++;
		}
		return moved;
	}
}
