/**
 * Mailbox tool definitions -> dsh-tools registry definitions.
 *
 * Names, descriptions, and argument schemas come from the core unchanged
 * (that is the byte-for-byte contract the pi extension exposes); only the
 * execute/output envelope differs: dsh-tools executes a typed body that
 * returns a canonical value and renders model content from it, so the
 * adapter returns the core's text and renders it as one text block.
 */
import type { MailboxToolDefinition } from "../core/index.ts";
import type { DshToolDefinition } from "./types.ts";
import { toDshParameterSchema } from "./schema.ts";

export function toDshTool(definition: MailboxToolDefinition): DshToolDefinition {
	return {
		name: definition.name,
		description: definition.description,
		parameters: toDshParameterSchema(definition.parameters),
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }],
		},
		async execute(args, exec) {
			const result = await definition.execute(exec.callId ?? definition.name, args, exec.signal);
			return result.content.map((block) => block.text).join("\n");
		},
	};
}
