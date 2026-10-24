/**
 * Core version contract.
 *
 * MAILBOX_CORE_API_VERSION is semver and governs the MailboxHost /
 * MailboxController surface only: while the MAJOR version is unchanged,
 * plugin-internal changes (notification wording, tool behavior details,
 * wire protocol) are invisible to a host. A host must refuse to enable
 * the core on a major-version mismatch.
 */
export const MAILBOX_CORE_API_VERSION = "1.1.0";

/** Major version of MAILBOX_CORE_API_VERSION (the compatibility gate). */
export function coreApiMajor(version: string = MAILBOX_CORE_API_VERSION): number {
	const major = Number.parseInt(version.split(".")[0] ?? "", 10);
	return Number.isFinite(major) ? major : 0;
}

/**
 * Identity of this package as a pi extension, for hosts that load pi's
 * installed extensions and must EXCLUDE the plugin itself (the host holds
 * the mailbox connection on the session's behalf; loading both would log
 * the same identity in twice).
 */
export const MAILBOX_EXTENSION_ID = "pi-mailbox";
