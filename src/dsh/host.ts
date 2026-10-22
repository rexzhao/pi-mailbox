/**
 * MailboxHost for one DSH agent.
 *
 * The mapping is the whole port: pi's sendUserMessage(steer) becomes
 * agent.followup() (a next-turn prompt that wakes an idle agent), pi's busy
 * flag becomes agent.status, and the unread badge / footer / resume features
 * simply stay absent (the core degrades them to no-ops).
 */
import { randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import type { MailboxHost, NotifyLevel, WakeResult } from "../core/index.ts";
import type { DshAgent, DshUserMessage } from "./types.ts";
import type { FileLoginStore } from "./store.ts";

/** Notice summary bound the DSH transcript uses for context rows. */
const SUMMARY_MAX = 120;

export interface MailboxHostOptions {
	agent: DshAgent;
	/** Project directory pinned when the session was adopted (mailbox identity). */
	projectRoot: string;
	store: FileLoginStore;
	/** Message source kind (config.sourceKind). */
	sourceKind: string;
	/** Command output / background warnings. */
	notify(message: string, level: NotifyLevel): void;
	/** Connection state changed: sync the tool set. */
	onConnectionChanged(): void;
	/** Unread total for this session changed (null = disconnected). */
	onUnread(total: number | null): void;
	/** Cold-resume an offline session (config.wakeOnMail); undefined disables wake. */
	wake?(origin: string): Promise<boolean>;
}

/** Build the identified user message DSH's followup() accepts. */
export function mailboxMessage(text: string, kind: string): DshUserMessage {
	const firstLine = text.split("\n", 1)[0] ?? text;
	const summary = firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX - 1)}…` : firstLine;
	return {
		id: randomUUID(),
		role: "user",
		content: [{ type: "text", text }],
		source: { kind, form: "notice", summary },
	};
}

export function createMailboxHost(options: MailboxHostOptions): MailboxHost {
	const agent = options.agent;
	const host: MailboxHost = {
		identity: {
			agent: "dsh",
			get sessionId() {
				return agent.session.id;
			},
			get cwd() {
				return options.projectRoot;
			},
		},
		loginStore: options.store,
		deliver: (text) => {
			agent.followup(mailboxMessage(text, options.sourceKind));
		},
		isBusy: () => agent.status === "running",
		notify: options.notify,
		onConnectionChanged: options.onConnectionChanged,
		setUnread: (total) => options.onUnread(total),
		// registration-time system meta: the model route and, locally only,
		// the machine identity (remote services never see host details)
		helloMeta: ({ remote }) => {
			const meta: Record<string, string> = {};
			const provider = agent.options?.provider;
			const model = agent.options?.model;
			if (provider && model) meta._model = `${provider}/${model}`;
			if (!remote) {
				meta._host = hostname();
				meta._platform = platform();
			}
			return meta;
		},
	};
	if (options.wake) {
		const wake = options.wake;
		host.wake = async (target): Promise<WakeResult> => {
			try {
				return (await wake(target.origin))
					? { ok: true, detail: `resumed session ${target.session}` }
					: { ok: false, reason: "session could not be resumed" };
			} catch (err) {
				return { ok: false, reason: err instanceof Error ? err.message : String(err) };
			}
		};
	}
	return host;
}
