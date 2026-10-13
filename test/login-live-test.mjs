// Manual live test for the named-mailbox identity model, against an
// ISOLATED daemon (see live-helpers.mjs). Phases:
//   0. a nameless mailbox_connect is rejected (named accounts only)
//   1. tool login with tags; binding persisted
//   2. mail round trip
//   3. named wake: the last holder's session is resumed and auto-logins
//   4. a failed login switch keeps the previous identity
//   5. a held binding cannot connect (no derived fallback): agent stops
//   6. wake fails when the session file is gone (no fresh spawn)
//   7. cleanup: named mailboxes deleted, tabs closed
//
// Requires: running herdr + go on PATH. Not CI.
// Run from the repo root: node --experimental-strip-types --no-warnings test/login-live-test.mjs
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MailboxConnection } from "../src/client.ts";
import { deriveSessionId } from "../src/daemon.ts";
import { wakeOfflineSession } from "../src/herdr.ts";
import { setupIsolatedDaemon, herdr, newProjectTab, sessionsDirFor ,
	sweepTestMailboxes,
} from "./live-helpers.mjs";

const projectDir = process.cwd();
const origin = `login-test-${Date.now().toString(36)}`;
const NAME = `nr-${Date.now().toString(36)}`;
const { apiDelete } = setupIsolatedDaemon("login");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessionsDir = sessionsDirFor(projectDir);
function findSessionFile() {
	try {
		for (const f of readdirSync(sessionsDir)) if (f.endsWith(`_${origin}.jsonl`)) return join(sessionsDir, f);
	} catch { /* not created yet */ }
	return null;
}
function transcriptTail(n = 14) {
	const file = findSessionFile();
	if (!file) return [];
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-n);
	} catch {
		return [];
	}
}
const derivedId = deriveSessionId("pi", origin);

let paneId = null;
let HELD = null;
let PROJECT_ID = null;
process.on("exit", () => {
	if (paneId) {
		try { spawnSync("herdr", ["pane", "close", paneId], { stdio: "ignore" }); } catch { /* best effort */ }
	}
	// named mailboxes are permanent: best-effort delete on every exit path
	if (!PROJECT_ID) return;
	for (const name of [NAME, HELD]) {
		if (name) apiDelete(`${name}@${PROJECT_ID}`);
	}
});

console.log(`test session: ${derivedId} (origin ${origin}), named mailbox: ${NAME}`);

// the sender connection also boots the isolated daemon (canSpawn), so the
// spawned agent's probe finds it running
const sender = new MailboxConnection("local", projectDir, null, `login-sender-${Date.now().toString(36)}`, "pi", {
	onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {},
}, { canSpawn: true });
await sender.start();
PROJECT_ID = sender.mailbox.project;
await sweepTestMailboxes(sender, apiDelete, PROJECT_ID);

// 0. spawn pi (new code); a nameless connect must be rejected
paneId = await newProjectTab(projectDir, "login-test");
console.log(`pane: ${paneId}`);
await herdr(
	["agent", "start", "login-test", "--kind", "pi", "--pane", paneId, "--timeout", "30000", "--", "-ne", "-e", join(projectDir, "src", "index.ts"), "--session-id", origin],
	40000,
);
await herdr(["agent", "prompt", paneId, "Use the mailbox_connect tool with NO parameters (this will fail). Then reply with exactly: attempted"]);
let sawNamelessRejection = false;
for (let i = 0; i < 60; i++) {
	const tail = transcriptTail(8).join("\n");
	if (tail.includes("no login for this session")) { sawNamelessRejection = true; break; }
	await sleep(1500);
}
if (!sawNamelessRejection) throw new Error("nameless mailbox_connect was not rejected");
console.log("phase 0 ok: nameless connect rejected");

// 1. tool login with tags
await herdr([
	"agent", "prompt", paneId,
	`Now log in to the named mailbox '${NAME}' with the mailbox_connect tool (as='${NAME}', tags='night,review'). Then read your new mail with mailbox_list and mailbox_read, and reply to each mail exactly as its body instructs.`,
]);
let info = null;
for (let i = 0; i < 100; i++) {
	const sessions = await sender.mailbox.sessions(true);
	info = sessions.find((s) => s.session === NAME) ?? null;
	if (info?.online) break;
	await sleep(1000);
}
if (!info?.online) throw new Error("named mailbox never came online");
const meta = info.meta ?? {};
if (meta.name !== NAME || meta.tags !== "night,review" || meta._named !== "1" || meta._origin !== origin) {
	throw new Error(`login meta wrong: ${JSON.stringify(meta)}`);
}
const binding = transcriptTail(40).find((l) => l.includes("pi-mailbox-login"));
if (!binding || !binding.includes(`"name":"${NAME}"`)) throw new Error("login binding not persisted");
console.log("phase 1 ok: login + binding");

// 2. mail round trip
await sender.mailbox.sendMail({ project: PROJECT_ID, session: NAME }, "login test", "Reply with exactly: mail-ok");
let reply = null;
for (let i = 0; i < 100; i++) {
	const { mails } = await sender.mailbox.inbox();
	reply = mails.find((m) => m.from.session === NAME && m.subject.startsWith("Re:")) ?? null;
	if (reply) break;
	await sleep(2000);
}
if (!reply) throw new Error("no reply from the named mailbox holder");
console.log(`phase 2 ok: holder replied ${JSON.stringify(reply.body)}`);

// 3. offline -> named wake: the woken session auto-logins via its binding
console.log("closing the holder's tab; waking via the named path");
spawnSync("herdr", ["pane", "close", paneId], { stdio: "ignore" });
paneId = null;
for (let i = 0; i < 60; i++) {
	const sessions = await sender.mailbox.sessions(true);
	if (sessions.some((s) => s.session === NAME && !s.online)) break;
	await sleep(1000);
}
await sender.mailbox.sendMail({ project: PROJECT_ID, session: NAME }, "wake again", "Reply with exactly: woke-ok");
const wake = await wakeOfflineSession({
	session: NAME, origin, projectRoot: projectDir, label: NAME, named: true, sessionDir: sessionsDir,
});
console.log("wake result:", JSON.stringify(wake));
if (!wake.ok) throw new Error("wake failed");
paneId = wake.paneId ?? null;
let relogged = false;
for (let i = 0; i < 60; i++) {
	const sessions = await sender.mailbox.sessions(true);
	if (sessions.some((s) => s.session === NAME && s.online)) { relogged = true; break; }
	await sleep(1000);
}
if (!relogged) throw new Error("woken agent did not claim the named mailbox");
let reply2 = null;
for (let i = 0; i < 150; i++) {
	const { mails } = await sender.mailbox.inbox();
	reply2 = mails.find((m) => m.from.session === NAME && m.body.includes("woke-ok")) ?? null;
	if (reply2) break;
	await sleep(2000);
}
if (!reply2) throw new Error("woken agent did not handle the mail");
console.log("phase 3 ok: wake -> auto-login -> woke-ok");

// 4. failed login switch keeps the previous identity
HELD = `held-${Date.now().toString(36)}`;
const holder2 = new MailboxConnection("local", projectDir, null, `held-holder-${Date.now().toString(36)}`, "pi", {
	onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {},
}, { login: { as: HELD } });
await holder2.start();
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
if (!stillReply || !stillReply.body.includes(NAME)) throw new Error(`failed switch lost the identity: ${stillReply?.body}`);
if (!(await sender.mailbox.sessions(true)).some((s) => s.session === NAME && s.online)) throw new Error("identity went offline after failed switch");
console.log(`phase 4 ok: failed switch preserved identity (${stillReply.body.trim()})`);

// 5. held binding: no derived fallback — the woken agent cannot connect and stops
console.log("closing the agent; taking over the name; waking through the held path");
spawnSync("herdr", ["pane", "close", paneId], { stdio: "ignore" });
paneId = null;
for (let i = 0; i < 60; i++) {
	const sessions = await sender.mailbox.sessions(true);
	if (sessions.some((s) => s.session === NAME && !s.online)) break;
	await sleep(1000);
}
await holder2.stop();
// the takeover is the two-step: a normal attempt is rejected (name_held),
// then the confirmed force takes the name
const takerOrigin = `name-taker-${Date.now().toString(36)}`;
const takerTry = new MailboxConnection("local", projectDir, null, takerOrigin, "pi", {
	onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {},
}, { login: { as: NAME } });
let heldErr = null;
try {
	await takerTry.start();
} catch (err) {
	heldErr = err;
}
if (!heldErr || !String(heldErr).includes("name_held")) {
	throw new Error(`expected name_held on the normal takeover attempt, got: ${heldErr}`);
}
await takerTry.stop();
console.log("phase 5: normal takeover attempt rejected with name_held");
const taker = new MailboxConnection("local", projectDir, null, takerOrigin, "pi", {
	onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {},
}, { login: { as: NAME, force: true } });
await taker.start();
console.log("phase 5: forced takeover succeeded");
const wake2 = await wakeOfflineSession({
	session: NAME, origin, projectRoot: projectDir, label: NAME, named: true, sessionDir: sessionsDir,
});
console.log("held-name wake result:", JSON.stringify(wake2));
if (!wake2.ok) throw new Error("held-name wake failed (spawn level)");
paneId = wake2.paneId ?? null;
// the agent's auto-login is rejected; with no derived fallback it must never
// register anything — NAME stays held by the taker, no reply arrives
let heldNote = null;
for (let i = 0; i < 90; i++) {
	const { mails } = await sender.mailbox.inbox();
	heldNote = mails.find((m) => m.from.session === derivedId) ?? null;
	if (heldNote) break;
	await sleep(2000);
}
if (heldNote) throw new Error("no derived fallback expected: the agent must not be able to send");
const heldSessions = await sender.mailbox.sessions(true);
if (!heldSessions.some((s) => s.session === NAME && s.online)) throw new Error("taker must still hold the name");
const tail = transcriptTail(10).join("\n");
if (!tail.includes("mailbox_in_use")) throw new Error("agent transcript should show the rejected login");
console.log("phase 5 ok: held binding rejected, no fallback, agent stopped");
// the agent must not be able to force-retake while the taker is ONLINE.
// Its forced attempt is refused client-side (force gate) or daemon-side
// (mailbox_in_use) — asserted via the transcript, since the agent has no
// mailbox connection to reply with.
await herdr([
	"agent", "prompt", paneId,
	`Use the mailbox_connect tool with as='${NAME}' and force=true. It must be REJECTED — that is expected. Do not retry.`,
]);
let forceRefused = false;
for (let i = 0; i < 60; i++) {
	const tail = transcriptTail(12).join("\n");
	if (tail.includes("force-refused") || tail.includes("force_not_allowed") || tail.includes("mailbox_in_use")) {
		forceRefused = tail.includes("force_not_allowed") || tail.includes("mailbox_in_use");
		break;
	}
	await sleep(1500);
}
if (!forceRefused) throw new Error("agent's forced attempt was not refused");
if (!(await sender.mailbox.sessions(true)).some((s) => s.session === NAME && s.online)) {
	throw new Error("taker must still hold the name after the refused force");
}
console.log("phase 5 ok: online holder cannot be displaced by force");
await taker.stop();
// close the phase-5 agent's pane: otherwise the live-agent branch could
// match it and prompt it in place, making the dead-session phase flaky
spawnSync("herdr", ["pane", "close", paneId], { stdio: "ignore" });
paneId = null;
await sleep(2000);

// 6. wake fails when the session file is gone (no fresh spawn)
const file = findSessionFile();
if (!file) throw new Error("session file expected before deletion");
unlinkSync(file);
await sender.mailbox.sendMail({ project: PROJECT_ID, session: NAME }, "wake the dead", "should not be delivered by wake");
const wake3 = await wakeOfflineSession({
	session: NAME, origin, projectRoot: projectDir, label: NAME, named: true, sessionDir: sessionsDir,
});
console.log("dead-session wake result:", JSON.stringify(wake3));
if (wake3.ok || !String(wake3.reason).includes("session file is gone")) {
	throw new Error(`wake must fail for a deleted session, got: ${JSON.stringify(wake3)}`);
}
console.log("phase 6 ok: dead session -> wake fails cleanly");

// 7. cleanup (exit handler deletes NAME/HELD)
spawnSync("herdr", ["pane", "close", paneId], { stdio: "ignore" });
paneId = null;
for (let i = 0; i < 30; i++) {
	const sessions = await sender.mailbox.sessions(true);
	if (!sessions.some((s) => s.session === NAME && s.online)) break;
	await sleep(1000);
}
await sender.stop();
console.log("PASS: nameless rejection + login/binding + wake/auto-login + identity-preserving switch + held-binding rejection + dead-session wake failure");
