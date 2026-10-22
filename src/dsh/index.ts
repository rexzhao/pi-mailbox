/**
 * dsh-mailbox: the DeepSeek Harness host for the pi-mailbox core.
 *
 * One Cordis plugin instance per host process manages every live root
 * agent: it attaches a MailboxController on agent/created, delivers mail as
 * an ordinary next-turn user message (agent.followup), and registers the
 * mailbox tools on the agent's own scope. A session cannot tell this layer
 * from the pi extension: same tools, same notification text, same command.
 */
import z from "@deepseek-ai/schemastery";
import { coreApiMajor } from "../core/version.ts";
import { MailboxManager } from "./manager.ts";
import type { DshContext, DshMailboxConfig } from "./types.ts";

export const name = "dsh-mailbox";

/** Cordis waits for these services before calling apply(). */
export const inject = ["agents", "tools", "commands"];

/** Settings-page schema: editable through the profile config UI. */
export const Config = z.object({
	stateDir: z
		.string()
		.default("")
		.description("Login-binding store directory (empty: $DSH_HOME/storages/mailbox)"),
	rootsOnly: z
		.boolean()
		.default(true)
		.description("Manage only ordinary sessions; subagent sessions are skipped"),
	autoConnect: z
		.boolean()
		.default(true)
		.description("Re-claim a stored login binding when a session starts"),
	wakeOnMail: z
		.boolean()
		.default(false)
		.description("Cold-resume an offline session to deliver waiting mail (starts a turn)"),
	sourceKind: z
		.string()
		.default("mailbox")
		.description("Message source kind used on delivered mail notices"),
});

export function apply(ctx: DshContext, config: DshMailboxConfig = {}): () => void {
	if (coreApiMajor() !== 1) {
		throw new Error(
			`dsh-mailbox: incompatible pi-mailbox core (need MAILBOX_CORE_API_VERSION major 1, found ${coreApiMajor()})`,
		);
	}
	const manager = new MailboxManager(ctx, config);
	manager.start();
	return () => manager.dispose();
}
