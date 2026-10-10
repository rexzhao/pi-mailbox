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
	const a = new MailboxConnection("local", projectDir, null, "sessA", "agent-a", events(logA), {
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
		{ project: a.mailbox.project, session: "sessC" },
		"hello",
		"world",
		[],
	);
	assert(ref.session === "sessC", "send returns triple");
	await new Promise((r) => setTimeout(r, 200));
	assert(logC.notify.includes(1), "notify pushed to recipient");

	const inb = await c.mailbox.inbox();
	assert(inb.total === 1 && inb.totalUnread === 1, "inbox totals");
	assert(inb.mails[0].subject === "hello", "mail content");
	const mailID = inb.mails[0].id;

	const read = await c.mailbox.read({ project: a.mailbox.project, session: "sessC", mail: mailID });
	assert(read?.readAt !== null && read?.readAt !== undefined, "own read marks readAt");
	const inb2 = await c.mailbox.inbox({ unreadOnly: true });
	assert(inb2.mails.length === 0, "read mail no longer unread");

	// sender can re-read by triple
	const again = await b.mailbox.read({ project: a.mailbox.project, session: "sessC", mail: mailID });
	assert(again?.body === "world", "sender can read by triple");

	// 5. meta ops: set/unset, system keys rejected, tags
	await c.mailbox.setMeta({ set: { name: "worker-c", tags: "x,y" } });
	let list = await a.mailbox.sessions();
	let cInfo = list.find((s) => s.session === "sessC");
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
	cInfo = list.find((s) => s.session === "sessC");
	assert(cInfo?.name === undefined && cInfo?.tags?.length === 2, "name unset, tags kept");
	assert(c.mailbox.sessionMeta?.name === undefined, "sessionMeta kept in sync after unset");

	// 6. offline delivery + offline listing + reconnect backfill
	await c.stop();
	const offlineRef = await b.mailbox.sendMail(
		{ project: a.mailbox.project, session: "sessC" },
		"offline mail",
		"while away",
		[],
	);
	assert(offlineRef.session === "sessC", "send to offline registered session accepted");
	const withOffline = await a.mailbox.sessions(true);
	const cOffline = withOffline.find((s) => s.session === "sessC");
	assert(cOffline && cOffline.online === false, "offline session listed with online=false");
	assert(cOffline?.agent === "agent-c", "offline agent from _agent");
	const onlineOnly = await a.mailbox.sessions();
	assert(!onlineOnly.some((s) => s.session === "sessC"), "default listing omits offline");

	const logC2 = { notify: [], connected: 0, disconnected: 0 };
	const c2 = new MailboxConnection("local", projectDir, null, "sessC", "agent-c", events(logC2));
	await c2.start();
	const after = await c2.mailbox.inbox(undefined, { limit: 100 });
	assert(after.mails.some((m) => m.subject === "offline mail"), "offline mail delivered on reconnect");
	assert(logC2.notify.some((n) => n >= 1), "unread backfill on reconnect");

	// 7. pagination + cursor semantics
	for (let i = 0; i < 3; i++) {
		await b.mailbox.sendMail({ project: a.mailbox.project, session: "sessC" }, `mail-${i}`, "x", []);
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

	// 10. findMailboxdBinary resolves the packaged binary without PI_MAILBOXD
	delete process.env.PI_MAILBOXD;
	const { findMailboxdBinary } = await import("../src/daemon.ts");
	const found = findMailboxdBinary();
	assert(found !== null && found.endsWith(exe), `default binary path resolves (${found})`);

	// 11. project registry persists
	const projectId = a.mailbox.project;
	await a.stop();
	await b.stop();
	// the daemon stays up (idle timeout is minutes); kill it via its flock
	// being released only on exit — instead verify reconnection after a
	// daemon restart by... the daemon is shared; restart is covered by the
	// mailboxd Go tests. Here we just verify the project registry survives.
	const { readProjectId } = await import("../src/daemon.ts");
	const pid = await readProjectId(projectDir);
	assert(pid === projectId, "project UUID persisted in the registry file");
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
