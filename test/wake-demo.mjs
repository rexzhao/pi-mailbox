// Manual end-to-end demo of the herdr wake feature, against the REAL local
// daemon and the running herdr server (not isolated, not CI).
//
// Flow: register a target session (with _host meta) and take it offline,
// send it a mail from a sender session, run the wake, and wait for the
// woken agent to connect and reply.
//
// Run from the repo root: node --experimental-strip-types --no-warnings test/wake-demo.mjs
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { MailboxConnection } from "../src/client.ts";
import { deriveSessionId } from "../src/daemon.ts";
import { wakeOfflineSession } from "../src/herdr.ts";

const projectDir = process.cwd();
const origin = `wake-demo-${Date.now().toString(36)}`;
const targetShort = deriveSessionId("pi", origin);
const senderOrigin = `wake-sender-${Date.now().toString(36)}`;
const senderShort = deriveSessionId("pi", senderOrigin);

const events = () => ({
	onNotify: (n) => console.log(`  notify: unread=${n}`),
	onConnected: () => {},
	onDisconnected: () => {},
});

console.log(`target:  ${targetShort} (origin ${origin})`);
console.log(`sender:  ${senderShort}`);

// 1. target registers (with _host, like a real local-mode session), then goes offline
const target = new MailboxConnection("local", projectDir, null, origin, "pi", events(), {
	helloMeta: { _host: hostname(), name: "wake-demo-target" },
	canSpawn: true,
});
await target.start();
console.log("target registered; going offline");
await target.stop();

// 2. sender sends mail to the offline target
const sender = new MailboxConnection("local", projectDir, null, senderOrigin, "pi", events(), { canSpawn: true });
await sender.start();
const ref = await sender.mailbox.sendMail(
	{ project: sender.mailbox.project, session: targetShort },
	"wake demo",
	"This is a wake test. Use mailbox_connect, read this mail, and reply with a single line: wake-ok",
);
console.log("sent:", JSON.stringify(ref));

// 3. wake (same checks as maybeWake in the extension)
const sessions = await sender.mailbox.sessions(true);
const info = sessions.find((s) => s.session === targetShort);
console.log("target session info:", JSON.stringify(info));
if (!info) throw new Error("target mailbox not found");
if (info.online) throw new Error("target unexpectedly online");
if ((info.meta ?? {})._host !== hostname()) throw new Error("_host mismatch: wake would be skipped");
if (!(info.meta ?? {})._origin) throw new Error("_origin missing");
const result = await wakeOfflineSession({
	session: targetShort,
	origin: info.meta._origin,
	projectRoot: projectDir,
	label: info.name,
});
console.log("wake result:", JSON.stringify(result));
if (!result.ok) process.exit(1);
// teardown on ANY exit path: close the woken agent's tab
const testPaneId = result.paneId ?? null;
process.on("exit", () => {
	if (!testPaneId) return;
	const r = spawnSync("herdr", ["pane", "close", testPaneId], { encoding: "utf8" });
	console.log(
		r.status === 0
			? "test tab closed"
			: `(tab close failed: ${(r.stderr || r.stdout || "").trim()} — close pane ${testPaneId} manually)`,
	);
});
// 4. wait for the woken agent to connect and reply
console.log("waiting for the woken agent to reply (up to 3 min)...");
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
	const { mails } = await sender.mailbox.inbox();
	const reply = mails.find((m) => m.from.session === targetShort);
	if (reply) {
		console.log("REPLY RECEIVED:");
		console.log(JSON.stringify(reply, null, 2));
		await sender.stop();
		process.exit(0); // tab teardown happens in the exit handler
	}
	await new Promise((r) => setTimeout(r, 3_000));
}
console.log("FAIL: no reply within 3 minutes");
await sender.stop();
process.exit(1);
