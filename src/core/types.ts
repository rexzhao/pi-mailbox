/**
 * Shared structural types for the core and the plugin shell.
 */

export interface DeleteOutcome {
	deleted: string[];
	skipped: Array<{ name: string; reason: string }>;
	failed: Array<{ name: string; error: string }>;
	withTotals: boolean;
	totalMails: number;
	totalUnread: number;
}

/** Result shape of a mailbox tool execution (pi's AgentToolResult, structurally). */
export interface MailboxToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
	structuredContent?: import("./format.ts").JsonValue;
}

/**
 * A mailbox tool definition: exactly what pi.registerTool accepts (minus
 * the pi-specific execute ctx), so a host can register each entry as-is.
 * execute acts on the controller instance it was built from.
 */
export interface MailboxToolDefinition {
	name: string;
	label: string;
	namespace?: { name: string; description: string; instructions?: string };
	description: string;
	parameters: unknown;
	exposure?: string;
	annotations?: { readOnlyHint?: boolean };
	outputSchema: unknown;
	execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (update: unknown) => void): Promise<MailboxToolResult>;
}
