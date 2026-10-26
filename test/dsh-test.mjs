// DSH host tests: the Cordis-side manager against fake agents and a real,
// isolated mailboxd (own PI_MAILBOXD_DIR; never touches ~/.pi).
//
// Run: node --experimental-strip-types --no-warnings test/dsh-test.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const exe = process.platform === "win32" ? "mailboxd.exe" : "mailboxd";
const daemonDir = join(import.meta.dirname, "..", "mailboxd");
const daemonBin = join(daemonDir, exe);
if (!existsSync(daemonBin)) {
	const built = spawnSync("go", ["build", "-o", daemonBin, "./"], { cwd: daemonDir, encoding: "utf8" });
	if (built.status !== 0) {
		console.error(`mailboxd binary missing (${daemonBin}) and go build failed:\n${built.stderr}`);
		process.exit(1);
	}
}

const home = mkdtempSync(join(tmpdir(), "dsh-mailbox-home-"));
process.env.PI_MAILBOXD_DIR = home;
process.env.PI_MAILBOXD = daemonBin;
const projectDir = mkdtempSync(join(tmpdir(), "dsh-mailbox-project-"));
mkdirSync(join(projectDir, ".pi"), { recursive: true });
const stateDir = mkdtempSync(join(tmpdir(), "dsh-mailbox-state-"));

const assert = (cond, msg) => {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	console.log(`ok: ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (deadlineMs, fn) => {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const value = fn();
		if (value) return value;
		await sleep(50);
	}
	return fn();
};

const { resolveLocalDaemon } = await import("../src/core/index.ts");
// DSH_TEST_ENTRY=dist runs the same suite against the BUILT bundle
// (dist/dsh/index.js, typebox inlined) — the artifact DSH actually loads
const entry = process.env.DSH_TEST_ENTRY === "dist" ? "../dist/dsh/index.js" : "../src/dsh/index.ts";
const { apply } = await import(entry);
if (process.env.DSH_TEST_ENTRY === "dist") {
	const bundle = readFileSync(join(import.meta.dirname, "..", "dist", "dsh", "index.js"), "utf8");
	assert(!/from\s+"typebox"|require\s*\(\s*"typebox"\)/.test(bundle), "the bundle inlines typebox (no external import)");
	console.log("ok: dist mode — testing the built bundle");
}

// ---------------------------------------------------------------------------
// fakes: the DSH surface the plugin actually touches
// ---------------------------------------------------------------------------

function makeAgent(sessionId, cwd, opts = {}) {
	const tools = new Map();
	const state = { status: "idle", followups: [] };
	const agent = {
		get status() {
			return state.status;
		},
		session: { id: sessionId, header: { id: sessionId, cwd, origin: opts.origin } },
		options: opts.options,
		ctx: {
			tools: {
				register(definition) {
					tools.set(definition.name, definition);
					return () => tools.delete(definition.name);
				},
			},
		},
		followup(message) {
			state.followups.push(message);
		},
		steer(message) {
			state.followups.push(message);
			state.steered = (state.steered ?? 0) + 1;
		},
	};
	return { agent, state, tools };
}

function fakeContext(agents) {
	const handlers = new Map();
	const commands = new Map();
	const ctx = {
		agents: { list: () => agents.map((entry) => entry.agent) },
		tools: { register: () => () => {} },
		commands: {
			register(definition) {
				commands.set(definition.name, definition);
				return () => commands.delete(definition.name);
			},
		},
		on(event, listener) {
			const list = handlers.get(event) ?? [];
			list.push(listener);
			handlers.set(event, list);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== listener));
		},
	};
	return {
		ctx,
		commands,
		emit(event, ...args) {
			for (const listener of [...(handlers.get(event) ?? [])]) listener(...args);
		},
	};
}

const SCHEMA_KEYWORDS = new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const",
	"description",
	"title",
]);

function assertSupportedSchema(node, path = "schema") {
	if (typeof node !== "object" || node === null) throw new Error(`FAIL: ${path} is not an object`);
	for (const key of Object.keys(node)) {
		if (!SCHEMA_KEYWORDS.has(key)) throw new Error(`FAIL: ${path} carries unsupported keyword "${key}"`);
	}
	for (const [key, value] of Object.entries(node.properties ?? {})) {
		assertSupportedSchema(value, `${path}.properties.${key}`);
	}
	if (node.items !== undefined) assertSupportedSchema(node.items, `${path}.items`);
}

try {
	await resolveLocalDaemon();

	const a = makeAgent("session-dsh-a", projectDir);
	const b = makeAgent("session-dsh-b", projectDir);
	const sub = makeAgent("session-dsh-sub", projectDir, { origin: "subagent" });
	const host = fakeContext([a, b, sub]);
	const dispose = apply(host.ctx, { stateDir, notifyAtStepBoundary: true });

	assert(host.commands.has("mailbox"), "apply() registers the /mailbox command");
	assert(a.tools.has("mailbox_connect"), "mailbox_connect is registered on the agent scope immediately");
	assert(!a.tools.has("mailbox_send"), "the deferred tools stay hidden while disconnected");
	assert(!sub.tools.has("mailbox_connect"), "subagent sessions are skipped (rootsOnly)");

	const command = host.commands.get("mailbox");
	const subResult = await command.handler({ agent: sub.agent, rawInput: "status" });
	assert(subResult.kind === "error", "the command refuses an unmanaged (subagent) session");

	// login: one named identity per session, as in the pi extension
	const loginA = await command.handler({ agent: a.agent, rawInput: "login dsh-alpha" });
	assert(loginA.kind === "success" && loginA.text.includes("dsh-alpha"), `agent A logs in through /mailbox login (${loginA.text.split("\n")[0]})`);
	const loginB = await command.handler({ agent: b.agent, rawInput: "login dsh-beta" });
	assert(loginB.kind === "success" && loginB.text.includes("dsh-beta"), "agent B logs in through /mailbox login");

	assert(a.tools.has("mailbox_send") && a.tools.has("mailbox_read"), "connecting activates the deferred tool set");
	assertSupportedSchema(a.tools.get("mailbox_connect").parameters);
	assert(a.tools.get("mailbox_connect").parameters.properties.as.pattern === undefined, "TypeBox-only keywords (pattern) are dropped for DSH");

	// send: A -> B, delivered as an ordinary next-turn user message
	const send = a.tools.get("mailbox_send");
	const sent = await send.execute({ address: "dsh-beta", subject: "first-mail", body: "hello beta" }, { callId: "call-1" });
	assert(typeof sent === "string" && sent.startsWith("sent: "), `mailbox_send returns the core's text result (${sent})`);
	const sentId = sent.split("/").pop();

	await waitFor(5000, () => b.state.followups.length === 1);
	assert(b.state.followups.length === 1, "the recipient receives exactly one notification");
	const delivered = b.state.followups[0];
	assert(delivered.role === "user" && delivered.source.kind === "mailbox", "the notification is a user-role message sourced as mailbox");
	assert(delivered.source.form === "notice" && typeof delivered.source.summary === "string", "the message carries a bounded notice summary");
	assert(delivered.content[0].text.includes(sentId) && delivered.content[0].text.includes("from dsh-alpha@") && !delivered.content[0].text.includes("first-mail"), "the notification names the mail by id + sender, not by subject");
	assert(typeof delivered.id === "string" && delivered.id.length > 0, "the injected message has a fresh identity");

	// busy: nothing is delivered mid-step; the STEP boundary coalesces everything
	b.state.status = "running";
	await send.execute({ address: "dsh-beta", subject: "second-mail", body: "x" }, {});
	await send.execute({ address: "dsh-beta", subject: "third-mail", body: "y" }, {});
	await sleep(800);
	assert(b.state.followups.length === 1, "a running agent holds notices until a step boundary");
	host.emit("session/event", { id: "session-dsh-b" }, { type: "step/end" });
	await waitFor(5000, () => b.state.followups.length === 2);
	assert(b.state.followups.length === 2, "the step boundary delivers the held notices");
	assert(b.state.steered === 1, "the step-boundary notice is delivered with steer");
	const coalesced = b.state.followups[1].content[0].text;
	assert(coalesced.includes("unread mail(s)") && !coalesced.includes("second-mail") && !coalesced.includes("third-mail"), "all arrivals in the step are coalesced into ONE (subjectless) notice");
	host.emit("session/event", { id: "session-dsh-b" }, { type: "turn/end" });
	await sleep(400);
	assert(b.state.followups.length === 2, "the turn boundary does not duplicate a delivered notice");

	// binding persistence
	const bindingFile = join(stateDir, "session-dsh-a.json");
	assert(existsSync(bindingFile), "the login binding is persisted per session");
	const stored = JSON.parse(readFileSync(bindingFile, "utf8"));
	assert(stored.login?.names?.join(",") === "dsh-alpha", "the stored binding carries the claimed name");

	// reconnect: a new manager over the same state re-claims the binding
	dispose();
	const a2 = makeAgent("session-dsh-a", projectDir);
	const host2 = fakeContext([a2]);
	const dispose2 = apply(host2.ctx, { stateDir });
	await waitFor(5000, () => a2.tools.has("mailbox_send"));
	assert(a2.tools.has("mailbox_send"), "a resumed session auto-connects from its stored binding");
	const status = await host2.commands.get("mailbox").handler({ agent: a2.agent, rawInput: "" });
	assert(status.kind === "success" && status.text.includes("dsh-alpha"), `/mailbox status reports the re-claimed identity (${status.text.split("\n")[0]})`);

	// a session created without a recorded project directory resolves the
	// effective working directory through the host's workingDirectory service
	const c = makeAgent("session-dsh-c", undefined);
	const host3 = fakeContext([c]);
	host3.ctx.get = (name) => (name === "workingDirectory" ? { get: () => projectDir } : undefined);
	const dispose3 = apply(host3.ctx, { stateDir });
	assert(c.tools.has("mailbox_connect"), "a session without header.cwd resolves the effective working directory");
	dispose3();

	dispose2();
	b.state.status = "idle";
	await sleep(200);
	console.log("\nall dsh host tests passed");
} finally {
	try {
		const fs = await import("node:fs");
		const registry = JSON.parse(fs.readFileSync(join(home, "mailboxd.json"), "utf8"));
		if (typeof registry.pid === "number" && registry.pid > 0) {
			process.kill(registry.pid, "SIGTERM");
			await sleep(400);
		}
	} catch {
		// daemon already gone
	}
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
	for (let i = 0; i < 10; i++) {
		try {
			rmSync(home, { recursive: true, force: true });
			break;
		} catch {
			await sleep(300);
		}
	}
}
process.exit(0);
