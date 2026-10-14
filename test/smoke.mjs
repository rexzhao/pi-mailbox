// Protocol conformance smoke test for the TS client against a real mailboxd.
//
// Requires the daemon binary: builds it with `go build` when Go is on PATH,
// otherwise expects mailboxd/mailboxd[.exe] to exist. The daemon runs with
// PI_MAILBOXD_DIR pointed at a temp dir (own registry/lock) for isolation.
//
// Run: node --experimental-strip-types --no-warnings test/smoke.mjs
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MailboxConnection } from "../src/client.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

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

const home = mkdtempSync(join(tmpdir(), "pi-mailboxd-home-"));
process.env.PI_MAILBOXD_DIR = home;
process.env.PI_MAILBOXD = daemonBin;

const projectDir = mkdtempSync(join(tmpdir(), "pi-mailbox-project-"));
mkdirSync(join(projectDir, ".pi"), { recursive: true });

const assert = (cond, msg) => {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	console.log(`ok: ${msg}`);
};

function events(log) {
	return {
		onNotify: (unread) => log.notify.push(unread),
		onConnected: () => log.connected++,
		onDisconnected: () => log.disconnected++,
	};
}

try {
	// 1. first connection spawns the daemon and registers the project
	const logA = { notify: [], connected: 0, disconnected: 0 };
	const { deriveSessionId } = await import("../src/daemon.ts");
	const shortA = deriveSessionId("agent-a", "sessA");
	const shortB = deriveSessionId("agent-b", "sessB");
	const shortC = deriveSessionId("agent-c", "sessC");
	const a = new MailboxConnection("local", projectDir, null, "sessA", "agent-a", events(logA), {
		helloMeta: { _model: "prov/m1", role: "worker" },
		canSpawn: true,
	});
	await a.start();
	assert(a.connected, "A connected (daemon spawned via resolveLocalDaemon)");
	assert(a.mailbox.project !== null && a.mailbox.project.length > 0, "project UUID assigned");
	const welcomeMeta = a.mailbox.sessionMeta ?? {};
	assert(welcomeMeta._agent === "agent-a" && welcomeMeta._model === "prov/m1", "welcome meta merged");
	assert(welcomeMeta.role === "worker", "user meta key applied");

	// 2. second session joins the same project
	const logB = { notify: [], connected: 0, disconnected: 0 };
	const b = new MailboxConnection("local", projectDir, null, "sessB", "agent-b", events(logB));
	await b.start();
	assert(b.connected, "B connected");
	assert(b.mailbox.project === a.mailbox.project, "both sessions share the project UUID");

	// 3. sessions listing
	const sessions = await a.mailbox.sessions();
	assert(sessions.length === 2 && sessions.every((s) => s.online), "two online sessions");

	// 4. send + notify + inbox totals + read
	const logC = { notify: [], connected: 0, disconnected: 0 };
	const c = new MailboxConnection("local", projectDir, null, "sessC", "agent-c", events(logC));
	await c.start();
	const ref = await b.mailbox.sendMail(
		{ project: a.mailbox.project, session: shortC },
		"hello",
		"world",
		[],
	);
	assert(ref.session === shortC, "send returns the target short id");
	await new Promise((r) => setTimeout(r, 200));
	assert(logC.notify.includes(1), "notify pushed to recipient");

	const inb = await c.mailbox.inbox();
	assert(inb.total === 1 && inb.totalUnread === 1, "inbox totals");
	assert(inb.mails[0].subject === "hello", "mail content");
	const mailID = inb.mails[0].id;

	const read = await c.mailbox.read({ project: a.mailbox.project, session: shortC, mail: mailID });
	assert(read?.readAt !== null && read?.readAt !== undefined, "own read marks readAt");
	const inb2 = await c.mailbox.inbox({ unreadOnly: true });
	assert(inb2.mails.length === 0, "read mail no longer unread");

	// sender can re-read by triple
	const again = await b.mailbox.read({ project: a.mailbox.project, session: shortC, mail: mailID });
	assert(again?.body === "world", "sender can read by triple");

	// 5. meta ops: set/unset, system keys rejected, tags
	await c.mailbox.setMeta({ set: { name: "worker-c", tags: "x,y" } });
	let list = await a.mailbox.sessions();
	let cInfo = list.find((s) => s.session === shortC);
	assert(cInfo?.name === "worker-c" && cInfo?.tags?.join(",") === "x,y", "name/tags visible in sessions");
	let sysErr = null;
	try {
		await c.mailbox.setMeta({ set: { _evil: "1" } });
	} catch (e) {
		sysErr = e;
	}
	assert(sysErr && String(sysErr).includes("bad_meta"), "system key rejected via meta op");
	await c.mailbox.setMeta({ unset: ["name"] });
	list = await a.mailbox.sessions();
	cInfo = list.find((s) => s.session === shortC);
	assert(cInfo?.name === undefined && cInfo?.tags?.length === 2, "name unset, tags kept");
	assert(c.mailbox.sessionMeta?.name === undefined, "sessionMeta kept in sync after unset");

	// 6. offline delivery + offline listing + reconnect backfill
	await c.stop();
	const offlineRef = await b.mailbox.sendMail(
		{ project: a.mailbox.project, session: shortC },
		"offline mail",
		"while away",
		[],
	);
	assert(offlineRef.session === shortC, "send to offline registered session accepted");
	const withOffline = await a.mailbox.sessions(true);
	const cOffline = withOffline.find((s) => s.session === shortC);
	assert(cOffline && cOffline.online === false, "offline session listed with online=false");
	assert(cOffline?.agent === "agent-c", "offline agent from _agent");
	const onlineOnly = await a.mailbox.sessions();
	assert(!onlineOnly.some((s) => s.session === shortC), "default listing omits offline");

	const logC2 = { notify: [], connected: 0, disconnected: 0 };
	const c2 = new MailboxConnection("local", projectDir, null, "sessC", "agent-c", events(logC2));
	await c2.start();
	const after = await c2.mailbox.inbox(undefined, { limit: 100 });
	assert(after.mails.some((m) => m.subject === "offline mail"), "offline mail delivered on reconnect");
	assert(logC2.notify.some((n) => n >= 1), "unread backfill on reconnect");

	// 7. pagination + cursor semantics
	for (let i = 0; i < 3; i++) {
		await b.mailbox.sendMail({ project: a.mailbox.project, session: shortC }, `mail-${i}`, "x", []);
	}
	const page1 = await c2.mailbox.inbox(undefined, { limit: 2 });
	assert(page1.mails.length === 2 && page1.nextCursor, "page 1 limited with cursor");
	assert(page1.total === 5 && page1.totalUnread === 4, "mailbox-wide totals under pagination");
	const page2 = await c2.mailbox.inbox(undefined, { limit: 2, cursor: page1.nextCursor });
	assert(page2.mails.length === 2 && page2.nextCursor, "page 2 with cursor");
	const page3 = await c2.mailbox.inbox(undefined, { limit: 2, cursor: page2.nextCursor });
	assert(page3.mails.length === 1 && !page3.nextCursor, "page 3 is last");
	const subjects = [...page1.mails, ...page2.mails, ...page3.mails].map((m) => m.subject);
	assert(
		JSON.stringify(subjects) === JSON.stringify(["mail-2", "mail-1", "mail-0", "offline mail", "hello"]),
		"pagination: newest first, all mails exactly once",
	);
	let badCursorErr = null;
	try {
		await c2.mailbox.inbox(undefined, { cursor: "bogus" });
	} catch (e) {
		badCursorErr = e;
	}
	assert(badCursorErr && String(badCursorErr).includes("bad_cursor"), "invalid cursor rejected");
	// future-dated cursor: strictly-older mails are returned (position semantics)
	const future = Buffer.from(JSON.stringify({ createdAt: "2200-01-01T00:00:00.000Z", id: "f" }), "utf8").toString(
		"base64url",
	);
	const beyond = await c2.mailbox.inbox(undefined, { cursor: future });
	assert(beyond.mails[0]?.subject === "mail-2", "future cursor returns strictly-older mails");

	// 8. send to never-registered session
	let noMailboxErr = null;
	try {
		await b.mailbox.sendMail({ project: a.mailbox.project, session: "ghost" }, "x", "y");
	} catch (e) {
		noMailboxErr = e;
	}
	assert(noMailboxErr && String(noMailboxErr).includes("no_mailbox"), "never-registered target: no_mailbox");

	// 9. user-set meta survives reconnect; hello defaults do not clobber
	await c2.mailbox.setMeta({ set: { name: "manual-c", role: "worker" } });
	await c2.stop();
	const logC3 = { notify: [], connected: 0, disconnected: 0 };
	const c3 = new MailboxConnection("local", projectDir, null, "sessC", "agent-c", events(logC3), {
		helloMeta: { name: "auto-c", _model: "prov/m2", role: "boss" },
	});
	await c3.start();
	const meta3 = c3.mailbox.sessionMeta ?? {};
	assert(meta3.name === "manual-c", "user-set name survives reconnect");
	assert(meta3._model === "prov/m2", "system key refreshed on reconnect");
	assert(meta3.role === "worker", "existing user key not clobbered by hello default");
	await c3.stop();

	// 10. named-mailbox login: claim, welcome echo, tags, exclusivity, inheritance
	const logD1 = { notify: [], connected: 0, disconnected: 0 };
	const d1 = new MailboxConnection("local", projectDir, null, "sessD1", "agent-d", events(logD1), {
		login: { as: "smoke-reviewer", tags: "review,urgent" },
		canSpawn: true,
	});
	await d1.start();
	assert(d1.address === `smoke-reviewer@${d1.mailbox.project}`, "login address uses the claimed name");
	assert(d1.mailboxId === "smoke-reviewer", "mailboxId is the login name");
	const metaD1 = d1.mailbox.sessionMeta ?? {};
	assert(metaD1.name === "smoke-reviewer", "login sets the display name");
	assert(metaD1.tags === "review,urgent", "login tags overwrite");
	assert(metaD1._named === "1", "named mailbox marker set");
	// mail to the named mailbox is delivered to the holder (the push is
	// async: poll briefly for it)
	await a.mailbox.sendMail({ project: d1.mailbox.project, session: "smoke-reviewer" }, "named", "body");
	for (let i = 0; i < 100 && !logD1.notify.includes(1); i++) await new Promise((r) => setTimeout(r, 30));
	assert(logD1.notify.includes(1), "named mailbox holder got the notify");
	// exclusivity: a different session claiming the held name is rejected
	const logD2 = { notify: [], connected: 0, disconnected: 0 };
	const d2 = new MailboxConnection("local", projectDir, null, "sessD2", "agent-d", events(logD2), {
		login: { as: "smoke-reviewer" },
	});
	let inUseErr = null;
	try {
		await d2.start();
	} catch (err) {
		inUseErr = err;
	}
	assert(inUseErr && String(inUseErr).includes("mailbox_in_use"), "concurrent login from another session rejected");
	assert(d2.loginRejected, "fatal login rejection stops the reconnect loop (no retry hammering)");
	await d2.stop();
	// same origin reconnecting replaces and inherits tags
	await d1.stop();
	const logD1b = { notify: [], connected: 0, disconnected: 0 };
	const d1b = new MailboxConnection("local", projectDir, null, "sessD1", "agent-d", events(logD1b), {
		login: { as: "smoke-reviewer" },
	});
	await d1b.start();
	assert((d1b.mailbox.sessionMeta ?? {}).tags === "review,urgent", "relogin inherits tags when none given");
	// ack-based clearing: a welcome WITHOUT `released` (legacy daemon)
	// must NOT clear the pending release — the client keeps it so the
	// next hello retries against an updated daemon
	const logD5 = { notify: [], connected: 0, disconnected: 0 };
	const d5 = new MailboxConnection("local", projectDir, null, "sessD5", "agent-d", events(logD5), {
		login: { as: "smoke-release-test" },
		canSpawn: true,
	});
	await d5.start();
	assert(d5.releaseAcked === false, "a hello without release must not set releaseAcked");
	await d5.stop();

	// (a held stored binding falling back to the derived identity is
	// extension-level policy — covered by test/login-live-test.mjs)

	// logout leaves the name held (offline): the next claimant needs the
	// normal attempt first (name_held), then a confirmed force
	await d1b.stop();
	const logD3 = { notify: [], connected: 0, disconnected: 0 };
	const d3 = new MailboxConnection("local", projectDir, null, "sessD3", "agent-d", events(logD3), {
		login: { as: "smoke-reviewer", tags: "fresh" },
	});
	let heldErr = null;
	try {
		await d3.start();
	} catch (err) {
		heldErr = err;
	}
	assert(heldErr && String(heldErr).includes("name_held"), "offline foreign holder rejects with name_held");
	assert(d3.loginRejected, "name_held is fatal (no reconnect loop)");
	await d3.stop();
	// forced retry takes over and inherits
	const d3f = new MailboxConnection("local", projectDir, null, "sessD3", "agent-d", events(logD3), {
		login: { as: "smoke-reviewer", tags: "fresh", force: true },
	});
	await d3f.start();
	for (let i = 0; i < 100 && !logD3.notify.includes(1); i++) await new Promise((r) => setTimeout(r, 30));
	assert(logD3.notify.includes(1), "new claimant gets the unread backfill");
	assert((d3f.mailbox.sessionMeta ?? {}).tags === "fresh", "new claimant overwrites tags");
	const inboxD3 = await d3f.mailbox.inbox();
	assert(inboxD3.total >= 1 && inboxD3.mails.some((m) => m.subject === "named"), "new claimant inherits the mail");
	await d3f.stop();

	// 11. findMailboxdBinary resolves the packaged binary without PI_MAILBOXD
	delete process.env.PI_MAILBOXD;
	const { findMailboxdBinary } = await import("../src/daemon.ts");
	const found = findMailboxdBinary();
	assert(found !== null && found.endsWith(exe), `default binary path resolves (${found})`);

	// 12. short ids: project id is a stable 8-char derivation, session ids
	// are 10-char derivations of (agent, session)
	const projectId = a.mailbox.project;
	await a.stop();
	await b.stop();
	const { deriveProjectId } = await import("../src/daemon.ts");
	const pid = await deriveProjectId(projectDir);
	assert(pid === projectId, "project id derivation must be stable");
	assert(/^[0-9a-z]{8}$/.test(projectId), "project id must be 8 base36 chars");
	assert(/^[0-9a-z]{10}$/.test(shortA), "session id must be 10 base36 chars");
	assert(shortA !== deriveSessionId("agent-b", "sessA"), "different agents must derive different session ids");
	const { readHostId } = await import("../src/daemon.ts");
	assert(/^[0-9a-f]{16}$/.test(await readHostId()), "host id must be 16 hex chars");

	// 13. extension tool harness: every mailbox tool must declare outputSchema
	// and return structuredContent that VALIDATES against it (pi does not
	// validate at runtime, so this is the only automated check of the declared
	// shapes). The tools are driven for real against this daemon through a
	// mock pi API; the extension's own mailbox_connect establishes the
	// connection (named login required in this project).
	const registeredTools = new Map();
	const recordedEntries = [];
	const piMock = {
		registerTool: (t) => registeredTools.set(t.name, t),
		registerCommand: () => {},
		on: () => {},
		appendEntry: (type, data) => recordedEntries.push({ type, data }),
		getActiveTools: () => [],
		setActiveTools: () => {},
		getSessionName: () => "smoke-extension-agent",
		sendUserMessage: () => {},
	};
	const extension = (await import("../src/index.ts")).default;
	extension(piMock);
	const toolNames = ["mailbox_list", "mailbox_read", "mailbox_send", "mailbox_reply", "mailbox_sessions"];
	for (const name of toolNames) {
		assert(registeredTools.has(name), `tool registered: ${name}`);
		assert(registeredTools.get(name).outputSchema !== undefined, `${name} declares outputSchema`);
	}
	const fakeCtx = {
		ui: { notify() {} },
		sessionManager: {
			getSessionId: () => "smoke-ext-session-id",
			getCwd: () => projectDir,
			getSessionDir: () => join(projectDir, ".pi", "sessions", "smoke-ext"),
			getEntries: () => recordedEntries,
		},
		model: { id: "smoke-model", provider: "smoke-prov" },
	};
	const { Validator } = await import("typebox/compile");
	const validate = (tool, value) => {
		const errors = new Validator({}, tool.outputSchema).Errors(value);
		assert(errors.length === 0, `${tool.name} structuredContent matches outputSchema${errors.length ? `: ${JSON.stringify(errors[0])}` : ""}`);
	};
	const exec = (tool, params) => tool.execute("smoke", params, undefined, undefined, fakeCtx);

	const connect = registeredTools.get("mailbox_connect");
	const listTool = registeredTools.get("mailbox_list");
	const readTool = registeredTools.get("mailbox_read");
	const sendTool = registeredTools.get("mailbox_send");
	const replyTool = registeredTools.get("mailbox_reply");
	const sessionsTool = registeredTools.get("mailbox_sessions");

	const connected = await exec(connect, { as: "extsmoke" });
	assert(/mailbox connected/.test(connected.content[0].text), "extension connects via mailbox_connect");
	// fresh-connect path: structuredContent with alreadyConnected false
	assert(connected.structuredContent.alreadyConnected === false, "connect fresh path: alreadyConnected false");
	assert(/^extsmoke@/.test(connected.structuredContent.address), "connect fresh path: full address");
	validate(connect, connected.structuredContent);

	// empty mailbox: mails [] with totals, nextCursor key absent
	let r = await exec(listTool, {});
	assert(Array.isArray(r.structuredContent.mails) && r.structuredContent.mails.length === 0, "list empty: mails []");
	assert(r.structuredContent.total === 0 && r.structuredContent.totalUnread === 0, "list empty: totals 0");
	assert(!("nextCursor" in r.structuredContent), "list empty: nextCursor key absent at end of pagination");
	validate(listTool, r.structuredContent);

	// sessions: own named mailbox online, online is boolean
	r = await exec(sessionsTool, {});
	const own = r.structuredContent.sessions.find((s) => s.session === "extsmoke");
	assert(own !== undefined && own.online === true, "sessions includes own named mailbox, online");
	validate(sessionsTool, r.structuredContent);

	// send to self: ref is the full session@project/mail form
	r = await exec(sendTool, { address: "extsmoke", subject: "structured content test", body: "machine-readable" });
	const sentRef = r.structuredContent.ref;
	assert(/^extsmoke@[^/]+\/.+/.test(sentRef), `send structuredContent ref is full form: ${sentRef}`);
	validate(sendTool, r.structuredContent);

	// list with the mail: unread readAt null, refs null (daemon nil), totalUnread 1
	r = await exec(listTool, {});
	assert(r.structuredContent.mails.length === 1, "list after send: 1 mail");
	assert(r.structuredContent.totalUnread === 1, "list after send: totalUnread 1");
	assert(r.structuredContent.mails[0].readAt === null, "unread mail readAt is null");
	assert(Array.isArray(r.structuredContent.mails[0].refs) && r.structuredContent.mails[0].refs.length === 0, "mail with no refs has refs [] (schema also tolerates null)");
	validate(listTool, r.structuredContent);

	// read by BARE id: ref is the resolved full ref (not the input param)
	const mailId = r.structuredContent.mails[0].id;
	r = await exec(readTool, { mail: mailId });
	assert(r.structuredContent.ref === sentRef, `read ref is resolved full ref: ${r.structuredContent.ref}`);
	assert(typeof r.structuredContent.mail.readAt === "string", "own mail marked read (readAt string)");
	validate(readTool, r.structuredContent);

	// reply: a new mail ref
	r = await exec(replyTool, { mail: sentRef, body: "re: machine-readable" });
	assert(r.structuredContent.ref.startsWith("extsmoke@") && r.structuredContent.ref !== sentRef, "reply ref is a new mail");
	validate(replyTool, r.structuredContent);

	// pagination branch: >limit mails yields a present nextCursor (string)
	for (let i = 0; i < 20; i++) {
		await exec(sendTool, { address: "extsmoke", subject: `bulk ${i}`, body: "x" });
	}
	r = await exec(listTool, {});
	assert(typeof r.structuredContent.nextCursor === "string" && r.structuredContent.nextCursor.length > 0, "list with more pages: nextCursor present");
	assert(r.structuredContent.mails.length === 20, "list default page size 20");
	validate(listTool, r.structuredContent);
	r = await exec(listTool, { cursor: r.structuredContent.nextCursor });
	assert(!("nextCursor" in r.structuredContent), "list last page: nextCursor key absent");
	validate(listTool, r.structuredContent);

	// error path stays an error: unregistered target throws (no empty-success)
	let threw = false;
	try {
		await exec(sendTool, { address: "never-registered-session", subject: "x" });
	} catch {
		threw = true;
	}
	assert(threw, "send to unregistered target throws (error path, not empty success)");

	// connect tool's structuredContent — both return paths plus the
	// onlineClients null / inbox-throws decisions
	const connectTool = registeredTools.get("mailbox_connect");
	assert(connectTool.outputSchema !== undefined, "mailbox_connect declares outputSchema");

	// fresh connect (already connected from the harness setup above): this
	// call takes the already-connected short-circuit path
	let cr = await exec(connectTool, {});
	assert(cr.structuredContent.alreadyConnected === true, "connect short-circuit: alreadyConnected true");
	assert(cr.structuredContent.address === sentRef.replace(/\/.*$/, ""), "connect short-circuit: full address");
	assert(typeof cr.structuredContent.mails.total === "number" && typeof cr.structuredContent.mails.unread === "number", "connect: mail counts present");
	assert(cr.structuredContent.onlineClients === 1, "connect: onlineClients counts self (isolated daemon)");
	assert(/clients online/.test(cr.content[0].text), "connect text keeps the online clause");
	validate(connectTool, cr.structuredContent);

	// sessions query fails, inbox succeeds: onlineClients is PRESENT and null
	// (never 0-on-failure), text drops the online clause (byte contract)
	const { MailboxClient } = await import("../src/client.ts");
	const realSessions = MailboxClient.prototype.sessions;
	try {
		MailboxClient.prototype.sessions = function () {
			return Promise.reject(new Error("simulated sessions failure"));
		};
		cr = await exec(connectTool, {});
	} finally {
		MailboxClient.prototype.sessions = realSessions;
	}
	assert(cr.structuredContent.onlineClients === null, "connect on sessions failure: onlineClients null (not 0, not absent)");
	assert("onlineClients" in cr.structuredContent, "connect on sessions failure: onlineClients key present");
	assert(typeof cr.structuredContent.mails.total === "number", "connect on sessions failure: mail counts kept");
	assert(!/clients online/.test(cr.content[0].text), "connect on sessions failure: text omits the online clause");
	validate(connectTool, cr.structuredContent);

	// sessions recovered: back to a count
	cr = await exec(connectTool, {});
	assert(cr.structuredContent.onlineClients === 1, "connect after recovery: onlineClients counts again");

	// inbox failure: the whole call errors (deliberate — announcing
	// "connected" without mail counts misleads), never a degraded result
	const realInbox = MailboxClient.prototype.inbox;
	try {
		MailboxClient.prototype.inbox = function () {
			return Promise.reject(new Error("simulated inbox failure"));
		};
		threw = false;
		try {
			await exec(connectTool, {});
		} catch {
			threw = true;
		}
	} finally {
		MailboxClient.prototype.inbox = realInbox;
	}
	assert(threw, "connect on inbox failure throws (no degraded structuredContent)");
	// restore sanity: the real inbox works again
	cr = await exec(connectTool, {});
	assert(typeof cr.structuredContent.mails.total === "number", "connect after inbox restore: counts again");
} finally {
	// the daemon is detached and holds the lock file in the temp home; stop
	// it via the pid recorded in the registry so cleanup can remove the dir
	try {
		const reg = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(home, "mailboxd.json"), "utf8")));
		if (typeof reg.pid === "number" && reg.pid > 0) {
			process.kill(reg.pid, "SIGTERM");
			await new Promise((r) => setTimeout(r, 500));
		}
	} catch {
		// daemon already gone
	}
	rmSync(projectDir, { recursive: true, force: true });
	for (let i = 0; i < 10; i++) {
		try {
			rmSync(home, { recursive: true, force: true });
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 300));
		}
	}
}
console.log("\nall smoke tests passed");
// the daemon is detached and section 13 drives the real extension, so live
// reconnect/wake timers can keep the loop alive after the last assertion:
// the run must end here rather than waiting on an idle event loop.
process.exit(0);
