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
// fast webhook pacing (D/M/backoff in ms) so the binding sections can
// observe POSTs without the production 10s/45s waits
process.env.PI_MAILBOXD_WEBHOOK_FAST = "1";
// daemon log for diagnosability (kept across runs; small): spawn-related
// flakes used to be undiagnosable because the detached daemon's stderr
// was discarded
const daemonLog = join(tmpdir(), `pi-mailbox-smoke-daemon-${process.pid}.log`);
process.env.PI_MAILBOXD_LOG = daemonLog;
console.log(`daemon log: ${daemonLog}`);

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
	// connections never spawn: the daemon is brought up explicitly (the
	// /mailbox start service command's spawn path)
	const { resolveLocalDaemon } = await import("../src/daemon.ts");
	await resolveLocalDaemon();
	const a = new MailboxConnection("local", projectDir, null, "sessA", "agent-a", events(logA), {
		login: { as: "smoke-a" },
		helloMeta: { _model: "prov/m1", role: "worker" },
	});
	await a.start();
	assert(a.connected, "A connected (daemon spawned via resolveLocalDaemon)");
	assert(a.mailbox.project !== null && a.mailbox.project.length > 0, "project UUID assigned");
	const welcomeMeta = a.mailbox.sessionMeta ?? {};
	assert(welcomeMeta._agent === "agent-a" && welcomeMeta._model === "prov/m1", "welcome meta merged");
	assert(welcomeMeta.role === "worker", "user meta key applied");

	// 2. second session joins the same project
	const logB = { notify: [], connected: 0, disconnected: 0 };
	const b = new MailboxConnection("local", projectDir, null, "sessB", "agent-b", events(logB), {
		login: { as: "smoke-b" },
	});
	await b.start();
	assert(b.connected, "B connected");
	assert(b.mailbox.project === a.mailbox.project, "both sessions share the project UUID");

	// 3. sessions listing
	const sessions = await a.mailbox.sessions();
	assert(sessions.length === 2 && sessions.every((s) => s.online), "two online sessions");

	// 4. send + notify + inbox totals + read
	const logC = { notify: [], connected: 0, disconnected: 0 };
	const c = new MailboxConnection("local", projectDir, null, "sessC", "agent-c", events(logC), {
		login: { as: "smoke-c" },
	});
	await c.start();
	const ref = await b.mailbox.sendMail(
		{ project: a.mailbox.project, session: "smoke-c" },
		"hello",
		"world",
		[],
	);
	assert(ref.session === "smoke-c", "send returns the claimed name");
	await new Promise((r) => setTimeout(r, 200));
	assert(logC.notify.includes(1), "notify pushed to recipient");

	const inb = await c.mailbox.inbox();
	assert(inb.total === 1 && inb.totalUnread === 1, "inbox totals");
	assert(inb.mails[0].subject === "hello", "mail content");
	const mailID = inb.mails[0].id;

	const read = await c.mailbox.read({ project: a.mailbox.project, session: "smoke-c", mail: mailID });
	assert(read?.readAt !== null && read?.readAt !== undefined, "own read marks readAt");
	const inb2 = await c.mailbox.inbox({ unreadOnly: true });
	assert(inb2.mails.length === 0, "read mail no longer unread");

	// sender can re-read by triple
	const again = await b.mailbox.read({ project: a.mailbox.project, session: "smoke-c", mail: mailID });
	assert(again?.body === "world", "sender can read by triple");

	// 5. meta ops: set/unset, system keys rejected, tags
	await c.mailbox.setMeta({ set: { name: "worker-c", tags: "x,y" } });
	let list = await a.mailbox.sessions();
	let cInfo = list.find((s) => s.session === "smoke-c");
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
	cInfo = list.find((s) => s.session === "smoke-c");
	assert(cInfo?.name === undefined && cInfo?.tags?.length === 2, "name unset, tags kept");
	assert(c.mailbox.sessionMeta?.name === undefined, "sessionMeta kept in sync after unset");

	// 6. nameless logins are rejected outright: every connection must
	// claim a named account. Named accounts keep offline delivery.
	await c.stop();
	const logGhost = { notify: [], connected: 0, disconnected: 0 };
	let namelessErr = null;
	try {
		const ghost = new MailboxConnection("local", projectDir, null, "sessGhost", "agent-ghost", events(logGhost));
		await ghost.start();
	} catch (e) {
		namelessErr = e;
	}
	assert(
		namelessErr && String(namelessErr).includes("name_required"),
		`nameless login rejected with name_required: ${namelessErr}`,
	);

	// named offline delivery + listing + reconnect backfill
	const logD4 = { notify: [], connected: 0, disconnected: 0 };
	const d4 = new MailboxConnection("local", projectDir, null, "sessD4", "agent-d4", events(logD4), {
		login: { as: "smoke-offline" },
	});
	await d4.start();
	await d4.stop();
	const offlineRef = await b.mailbox.sendMail(
		{ project: a.mailbox.project, session: "smoke-offline" },
		"offline mail",
		"while away",
		[],
	);
	assert(offlineRef.session === "smoke-offline", "send to offline named mailbox accepted");
	const withOffline2 = await a.mailbox.sessions(true);
	const cOffline = withOffline2.find((s) => s.session === "smoke-offline");
	assert(cOffline && cOffline.online === false, "offline named mailbox listed with online=false");
	assert(cOffline?.agent === "agent-d4", "offline agent from _agent");
	const onlineOnly = await a.mailbox.sessions();
	assert(!onlineOnly.some((s) => s.session === "smoke-offline"), "default listing omits offline");

	const logC2 = { notify: [], connected: 0, disconnected: 0 };
	const c2 = new MailboxConnection("local", projectDir, null, "sessD4", "agent-d4", events(logC2), {
		login: { as: "smoke-offline" },
	});
	await c2.start();
	const after = await c2.mailbox.inbox(undefined, { limit: 100 });
	assert(after.mails.some((m) => m.subject === "offline mail"), "offline mail delivered on reconnect");
	assert(logC2.notify.some((n) => n >= 1), "unread backfill on reconnect");

	// 7. pagination + cursor semantics
	for (let i = 0; i < 4; i++) {
		await b.mailbox.sendMail({ project: a.mailbox.project, session: "smoke-offline" }, `mail-${i}`, "x", []);
	}
	const page1 = await c2.mailbox.inbox(undefined, { limit: 2 });
	assert(page1.mails.length === 2 && page1.nextCursor, "page 1 limited with cursor");
	assert(page1.total === 5 && page1.totalUnread === 5, "mailbox-wide totals under pagination");
	const page2 = await c2.mailbox.inbox(undefined, { limit: 2, cursor: page1.nextCursor });
	assert(page2.mails.length === 2 && page2.nextCursor, "page 2 with cursor");
	const page3 = await c2.mailbox.inbox(undefined, { limit: 2, cursor: page2.nextCursor });
	assert(page3.mails.length === 1 && !page3.nextCursor, "page 3 is last");
	const subjects = [...page1.mails, ...page2.mails, ...page3.mails].map((m) => m.subject);
	assert(
		JSON.stringify(subjects) === JSON.stringify(["mail-3", "mail-2", "mail-1", "mail-0", "offline mail"]),
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
	assert(beyond.mails[0]?.subject === "mail-3", "future cursor returns strictly-older mails");

	// 8. send to never-registered session
	let noMailboxErr = null;
	try {
		await b.mailbox.sendMail({ project: a.mailbox.project, session: "ghost" }, "x", "y");
	} catch (e) {
		noMailboxErr = e;
	}
	assert(noMailboxErr && String(noMailboxErr).includes("no_mailbox"), "never-registered target: no_mailbox");

	// 9. user-set meta survives reconnect; hello defaults do not clobber
	// (on a NAMED mailbox — the persistent kind; name is claim-owned)
	await c2.mailbox.setMeta({ set: { role: "worker" } });
	await c2.stop();
	const logC3 = { notify: [], connected: 0, disconnected: 0 };
	const c3 = new MailboxConnection("local", projectDir, null, "sessD4", "agent-d4", events(logC3), {
		login: { as: "smoke-offline" },
		helloMeta: { _model: "prov/m2", role: "boss" },
	});
	await c3.start();
	const meta3 = c3.mailbox.sessionMeta ?? {};
	assert(meta3.name === "smoke-offline", "claim name applies at login");
	assert(meta3._model === "prov/m2", "system key refreshed on reconnect");
	assert(meta3.role === "worker", "existing user key not clobbered by hello default");
	await c3.stop();

	// 10. named-mailbox login: claim, welcome echo, tags, exclusivity, inheritance
	const logD1 = { notify: [], connected: 0, disconnected: 0 };
	const d1 = new MailboxConnection("local", projectDir, null, "sessD1", "agent-d", events(logD1), {
		login: { as: "smoke-reviewer", tags: "review,urgent" },
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
	const registeredCommands = new Map();
	const sentUserMessages = [];
	const recordedEntries = [];
	const registeredEvents = new Map();
	const piMock = {
		registerTool: (t) => registeredTools.set(t.name, t),
		registerCommand: (name, def) => registeredCommands.set(name, def),
		on: (ev, handler) => registeredEvents.set(ev, handler),
		// mirror pi's entry shape: appendEntry(customType, data) surfaces via
		// getEntries() as { type: "custom", customType, data }
		appendEntry: (customType, data) => recordedEntries.push({ type: "custom", customType, data }),
		getActiveTools: () => [],
		setActiveTools: () => {},
		getSessionName: () => "smoke-extension-agent",
		sendUserMessage: (msg, opts) => sentUserMessages.push({ msg, opts }),
	};
	const extension = (await import("../src/index.ts")).default;
	extension(piMock);
	const cmdNotifies = [];
	// same session id as fakeCtx: the start/restart service commands
	// connect with this ctx, and their origin must match the extsmoke
	// holder for the same-origin re-claim to work
	const cmdCtx = (entries = []) => ({
		ui: { notify: (msg, kind) => cmdNotifies.push({ msg, kind }) },
		sessionManager: {
			getSessionId: () => "smoke-ext-session-id",
			getCwd: () => projectDir,
			getSessionDir: () => join(projectDir, ".pi", "sessions", "smoke-cmd"),
			getEntries: () => entries,
		},
	});
	const runCommand = (args, ctx) => registeredCommands.get("mailbox").handler(args, ctx);
	const toolNames = ["mailbox_list", "mailbox_read", "mailbox_send", "mailbox_reply", "mailbox_sessions", "mailbox_projects"];
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

	// start service with NO stored login: starts the service without
	// demanding a login (the named-account policy applies to CONNECTING,
	// not to bringing the daemon up)
	await runCommand("start service", cmdCtx());
	const startNoLogin = cmdNotifies[cmdNotifies.length - 1];
	assert(
		startNoLogin && /service (started|already running)/.test(startNoLogin.msg) && /login <name>/.test(startNoLogin.msg),
		`start service without login manages the service: ${startNoLogin?.msg}`,
	);

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

	// restart service with NO stored login (fresh ctx): restarts the daemon
	// without demanding a login, leaves the session disconnected
	cmdNotifies.length = 0;
	await runCommand("restart service", cmdCtx());
	const restartNoLogin = cmdNotifies[cmdNotifies.length - 1];
	assert(
		restartNoLogin && /service restarted/.test(restartNoLogin.msg) && /login <name>/.test(restartNoLogin.msg),
		`restart service without login restarts the service: ${restartNoLogin?.msg}`,
	);
	// liveness: the daemon must actually be back up after the restart —
	// POLLED (the command's internal 500ms sleep is not a guarantee; a
	// stale registry read right here was the suspected cause of the
	// section-13-tail fetch flake)
	const { connectLocalDaemonIfRunning } = await import("../src/daemon.ts");
	let liveEndpoint = null;
	for (let i = 0; i < 50 && !liveEndpoint; i++) {
		liveEndpoint = await connectLocalDaemonIfRunning();
		if (!liveEndpoint) await new Promise((r) => setTimeout(r, 100));
	}
	assert(liveEndpoint !== null, "daemon is live after restart service (polled)");

	// identity rule is shipped with the mailbox: present in the namespace
	// instructions (every tool registration), the mailbox_connect
	// description, and the connect result text — a refactor cannot silently
	// drop it without failing here
	const IDENTITY_RULE = /mail from 'user' is your human operator/i;
	assert(
		IDENTITY_RULE.test(registeredTools.get("mailbox_list").namespace.instructions),
		"identity rule present in the namespace instructions",
	);
	assert(
		IDENTITY_RULE.test(registeredTools.get("mailbox_connect").description),
		"identity rule present in the mailbox_connect description",
	);
	assert(
		IDENTITY_RULE.test(connected.content[0].text),
		"identity rule present in the connect result text",
	);

	// footer unread badge: fire the captured session_start (installs the
	// footer), reconnect (binding auto-applies), render the component
	const sessionStart = registeredEvents.get("session_start");
	assert(typeof sessionStart === "function", "session_start handler registered");
	let footerFactory = null;
	const footerCtx = {
		mode: "tui",
		ui: { setFooter: (f) => (footerFactory = f), notify: () => {} },
		sessionManager: {
			// same session id as fakeCtx: the stored binding must reconnect
			// as the SAME origin (a second origin would hit name_held)
			getSessionId: () => "smoke-ext-session-id",
			getCwd: () => projectDir,
			getSessionDir: () => join(projectDir, ".pi", "sessions", "smoke-foot"),
			getSessionName: () => "smoke-footer-agent",
			getEntries: () => recordedEntries,
		},
	};
	await sessionStart({}, footerCtx);
	assert(typeof footerFactory === "function", "session_start installed the footer");
	const component = footerFactory(
		{ requestRender: () => {} },
		{ fg: (_style, text) => text },
		{ getGitBranch: () => "main" },
	);
	const renderLine1 = () => component.render(200)[0];

	// not connected: no address, no badge
	let line = renderLine1();
	assert(!line.includes("✉"), "disconnected footer has no unread badge");

	// reconnect happens via the autoConnect fired by session_start (same
	// session id as fakeCtx, so the stored binding extsmoke auto-applies
	// as a same-origin reconnect; a different id would race the two
	// connects — see the orphan note in the review mail)
	let addressShown = false;
	for (let i = 0; i < 40 && !addressShown; i++) {
		await new Promise((r) => setTimeout(r, 100));
		addressShown = renderLine1().includes("extsmoke@");
	}
	assert(addressShown, "footer shows the address after auto-connect");
	line = renderLine1();
	const inboxBefore = await exec(listTool, { unreadOnly: true });
	const unreadBefore = inboxBefore.structuredContent.totalUnread;
	assert(unreadBefore > 0, "precondition: unread mails exist");
	assert(
		line.includes(`✉${unreadBefore}`),
		`footer badge matches inbox unread (${unreadBefore}): ${line}`,
	);

	// reading one unread mail decrements the badge (refreshUnread is async)
	const oneUnread = inboxBefore.structuredContent.mails[0];
	await exec(readTool, { mail: oneUnread.id });
	let decremented = false;
	for (let i = 0; i < 30 && !decremented; i++) {
		await new Promise((r) => setTimeout(r, 100));
		decremented = renderLine1().includes(`✉${unreadBefore - 1}`);
	}
	assert(decremented, `footer badge decremented to ${unreadBefore - 1} after a read: ${renderLine1()}`);

	// ordering (pinned): the session name sits at pi's default position and
	// the mail address comes AFTER it — a swap back to the old
	// "address • name" order fails here
	const ordered = renderLine1();
	assert(
		ordered.includes("smoke-footer-agent") &&
			ordered.indexOf("smoke-footer-agent") < ordered.indexOf("extsmoke@"),
		`footer order: name before address (${ordered})`,
	);
	// truncation (pinned): at a width that fits the name but not the
	// address, the name survives and the address/badge are eaten first
	const cut = ordered.indexOf("extsmoke@");
	const narrow = component.render(cut)[0];
	assert(
		narrow.includes("smoke-footer-agent") && !narrow.includes("extsmoke@") && !narrow.includes("\u2709"),
		`footer truncation keeps the name, eats the address first (${narrow})`,
	);

	// startConnection race: a failing concurrent connect must not orphan a
	// live one. A = same-origin reconnect (extsmoke, succeeds); B = claim of
	// a name held ONLINE by a foreign-origin raw connection (mailbox_in_use,
	// fatal). Old code: B's fatal rollback set conn=null, orphaning A. Fixed:
	// identity-checked rollback restores B's captured previous, so the
	// extension keeps a live connection either way.
	const { MailboxConnection: RaceConn } = await import("../src/client.ts");
	const holderLog = { notify: [], connected: 0, disconnected: 0 };
	const holder = new RaceConn("local", projectDir, null, "race-holder-sess", "race-holder-agent", events(holderLog), {
		login: { as: "race-b" },
	});
	await holder.start();
	assert(holder.connected, "foreign-origin holder online for race-b");

	// TRUE REPRODUCER (review-1's seam): delay the FIRST start() call, so A
	// (fired first) assigns conn=A and then sits inside start() — the
	// vulnerable window. 150ms later B's prologue clobbers conn=B and B
	// fails fatally; the rollback must restore A, and A's start must then
	// complete into a live, referenced connection.
	const realStart = RaceConn.prototype.start;
	let delayedFirst = false;
	RaceConn.prototype.start = async function (...startArgs) {
		if (!delayedFirst) {
			delayedFirst = true;
			await new Promise((r) => setTimeout(r, 1200));
		}
		return realStart.apply(this, startArgs);
	};
	try {
		const pA = exec(connectTool, { as: "extsmoke" });
		await new Promise((r) => setTimeout(r, 150)); // B fires inside A's window
		const pB = exec(connectTool, { as: "race-b" }).then(
			() => "unexpected-success",
			(err) => String(err),
		);
		await pA.catch((err) => `A failed: ${err}`);
		const bOutcome = await pB;
		assert(
			typeof bOutcome === "string" && /session_bound|mailbox_in_use/.test(bOutcome),
			`race: B fails fatally (${bOutcome})`,
		);
		// the race outcome: the extension must still hold a LIVE connection
		const afterRace = await exec(connectTool, {});
		assert(
			afterRace.structuredContent.alreadyConnected === true,
			`race: A is not orphaned (extension still connected): ${afterRace.content[0].text.slice(0, 80)}`,
		);
	} finally {
		RaceConn.prototype.start = realStart;
	}
	await holder.stop();

	// interactive mode gate: print-mode SDK hosts MUST receive new-mail
	// injections (sendUserMessage -> prompt()); json (pure event stream)
	// MUST NOT. A peer named mailbox sends one mail per mode; polling
	// covers the 300ms coalescing debounce.
	const modeCtx = (mode) => ({
		mode,
		ui: { setFooter: () => {}, notify: () => {} },
		sessionManager: {
			getSessionId: () => "smoke-ext-session-id",
			getCwd: () => projectDir,
			getSessionDir: () => join(projectDir, ".pi", "sessions", "smoke-ext"),
			getSessionName: () => "smoke-mode-agent",
			getEntries: () => recordedEntries,
		},
	});
	const extProject = connected.structuredContent.address.split("@")[1];
	const peerLog = { notify: [], connected: 0, disconnected: 0 };
	const peer = new RaceConn("local", projectDir, null, "mode-peer-sess", "mode-peer-agent", events(peerLog), {
		login: { as: "mode-peer" },
	});
	await peer.start();
	const peerSends = (subject) =>
		peer.mailbox.sendMail({ project: extProject, session: "extsmoke" }, subject, "x");

	// print: the injection MUST fire
	await sessionStart({}, modeCtx("print"));
	sentUserMessages.length = 0;
	await peerSends("print-mode notify test");
	let printInjected = false;
	for (let i = 0; i < 40 && !printInjected; i++) {
		await new Promise((r) => setTimeout(r, 100));
		printInjected = sentUserMessages.some((s) => String(s.msg).includes("print-mode notify test"));
	}
	assert(printInjected, "print mode: new-mail injection reaches the host");
	assert(
		sentUserMessages.every((s) => s.opts?.deliverAs === "steer"),
		"print mode: injections are steered",
	);

	// json: no injection (stdout stays a pure event stream)
	await sessionStart({}, modeCtx("json"));
	sentUserMessages.length = 0;
	await peerSends("json-mode notify test");
	await new Promise((r) => setTimeout(r, 1000));
	assert(
		sentUserMessages.length === 0,
		"json mode: no injection (pure event stream)",
	);
	await peer.stop();

	// mailbox_projects: lists every project on the daemon; count must match
	// the daemon's own /api/info listing exactly; includeSessions aggregates
	// per-project counts from /api/sessions
	const projectsTool = registeredTools.get("mailbox_projects");
	assert(projectsTool.outputSchema !== undefined, "mailbox_projects declares outputSchema");
	let pr = await exec(projectsTool, {});
	validate(projectsTool, pr.structuredContent);
	const { readFileSync: readFileSyncSync } = await import("node:fs");
	const reg = JSON.parse(readFileSyncSync(join(home, "mailboxd.json"), "utf8"));
	const infoResp = await fetch(`http://127.0.0.1:${reg.port}/api/info`);
	const info = await infoResp.json();
	assert(
		pr.structuredContent.projects.length === info.projects.length,
		`projects count matches /api/info (${pr.structuredContent.projects.length} vs ${info.projects.length})`,
	);
	const ownProject = pr.structuredContent.projects.find((p) => p.project === extProject);
	assert(ownProject !== undefined, "own project listed");
	assert(ownProject.path === projectDir, `own project path matches cwd (${ownProject.path})`);
	assert(typeof ownProject.host === "string" && ownProject.host.length > 0, "own project host present (local mode)");
	// without includeSessions: no counts
	assert(ownProject.total === undefined && ownProject.online === undefined, "no counts without includeSessions");
	pr = await exec(projectsTool, { includeSessions: true });
	validate(projectsTool, pr.structuredContent);
	const ownCounted = pr.structuredContent.projects.find((p) => p.project === extProject);
	assert(ownCounted !== undefined && ownCounted.total !== undefined && ownCounted.total >= 1, "includeSessions: own project total >= 1");
	assert(ownCounted !== undefined && ownCounted.online !== undefined && ownCounted.online >= 1, "includeSessions: own project online >= 1");
	assert(pr.content[0].text.includes(extProject), "projects text lists own project id");

	// 14. connections NEVER spawn the daemon: a deliberately stopped
	// daemon stays down (retry loops are probe-only), and only the explicit
	// /mailbox start service command brings it back up
	const logR = { notify: [], connected: 0, disconnected: 0 };
	const r1 = new MailboxConnection("local", projectDir, null, "respawn-sess-1", "respawn-agent", events(logR), {
		login: { as: "respawn-guard" },
	});
	await r1.start();
	assert(r1.connected, "probe-only connection established (daemon was running)");
	const { readFileSync: rf } = await import("node:fs");
	const reg1 = JSON.parse(rf(join(home, "mailboxd.json"), "utf8"));
	process.kill(reg1.pid, "SIGTERM");
	await new Promise((r) => setTimeout(r, 2600)); // daemon exits + retries fire
	let resurrected = false;
	try {
		const reg2 = JSON.parse(rf(join(home, "mailboxd.json"), "utf8"));
		if (typeof reg2.pid === "number" && reg2.pid !== reg1.pid) resurrected = true;
	} catch {
		// registry gone: daemon down and nobody respawned it
	}
	assert(!resurrected, "a connection's retry loop must NOT respawn a stopped daemon");
	await r1.stop();
	// the explicit start-service COMMAND path DOES bring it back (the only
	// spawn path): drive it through the harness's registered command
	cmdNotifies.length = 0;
	await runCommand("start service", cmdCtx(recordedEntries)); // extsmoke binding
	let restarted = false;
	for (let i = 0; i < 30 && !restarted; i++) {
		await new Promise((r) => setTimeout(r, 100));
		try {
			const reg3 = JSON.parse(rf(join(home, "mailboxd.json"), "utf8"));
			restarted = typeof reg3.pid === "number" && reg3.pid > 0;
		} catch {
			// not yet
		}
	}
	assert(restarted, "/mailbox start service respawns the daemon (the only spawn path)");
	const lastNotify = cmdNotifies[cmdNotifies.length - 1];
	assert(
		lastNotify && /connected as|service started/.test(lastNotify.msg),
		`start service after respawn: ${lastNotify?.msg}`,
	);

	// 15. replaced-signal: two connections with the SAME identity — the
	// loser gets close status 4000 and STANDS DOWN (no retry), so two live
	// agents on one session cannot ping-pong forever
	const logDup1 = { notify: [], connected: 0, disconnected: 0 };
	const dup1 = new MailboxConnection("local", projectDir, null, "dup-sess", "dup-agent", events(logDup1), {
		login: { as: "dup-test" },
	});
	await dup1.start();
	const logDup2 = { notify: [], connected: 0, disconnected: 0 };
	const dup2 = new MailboxConnection("local", projectDir, null, "dup-sess", "dup-agent", events(logDup2), {
		login: { as: "dup-test" },
	});
	await dup2.start();
	assert(dup2.connected, "the second (replacing) connection wins");
	let loserReplaced = false;
	for (let i = 0; i < 30 && !loserReplaced; i++) {
		await new Promise((r) => setTimeout(r, 100));
		loserReplaced = dup1.replaced;
	}
	assert(loserReplaced, "the loser sees the replaced signal");
	assert(!dup1.connected, "the loser is down");
	// and it STAYS down: after the retry window, the winner is still the
	// only connection (the old behavior was an endless kick ping-pong)
	await new Promise((r) => setTimeout(r, 2600));
	assert(dup2.connected && !dup1.connected, "no ping-pong: winner stays up, loser stays down");
	await dup1.stop();
	await dup2.stop();

	// 16. rename-to-login: a session_info_changed with a valid mailbox
	// name, while not logged in, logs in to that mailbox (like /mailbox
	// login); never re-logins an identified session; invalid names are
	// just display names
	const infoChanged = registeredEvents.get("session_info_changed");
	assert(typeof infoChanged === "function", "session_info_changed handler registered");

	// 16a. /mailbox argument completions (while connected as extsmoke)
	const mailboxCmd = registeredCommands.get("mailbox");
	assert(typeof mailboxCmd.getArgumentCompletions === "function", "getArgumentCompletions registered");
	// first argument: subcommands with placeholder labels and typed values
	let compl = await mailboxCmd.getArgumentCompletions("lo");
	assert(
		compl && compl.length === 2 && compl.every((i) => i.value.endsWith(" ")),
		`subcommand completion 'lo' -> login/logout: ${JSON.stringify(compl)}`,
	);
	assert(
		compl.some((i) => i.value === "login " && i.label === "login <name>"),
		"login completion: value is typed text, label carries the placeholder",
	);
	compl = await mailboxCmd.getArgumentCompletions("start");
	assert(
		compl && compl.length === 1 && compl[0].value === "start service ",
		`multi-word subcommand completes as one value: ${JSON.stringify(compl)}`,
	);
	assert(await mailboxCmd.getArgumentCompletions("zzz") === null, "no subcommand match -> null");
	// login <name>: live name list through the connected session. The
	// session's OWN held name (extsmoke) is excluded from the suggestions
	// (re-login replaces — valid to type, just not hinted); peers appear
	// with online/offline markers.
	compl = await mailboxCmd.getArgumentCompletions("login ");
	assert(
		compl && !compl.some((i) => i.value === "login extsmoke "),
		`login name completion excludes the own held name extsmoke: ${JSON.stringify((compl ?? []).slice(0, 3))}`,
	);
	assert(
		(compl ?? []).some((i) => i.description === "offline"),
		"login name completion still offers other named mailboxes",
	);
	assert(compl.every((i) => i.value !== "login user "), "user is never offered as a login name");
	// delete <name>: online holders are not deletable -> filtered out
	compl = await mailboxCmd.getArgumentCompletions("delete ");
	assert(
		compl && !compl.some((i) => i.value === "delete extsmoke "),
		"delete name completion omits the online extsmoke",
	);
	assert(compl.some((i) => i.value === "delete smoke-reviewer "), "delete offers offline named mailboxes");
	// two-plus arguments: no suggestions
	assert(await mailboxCmd.getArgumentCompletions("login a b") === null, "third argument -> null");

	// negative: while connected, a rename does NOT re-login
	cmdNotifies.length = 0;
	await infoChanged({ type: "session_info_changed", name: "renamed-name" }, cmdCtx(recordedEntries));
	await new Promise((r) => setTimeout(r, 400));
	assert(!cmdNotifies.some((n) => /logged in/.test(n.msg)), "rename while connected does not re-login");
	// logout (disconnects + clears the binding), then rename -> auto-login
	await runCommand("logout", cmdCtx(recordedEntries));
	cmdNotifies.length = 0;
	await infoChanged({ type: "session_info_changed", name: "renamed-name" }, cmdCtx(recordedEntries));
	let loginNote = null;
	for (let i = 0; i < 30 && !loginNote; i++) {
		await new Promise((r) => setTimeout(r, 100));
		loginNote = cmdNotifies.find((n) => /logged in/.test(n.msg)) ?? null;
	}
	assert(loginNote && loginNote.msg.includes("renamed-name"), `rename with a valid name logs in: ${loginNote?.msg}`);
	assert(
		recordedEntries.some((e) => e.customType === "pi-mailbox-login" && e.data?.name === "renamed-name"),
		"auto-login persists the binding",
	);
	// invalid name while logged out: no login
	await runCommand("logout", cmdCtx(recordedEntries));
	cmdNotifies.length = 0;
	await infoChanged({ type: "session_info_changed", name: "Not A Valid Name" }, cmdCtx(recordedEntries));
	await new Promise((r) => setTimeout(r, 600));
	assert(!cmdNotifies.some((n) => /logged in/.test(n.msg)), "invalid name does not log in");

	// 14. channel bindings: caps + CRUD + webhook delivery to a local bot
	{
		// fresh connection (the earlier ones were stopped by their sections)
		const logW = { notify: [], connected: 0, disconnected: 0 };
		const w = new MailboxConnection("local", projectDir, null, "sessW", "agent-w", events(logW), {
			login: { as: "smoke-bindmgr" },
		});
		await w.start();
		assert(w.mailbox.hasCap("bindings"), "welcome advertises the bindings capability");
		assert((w.mailbox.caps ?? []).some((c) => c === "channel:webhook"), "caps list the webhook channel");
		const http = await import("node:http");
		const crypto = await import("node:crypto");
		const requests = [];
		const bot = http.createServer((req, res) => {
			let body = "";
			req.on("data", (d) => (body += d));
			req.on("end", () => {
				requests.push({ headers: req.headers, body });
				// first attempt fails: the retry must keep the same deliveryId
				if (requests.length === 1) {
					res.writeHead(500);
					res.end();
				} else {
					res.writeHead(200);
					res.end();
				}
			});
		});
		await new Promise((r) => bot.listen(0, "127.0.0.1", r));
		const botPort = bot.address().port;
		const botCfg = { url: `http://127.0.0.1:${botPort}/hook`, secret: "smokesecret", headers: { "X-Bot-Key": "bkey" } };
		try {
			// add: bind smoke-bot (a fresh name) to the webhook
			const binfo = await w.mailbox.bindingAdd({ channel: "webhook", config: botCfg, targets: ["smoke-bot"] });
			assert(binfo.id !== "" && binfo.enabled && binfo.targets[0] === "smoke-bot", "binding_add creates an enabled binding");

			// arbitration: a name held ONLINE (this very connection) is
			// refused even with force
			let refused = false;
			try {
				await w.mailbox.bindingAdd({ channel: "webhook", config: botCfg, targets: ["smoke-bindmgr"], force: true });
			} catch (e) {
				refused = e.code === "mailbox_in_use";
			}
			assert(refused, "binding a name held online is refused (mailbox_in_use)");

			// mail to the bound mailbox -> POST (attempt 1 fails, retry lands)
			await w.mailbox.sendMail({ project: w.mailbox.project, session: "smoke-bot" }, "bot mail", "body text", []);
			let got2 = null;
			for (let i = 0; i < 100 && !got2; i++) {
				await new Promise((r) => setTimeout(r, 50));
				if (requests.length >= 2) got2 = requests[1];
			}
			assert(got2 !== null, "webhook POST retried after a 500");
			const p = JSON.parse(got2.body);
			assert(p.event === "mail.batch" && p.mailbox === `smoke-bot@${w.mailbox.project}` && p.mailCount === 1, "webhook payload shape (event/mailbox/mailCount)");
			assert(p.mails[0].subject === "bot mail" && p.mails[0].snippet === "body text", "summary carries subject + snippet (no full body)");
			assert(p.mails[0].body === undefined, "payload never carries the full body");
			const ts = got2.headers["x-mailbox-timestamp"];
			const sig = got2.headers["x-mailbox-signature"];
			const expectSig = crypto.createHmac("sha256", "smokesecret").update(ts + "." + got2.body).digest("hex");
			assert(sig === expectSig, "HMAC signature verifies against the raw body");
			assert(got2.headers["x-bot-key"] === "bkey", "static header rides along");
			const p1 = JSON.parse(requests[0].body);
			assert(p1.deliveryId === p.deliveryId, "deliveryId stable across retries");

			// list: this project's bindings, redacted
			const list = await w.mailbox.bindings();
			assert(list.length === 1 && list[0].id === binfo.id, "bindings list returns the binding");
			assert(!JSON.stringify(list).includes("smokesecret"), "bindings list never echoes the secret");

			// disable + delete
			const up = await w.mailbox.bindingUpdate({ id: binfo.id, enabled: false });
			assert(up.enabled === false, "binding disabled");
			const del = await w.mailbox.bindingDelete(binfo.id);
			assert(del.id === binfo.id, "binding deleted");
			assert((await w.mailbox.bindings()).length === 0, "list empty after delete");
		} finally {
			await new Promise((r) => bot.close(r));
			await w.stop();
		}
	}

	// success: drop this run's daemon log (kept on failure for diagnosis)
	rmSync(daemonLog, { force: true });
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
