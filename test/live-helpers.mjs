// Shared helpers for the manual live tests: an ISOLATED mailboxd (freshly
// built from source, own registry/home) plus herdr CLI wrappers, so the
// tests never touch the user's real daemon. The herdr-spawned agents reach
// the isolated daemon through tab env vars (PI_MAILBOXD_DIR / PI_MAILBOXD).
//
// Not CI; requires go on PATH and a running herdr.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Boot an isolated daemon from the current sources; returns its home dir,
 *  binary path, port, and the tab-env spec the herdr tabs need. */
export function setupIsolatedDaemon(label) {
	const home = mkdtempSync(join(tmpdir(), `pi-mailbox-live-${label}-`));
	const daemonDir = join(import.meta.dirname, "..", "mailboxd");
	const daemonBin = join(home, "mailboxd.exe");
	// always build from the current source: the repo exe may be stale/locked
	const built = spawnSync("go", ["build", "-o", daemonBin, "./"], { cwd: daemonDir, encoding: "utf8" });
	if (built.status !== 0) throw new Error(`go build failed: ${built.stderr}`);
	process.env.PI_MAILBOXD_DIR = home;
	process.env.PI_MAILBOXD = daemonBin;
	// env for herdr tabs (the spawned pi resolves the daemon through these)
	const tabEnv = `PI_MAILBOXD_DIR=${home};PI_MAILBOXD=${daemonBin}`;
	process.env.PI_MAILBOX_TEST_TAB_ENV = tabEnv;
	process.env.PI_MAILBOX_TEST_PI_ARGS = `-ne -e ${join(import.meta.dirname, "..", "src", "index.ts")}`;
	const registryPath = join(home, "mailboxd.json");
	// teardown on any exit: stop the isolated daemon and drop the temp home
	// (incl. the ~11 MB binary built into it)
	process.on("exit", () => {
		try {
			const reg = JSON.parse(readFileSync(registryPath, "utf8"));
			if (typeof reg.pid === "number" && reg.pid > 0) {
				// synchronous kill: the binary must be unlocked before rmSync
				if (process.platform === "win32") {
					try { spawnSync("taskkill", ["/F", "/PID", String(reg.pid)], { stdio: "ignore" }); } catch { /* already gone */ }
				} else {
					try { process.kill(reg.pid); } catch { /* already gone */ }
				}
			}
		} catch { /* no registry: daemon never started */ }
		try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
	});
	const port = () => JSON.parse(readFileSync(registryPath, "utf8")).port;
	const apiDelete = (address) => {
		try {
			const p = port();
			return spawnSync(
				"curl",
				["-s", "-X", "POST", `http://127.0.0.1:${p}/api/delete`, "-H", "Content-Type: application/json", "-d", JSON.stringify({ address })],
				{ encoding: "utf8" },
			);
		} catch {
			// daemon or registry already gone (another exit handler cleaned
			// up first): nothing to delete through
			return null;
		}
	};
	return { home, daemonBin, port, tabEnv, apiDelete, registryPath };
}

/** Delete leftover test mailboxes from earlier runs (idempotent, survives
 *  hard kills of previous runs — exit handlers do not fire on SIGKILL).
 *
 * The predicate matches the mailbox's _origin (the creating client's
 * session id): every mailbox a live test creates carries one of the
 * TEST_ORIGIN_PREFIXES, while a real account's origin is a genuine pi
 * session id — so real mailboxes can never match, even when their names
 * merely start with a test-ish prefix (e.g. a legit "pr-lead"). The name
 * shape check (prefix + base36 timestamp) is a secondary guard. */
const TEST_ORIGIN_PREFIXES = ["login-test-", "notif-test-", "held-holder-", "name-taker-", "login-sender-"];
const TEST_NAME_SHAPE = /^(nr|nt|held|pr|snd)-[0-9a-z]{6,}$/;

export async function sweepTestMailboxes(connection, apiDelete, project) {
	try {
		const sessions = await connection.mailbox.sessions(true);
		for (const s of sessions) {
			const origin = (s.meta ?? {})._origin ?? "";
			if (
				!s.online &&
				(s.meta ?? {})._named === "1" &&
				TEST_ORIGIN_PREFIXES.some((p) => origin.startsWith(p)) &&
				TEST_NAME_SHAPE.test(s.session)
			) {
				apiDelete(`${s.session}@${project}`);
			}
		}
	} catch {
		// best effort: a failed sweep must not fail the test
	}
}

/** Run one herdr CLI command; resolves with its `result` object. */
export function herdr(args, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const child = spawn("herdr", args, { windowsHide: true });
		let out = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`herdr ${args[0]} timeout`));
		}, timeoutMs);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", () => {
			clearTimeout(timer);
			try {
				resolve(JSON.parse(out).result);
			} catch (e) {
				reject(e);
			}
		});
	});
}

/** Create a herdr tab in the project's workspace, carrying the isolated
 *  daemon env; resolves the new pane id. */
export async function newProjectTab(projectDir, label) {
	const panes = (await herdr(["pane", "list"])).panes;
	const ws = panes.find(
		(p) => p.cwd && p.cwd.replace(/\\/g, "/").toLowerCase() === projectDir.replace(/\\/g, "/").toLowerCase(),
	);
	if (!ws) throw new Error("no herdr workspace for this project");
	const env = process.env.PI_MAILBOX_TEST_TAB_ENV.split(";").flatMap((kv) => ["--env", kv]);
	const tab = await herdr(["tab", "create", "--workspace", ws.workspace_id, "--label", label, ...env]);
	return tab.root_pane.pane_id;
}

/** pi sessions dir for a project root (mirrors pi's per-character slug). */
export function sessionsDirFor(projectDir, home = null) {
	const base = home ?? (process.env.USERPROFILE ?? process.env.HOME);
	return join(base, ".pi", "agent", "sessions", `--${projectDir.replace(/[:\\/]/g, "-")}--`);
}
