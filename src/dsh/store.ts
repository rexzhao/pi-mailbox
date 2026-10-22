/**
 * DSH login-binding store: one JSON document per DSH session, outside the
 * session log.
 *
 * pi stores the binding as session entries; DSH session records are owned by
 * the session package (plugin records are reserved for in-repo experimental
 * packages), so the host keeps its own file instead. The file is keyed by the
 * DSH session id and lives under $DSH_HOME/storages/mailbox by default, so it
 * survives session resume, compaction, and harness restarts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LoginBinding, MailboxLoginStore } from "../core/index.ts";

interface StoredBinding {
	login: LoginBinding | null;
	releases: string[];
}

function parse(file: string, raw: string): StoredBinding {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (err) {
		throw new Error(`dsh-mailbox: login store ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (typeof value !== "object" || value === null) {
		throw new Error(`dsh-mailbox: login store ${file} must contain an object`);
	}
	const record = value as { login?: unknown; releases?: unknown };
	const login = record.login as LoginBinding | null | undefined;
	const releases = record.releases;
	return {
		login:
			login && typeof login.current === "string" && Array.isArray(login.names)
				? { current: login.current, names: login.names.filter((name) => typeof name === "string") }
				: null,
		releases: Array.isArray(releases) ? releases.filter((name): name is string => typeof name === "string") : [],
	};
}

/** File-backed MailboxLoginStore for one DSH session. Throws on a corrupt file. */
export class FileLoginStore implements MailboxLoginStore {
	private data: StoredBinding | null = null;
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	private load(): StoredBinding {
		if (this.data !== null) return this.data;
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			this.data = { login: null, releases: [] };
			return this.data;
		}
		this.data = parse(this.file, raw);
		return this.data;
	}

	private save(): void {
		const data = this.load();
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(data)}\n`);
		renameSync(tmp, this.file);
	}

	readLogin(): LoginBinding | null {
		const login = this.load().login;
		return login ? { current: login.current, names: [...login.names] } : null;
	}

	writeLogin(binding: LoginBinding | null): void {
		const data = this.load();
		data.login = binding ? { current: binding.current, names: [...binding.names] } : null;
		this.save();
	}

	readRelease(): string[] {
		return [...this.load().releases];
	}

	writeRelease(names: string[] | null): void {
		const data = this.load();
		data.releases = names ? [...new Set(names)] : [];
		this.save();
	}
}
