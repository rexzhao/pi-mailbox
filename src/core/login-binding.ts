/**
 * Login-binding persistence.
 *
 * The plugin stores its binding in the pi session file as custom entries
 * (append-only log):
 *   pi-mailbox-login   { name: <current>, names: [<all held>] } | { name: null }  (clear)
 *   pi-mailbox-release { name: <n>, names: [...] } | { names: null }             (clear all)
 * The legacy single-name shapes ({ name }) are read transparently. Hosts
 * that do not run inside pi implement the same store however they like;
 * readLoginBinding() parses a session FILE directly (no pi runtime),
 * for service-startup scans of managed sessions.
 */
import { readFileSync } from "node:fs";

export const LOGIN_ENTRY = "pi-mailbox-login";
export const RELEASE_ENTRY = "pi-mailbox-release";

/**
 * A session's held names plus the current identity. Names carry their
 * CLAIMED spellings (the display case survives restarts via the daemon's
 * `_case`); every comparison must fold to lowercase.
 */
export interface LoginBinding {
	/** Every held name (claimed spelling). */
	names: string[];
	/** The current identity — the last successful login (claimed spelling). */
	current: string;
}

/** Structural shape of a session entry as exposed by pi's getEntries/appendEntry. */
export interface SessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

function namesOf(data: { name?: string | null; names?: string[] | null } | null | undefined): string[] | null {
	if (!data) return null;
	// claimed spellings are preserved: folding here would make the next
	// hello claim the lowercase form and clobber the daemon's `_case`
	if (Array.isArray(data.names) && data.names.length > 0) return [...data.names];
	if (typeof data.name === "string" && data.name.length > 0) return [data.name];
	return null;
}

/**
 * Fold an entry log into the current binding state: the last login entry
 * wins for the binding; release entries accumulate until a clear (null)
 * entry resets them.
 */
export function bindingFromEntries(entries: readonly SessionEntry[]): { login: LoginBinding | null; releases: string[] } {
	let login: LoginBinding | null = null;
	let releases: string[] = [];
	for (const e of entries) {
		if (e.type !== "custom") continue;
		const data = e.data as { name?: string | null; names?: string[] | null } | undefined | null;
		if (e.customType === LOGIN_ENTRY) {
			const names = namesOf(data);
			login = names
				? { names: [...new Set(names)], current: typeof data?.name === "string" && data.name ? data.name : names[0] ?? "" }
				: null;
		} else if (e.customType === RELEASE_ENTRY) {
			const names = namesOf(data);
			releases = names ? [...new Set([...releases, ...names])] : [];
		}
	}
	return { login, releases };
}

/**
 * Read the login binding (all held names, plus pending releases) directly
 * from a pi session file, without opening the session. Unreadable or
 * missing files read as "no binding" — same as entries being unavailable.
 */
export function readLoginBinding(sessionFile: string): { login: LoginBinding | null; releases: string[] } {
	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf8");
	} catch {
		return { login: null, releases: [] };
	}
	const entries: SessionEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const e = JSON.parse(trimmed) as SessionEntry;
			if (e && typeof e === "object" && typeof e.type === "string") entries.push(e);
		} catch {
			// non-JSON line: skip (the session file mixes entry kinds)
		}
	}
	return bindingFromEntries(entries);
}
