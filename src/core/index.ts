/**
 * pi-mailbox core: the host-agnostic, Node-loadable entry.
 *
 * Loadable directly from Node (erasable TS only — no enum/namespace/
 * parameter properties; type-only imports are marked). A host (e.g. the
 * simple-agent web service) constructs MailboxController instances with
 * its own MailboxHost implementation; the pi extension (src/index.ts) is
 * just one such host. Check MAILBOX_CORE_API_VERSION's major before
 * enabling.
 */
export {
	MailboxController,
	type MailboxHost,
	type MailboxIdentity,
	type MailboxLoginStore,
	type WakeTarget,
	type WakeResult,
	type NameLostInfo,
	type NotifyLevel,
	type ConnectionStatus,
} from "./controller.ts";
export type { MailboxToolDefinition, MailboxToolResult, DeleteOutcome } from "./types.ts";
export { buildToolDefinitions, DEFERRED_TOOL_NAMES } from "./tools.ts";
export { executeMailboxCommand, mailboxArgumentCompletions } from "./command.ts";
export { validMailboxName } from "./names.ts";
export {
	LOGIN_ENTRY,
	RELEASE_ENTRY,
	bindingFromEntries,
	readLoginBinding,
	type LoginBinding,
	type SessionEntry,
} from "./login-binding.ts";
export {
	ADDRESS_FORMAT_DOC,
	MAILBOX_NAMESPACE,
	READ_ONLY,
	asStructured,
	formatDeleteSummary,
	formatMail,
	formatMailList,
	formatMailRef,
	formatSessions,
	httpBase,
	parseAddress,
	parseMailRef,
	summarizeEntries,
	type JsonValue,
} from "./format.ts";
export { MAILBOX_CORE_API_VERSION, MAILBOX_EXTENSION_ID, coreApiMajor } from "./version.ts";

// daemon discovery & identity derivation (same ids in TUI and web hosts)
export {
	connectLocalDaemonIfRunning,
	daemonHome,
	daemonRegistryPath,
	deriveProjectId,
	deriveSessionId,
	fetchProjectsViaApi,
	fetchSessionsViaApi,
	findMailboxdBinary,
	readHostId,
	resolveLocalDaemon,
} from "../daemon.ts";
export { MailboxConnection, MailboxError, isFatalLoginError, type ConnectionEvents, type ConnectionOptions, type RemoteTarget } from "../client.ts";
export { PROTOCOL_VERSION } from "../protocol.ts";
