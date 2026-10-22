/**
 * Structural view of the DSH host surface this plugin uses.
 *
 * Declared locally on purpose: the plugin imports no @deepseek-ai/* package,
 * so it resolves against whichever DSH build loads it and can be tested
 * without booting the harness. Every member here was taken from the shipped
 * DSH 0.2.x packages (dsh-agent, dsh-tools, dsh-commands, dsh-session).
 */

/** The durable session header fields the plugin reads. */
export interface DshSessionHeader {
	/** The DSH session id (also the durable log id). */
	id: string;
	/** Absolute project directory recorded when the session was created. */
	cwd?: string;
	/** "subagent" for delegated children; absent for ordinary sessions. */
	origin?: string;
}

export interface DshSession {
	readonly id: string;
	readonly header: DshSessionHeader;
}

/** One identified user-role message, as dsh-agent's followup() expects it. */
export interface DshUserMessage {
	id: string;
	role: "user";
	content: Array<{ type: "text"; text: string }>;
	source: { kind: string; form?: "notice"; summary?: string };
}

export interface DshToolExecution {
	signal?: AbortSignal;
	callId?: string;
}

/** The registry-ready shape dsh-tools' register() accepts (defineTool output). */
export interface DshToolDefinition {
	name: string;
	description: string;
	parameters: unknown;
	output: {
		schema: unknown;
		render(args: unknown, value: string): Array<{ type: "text"; text: string }>;
	};
	execute(args: Record<string, unknown>, exec: DshToolExecution): Promise<string>;
}

export interface DshAgentScope {
	readonly tools: { register(definition: DshToolDefinition): () => void };
}

export interface DshAgent {
	/** "running" while a turn is executing; "idle" (and maintenance) otherwise. */
	readonly status: "idle" | "running";
	readonly session: DshSession;
	/** The agent-scoped context: registrations here unwind with the agent. */
	readonly ctx: DshAgentScope;
	readonly options?: { provider?: string; model?: string };
	/** Queue an ordinary next-turn prompt and wake the driver. */
	followup(message: DshUserMessage): void;
	/** Queue next-step input and wake the driver (delivered at the next step). */
	steer(message: DshUserMessage): void;
}

export interface DshCommandInvocation {
	agent: DshAgent;
	rawInput: string;
	signal: AbortSignal;
}

export type DshCommandResult = { kind: "success"; text?: string } | { kind: "error"; text: string };

export interface DshCommandDefinition {
	name: string;
	description: string;
	input?: { hint: string };
	handler(invocation: DshCommandInvocation): DshCommandResult | Promise<DshCommandResult>;
}

/** Minimal node:http response used by the status route. */
export interface DshResponse {
	writeHead(status: number, headers?: Record<string, string>): void;
	end(body?: string): void;
}

export interface DshCommandRegistry {
	register(definition: DshCommandDefinition): () => void;
}

export interface DshContext {
	readonly agents: { list(): readonly DshAgent[] };
	readonly tools: { register(definition: DshToolDefinition): () => void };
	readonly commands: DshCommandRegistry;
	on(event: "agent/created" | "agent/disposed", listener: (payload: { agent: DshAgent }) => void): () => void;
	on(event: "session/event", listener: (session: DshSession, event: { type: string }) => void): () => void;
	/** Resolve an optional service by name (missing services return undefined). */
	get?(name: string): unknown;
	/** Run a callback once optional services are available (Cordis optional injection). */
	inject?(dependencies: string[], callback: (ctx: DshContext) => void): unknown;
	/** The HTTP carrier's route registry (absent outside a browser-facing host). */
	readonly webServer?: {
		register(route: {
			kind: "exact" | "prefix";
			path: string;
			handler(req: unknown, res: DshResponse): void | Promise<void>;
		}): () => void;
	};
	/** Cordis logging service (callable with a scope name); optional. */
	readonly logger?: unknown;
	/** Host-side session control; present in the shipped Web composition. */
	readonly sessionController?: {
		resolveAgent(sessionId: string): Promise<{ agent?: DshAgent; error?: unknown }>;
	};
}

/**
 * Outcome of one wake attempt, mapped onto the core's WakeResult: `silent`
 * means "no wake is possible here" (archived session, no resume service) and
 * must not read as a failure to the sender.
 */
export type DshWakeOutcome =
	| { ok: true }
	| { ok: false; reason: string; silent?: boolean };

/** The plugin's row config (cordis.patch.yml / dsh.bundle.yml). */
export interface DshMailboxConfig {
	/** Login-binding store directory; default `$DSH_HOME/storages/mailbox`. */
	stateDir?: string;
	/** Manage only ordinary (non-subagent) sessions. Default true. */
	rootsOnly?: boolean;
	/** Re-claim a stored login binding when the session starts. Default true. */
	autoConnect?: boolean;
	/** Cold-resume an offline session to deliver mail (needs sessionController). Default false. */
	wakeOnMail?: boolean;
	/** Message source kind on delivered notices. Default "mailbox". */
	sourceKind?: string;
	/** Deliver new-mail notices during a running turn instead of waiting for turn end. Default true. */
	notifyWhileBusy?: boolean;
	/** Coalesce at session step boundaries (one steer per boundary). Default true; false uses the timer window. */
	notifyAtStepBoundary?: boolean;
	/** While busy: coalesce arrivals for this long before notifying. Default 1500. */
	notifyWindowMs?: number;
	/** While busy: minimum gap between delivered notices. Default 10000. */
	notifyCooldownMs?: number;
}
