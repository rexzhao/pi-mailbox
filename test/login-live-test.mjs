// Manual live test for the named-mailbox login feature (new daemon +
// extension code). Spawns a fresh pi agent (new code) in a herdr tab, has it
// log in via the mailbox_connect tool, verifies the binding and named
// mailbox, then takes it offline and wakes it through the named path —
// pointing the woken pi at the working-tree extension via
// PI_MAILBOX_TEST_PI_ARGS so the claim-after-wake is really exercised —
// and finally deletes the named mailbox (named mailboxes are permanent
// accounts; the test must not leak one per run).
//
// Requires: running herdr + local mailboxd (new binary). Not CI.
// Run from the repo root: node --experimental-strip-types --no-warnings test/login-live-test.mjs
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MailboxConnection } from "../src/client.ts";
import { deriveSessionId } from "../src/daemon.ts";
import { wakeOfflineSession } from "../src/herdr.ts";

const projectDir = process.cwd();
const origin = `login-test-${Date.now().toString(36)}`;
const shortSession = deriveSessionId("pi", origin);
// unique per run: prior runs' leftover mails must not pollute this one
const NAME = `nr-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// point woken pi sessions at the working-tree extension (test-only hook)
process.env.PI_MAILBOX_TEST_PI_ARGS = `-ne -e ${join(projectDir, "src", "index.ts")}`;

const registry = JSON.parse(readFileSync(join(homedir(), ".pi", "mailboxd.json"), "utf8"));
const PORT = registry.port;

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

const sessionsDir = join(homedir(), ".pi", "agent", "sessions", `--${projectDir.replace(/[:\\/]/g, "-")}--`);
function findSessionFile() {
	try {
		for (const f of readdirSync(sessionsDir)) if (f.endsWith(`_${origin}.jsonl`)) return join(sessionsDir, f);
	} catch { /* not created yet */ }
	return null;
}

let paneId = null;
let HELD = null;
let PROJECT_ID = null;
process.on("exit", () => {
	if (paneId) {
		try { spawnSync("herdr", ["pane", "close", paneId], { stdio: "ignore" }); } catch { /* best effort */ }
	}
	// named mailboxes are permanent: best-effort delete on every exit path
	// (refused while a holder is online or already deleted — both fine)
	if (!PROJECT_ID) return;
	for (const name of [NAME, HELD]) {
		if (!name) continue;
		try {
			spawnSync("curl", [
				"-s", "-X", "POST", `http://127.0.0.1:${PORT}/api/delete`,
				"-H", "Content-Type: application/json",
				"-d", JSON.stringify({ address: `${name}@${PROJECT_ID}` }),
			], { stdio: "ignore" });
		} catch { /* best effort */ }
	}
});

console.log(`test session: ${shortSession} (origin ${origin}), mailbox name: ${NAME}`);

// 1. fresh tab + start pi (new extension code) with the login task
const panes = (await herdr(["pane", "list"])).panes;
const ws = panes.find((p) => p.cwd && p.cwd.replace(/\\/g, "/").toLowerCase() === projectDir.replace(/\\/g, "/").toLowerCase());
if (!ws) throw new Error("no herdr workspace for this project");
const tab = await herdr(["tab", "create", "--workspace", ws.workspace_id, "--label", "login-test"]);
paneId = tab.root_pane.pane_id;
console.log(`pane: ${paneId}`);
await herdr(
	["agent", "start", "login-test", "--kind", "pi", "--pane", paneId, "--timeout", "30000", "--", "-ne", "-e", join(projectDir, "src", "index.ts"), "--session-id", origin],
	40000,
);
await herdr([
	"agent", "prompt", paneId,
	`Use the mailbox_connect tool with as='${NAME}' and tags='night,review' to log in to that named mailbox. Then read your new mail with mailbox_list and mailbox_read, and reply to each mail exactly as its body instructs.`,
]);

// 2. poll until the named mailbox is online
const sender = new MailboxConnection("local", projectDir, null, `login-sender-${Date.now().toString(36)}`, "pi", {
	onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {},
}, { canSpawn: true });
await sender.start();
PROJECT_ID = sender.mailbox.project;
let info = null;
for (let i = 0; i < 100; i++) {
	const sessions = await sender.mailbox.sessions(true);
	info = sessions.find((s) => s.session === NAME) ?? null;
	if (info?.online) break;
	await sleep(1000);
}
if (!info?.online) throw new Error("named mailbox never came online");
console.log("named mailbox online:", JSON.stringify(info));
const meta = info.meta ?? {};
if (meta.name !== NAME || meta.tags !== "night,review" || meta._named !== "1") throw new Error(`login meta wrong: ${JSON.stringify(meta)}`);
if (meta._origin !== origin) throw new Error(`_origin should be the spawning session: ${meta._origin}`);

// 3. binding persisted in the pi session file
const file = findSessionFile();
if (!file) throw new Error("session file not found");
const binding = readFileSync(file, "utf8").split("\n").filter((l) => l.includes("pi-mailbox-login")).pop();
if (!binding || !binding.includes(`"name":"${NAME}"`)) throw new Error(`login binding not persisted: ${binding ?? "(none)"}`);
console.log("binding persisted:", binding.slice(0, 160));

// 4. send mail to the named mailbox, wait for the reply
await sender.mailbox.sendMail({ project: sender.mailbox.project, session: NAME }, "login test", "Reply with exactly: mail-ok");
let reply = null;
for (let i = 0; i < 100; i++) {
	const { mails } = await sender.mailbox.inbox();
	reply = mails.find((m) => m.from.session === NAME && m.subject.startsWith("Re:")) ?? null;
	if (reply) break;
	await sleep(2000);
}
if (!reply) throw new Error("no reply from the named mailbox holder");
console.log(`holder replied: ${JSON.stringify(reply.body)}`);

// 5. take the holder offline, send mail, and wake through the named path.
// The woken pi runs the working-tree extension (PI_MAILBOX_TEST_PI_ARGS):
// its persisted binding must auto-login it to the named mailbox.
console.log("closing the holder's tab; waiting for offline...");
spawnSync("herdr", ["pane", "close", paneId], { stdio: "ignore" });
paneId = null;
let offline = false;
for (let i = 0; i < 60; i++) {
	const sessions = await sender.mailbox.sessions(true);
	if (sessions.some((s) => s.session === NAME && !s.online)) { offline = true; break; }
	await sleep(1000);
}
if (!offline) throw new Error("named mailbox never went offline");
console.log("offline; sending mail + waking via the named path");
await sender.mailbox.sendMail({ project: sender.mailbox.project, session: NAME }, "wake again", "Reply with exactly: woke-ok");
const namedInfo = (await sender.mailbox.sessions(true)).find((s) => s.session === NAME);
const wake = await wakeOfflineSession({
	session: NAME,
	origin: namedInfo.meta._origin,
	projectRoot: projectDir,
	label: NAME,
	named: true,
	sender: sender.address,
});
console.log("wake result:", JSON.stringify(wake));
if (!wake.ok) throw new Error("wake failed");
paneId = wake.paneId ?? null;
// the woken session must come online AS THE NAMED MAILBOX (auto-login via
// its binding — the real claim-after-wake, not a simulation)
let relogged = false;
for (let i = 0; i < 60; i++) {
	const sessions = await sender.mailbox.sessions(true);
	if (sessions.some((s) => s.session === NAME && s.online)) { relogged = true; break; }
	await sleep(1000);
}
if (!relogged) throw new Error("woken agent did not claim the named mailbox");
console.log("woken agent claimed the named mailbox (auto-login via binding)");
let reply2 = null;
for (let i = 0; i < 150; i++) {
	const { mails } = await sender.mailbox.inbox();
	reply2 = mails.find((m) => m.from.session === NAME && m.body.includes("woke-ok")) ?? null;
	if (reply2) break;
	await sleep(2000);
}
if (!reply2) throw new Error("woken agent did not handle the mail");
console.log("woken agent replied: woke-ok");

// 5b. a FAILED login switch must keep the previous identity: while the
// woken agent holds NAME, another name is held by the test client; the
// agent's explicit login to it is rejected and it must stay on NAME
HELD = `held-${Date.now().toString(36)}`;
const holder2 = new MailboxConnection("local", projectDir, null, `held-holder-${Date.now().toString(36)}`, "pi", {
	onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {},
}, { login: { as: HELD } });
await holder2.start();
console.log(`second named mailbox '${HELD}' held by the test client`);
await herdr([
	"agent", "prompt", paneId,
	`Use the mailbox_connect tool with as='${HELD}'. The login will be REJECTED (mailbox_in_use) — that is expected. After the rejection, use the mailbox_send tool to send a mail to ${sender.address} whose body is exactly one line: still-<your current mailbox address>`,
]);
let stillReply = null;
for (let i = 0; i < 100; i++) {
	const { mails } = await sender.mailbox.inbox();
	stillReply = mails.find((m) => m.from.session === NAME && m.body.includes("still-")) ?? null;
	if (stillReply) break;
	await sleep(2000);
}
if (!stillReply) throw new Error("agent did not report its identity after the failed switch");
if (!stillReply.body.includes(NAME)) throw new Error(`agent lost its identity after the failed switch: ${stillReply.body}`);
const stillOnline = (await sender.mailbox.sessions(true)).some((s) => s.session === NAME && s.online);
if (!stillOnline) throw new Error("named mailbox went offline after the failed switch");
console.log(`failed switch preserved the identity: ${stillReply.body.trim()}`);

// 5c. a HELD stored binding must fall back to the derived identity and the
// wake prompt's fallback instruction must be actionable: take the agent
// offline, let the test client take over NAME, wake the agent again — its
// auto-login is rejected, it falls back to its derived id, and sends the
// "mailbox is held" note to the sender as the prompt instructs
console.log("closing the agent; taking over the name; waking again through the held path");
spawnSync("herdr", ["pane", "close", paneId], { stdio: "ignore" });
paneId = null;
for (let i = 0; i < 60; i++) {
	const sessions = await sender.mailbox.sessions(true);
	if (sessions.some((s) => s.session === NAME && !s.online)) break;
	await sleep(1000);
}
await holder2.stop();
const taker = new MailboxConnection("local", projectDir, null, `name-taker-${Date.now().toString(36)}`, "pi", {
	onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {},
}, { login: { as: NAME } });
await taker.start(); // holds NAME now
const wake2 = await wakeOfflineSession({
	session: NAME,
	origin,
	projectRoot: projectDir,
	label: NAME,
	named: true,
	sender: sender.address,
});
console.log("held-name wake result:", JSON.stringify(wake2));
if (!wake2.ok) throw new Error("held-name wake failed");
paneId = wake2.paneId ?? null;
// the woken agent falls back to its derived id (binding held) and sends the
// note; its derived mailbox id is derivable from the origin
const derivedId = shortSession;
let heldNote = null;
for (let i = 0; i < 150; i++) {
	const { mails } = await sender.mailbox.inbox();
	heldNote = mails.find((m) => m.from.session === derivedId && /held/i.test(m.body)) ?? null;
	if (heldNote) break;
	await sleep(2000);
}
if (!heldNote) throw new Error("woken agent did not send the held-note from its derived identity");
console.log(`woken agent fell back and notified: ${JSON.stringify(heldNote.body.slice(0, 120))}`);
await taker.stop();
await holder2.stop();

// 6. cleanup: named mailboxes are permanent accounts — delete them
// (holders must be offline)
spawnSync("herdr", ["pane", "close", paneId], { stdio: "ignore" });
paneId = null;
for (let i = 0; i < 30; i++) {
	const sessions = await sender.mailbox.sessions(true);
	const nameOnline = sessions.some((s) => s.session === NAME && s.online);
	const heldOnline = sessions.some((s) => s.session === HELD && s.online);
	if (!nameOnline && !heldOnline) break;
	await sleep(1000);
}
for (const name of [NAME, HELD]) {
	const del = spawnSync("curl", [
		"-s", "-X", "POST", `http://127.0.0.1:${PORT}/api/delete`,
		"-H", "Content-Type: application/json",
		"-d", JSON.stringify({ address: `${name}@${sender.mailbox.project}` }),
	], { encoding: "utf8" });
	console.log(`delete ${name}:`, (del.stdout || del.stderr || "").trim().slice(0, 120));
}
await sender.stop();
console.log("PASS: tool login + binding + named wake (real claim) + identity-preserving switch failure + held-binding fallback + cleanup all verified");
