// Ad-hoc smoke test for pi-mailbox core (service, election, client, store).
// Run: node --experimental-strip-types --no-warnings smoke.mjs
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netCreateServer } from "node:net";
import { WebSocketServer } from "ws";
import { MailboxConnection } from "../src/client.ts";
import { MailboxService } from "../src/service.ts";
import { ensureService, readRegistry } from "../src/registry.ts";
import { tryOpenLock, Lock } from "@lickle/lock";

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
	let c = new MailboxConnection("local", projectDir, null, "sessionC", "agent-c", {
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

	// 4. meta: key/value, merge rules, persistence
	await c.mailbox.setMeta({ set: { name: "worker-c", tags: "worker,test" } });
	const sessions = await b.mailbox.sessions();
	const cInfo = sessions.find((s) => s.session === "sessionC");
	assert(
		cInfo?.name === "worker-c" && cInfo?.tags?.join(",") === "worker,test",
		"name and tags visible in sessions",
	);
	assert(cInfo?.meta?.name === "worker-c", "full meta map in sessions reply");
	await c.mailbox.setMeta({ unset: ["name"] });
	const cleared = (await b.mailbox.sessions()).find((s) => s.session === "sessionC");
	assert(cleared?.name === undefined && cleared?.tags?.length === 2, "name unset, tags kept");

	// 4b. hello-time meta merge rules
	const d = new MailboxConnection(
		"local",
		projectDir,
		null,
		"sessionD",
		"agent-d",
		{ onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {} },
		{ helloMeta: { name: "auto-d", _model: "prov/m1", role: "worker" } },
	);
	await d.start();
	assert(
		d.mailbox.sessionMeta?.name === "auto-d" && d.mailbox.sessionMeta?._model === "prov/m1",
		"welcome returns merged hello meta",
	);
	// user override, then reconnect with different hello defaults
	await d.mailbox.setMeta({ set: { name: "manual-d" } });
	await d.stop();
	const d2 = new MailboxConnection(
		"local",
		projectDir,
		null,
		"sessionD",
		"agent-d",
		{ onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {} },
		{ helloMeta: { name: "auto-d2", _model: "prov/m2", role: "boss" } },
	);
	await d2.start();
	const d2meta = d2.mailbox.sessionMeta ?? {};
	assert(d2meta.name === "manual-d", "user-set name survives reconnect (hello default does not clobber)");
	assert(d2meta._model === "prov/m2", "system key refreshes on every hello");
	assert(d2meta.role === "worker", "existing user key not overwritten by hello default");
	let sysErr = null;
	try {
		await d2.mailbox.setMeta({ set: { _evil: "x" } });
	} catch (e) {
		sysErr = e;
	}
	assert(sysErr && String(sysErr).includes("bad_meta"), "system key cannot be set via meta op");

	// 4c. meta robustness: null set, per-key hello filter, cap, local sync
	let nullSetErr = null;
	try {
		await d2.mailbox.setMeta({ set: null });
	} catch (e) {
		nullSetErr = e;
	}
	assert(nullSetErr && String(nullSetErr).includes("bad_meta"), "null set rejected as bad_meta (not internal/timeout)");
	await d2.mailbox.setMeta({ set: { task: "verifying" } });
	assert(d2.mailbox.sessionMeta?.task === "verifying", "sessionMeta updated locally after setMeta");
	await d2.stop();

	// hello meta: per-key filtering, Object.hasOwn, cap
	const e1 = new MailboxConnection(
		"local",
		projectDir,
		null,
		"sessionE",
		"agent-e",
		{ onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {} },
		{
			helloMeta: {
				good: "1",
				"bad key": "2",
				_model: "prov/me",
				constructor: "own-property",
			},
		},
	);
	await e1.start();
	const e1meta = e1.mailbox.sessionMeta ?? {};
	assert(e1meta.good === "1" && e1meta._model === "prov/me", "valid hello meta keys land (per-key filter)");
	assert(!("bad key" in e1meta), "invalid hello meta key skipped, not fatal");
	assert(e1meta.constructor === "own-property", "inherited Object.prototype members are not mistaken for existing values");
	await e1.stop();

	// legacy over-cap state converges: pre-seed 40 system keys on disk, hello
	// with the same 40 keys -> truncated to 8 (accepted set, not raw msg.meta)
	mkdirSync(join(projectDir, ".pi", "mailbox"), { recursive: true });
	{
		const legacy = { t: "meta", set: {} };
		for (let i = 0; i < 40; i++) legacy.set[`_p${i}`] = "v";
		writeFileSync(
			join(projectDir, ".pi", "mailbox", "sessionH.jsonl"),
			JSON.stringify(legacy) + "\n",
		);
	}
	const bigSame = {};
	for (let i = 0; i < 40; i++) bigSame[`_p${i}`] = "v";
	const e5 = new MailboxConnection(
		"local",
		projectDir,
		null,
		"sessionH",
		"agent-h",
		{ onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {} },
		{ helloMeta: bigSame },
	);
	await e5.start();
	const e5meta = e5.mailbox.sessionMeta ?? {};
	assert(
		Object.keys(e5meta).filter((k) => k.startsWith("_")).length === 8,
		"legacy over-cap system keys converge to 8 on hello with the same keyset",
	);
	await e5.stop();

	// hello meta cap: 40 system keys are truncated to META_MAX_SYSTEM_KEYS
	const bigSys = {};
	for (let i = 0; i < 40; i++) bigSys[`_k${i}`] = "v";
	const e3 = new MailboxConnection(
		"local",
		projectDir,
		null,
		"sessionG",
		"agent-g",
		{ onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {} },
		{ helloMeta: bigSys },
	);
	await e3.start();
	const e3meta = e3.mailbox.sessionMeta ?? {};
	assert(
		Object.keys(e3meta).filter((k) => k.startsWith("_")).length === 8,
		"system keys capped at META_MAX_SYSTEM_KEYS (first 8 win)",
	);
	// system keyset is authoritative: keys absent from a later hello are unset
	await e3.stop();
	const e4 = new MailboxConnection(
		"local",
		projectDir,
		null,
		"sessionG",
		"agent-g",
		{ onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {} },
		{ helloMeta: { _model: "prov/only" } },
	);
	await e4.start();
	const e4meta = e4.mailbox.sessionMeta ?? {};
	assert(
		e4meta._model === "prov/only" && !("_k0" in e4meta),
		"system keys absent from a later hello are unset (no accumulation)",
	);
	await e4.stop();

	// hello meta cap: a large user-key payload is dropped entirely (system keys kept)
	const big = { _model: "prov/big" };
	for (let i = 0; i < 40; i++) big[`k${i}`] = "v";
	const e2 = new MailboxConnection(
		"local",
		projectDir,
		null,
		"sessionF",
		"agent-f",
		{ onNotify: () => {}, onConnected: () => {}, onDisconnected: () => {} },
		{ helloMeta: big },
	);
	await e2.start();
	const e2meta = e2.mailbox.sessionMeta ?? {};
	assert(e2meta._model === "prov/big", "system key lands even when user keys hit the cap");
	assert(!("k0" in e2meta) && !("k39" in e2meta), "over-cap hello user keys are dropped");
	assert(Object.keys(e2meta).length <= 32, "merged meta respects META_MAX_KEYS");
	await e2.stop();

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

	// 5b. cursor continuation when the cursor mail leaves the filtered set:
	// unreadOnly pages, then the cursor mail gets marked read mid-pagination
	const u1 = await c.mailbox.inbox({ unreadOnly: true }, { limit: 1 });
	assert(u1.mails.length === 1 && u1.mails[0].subject === "mail-2" && u1.nextCursor, "unread page 1");
	await c.mailbox.read({ project: reg.projectId, session: "sessionC", mail: u1.mails[0].id });
	const u2 = await c.mailbox.inbox({ unreadOnly: true }, { limit: 10, cursor: u1.nextCursor });
	assert(
		u2.mails.map((m) => m.subject).join(",") === "mail-1,mail-0",
		"cursor skips at-or-newer positions even when the cursor mail left the set (no repeat, no restart)",
	);

	// 5c. refs validation: null elements and non-array refs
	let badRefsErr = null;
	try {
		// bypass client typing deliberately
		await c.mailbox.sendMail({ project: reg.projectId, session: "sessionB" }, "x", "y", [null]);
	} catch (e) {
		badRefsErr = e;
	}
	assert(badRefsErr && String(badRefsErr).includes("bad_send"), "null ref element rejected as bad_send");
	let nonArrayRefsErr = null;
	try {
		await c.mailbox.sendMail({ project: reg.projectId, session: "sessionB" }, "x", "y", "nope");
	} catch (e) {
		nonArrayRefsErr = e;
	}
	assert(nonArrayRefsErr && String(nonArrayRefsErr).includes("bad_send"), "non-array refs rejected as bad_send");

	// 5d. cursor position semantics (locks position-based continuation):
	// a cursor NEWER than every mail means all mails are strictly older —
	// they are returned (same as the cursor-mail-left-the-set case in 5b);
	// a cursor OLDER than every mail means everything is at-or-newer — empty page
	const futureCursor = Buffer.from(
		JSON.stringify({ createdAt: "2999-01-01T00:00:00.000Z", id: "ffffffff" }),
		"utf8",
	).toString("base64url");
	const beyondPage = await c.mailbox.inbox(undefined, { cursor: futureCursor });
	assert(
		beyondPage.mails.length > 0 && beyondPage.mails[0].subject === "mail-2",
		"cursor newer than all mails returns the strictly-older mails",
	);
	const pastCursor = Buffer.from(
		JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z", id: "00000000" }),
		"utf8",
	).toString("base64url");
	const exhaustedPage = await c.mailbox.inbox(undefined, { cursor: pastCursor });
	assert(
		exhaustedPage.mails.length === 0 && !exhaustedPage.nextCursor,
		"cursor older than all mails returns empty page with no cursor",
	);

	// 5e. offline delivery + offline client listing
	await c.stop();
	// C is offline but registered: send succeeds and lands as unread
	const offlineRef = await b.mailbox.sendMail(
		{ project: reg.projectId, session: "sessionC" },
		"offline mail",
		"while away",
		[],
	);
	assert(offlineRef.session === "sessionC", "send to offline registered session accepted");
	// offline listing: C shows as offline with identity preserved (_agent meta)
	const withOffline = await b.mailbox.sessions(true);
	const cOffline = withOffline.find((s) => s.session === "sessionC");
	assert(cOffline && cOffline.online === false, "offline session listed with online=false");
	assert(cOffline?.agent === "agent-c", "offline session agent preserved via _agent");
	assert(cOffline?.name === undefined, "name was unset earlier, stays unset");
	const onlineOnly = await b.mailbox.sessions();
	assert(!onlineOnly.some((s) => s.session === "sessionC"), "default listing omits offline sessions");
	// reconnect: unread backfill + the offline mail is there
	let backfill = 0;
	const c2 = new MailboxConnection("local", projectDir, null, "sessionC", "agent-c", {
		onNotify: (unread) => {
			backfill = unread;
		},
		onConnected: () => {},
		onDisconnected: () => {},
	});
	await c2.start();
	c = c2;
	const afterOffline = await c.mailbox.inbox(undefined, { limit: 100 });
	assert(afterOffline.mails.some((m) => m.subject === "offline mail"), "offline mail delivered on reconnect");
	assert(backfill > 0, `unread backfill notified on reconnect (unread=${backfill})`);

	// 6. offline target errors
	let err = null;
	try {
		await b.mailbox.sendMail({ project: reg.projectId, session: "sessionZZZ" }, "x", "y");
	} catch (e) {
		err = e;
	}
	assert(err && String(err).includes("no mailbox"), "send to never-registered session errors (no_mailbox)");

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
	assert(mails2.length === 5 && mails2[0].subject === "offline mail", "mails survive host handover (incl. offline delivery)");
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

	// 8. flock-based election: the leader lock is the lease
	const busy = netCreateServer(() => {});
	const busySockets = new Set();
	busy.on("connection", (s) => busySockets.add(s));
	await new Promise((r) => busy.listen(0, "127.0.0.1", r));
	const busyPort = busy.address().port;
	const projectDir2 = mkdtempSync(join(tmpdir(), "pi-mailbox-smoke2-"));
	mkdirSync(join(projectDir2, ".pi"), { recursive: true });

	// 8a. stale registry pointing at a busy foreign port does not wedge: the
	// flock is free, so we host on a fresh port and overwrite the registry
	writeFileSync(
		join(projectDir2, ".pi", "mailbox.json"),
		JSON.stringify({ projectId: "probe-test", service: { port: busyPort, instanceId: "busy-instance" } }),
	);
	const eBusy = await ensureService(projectDir2);
	assert(eBusy.hosted !== null && eBusy.port !== busyPort, "stale busy registry: flock free -> host on a fresh port");
	await eBusy.hosted.stop();

	// 8b. held leader lock: election defers to the holder until it releases
	const leaderGuard = await tryOpenLock(join(projectDir2, ".pi", "mailbox.leader"), Lock.Exclusive);
	assert(leaderGuard !== undefined, "test acquires the leader lock externally");
	let deferredErr = null;
	try {
		await ensureService(projectDir2);
	} catch (e) {
		deferredErr = e;
	}
	assert(
		deferredErr && String(deferredErr).includes("leader lock is held"),
		"held leader lock defers election instead of hosting a duplicate",
	);
	await leaderGuard.drop();
	const eAfter = await ensureService(projectDir2);
	assert(eAfter.hosted !== null, "released leader lock: election proceeds");
	await eAfter.hosted.stop();

	// 8c. graceful stop clears the registry while still holding the lock
	const regAfterStop = await readRegistry(projectDir2);
	assert(regAfterStop.service === null, "graceful leader stop clears the registry");

	// 8d. foreign responders on the registered port do not satisfy the probe,
	// but with a free flock election still proceeds
	const foreign1 = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	foreign1.on("connection", (ws) => ws.on("message", () => ws.send(JSON.stringify({ t: "hello" }))));
	await new Promise((r) => foreign1.once("listening", r));
	writeFileSync(
		join(projectDir2, ".pi", "mailbox.json"),
		JSON.stringify({ projectId: "probe-test", service: { port: foreign1.address().port, instanceId: "expected" } }),
	);
	const eForeign = await ensureService(projectDir2);
	assert(eForeign.hosted !== null, "non-pong responder: flock free -> election proceeds");
	await eForeign.hosted.stop();
	await new Promise((r) => foreign1.close(r));

	const foreign2 = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	foreign2.on("connection", (ws) => ws.on("message", () => ws.send(JSON.stringify({ t: "pong", instanceId: "other" }))));
	await new Promise((r) => foreign2.once("listening", r));
	writeFileSync(
		join(projectDir2, ".pi", "mailbox.json"),
		JSON.stringify({ projectId: "probe-test", service: { port: foreign2.address().port, instanceId: "expected" } }),
	);
	const eForeign2 = await ensureService(projectDir2);
	assert(eForeign2.hosted !== null, "instanceId-mismatched pong: flock free -> election proceeds");
	await eForeign2.hosted.stop();
	await new Promise((r) => foreign2.close(r));

	// dead port (nothing listening) with a free flock: election proceeds and hosts
	const tmpServer = netCreateServer(() => {});
	await new Promise((r) => tmpServer.listen(0, "127.0.0.1", r));
	const deadPort = tmpServer.address().port;
	await new Promise((r) => tmpServer.close(r));
	writeFileSync(
		join(projectDir2, ".pi", "mailbox.json"),
		JSON.stringify({ projectId: "probe-test", service: { port: deadPort, instanceId: "gone" } }),
	);
	const election2 = await ensureService(projectDir2);
	assert(election2.hosted !== null, "dead registered port with free flock: election proceeds");
	await election2.hosted.stop();
	for (const s of busySockets) s.destroy();
	await new Promise((r) => busy.close(r));
	rmSync(projectDir2, { recursive: true, force: true });

	// 8e. guard-leak regression: a failure after acquiring the flock must
	// release it (previously a leaked FileHandle kept the lock forever and
	// crashed the process at GC)
	const projectDir4 = mkdtempSync(join(tmpdir(), "pi-mailbox-smoke4-"));
	mkdirSync(join(projectDir4, ".pi"), { recursive: true });
	// a FILE where the store wants its directory -> service.start() throws EEXIST
	writeFileSync(join(projectDir4, ".pi", "mailbox"), "not a directory");
	let firstErr = null;
	try {
		await ensureService(projectDir4);
	} catch (e) {
		firstErr = e;
	}
	assert(firstErr && String(firstErr).includes("EEXIST"), "service start fails on EEXIST");
	let secondErr = null;
	try {
		await ensureService(projectDir4);
	} catch (e) {
		secondErr = e;
	}
	assert(
		secondErr && String(secondErr).includes("EEXIST"),
		"flock released after failure (second attempt retries hosting, not leader-lock-held)",
	);
	rmSync(join(projectDir4, ".pi", "mailbox"));
	const eRecovered = await ensureService(projectDir4);
	assert(eRecovered.hosted !== null, "recovered hosting after the blocker is removed");
	await eRecovered.hosted.stop();
	rmSync(projectDir4, { recursive: true, force: true });

	await b.stop();
	await c.stop();
	console.log("\nall smoke tests passed");
} finally {
	rmSync(projectDir, { recursive: true, force: true });
}
