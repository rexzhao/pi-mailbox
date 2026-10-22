/**
 * Minimal typings for the harness-bundled Schemastery (no .d.ts ships in the
 * asar). Only the surface this plugin's Config uses is declared.
 */
declare module "@deepseek-ai/schemastery" {
	interface Schema {
		default(value: unknown): Schema;
		description(text: string): Schema;
	}
	interface SchemaFactory {
		string(): Schema;
		boolean(): Schema;
		number(): Schema;
		object(shape: Record<string, Schema>): Schema;
	}
	const z: SchemaFactory;
	export default z;
}
