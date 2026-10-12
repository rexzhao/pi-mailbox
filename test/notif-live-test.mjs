// Manual live test for the coalesced boundary notification (new extension
// code). Spawns a fresh pi agent (new code) in a herdr tab, keeps it busy,
// sends mails mid-run, and verifies the injected [mailbox] messages in its
// session transcript.
//
// Requires: running herdr + local mailboxd. Not CI.
// Run from the repo root: node --experimental-strip-types --no-warnings test/notif-live-test.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MailboxConnection } from "../src/client.ts";
import { deriveSessionId } from "../src/daemon.ts";

const projectDir = process.cwd();
const origin = `notif-test-${Date.now().toString(36)}`;
const shortSession = deriveSessionId("pi", origin);
const registry = JSON.parse(readFileSync(join(homedir(), ".pi", "mailboxd.json"), "utf8"));
const PORT = registry.port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function herdr(args, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const child = spawn("herdr", args, { windowsHide: true });
		let out = "";
		const timer = setTimeout(() => { child.kill(); reject(new Error(`herdr ${args[0]} timeout`)); }, timeoutMs);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.on("close", () => { clearTimeout(timer); try { resolve(JSON.parse(out).result); } catch (e) { reject(e); } });
	});
}

// sessions dir slug mirrors pi's per-project layout (F:\work\x -> --F--work\u200bx--)
const sessionsDir = join(homedir(), ".pi", "agent", "sessions", `--${projectDir.replace(/[:\\/]/g, "-")}--`);
import { readdirSync } from "node:fs";
function findSessionFile() {
	try {
		for (const f of readdirSync(sessionsDir)) if (f.endsWith(`_${origin}.jsonl`)) return join(sessionsDir, f);
	} catch { /* dir not created yet */ }
	return null;
}
function mailboxEntries(file) {
	if (!file) return [];
	try {
		return readFileSync(file, "utf8").split("\n").filter((l) => l.includes("[mailbox] You have"));
	} catch { return []; }
}

console.log(`test session: ${shortSession} (origin ${origin})`);

// 1. fresh tab + start pi (new extension code) with a long-ish task
const panes = (await herdr(["pane", "list"])).panes;
const ws = panes.find((p) => p.cwd && p.cwd.replace(/\\/g, "/").toLowerCase() === projectDir.replace(/\\/g, "/").toLowerCase());
if (!ws) throw new Error("no herdr workspace for this project");
const tab = await herdr(["tab", "create", "--workspace", ws.workspace_id, "--label", "notif-test"]);
const paneId = tab.root_pane.pane_id;
console.log(`pane: ${paneId}`);
// teardown on ANY exit path (fail fast-exits included): close the test tab
process.on("exit", () => {
	if (paneId) {
		try { spawnSync("herdr", ["pane", "close", paneId], { stdio: "ignore" }); } catch { /* best effort */ }
	}
});
await herdr(
	["agent", "start", "notif-test", "--kind", "pi", "--pane", paneId, "--timeout", "30000", "--", "-ne", "-e", join(projectDir, "src", "index.ts"), "--session-id", origin],
	40000,
);
await herdr([
	"agent", "prompt", paneId,
	"First use the mailbox_connect tool to connect to the project mailbox. Then use the bash tool to run: sleep 25. After the sleep finishes, reply with exactly: done. If a [mailbox] notification arrives, finish the current task first as it says.",
]);

// 2. sender client: wait until the test session registers, then send 3 mails mid-run
const sender = new MailboxConnection("local", projectDir, null, `notif-sender-${Date.now().toString(36)}`, "pi", {
	onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {},
}, { canSpawn: true });
await sender.start();
let online = false;
for (let i = 0; i < 200; i++) {
	const sessions = await sender.mailbox.sessions();
	if (sessions.some((s) => s.session === shortSession && s.online)) { online = true; break; }
	await sleep(300);
}
if (!online) throw new Error("test session never came online");
console.log("test session online (busy) — sending 2 agent mails + 1 user mail");
const t = shortSession;
await sender.mailbox.sendMail({ project: sender.mailbox.project, session: t }, "agent-mail-alpha", "body a");
await sender.mailbox.sendMail({ project: sender.mailbox.project, session: t }, "agent-mail-beta", "body b");
const userSend = spawnSync("curl", [
	"-s", "-X", "POST", `http://127.0.0.1:${PORT}/api/send`,
	"-H", "Content-Type: application/json",
	"-d", JSON.stringify({ to: `${t}@${sender.mailbox.project}`, subject: "user-mail-gamma", body: "from the operator" }),
], { encoding: "utf8" });
console.log("user send:", userSend.stdout.trim() || userSend.stderr.trim());

// 3. wait for the coalesced busy-phase message in the transcript
let file = null;
let busyEntries = [];
for (let i = 0; i < 100; i++) {
	file = findSessionFile();
	if (file) {
		busyEntries = mailboxEntries(file);
		const hit = busyEntries.find((l) => l.includes("agent-mail-alpha") && l.includes("agent-mail-beta") && l.includes("user-mail-gamma"));
		if (hit) { busyEntries = [hit]; break; }
	}
	await sleep(1500);
}
if (busyEntries.length !== 1) {
	console.log("FAIL: busy phase did not coalesce into one message");
	console.log(`found ${busyEntries.length} [mailbox] entries:`);
	for (const e of busyEntries) console.log(e.slice(0, 300));
	process.exit(1);
}
const coalesced = busyEntries[0];
const checks = [
	["user priority section", coalesced.includes("New mail from the user") && coalesced.includes("takes priority")],
	["agent mail section", coalesced.includes("from ") && coalesced.includes("agent-mail-alpha")],
	["boundary guidance", coalesced.includes("Finish your current task")],
];
for (const [name, ok] of checks) { console.log(`${ok ? "ok" : "FAIL"}: ${name}`); if (!ok) process.exit(1); }
console.log("busy-phase coalesced message:", coalesced.slice(0, 600));

// 4. idle phase: wait for the agent to settle, then send a user mail
console.log("waiting for the test agent to go idle...");
let idle = false;
for (let i = 0; i < 80; i++) {
	const agents = (await herdr(["agent", "list"])).agents ?? [];
	const a = agents.find((x) => x.pane_id === paneId);
	if (a && (a.agent_status === "idle" || a.agent_status === "done")) { idle = true; break; }
	await sleep(1500);
}
console.log(`idle: ${idle} — sending idle-phase user mail`);
spawnSync("curl", [
	"-s", "-X", "POST", `http://127.0.0.1:${PORT}/api/send`,
	"-H", "Content-Type: application/json",
	"-d", JSON.stringify({ to: `${t}@${sender.mailbox.project}`, subject: "user-mail-delta", body: "second operator mail" }),
], { encoding: "utf8" });

let idleEntry = null;
for (let i = 0; i < 60; i++) {
	const entries = mailboxEntries(findSessionFile() ?? "");
	const hit = entries.find((l) => l.includes("user-mail-delta"));
	if (hit) { idleEntry = hit; break; }
	await sleep(1500);
}
if (!idleEntry) { console.log("FAIL: idle-phase user mail never injected"); process.exit(1); }
console.log("idle-phase message:", idleEntry.slice(0, 400));
await sender.stop();
console.log("PASS: busy coalescing + user priority + idle direct injection all verified");
// tab teardown happens in the exit handler
