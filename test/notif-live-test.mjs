// Manual live test for the coalesced boundary notification, against an
// ISOLATED daemon (see live-helpers.mjs). Spawns a fresh pi agent (new code)
// in a herdr tab, has it log in to a named mailbox, keeps it busy, sends
// mails mid-run, and verifies the injected [mailbox] messages in its session
// transcript.
//
// Requires: running herdr + go on PATH. Not CI.
// Run from the repo root: node --experimental-strip-types --no-warnings test/notif-live-test.mjs
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MailboxConnection } from "../src/client.ts";
import { setupIsolatedDaemon, herdr, newProjectTab, sessionsDirFor ,
	sweepTestMailboxes,
} from "./live-helpers.mjs";

const projectDir = process.cwd();
const origin = `notif-test-${Date.now().toString(36)}`;
const NAME = `nt-${Date.now().toString(36)}`;
const { port, apiDelete } = setupIsolatedDaemon("notif");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessionsDir = sessionsDirFor(projectDir);
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
	} catch {
		return [];
	}
}

console.log(`test session origin: ${origin}, named mailbox: ${NAME}`);

// 1. fresh tab + start pi (new extension code) with a long-ish task
// sweep BEFORE this run's agent exists, so it can never consider it
const preSender = new MailboxConnection("local", projectDir, null, `notif-sweep-${Date.now().toString(36)}`, "pi", {
	onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {},
}, { canSpawn: true });
await preSender.start();
await sweepTestMailboxes(preSender, apiDelete, preSender.mailbox.project);
await preSender.stop();

const paneId = await newProjectTab(projectDir, "notif-test");
process.on("exit", () => {
	try { spawnSync("herdr", ["pane", "close", paneId], { stdio: "ignore" }); } catch { /* best effort */ }
});
console.log(`pane: ${paneId}`);
await herdr(
	["agent", "start", "notif-test", "--kind", "pi", "--pane", paneId, "--timeout", "30000", "--", "-ne", "-e", join(projectDir, "src", "index.ts"), "--session-id", origin],
	40000,
);
await herdr([
	"agent", "prompt", paneId,
	`First log in to the project mailbox with the mailbox_connect tool (as='${NAME}'). Then use the bash tool to run: sleep 25. After the sleep finishes, reply with exactly: done. If a [mailbox] notification arrives, finish the current task first as it says.`,
]);

// 2. sender client: wait until the named mailbox is online, then send 3 mails mid-run
const sender = new MailboxConnection("local", projectDir, null, `notif-sender-${Date.now().toString(36)}`, "pi", {
	onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {},
}, { canSpawn: true });
await sender.start();
let online = false;
for (let i = 0; i < 200; i++) {
	const sessions = await sender.mailbox.sessions();
	if (sessions.some((s) => s.session === NAME && s.online)) { online = true; break; }
	await sleep(300);
}
if (!online) throw new Error("named mailbox never came online");
console.log("named mailbox online (busy) — sending 2 agent mails + 1 user mail");
await sender.mailbox.sendMail({ project: sender.mailbox.project, session: NAME }, "agent-mail-alpha", "body a");
await sender.mailbox.sendMail({ project: sender.mailbox.project, session: NAME }, "agent-mail-beta", "body b");
const userSend = spawnSync("curl", [
	"-s", "-X", "POST", `http://127.0.0.1:${port()}/api/send`,
	"-H", "Content-Type: application/json",
	"-d", JSON.stringify({ to: `${NAME}@${sender.mailbox.project}`, subject: "user-mail-gamma", body: "from the operator" }),
], { encoding: "utf8" });
console.log("user send:", userSend.stdout.trim() || userSend.stderr.trim());

// 3. wait for the coalesced busy-phase message in the transcript
let coalesced = null;
for (let i = 0; i < 100; i++) {
	const entries = mailboxEntries(findSessionFile());
	coalesced = entries.find((l) => l.includes("agent-mail-alpha") && l.includes("agent-mail-beta") && l.includes("user-mail-gamma")) ?? null;
	if (coalesced) break;
	await sleep(1500);
}
if (!coalesced) {
	console.log("FAIL: busy phase did not coalesce into one message");
	process.exit(1);
}
const checks = [
	["user priority section", coalesced.includes("New mail from the user") && coalesced.includes("takes priority")],
	["agent mail section", coalesced.includes("agent-mail-alpha")],
	["boundary guidance", coalesced.includes("Finish your current task")],
];
for (const [name, ok] of checks) { console.log(`${ok ? "ok" : "FAIL"}: ${name}`); if (!ok) process.exit(1); }
console.log("busy-phase coalesced message:", coalesced.slice(0, 500));

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
	"-s", "-X", "POST", `http://127.0.0.1:${port()}/api/send`,
	"-H", "Content-Type: application/json",
	"-d", JSON.stringify({ to: `${NAME}@${sender.mailbox.project}`, subject: "user-mail-delta", body: "second operator mail" }),
], { encoding: "utf8" });

let idleEntry = null;
for (let i = 0; i < 60; i++) {
	const entries = mailboxEntries(findSessionFile());
	idleEntry = entries.find((l) => l.includes("user-mail-delta")) ?? null;
	if (idleEntry) break;
	await sleep(1500);
}
if (!idleEntry) { console.log("FAIL: idle-phase user mail never injected"); process.exit(1); }
console.log("idle-phase message:", idleEntry.slice(0, 400));
await sender.stop();
console.log("PASS: busy coalescing + user priority + idle direct injection all verified (named mailbox)");
