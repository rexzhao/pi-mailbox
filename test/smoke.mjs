// Ad-hoc smoke test for pi-mailbox core (service, election, client, store).
// Run: node --experimental-strip-types --no-warnings smoke.mjs
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxConnection } from "../src/client.ts";
import { MailboxService } from "../src/service.ts";
import { ensureService, readRegistry } from "../src/registry.ts";

const projectDir = mkdtempSync(join(tmpdir(), "pi-mailbox-smoke-"));
const assert = (cond, msg) => {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	console.log(`ok: ${msg}`);
};

try {
	// 0. prepare a sessions dir and an orphan mailbox file for the GC test
	const sessionsDir = join(projectDir, "fake-sessions");
	mkdirSync(sessionsDir);
	writeFileSync(join(sessionsDir, "2026-01-01_12-00-00_sessionC.jsonl"), "{}\n");
	mkdirSync(join(projectDir, ".pi", "mailbox"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "mailbox", "sessionOLD.jsonl"), '{"t":"send","mail":{"id":"x"}}\n');

	// 1. election: first connector hosts (sessionsDir enables GC; delayed + grace 0 for tests)
	const a = new MailboxConnection(
		"local",
		projectDir,
		null,
		"sessionA",
		"agent-a",
		{
			onNotify: () => {},
			onConnected: () => {},
			onDisconnected: () => {},
		},
		{ sessionsDir, gcDelayMs: 50, gcGraceMs: 0 },
	);
	await a.start();
	assert(a.connected, "A connected");
	assert(a.isHost, "A hosts the service");
	// GC runs after gcDelayMs; wait for it
	await new Promise((r) => setTimeout(r, 400));
	assert(
		!existsSync(join(projectDir, ".pi", "mailbox", "sessionOLD.jsonl")),
		"GC moved orphan mailbox file",
	);
	const trashDir = join(projectDir, ".pi", "mailbox", ".trash");
	assert(
		existsSync(trashDir) && readdirSync(trashDir).some((f) => f.endsWith("sessionOLD.jsonl")),
		"orphan landed in .trash",
	);

	const reg = await readRegistry(projectDir);
	assert(typeof reg.projectId === "string" && reg.service !== null, "registry written");

	// 2. second connector is a client of the same service
	const b = new MailboxConnection("local", projectDir, null, "sessionB", "agent-b", {
		onNotify: () => {},
		onConnected: () => {},
		onDisconnected: () => {},
	});
	await b.start();
	assert(b.connected && !b.isHost, "B connects as client");
	assert((await b.mailbox.sessions()).length === 2, "two sessions online");

	// 3. send + notify + read
	let notified = 0;
	const c = new MailboxConnection("local", projectDir, null, "sessionC", "agent-c", {
		onNotify: (unread) => {
			notified = unread;
		},
		onConnected: () => {},
		onDisconnected: () => {},
	});
	await c.start();

	const ref = await b.mailbox.sendMail(
		{ project: reg.projectId, session: "sessionC" },
		"hello",
		"world",
		[],
	);
	assert(ref.mail && ref.session === "sessionC", "send returns triple");
	await new Promise((r) => setTimeout(r, 100));
	assert(notified === 1, `notify pushed (unread=${notified})`);

	let { mails } = await c.mailbox.inbox({ unreadOnly: true });
	assert(mails.length === 1 && mails[0].subject === "hello", "inbox filter works");
	const read = await c.mailbox.read({ project: reg.projectId, session: "sessionC", mail: ref.mail });
	assert(read?.readAt !== null, "own read marks readAt");
	({ mails } = await c.mailbox.inbox({ unreadOnly: true }));
	assert(mails.length === 0, "read mail no longer unread");

	// B can read its own sent mail by triple
	const sent = await b.mailbox.read({ project: reg.projectId, session: "sessionC", mail: ref.mail });
	assert(sent?.body === "world", "sender can read sent mail by triple");

	// 4. name/tag metadata
	await c.mailbox.setMeta({ name: "worker-c", tags: ["worker", "test"] });
	const sessions = await b.mailbox.sessions();
	const cInfo = sessions.find((s) => s.session === "sessionC");
	assert(cInfo?.name === "worker-c" && cInfo?.tags?.join(",") === "worker,test", "name and tags visible in sessions");
	await c.mailbox.setMeta({ name: null });
	const cleared = (await b.mailbox.sessions()).find((s) => s.session === "sessionC");
	assert(cleared?.name === undefined && cleared?.tags?.length === 2, "name cleared, tags kept");

	// 5. pagination
	for (let i = 0; i < 3; i++) {
		await b.mailbox.sendMail({ project: reg.projectId, session: "sessionC" }, `mail-${i}`, "body", []);
	}
	const page1 = await c.mailbox.inbox(undefined, { limit: 2 });
	assert(page1.mails.length === 2 && page1.nextCursor, "page 1 limited with cursor");
	const page2 = await c.mailbox.inbox(undefined, { limit: 2, cursor: page1.nextCursor });
	assert(page2.mails.length === 2 && !page2.nextCursor, "page 2 is last (no cursor when exhausted)");
	const subjects = [...page1.mails, ...page2.mails].map((m) => m.subject);
	assert(
		JSON.stringify(subjects) === JSON.stringify(["mail-2", "mail-1", "mail-0", "hello"]),
		"pagination returns newest first, all mails once",
	);
	let badCursorErr = null;
	try {
		await c.mailbox.inbox(undefined, { cursor: "not-a-cursor" });
	} catch (e) {
		badCursorErr = e;
	}
	assert(badCursorErr && String(badCursorErr).includes("bad_cursor"), "invalid cursor errors");

	// 6. offline target errors
	let err = null;
	try {
		await b.mailbox.sendMail({ project: reg.projectId, session: "sessionZZZ" }, "x", "y");
	} catch (e) {
		err = e;
	}
	assert(err && String(err).includes("offline"), "send to offline session errors");

	// 7. persistence: stop host, re-elect, data survives
	await a.stop();
	assert(!a.connected, "A stopped");
	// wait for B and C to re-elect and reconnect
	const deadline = Date.now() + 10_000;
	while (!(b.connected && c.connected) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
	}
	assert(b.connected, "B reconnected after host exit");
	assert(c.connected, "C reconnected after host exit");
	const mails2 = (await c.mailbox.inbox(undefined, { limit: 100 })).mails;
	assert(mails2.length === 4 && mails2[3].readAt !== null, "mail survives host handover");
	const metaAfter = (await c.mailbox.sessions()).find((s) => s.session === "sessionC");
	assert(metaAfter?.tags?.length === 2, "tags survive host handover");

	// registry still points at a live service
	const reg2 = await readRegistry(projectDir);
	assert(reg2.service !== null, "registry still has service entry");

	// raw jsonl includes meta event
	const rawAll = readFileSync(join(projectDir, ".pi", "mailbox", "sessionC.jsonl"), "utf8");
	assert(rawAll.includes('"meta"'), "jsonl has meta event");

	// jsonl exists and is non-empty
	const raw = readFileSync(join(projectDir, ".pi", "mailbox", "sessionC.jsonl"), "utf8");
	assert(rawAll.includes(String.raw`"send"`) && rawAll.includes(String.raw`"read"`), "jsonl has send+read events");

	await b.stop();
	await c.stop();
	console.log("\nall smoke tests passed");
} finally {
	rmSync(projectDir, { recursive: true, force: true });
}
