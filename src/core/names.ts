/**
 * Mailbox-name grammar (client-side mirror of the daemon's authority).
 */

const WINDOWS_RESERVED = new Set([
	"con", "prn", "aux", "nul",
	"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
	"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * Mailbox-name grammar: 1-255 chars, letter first. Case is DISPLAY-only
 * (the daemon canonicalizes to lowercase); the derived-id shape and the
 * reserved ids are excluded case-insensitively.
 */
export function validMailboxName(name: string): boolean {
	if (!/^[A-Za-z][A-Za-z0-9_-]{0,254}$/.test(name)) return false;
	const lower = name.toLowerCase();
	return !/^[0-9a-z]{10}$/.test(lower) && lower !== "user" && !WINDOWS_RESERVED.has(lower);
}
