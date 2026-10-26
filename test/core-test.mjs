// Host-agnostic core tests: MailboxController against fake hosts and a
// real, isolated mailboxd (own PI_MAILBOXD_DIR; never touches ~/.pi).
//
// Run: node --experimental-strip-types --no-warnings test/core-test.mjs
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

const home = mkdtempSync(join(tmpdir(), "pi-mailbox-core-home-"));
process.env.PI_MAILBOXD_DIR = home;
process.env.PI_MAILBOXD = daemonBin;
// fast webhook pacing so the binding section observes POSTs quickly
process.env.PI_MAILBOXD_WEBHOOK_FAST = "1";
const projectDir = mkdtempSync(join(tmpdir(), "pi-mailbox-core-project-"));
mkdirSync(join(projectDir, ".pi"), { recursive: true });

const assert = (cond, msg) => {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	console.log(`ok: ${msg}`);
};

const core = await import("../src/core/index.ts");
const {
	MailboxController,
	MAILBOX_CORE_API_VERSION,
	MAILBOX_EXTENSION_ID,
	coreApiMajor,
	readLoginBinding,
	bindingFromEntries,
	resolveLocalDaemon,
	MailboxConnection,
} = core;

// ---------------------------------------------------------------------------
// fake host: an in-memory entry log (same shapes the pi shell persists)
// ---------------------------------------------------------------------------

function fakeHost({ sessionId, cwd = projectDir, agent = "core-test", deliverImpl } = {}) {
	const state = {
		entries: [],
		delivered: [],
		notifies: [],
		unread: null,
		byName: null,
		connChanges: 0,
		busy: false,
	};
	const pushEntry = (customType, data) => state.entries.push({ type: "custom", customType, data });
	return {
		state,
		host: {
			identity: { agent, sessionId, cwd },
			loginStore: {
				readLogin: () => bindingFromEntries(state.entries).login,
				writeLogin: (b) => pushEntry("pi-mailbox-login", b ? { name: b.current, names: b.names } : { name: null }),
				readRelease: () => bindingFromEntries(state.entries).releases,
				writeRelease: (names) => pushEntry("pi-mailbox-release", names ? { names } : { names: null }),
			},
			deliver: async (text) => {
				state.delivered.push(text);
				if (deliverImpl) await deliverImpl(text, state);
			},
			isBusy: () => state.busy,
			notify: (msg, level) => state.notifies.push({ msg, level: level ?? "info" }),
			setUnread: (total, byName) => {
				state.unread = total;
				state.byName = byName;
			},
			onConnectionChanged: () => state.connChanges++,
		},
	};
}

const poll = async (deadlineMs, fn) => {
	const deadline = Date.now() + deadlineMs;
	let last;
	while (Date.now() < deadline) {
		last = fn();
		if (last) return last;
		await new Promise((r) => setTimeout(r, 100));
	}
	return last;
};

try {
	// 0. version contract
	assert(MAILBOX_CORE_API_VERSION === "1.1.1", `MAILBOX_CORE_API_VERSION is 1.1.1 (${MAILBOX_CORE_API_VERSION})`);
	assert(coreApiMajor() === 1, "coreApiMajor() === 1");
	assert(MAILBOX_EXTENSION_ID === "pi-mailbox", "MAILBOX_EXTENSION_ID exported");

	// package exports entry points at the core and the core loads under
	// Node type stripping (the submodule host's loading mode)
	{
		const pkg = JSON.parse((await import("node:fs")).readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
		assert(pkg.exports?.["./core"] === "./src/core/index.ts", 'package.json exports["./core"] -> ./src/core/index.ts');
	}

	// bring the daemon up (the only spawn path)
	await resolveLocalDaemon();

	// 1. multi-login: one controller, two names, both live
	const a = fakeHost({ sessionId: "core-sess-a" });
	const ca = new MailboxController(a.host);
	const connA = await ca.login({ as: "core-alpha" });
	assert(ca.connected && /^core-alpha@/.test(connA.address ?? ""), "first login connects as core-alpha");
	assert(ca.currentName === "core-alpha", "current identity is core-alpha");
	const connB = await ca.login({ as: "core-beta" });
	assert(ca.heldNames.join(",") === "core-alpha,core-beta", `multi-login holds both names (${ca.heldNames.join(",")})`);
	assert(ca.currentName === "core-beta", "the last login becomes the current identity");
	assert(connA.connected && connB.connected, "both connections live");
	// the binding persisted the full set
	const bindingA = a.state.entries.length > 0 && bindingFromEntries(a.state.entries).login;
	assert(bindingA?.names.length === 2 && bindingA?.current === "core-beta", "binding persists names + current");

	// 2. per-identity tools: send as core-alpha while current is core-beta
	const tools = Object.fromEntries(ca.tools.map((t) => [t.name, t]));
	assert(ca.tools.length === 8, "8 tool definitions exported (7 + mailbox_bindings)");
	const sendTool = tools["mailbox_send"];
	assert(sendTool.parameters.properties.as !== undefined, "mailbox_send exposes the as parameter");
	const sent = await sendTool.execute("t1", { address: "core-beta", subject: "cross-self", body: "x", as: "core-alpha" });
	assert(/^core-beta@.+\/.+/.test(sent.structuredContent.ref), "send targets core-beta");
	// the mail landed in core-beta with core-alpha as the sender
	const listTool = tools["mailbox_list"];
	const inBeta = await listTool.execute("t2", { as: "core-beta" });
	assert(inBeta.structuredContent.mails.some((m) => m.subject === "cross-self" && m.from.session === "core-alpha"), "sent FROM core-alpha (as param selects the sender identity)");
	// unread badge totals across identities
	assert(a.state.unread === 1 && a.state.byName?.["core-beta"] === 1, `setUnread carries total + per-name detail (${a.state.unread}, ${JSON.stringify(a.state.byName)})`);
	// unknown identity -> clean error
	let threw = false;
	try {
		await listTool.execute("t3", { as: "core-gamma" });
	} catch (e) {
		threw = /not logged in/.test(String(e.message));
	}
	assert(threw, "operating as an un-held identity errors cleanly");

	// 3. a second controller (different session) coexists without interference
	const b = fakeHost({ sessionId: "core-sess-b" });
	const cb = new MailboxController(b.host);
	await cb.login({ as: "core-delta" });
	assert(cb.connected && ca.connected, "two controllers, both connected (no shared module state)");
	const sessionsTool = cb.tools.find((t) => t.name === "mailbox_sessions");
	const list = await sessionsTool.execute("t4", {});
	const self = list.structuredContent.sessions.filter((s) => s.session === "core-delta");
	assert(self.length === 1 && self[0].online === true, "controller B sees its own identity online");

	// 3b. name completion (the TUI input hints): logout lists ONLY the own
	//     names, login/resume exclude them, delete lists offline names only
	{
		const offLog = { notify: [], connected: 0, disconnected: 0 };
		const off = new MailboxConnection("local", projectDir, null, "core-off-sess", "core-off-agent", {
			onNotify: (n) => offLog.notify.push(n),
			onConnected: () => offLog.connected++,
			onDisconnected: () => offLog.disconnected++,
		}, { login: { as: "core-offline" } });
		await off.start();
		await off.stop(); // leaves a named mailbox that is registered but offline
		let items = await ca.completeCommand("logout ");
		let values = (items ?? []).map((i) => i.value);
		assert(items !== null && values.includes("logout core-alpha ") && values.includes("logout core-beta ") && values.length === 2, `logout completion lists exactly the own held names (${values.join(",")})`);
		assert(items.find((i) => i.value === "logout core-beta ").description === "current identity", "logout marks the current identity");
		items = await ca.completeCommand("login ");
		values = (items ?? []).map((i) => i.value);
		assert(items !== null && !values.includes("login core-alpha ") && !values.includes("login core-beta "), `login completion excludes the own held names (${values.join(",")})`);
		assert(values.includes("login core-delta ") && items.find((i) => i.value === "login core-delta ").description === "online", "login completion offers peers with online markers");
		items = await ca.completeCommand("delete ");
		values = (items ?? []).map((i) => i.value);
		assert(items !== null && values.includes("delete core-offline ") && !values.includes("delete core-delta ") && !values.includes("delete core-alpha "), `delete completion lists offline names only (${values.join(",")})`);
	}

	// 3c. logout completion: claimed-spelling labels, case-folded prefix
	//     matching, and the current marker surviving a disconnect
	{
		const h = fakeHost({ sessionId: "core-sess-compl" });
		const cc = new MailboxController(h.host);
		await cc.login({ as: "Compl-Mixed" });
		await cc.disconnectAll();
		let items = await cc.completeCommand("logout ");
		const it = (items ?? []).find((i) => i.value === "logout compl-mixed ");
		assert(items !== null && it !== undefined && it.label === "Compl-Mixed", `logout shows the claimed spelling (${JSON.stringify(items)})`);
		assert(it !== undefined && it.description === "current identity", "the current marker survives a disconnect (binding fallback)");
		items = await cc.completeCommand("logout COMPL");
		assert(items !== null && items.length === 1, `logout matches the typed prefix case-insensitively (${JSON.stringify(items)})`);
	}

	// 4. multi-identity notification: one coalesced deliver, grouped by mailbox
	b.state.busy = false; // idle: the 300ms debounce path
	const peerLog = { notify: [], connected: 0, disconnected: 0 };
	const peer = new MailboxConnection("local", projectDir, null, "core-peer-sess", "core-peer-agent", {
		onNotify: (n) => peerLog.notify.push(n),
		onConnected: () => peerLog.connected++,
		onDisconnected: () => peerLog.disconnected++,
	}, { login: { as: "core-peer" } });
	await peer.start();
	await peer.mailbox.sendMail({ project: connA.mailbox.project, session: "core-alpha" }, "to alpha", "x");
	await peer.mailbox.sendMail({ project: connA.mailbox.project, session: "core-beta" }, "to beta", "x");
	const grouped = await poll(5000, () => a.state.delivered.find((t) => t.includes("to alpha") && t.includes("to beta")));
	assert(grouped !== undefined, "one coalesced notification covers both identities");
	assert(grouped.includes("across 2 mailboxes") && grouped.includes("In 'core-alpha'") && grouped.includes("In 'core-beta'"), "multi-identity notification groups per mailbox");
	assert(a.state.delivered.filter((t) => t.includes("to alpha")).length === 1, "no duplicate delivery (announced dedup)");

	// 4b. F2 regression: a second mail to the same identity must not re-list
	//     the already-announced one (dedup applies to the listing too)
	{
		await peer.mailbox.sendMail({ project: connA.mailbox.project, session: "core-beta" }, "beta second wave", "x");
		const second = await poll(5000, () => a.state.delivered.find((t) => t.includes("beta second wave")));
		assert(second !== undefined, "the second notification arrives");
		assert(second.includes("beta second wave") && !second.includes(": to beta"), "the second notification lists only the NEW mail (no re-announce)");
	}

	// 4c. F1 regression: concurrent same-name logins — the failing one must
	//     not clobber the winner's slot (ownership-checked rollback)
	{
		await ca.login({ as: "race-x" });
		assert(ca.isHeld("race-x"), "race-x precondition: held online");
		const realStart = MailboxConnection.prototype.start;
		let calls = 0;
		MailboxConnection.prototype.start = async function (...startArgs) {
			const n = calls++;
			if (n === 1) {
				// A (issued SECOND, its prologue clobbers B): fails fatally fast
				await new Promise((r) => setTimeout(r, 400));
				throw new core.MailboxError("login_failed", "simulated concurrent failure");
			}
			// B (issued first): succeeds slowly — A must not orphan it
			await new Promise((r) => setTimeout(r, 900));
			return realStart.apply(this, startArgs);
		};
		try {
			const pB = ca.login({ as: "race-x" }).then(() => "ok", (e) => String(e));
			const pA = ca.login({ as: "race-x" }).then(() => "ok", (e) => String(e));
			const aOutcome = await pA;
			assert(String(aOutcome).includes("login_failed"), `the clobbering login fails (${aOutcome})`);
			const bOutcome = await pB;
			assert(bOutcome === "ok", `the slow same-name login still wins (${bOutcome})`);
			let live = false;
			for (let i = 0; i < 30 && !live; i++) {
				await new Promise((r) => setTimeout(r, 100));
				live = ca.isHeld("race-x");
			}
			assert(live, "the winner is not orphaned: the controller still holds a live race-x connection");
			const binding = bindingFromEntries(a.state.entries).login;
			assert(binding !== null && binding.names.some((n) => n.toLowerCase() === "race-x"), "the binding is not wiped by the loser");
		} finally {
			MailboxConnection.prototype.start = realStart;
		}
		await ca.logout("race-x");
	}

	// 5. async deliver failure keeps the undelivered count for a retry
	{
		const failHost = fakeHost({ sessionId: "core-sess-c" });
		let failures = 2;
		const wrapped = {
			...failHost.host,
			deliver: async (text) => {
				if (failures > 0) {
					failures--;
					throw new Error("simulated deliver failure");
				}
				failHost.state.delivered.push(text);
			},
		};
		const cc = new MailboxController(wrapped);
		await cc.login({ as: "core-epsilon" });
		await peer.mailbox.sendMail({ project: connA.mailbox.project, session: "core-epsilon" }, "retry me", "x");
		const retried = await poll(6000, () => failHost.state.delivered.find((t) => t.includes("retry me")));
		assert(retried !== undefined && failures === 0, "a failing async deliver is retried until it succeeds");
		await cc.stop();
	}

	// 6. logout by name: one identity goes, the other stays
	await ca.logout("core-alpha");
	assert(!ca.heldNames.includes("core-alpha") && ca.heldNames.includes("core-beta"), "logout(name) removes exactly that identity");
	assert(ca.currentName === "core-beta", "current falls back to the remaining identity");
	const rel = bindingFromEntries(a.state.entries).releases;
	assert(rel.includes("core-alpha") && !rel.includes("core-beta"), "a pending release is recorded for the logged-out name only");
	assert(ca.connected, "the remaining identity stays connected");
	// logout all
	await ca.logout();
	assert(ca.heldNames.length === 0 && !ca.connected, "logout() clears every identity");

	// 7. readLoginBinding: session FILE parsing without opening a session
	{
		const sf = join(projectDir, ".pi", "sessions");
		mkdirSync(sf, { recursive: true });
		const file = join(sf, "20260101_core-sess-file.jsonl");
		const e = (customType, data) => JSON.stringify({ type: "custom", customType, data });
		writeFileSync(file, [
			JSON.stringify({ type: "user", text: "hi" }),
			e("pi-mailbox-login", { name: "first" }),
			e("pi-mailbox-login", { name: "second", names: ["first", "second"] }),
			e("pi-mailbox-release", { names: ["first"] }),
		].join("\n") + "\n");
		const read = readLoginBinding(file);
		assert(read.login?.names.join(",") === "first,second" && read.login?.current === "second", "readLoginBinding returns ALL bound names + current");
		assert(read.releases.join(",") === "first", "readLoginBinding returns pending releases");
		const missing = readLoginBinding(join(sf, "nope.jsonl"));
		assert(missing.login === null && missing.releases.length === 0, "a missing session file reads as no binding");
	}

	// 7b. channel bindings: caps gate, tool CRUD, /mailbox binding command,
	//     arbitration errors, and an end-to-end webhook round to a local bot
	{
		const h7 = fakeHost({ sessionId: "core-sess-binding" });
		const c7 = new MailboxController(h7.host);
		await c7.login({ as: "core-cmd" });
		assert(c7.supportsBindings, "controller sees the bindings capability (caps)");
		assert(c7.supportedChannels().includes("webhook"), "supportedChannels derives from caps");
		const http = await import("node:http");
		const crypto = await import("node:crypto");
		const requests = [];
		const bot = http.createServer((req, res) => {
			let body = "";
			req.on("data", (d) => (body += d));
			req.on("end", () => {
				requests.push({ headers: req.headers, body });
				res.writeHead(200);
				res.end();
			});
		});
		await new Promise((r) => bot.listen(0, "127.0.0.1", r));
		const botPort = bot.address().port;
		try {
			// tool: add (config is a JSON STRING — channel-defined passthrough)
			const bindTool = Object.fromEntries(c7.tools.map((t) => [t.name, t]))["mailbox_bindings"];
			assert(bindTool !== undefined, "mailbox_bindings tool exported");
			const added = await bindTool.execute("tb1", {
				action: "add",
				channel: "webhook",
				config: JSON.stringify({ url: `http://127.0.0.1:${botPort}/hook`, secret: "coresecret", headers: { "X-Bot-Key": "bkey" } }),
				targets: ["core-botbox"],
			});
			const bid = added.content[0].text.split(" ")[1];
			assert(/^b[0-9a-z]{10}$/.test(bid), `add returns the binding id (${bid})`);

			// arbitration: an online-held name is refused with mailbox_in_use
			let refused = false;
			try {
				await bindTool.execute("tb2", { action: "add", channel: "webhook", config: JSON.stringify({ url: `http://127.0.0.1:${botPort}/hook`, secret: "coresecret" }), targets: ["core-delta"], force: true });
			} catch (e) {
				refused = /mailbox_in_use/.test(String(e.message));
			}
			assert(refused, "binding a name held online is refused (mailbox_in_use)");

			// end-to-end: mail to the bound mailbox -> signed summary POST
			await peer.mailbox.sendMail({ project: peer.mailbox.project, session: "core-botbox" }, "for the bot", "snip me", []);
			const req1 = await poll(5000, () => requests[0]);
			assert(req1 !== undefined, "webhook POST arrived");
			const p = JSON.parse(req1.body);
			assert(p.event === "mail.batch" && p.mailbox === `core-botbox@${peer.mailbox.project}` && p.mailCount === 1, "payload shape (event/mailbox/mailCount)");
			assert(p.mails[0].snippet === "snip me" && p.mails[0].body === undefined, "summary carries a snippet, never the full body");
			assert(typeof p.unreadCount === "number" && p.unreadCount >= 1, "payload carries unreadCount for reconciliation");
			const ts = req1.headers["x-mailbox-timestamp"];
			const sig = req1.headers["x-mailbox-signature"];
			const expectSig = crypto.createHmac("sha256", "coresecret").update(ts + "." + req1.body).digest("hex");
			assert(sig === expectSig && req1.headers["x-bot-key"] === "bkey", "HMAC signature + static header verify");

			// tool: list (redacted) + command round-trip
			const listed = await bindTool.execute("tb3", { action: "list" });
			assert(listed.structuredContent.bindings.some((b) => b.id === bid), "list (tool) returns the binding");
			assert(!JSON.stringify(listed).includes("coresecret"), "list output never echoes the secret");
			await c7.executeCommand("binding list");
			assert(h7.state.notifies.some((n) => n.msg.includes(bid) && n.msg.includes("core-botbox")), "/mailbox binding list shows the binding");
			// completion: binding subcommands + ids
			let items = await c7.completeCommand("binding ");
			assert((items ?? []).some((i) => i.value === "binding list "), "binding completion offers subcommands");
			items = await c7.completeCommand("binding update ");
			assert((items ?? []).some((i) => i.value === `binding update ${bid} `), `binding update completes ids (${bid})`);
			// command: update (disable) + delete
			await c7.executeCommand(`binding update ${bid} --enabled off`);
			assert(h7.state.notifies.some((n) => n.msg.includes("disabled")), "/mailbox binding update disables");
			// disabled releases the target: claim without force succeeds
			const h8 = fakeHost({ sessionId: "core-sess-claim" });
			const c8 = new MailboxController(h8.host);
			await c8.login({ as: "core-botbox" });
			assert(c8.connected, "a disabled binding releases its target (claimable without force)");
			await c8.stop();
			// command: delete
			await c7.executeCommand(`binding delete ${bid}`);
			assert(h7.state.notifies.some((n) => n.msg.includes("deleted")), "/mailbox binding delete removes it");
			assert((await c7.bindingList()).length === 0, "list empty after delete");
			await c7.stop();
		} finally {
			await new Promise((r) => bot.close(r));
		}
	}

	// 7c. controller stop is revivable: session_shutdown stops the shared
	//     controller; restart() (the next session's session_start) brings
	//     it back from the stored binding (BUG-MAILBOX-CONTROLLER-STOP)
	{
		const h = fakeHost({ sessionId: "core-sess-revive" });
		const c = new MailboxController(h.host);
		await c.login({ as: "core-revive" });
		assert(c.connected && !c.isStopped, "precondition: connected");
		c.onShutdown(); // the session_shutdown path
		assert(c.isStopped && !c.connected, "onShutdown stops the controller");
		let threw = false;
		try {
			await c.requireConnection();
		} catch (e) {
			threw = /controller stopped/.test(String(e.message));
		}
		assert(threw, "a stopped controller rejects operations");
		// autoConnect must NOT revive on its own (explicit restart only)
		await c.autoConnect();
		assert(c.isStopped && !c.connected, "autoConnect alone does not revive a stopped controller");
		// restart: silent reconnect from the stored binding
		await c.restart();
		assert(!c.isStopped && c.connected, "restart() revives the controller from the stored binding");
		// the revived controller still works end to end: mail arrives and is announced
		await peer.mailbox.sendMail({ project: peer.mailbox.project, session: "core-revive" }, "revived", "after restart", []);
		const revived = await poll(5000, () => h.state.delivered.find((t) => t.includes("revived")));
		assert(revived !== undefined, "the revived controller delivers notifications");
		await c.stop();
	}

	// 8. daemon isolation: everything lived under the temp PI_MAILBOXD_DIR
	assert(existsSync(join(home, "mailboxd.json")), "the daemon registry stayed inside PI_MAILBOXD_DIR");

	await peer.stop();
	await cb.stop();
	rmSync(join(projectDir, ".pi", "sessions"), { recursive: true, force: true });
	console.log("\nall core tests passed");
} finally {
	try {
		const fs = await import("node:fs");
		const reg = JSON.parse(fs.readFileSync(join(home, "mailboxd.json"), "utf8"));
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
process.exit(0);
