/**
 * TypeBox -> DSH parameter-schema adapter.
 *
 * The mailbox tools declare their parameters with TypeBox (the pi contract).
 * dsh-tools accepts a narrower JSON Schema subset: type/oneOf/properties/
 * required/additionalProperties/items/enum/const plus annotations. This
 * module projects the TypeBox schemas onto that subset, dropping constraint
 * keywords the registry does not understand (minLength, pattern, format,
 * default, ...). The mailbox core re-validates the values that matter
 * (names, addresses, sizes) and the daemon enforces the wire limits, so the
 * dropped constraints are never the only check.
 */

const ANNOTATIONS = new Set(["description", "title"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Project one tool's parameter schema onto the DSH subset. */
export function toDshParameterSchema(schema: unknown): Record<string, unknown> {
	const out = sanitize(schema, "parameters");
	const typed = out["type"] === "object";
	const unioned = Array.isArray(out["oneOf"]);
	if (!typed && !unioned) {
		throw new Error(`dsh-mailbox: tool parameters must be object-rooted (got ${String(out["type"])})`);
	}
	return out;
}

function sanitize(node: unknown, path: string): Record<string, unknown> {
	if (!isRecord(node)) throw new Error(`dsh-mailbox: ${path} must be a schema object`);

	const out: Record<string, unknown> = {};
	const type = node["type"];
	if (type !== undefined) {
		if (typeof type !== "string") throw new Error(`dsh-mailbox: ${path}.type must be a single type string`);
		out["type"] = type;
	}

	// TypeBox emits anyOf for Type.Union; dsh-tools only knows oneOf.
	const union = node["oneOf"] ?? node["anyOf"];
	if (union !== undefined) {
		if (!Array.isArray(union) || union.length < 2) {
			throw new Error(`dsh-mailbox: ${path} union must have at least two branches`);
		}
		out["oneOf"] = union.map((branch, index) => sanitize(branch, `${path}.oneOf[${index}]`));
	}

	if (type === undefined && union === undefined) {
		throw new Error(`dsh-mailbox: ${path} declares neither type nor oneOf`);
	}

	const properties = node["properties"];
	if (properties !== undefined) {
		if (!isRecord(properties)) throw new Error(`dsh-mailbox: ${path}.properties must be an object`);
		const mapped: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(properties)) {
			mapped[key] = sanitize(value, `${path}.properties.${key}`);
		}
		out["properties"] = mapped;
	}

	const required = node["required"];
	if (required !== undefined) {
		if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) {
			throw new Error(`dsh-mailbox: ${path}.required must be a string array`);
		}
		out["required"] = [...required];
	}

	const additional = node["additionalProperties"];
	if (typeof additional === "boolean") out["additionalProperties"] = additional;
	else if (additional !== undefined) out["additionalProperties"] = sanitize(additional, `${path}.additionalProperties`);

	const items = node["items"];
	if (items !== undefined) out["items"] = sanitize(items, `${path}.items`);

	const enumValues = node["enum"];
	if (enumValues !== undefined) {
		if (!Array.isArray(enumValues)) throw new Error(`dsh-mailbox: ${path}.enum must be an array`);
		out["enum"] = [...enumValues];
	}

	if (Object.hasOwn(node, "const")) out["const"] = node["const"];

	for (const key of ANNOTATIONS) {
		const value = node[key];
		if (typeof value === "string") out[key] = value;
	}

	// Everything else (minLength, maxLength, pattern, format, default,
	// examples, $id, $schema, ...) is outside the DSH subset and dropped.
	return out;
}
