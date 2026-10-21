# pi-mailbox

A mailbox service and [pi](https://github.com/earendil-works/pi) extension for
cross-session agent messaging within a project.

The service is `mailboxd`, a standalone Go daemon: one process serves every
project that connects to it, holding a crash-safe flock for singleton
election, and exiting after an idle period with no clients. The extension is
a pure client that spawns the daemon on demand. See [mailboxd](#mailboxd)
below.

## How it works

- One mailboxd process serves the whole machine: it holds an exclusive
  flock on `~/.pi/mailboxd.leader` (the OS releases it when the process
  dies), records its address in `~/.pi/mailboxd.json`, and exits after an
  idle period with no clients. The extension probes that address and spawns
  the daemon when dead.
- Ids are short and deterministic (base36): a per-machine host id
  (`~/.pi/mailbox-host-id`, 16 hex chars, created once), a project id
  `base36(sha256(hostId + path))[0:8]`, and a session id
  `base36(sha256(agent + sessionId))[0:10]` (unique per project, per agent).
  The daemon treats ids as opaque strings. It routes by project and stores
  data in `<project>/.pi/mailbox/` (local mode). Addresses are
  `session@project`; a bare session id means the own project.
- Mails are immutable: send, read, and reference only. No editing, no
  comments, no deletion (yet). A mail is addressed by the triple
  `{project, session, mail}`; knowing the triple is the capability to read it.
  "Comments" are modeled as new mails that reference the original via `refs`.
- Offline delivery: the target of a send must have a mailbox (i.e. have
  registered at least once) but does not need to be online — offline mail
  is delivered as unread on the target's next connection.
- Sessions register per project; a session may instead **log in to a named
  mailbox** (`/mailbox login <name> [tags=a,b]` or `mailbox_connect` with
  `as`): the mailbox is then keyed by the name, inheriting its mails, tags,
  and meta wholesale. Named mailboxes are persistent accounts — only
  removed explicitly. Login names are 1-255 chars `[A-Za-z][A-Za-z0-9_-]`
  (never a derived-id shape, `user` reserved case-insensitively). Case is
  DISPLAY-only: the canonical identity is lowercase (mailbox files,
  registration, comparisons), the claimed spelling is kept for display
  (the `_case` meta, the welcome's mailbox field), and every address use
  — login, send, read, delete — is case-insensitive. One wrinkle: the
  `/mailbox login <Name>` command lowercases its argument (historical
  behavior), so THAT path claims the lowercase spelling and refreshes
  `_case` accordingly; `mailbox_connect as=`, rename-to-login, and resume
  keep the claimed spelling as typed.
  MULTI-LOGIN: a session may hold several names at once — each name is
  its own connection (notify routes per connection), a name is still
  held by AT MOST one session, and the daemon tracks the reverse binding
  (`_holds` on the session's own record: a set of names, O(1) per login).
  Consecutive `/mailbox login <name>` calls accumulate identities; the
  last successful login is the CURRENT identity (tools and commands act
  on it unless given `as=<name>`); `/mailbox logout <name>` releases one
  name, `/mailbox logout` (alias `off`) releases all. Bindings are
  released by logout (model E): the client records pending releases that
  ride the NEXT hello (a comma-separated name list), surviving daemon
  downtime and pi restarts. The daemon clears the names from `_holds` on
  the caller's derived record — never `_origin`, never the named record.
  A stale reverse binding (a name was taken over or deleted) self-heals
  against the authoritative `_origin`. The release is
  client-asserted, same trust class as `force` within a project.
  Old daemons (pre multi-login) still enforce one name per session: a
  second login is rejected with `session_bound` and the client degrades
  to single-login (bidirectional version compatibility).
  The extension refuses nameless connections entirely: a session with no
  login gets "no login for this session" from every connect path — named
  accounts are the only identity.

  Claim rules (S = the claiming session, X = the claimed name):
  - X free, or already S's (offline resume / online reconnect): succeeds.
  - X held ONLINE by another session: `mailbox_in_use` — force can never
    displace a live holder; ask that session to log out.
  - X held OFFLINE by another session: `name_held` — previously this
    takeover happened silently; it now requires an explicit, confirmed
    force (`/mailbox login <name> --force`, or `mailbox_connect` with
    `force: true` right after the normal attempt failed with name_held).
    The agent-side force is gated: it is only honored within 5 minutes
    after a normal attempt for the same name failed with `name_held`
    (typing `--force` in the command is itself the user's confirmation).
  - S already holds other names: fine (multi-login) — force is irrelevant
    for the claim itself; the exclusivity rules above still apply per name.
  Note "offline" means the mailbox connection is down: a pi process that
  is alive but disconnected can be taken over after confirmation. A
  displaced session's next auto-login fails (name_held/mailbox_in_use),
  its stale binding is cleared, and it is told to log in again; a forced
  takeover is logged by the daemon. Note that "same origin" means
  the last holder's pi session id (the `_origin` meta, visible to every
  session via `mailbox_sessions`): within a trusted project this lets a
  member replace even a live holder by replaying the origin — acceptable in
  the local/remote trust model, but prefer asking the holder to log out.
  Login overwrites the display name with the claimed name and the tags
  when given (omitted tags are inherited). The FULL set of held names is
  persisted in the pi session file (`pi-mailbox-login` entries), so resumes
  auto-login into every held identity; a stored binding name that is now
  held elsewhere is dropped from the binding with a displacement notice
  instead of failing the connection. `/mailbox logout [<name>]` (alias
  `off` for all) disconnects AND clears the binding. Named mailboxes are
  permanent accounts: they are only deleted explicitly from the web UI (or
  `POST /api/delete`) while offline.
- Session meta is cookie-like key/value data (`Record<string, string>`;
  keys match `/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/`, values are capped at 512
  chars, at most 32 user keys and 8 system keys). Keys starting with `_` are
  system-reserved and set automatically at registration time: `_model`
  (provider/model), `_pi` (pi version), and — local mode only, not sent to
  remote services — `_host` and `_platform`. User keys set via `/mailbox set`
  or `name`/`tag` persist server-side and survive reconnects and daemon
  restarts; registration-time defaults never overwrite an existing user
  key. The welcome reply returns the session's full merged meta.
- Storage is a per-session JSONL event log at
  `<project>/.pi/mailbox/<sessionId>.jsonl` (`send` / `read` / `meta` events),
  lazily loaded, replayed on service start.
- No unnamed mailboxes: every connection must claim a named account
  (hello without `as` is rejected with `name_required`). The derived
  bookkeeping record of a named login (the `_holds` reverse marker) is
  in-memory only for the daemon's lifetime: the multi-name set is
  remembered across reconnects, but a daemon restart forgets it. Mailbox
  files on disk are never garbage-collected; remove stale ones manually.
- Delivery: new-mail notices are coalesced at turn boundaries. While the
  agent runs, arriving notifies are held and flushed as ONE steered
  message at the next `turn_end` (the earliest moment a steered message is
  processed — the next LLM call), listing the subjects of new, not yet
  announced mails; while idle, the notice is submitted directly after a
  short debounce. Mail from the web UI `user` session (the human operator)
  is called out with priority instructions: quick tasks are handled and
  replied to immediately, large ones get a brief acknowledgment now and a
  full reply after the current work. After reconnect, the unread count is
  backfilled through the same path.
- herdr wake (opt-out): when a send targets an offline session that runs on
  this machine and [herdr](https://herdr.dev) is up, the sender's extension
  wakes it instead of waiting for its next connection: it finds (or creates)
  the project's herdr workspace, opens a fresh tab, resumes the target's
  exact pi session there (`pi --session-id`, same session id -> same
  mailbox identity -> unread backfill applies), and prompts the agent to
  connect and handle the mail. If the target's pi is already running in a
  herdr pane (e.g. mailbox-disconnected), it is prompted in place. Wake is
  best-effort and never fails the send; disable per send with `wake: false`.
  When herdr is unavailable (no binary / server down) the wake is silently
  skipped. The wake tab is opened with the project root as its cwd — pi
  derives both its session directory and its mailbox identity from cwd.
  Cross-project, remote-mailbox, and off-host targets are skipped (the
  target must carry a local `_host` and an `_origin` in its meta). The wake
  is resume-only and name-aware: a named target's prompt carries the name
  so the woken agent claims it, and when the last holder's pi session file
  no longer exists the wake fails cleanly (never a fresh identity-less
  spawn) — the name can then be claimed manually. Legacy derived mailboxes
  are not woken (the extension cannot connect nameless).

  Upgrade note: with named-only logins, a session whose mailbox is a
  derived id can no longer connect, read, or reply at all — its existing
  mail is readable only in the web UI. Log such sessions in with
  `/mailbox login <name>` (a fresh, empty named mailbox; nothing is
  inherited from the derived one).

## Commands

`/mailbox` supports argument completions (pi's getArgumentCompletions
hook): subcommands with descriptions for the first argument, and live
mailbox-name completion for `login`/`resume` (all named mailboxes,
marked online/offline) and `delete` (offline ones only — online holders
cannot be deleted). Name completion queries through the connected
session only; a down daemon yields no suggestions.

- While connected, the session's mailbox address (name@project) rides on
  the pi footer's FIRST line, right after the project path and git branch
  — a custom footer component subclassing pi's default (stats line and
  extension statuses unchanged, no extra height). The address clears on
  disconnect. The default footer's AgentSession dependency is served by a
  small proxy over the extension context (two fidelity losses: the "(sub)"
  cost suffix for subscription providers is not detected, and virtual-model
  routing never shows its "→ <model>" suffix).
- Sessions that have logged in before auto-connect silently on startup
  when the daemon is already running (never spawning it): the stored
  binding re-claims its name, and mail notifications resume. A permanent
  login rejection during auto-connect (e.g. the name was taken over)
  surfaces to the user; everything else stays silent. Auto-connect always
  targets the LOCAL daemon: a remote target from `/mailbox host:port` is
  not remembered — reconnect to it explicitly.
- `/mailbox` — show a one-line status summary (mail counts, clients
  online); requires an active connection
- `/mailbox host:port [token]` — connect to a remote mailboxd (token
  required by remote-mode daemons)
- `/mailbox list [client [all]|mail]` — list online sessions, all
  mailboxes (with `all`, including offline ones marked `-`; the own
  session is marked `(you)`), or this session's mail (default: mail,
  same as `/mailbox`). The client listing also works while NOT logged
  in (read-only view through the daemon's HTTP API, no mailbox created;
  like resume, it may start the daemon to do so; `(you)` is omitted
  then)
- `/mailbox name <name>` — set this session's display name (persists across
  reconnects; a name set once is not overwritten by later registration
  defaults)
- `/mailbox tag <a,b,...>` — set this session's tags
- `/mailbox set k=v [k2=v2 ...]` — set meta values (cookie-like key/value)
- `/mailbox unset k [k2 ...]` — remove meta values
- `/mailbox meta` — show this session's full meta
- `/mailbox read <mailId>` — view one mail
- `/mailbox login <name> [tags=a,b]` — log in to a named mailbox (persistent
  identity; tags overwrite when given, inherited when omitted). MULTI-LOGIN:
  repeated logins ADD names to the session's held set (the last one becomes
  the current identity the tools and commands act on); a held name still
  rejects with name_held/mailbox_in_use and force works per name as before.
  The footer shows the current address plus `+N` when more identities are
  held; the unread badge totals across all of them.
- `/mailbox logout [<name>]` — log out of one held name (disconnect its
  connection, drop it from the binding, record a pending daemon-side
  release that rides the next hello); without a name, log out of EVERY
  held identity (`off` is an alias of the full logout)
- Rename-to-login: renaming the pi session (pi's `/name`) to a name that
  is a VALID mailbox name, while the session has no mailbox identity yet
  (not connected, no stored binding), logs in to that mailbox — the same
  effect as `/mailbox login <name>` (the claimed spelling becomes the
  display case of the canonical lowercase name). Display names that are
  not valid mailbox names (spaces, non-ASCII, digit-first) never trigger
  it — case is a valid mailbox spelling; a
  rename never re-logins an identified session and never forces a
  takeover; the daemon must already be running (no spawn).
- `/mailbox delete <name> [<name> ...]` — hard-delete mailboxes in this
  project (mails, meta, registration — irreversibly; local mode only, no
  login required). Works for named and derived mailboxes; the holder
  must be offline — an online mailbox (including your own current login)
  is skipped; log out first, then delete. Multiple names are processed
  best-effort in the order given (whitespace-separated, deduplicated):
  unknown or online names are skipped and reported in the summary, a
  failed delete never aborts the rest of the batch.
- `/mailbox resume <name>` — switch THIS terminal to the named mailbox's
  session in place (pi's switchSession). The name is resolved through the
  daemon's read-only HTTP API, so the current session needs NO mailbox of
  its own — a fresh session can resume directly without creating an
  address. The lookup starts the daemon if none is running (like
  /mailbox login) and asks it to load the project on demand, so it works
  even against a freshly spawned daemon. Fails when the name is unknown,
  online (its holder runs elsewhere), or the session file is gone (claim it with
  `/mailbox login <name> [--force]` instead); a live-but-disconnected
  holder is detected through herdr when available. The switched-to session
  auto-logins through its stored binding.
- `/mailbox start service` — connect (spawns the daemon if needed)
- `/mailbox stop service` — disconnect (the daemon itself keeps running
  until its idle timeout, or `mailboxd --stop`)
- `/mailbox restart service` — disconnect and reconnect
- `/mailbox status` — connection status

## Agent tools

`mailbox_connect` (optional `as`/`tags` to log in to a named mailbox) is
declared from the start so the agent can enable the mailbox on its own when
it needs to talk to other sessions; calling it connects and activates the
tools below (they are `deferred` until then, or until the user runs
`/mailbox`). With `as`, an already-connected session logs in to ANOTHER
name (multi-login: adds to the held set and switches the current identity)
instead of reconnecting:

- `mailbox_list [unreadOnly] [since] [limit] [cursor] [as]` — list this
  session's mail, newest first, paginated (default page 20, max 100); the
  reply carries a `cursor` token to fetch older mails
- `mailbox_read <mail> [session] [project] [as]` — read a mail by triple
- `mailbox_send <session> <subject> [body] [refs] [wake] [as]` — send to a
  registered session (online or offline)
- `mailbox_reply <mail> <body> [wake] [as]` — reply to a mail (auto
  recipient, refs, and `Re:` subject)
- `mailbox_sessions [includeOffline]` — list sessions with name, tags, and
  meta (every held identity of yours is marked `(you)`); offline mailboxes
  included on request

The optional `as` selects the held identity for the operation (default:
the current identity — the last successful login).

## Protocol

See `src/protocol.ts` for the full message set. Requests carry a `rid`;
responses echo it. `notify` is the only unsolicited push. Send validates
sizes: subject <= 256 chars, body <= 64 KiB, at most 16 refs. Inbox queries
are paginated: `limit` (default 20, max 100) plus an opaque `cursor`
token; every reply also carries mailbox-wide `total` / `totalUnread`.

## Development

```
npm install --ignore-scripts
npm run check          # tsc --noEmit (everything, incl. the pi shell)
npm run check:core     # the core chain under the FULL strict config
                       # (see "Embedding the core" below) — what vendoring
                       # hosts run against
node --experimental-strip-types --no-warnings test/smoke.mjs
cd mailboxd && go test ./...
```

Host-agnostic core tests (fake hosts + a real isolated daemon; multi
controllers, multi-login, async deliver, binding-file parsing):

```
node --experimental-strip-types --no-warnings test/core-test.mjs
```

The herdr wake and the notification injection have manual end-to-end demos
(real daemon + running herdr; they spawn live pi agents in new tabs and
clean them up afterwards — see `src/herdr.ts` and the notification section
in `src/index.ts`):

```
node --experimental-strip-types --no-warnings test/notif-live-test.mjs
node --experimental-strip-types --no-warnings test/login-live-test.mjs
```

Both build an isolated mailboxd from the current sources (own registry, go
required) and never touch the running daemon.

## Embedding the core (hosts other than pi)

The plugin is a thin shell over a host-agnostic core: `src/index.ts` (the
pi extension) is just one host; the core lives in `src/core/` and is
loadable directly from Node — erasable TypeScript only (no enum /
namespace / parameter properties), relative imports carry `.ts`
extensions, and `package.json` `exports["./core"]` points at
`src/core/index.ts`. Runtime dependencies are exactly `ws` + `typebox`
(versions declared in package.json; additions are release-notes-worthy).

**The contract**: `MAILBOX_CORE_API_VERSION` (semver). A host checks the
MAJOR version at startup and refuses to enable on a mismatch; within a
major version, plugin-internal changes (notification wording, tool
behavior, wire details) are invisible to the host. Every release is
tagged (`v1.0.0` onward); hosts pin a submodule or a tag.

```ts
import {
  MailboxController, type MailboxHost,
  MAILBOX_CORE_API_VERSION, coreApiMajor,
  readLoginBinding, resolveLocalDaemon,
} from "pi-mailbox/core";   // or a relative path into the submodule

if (coreApiMajor() !== 1) throw new Error("incompatible mailbox core");

// one controller per session; N controllers coexist in one process
const controller = new MailboxController({
  identity: { agent: "pi", sessionId, cwd },   // same derivation as the TUI
                                              // (identity may be getters: it is read
                                              //  live per call — but the host MUST
                                              //  ensure it is resolvable before the
                                              //  first core call; in pi, session_start
                                              //  precedes everything)
  loginStore: { readLogin, writeLogin, readRelease, writeRelease },
  deliver: async (text) => { /* into the agent's input stream */ },
  isBusy: () => boolean,
  // optional: notify, setUnread(total, byName?), canDeliver, helloMeta,
  //           onConnectionChanged, wake, findLiveSession, switchSession,
  //           openUrl, sessionDir
});

await controller.login({ as: "worker" });   // multi-login: repeat to add names
for (const def of controller.tools) /* register with your tool system */;
await controller.executeCommand("list");     // /mailbox subcommands
await controller.autoConnect();               // stored binding (all names)
controller.stop();                            // the ONLY stop path
```

Host-facing surface:
- `controller.tools` — the 7 tool definitions (names, descriptions,
  schemas, output text identical to the plugin; `mailbox_list` / `_read` /
  `_send` / `_reply` take an optional `as` for multi-login identity
  selection).
- `controller.executeCommand(arg)` / `completeCommand(prefix)` — the
  `/mailbox` command, output via `host.notify`.
- Event entry points: `onAgentStart` / `onAgentEnd` / `onAgentSettled` /
  `onTurnEnd` / `onSessionNameChanged` — forward them from your agent
  runtime; silence never disconnects (the controller stops only on
  `stop()`).
- `deliver` may be async — the notification pipeline awaits it and
  retries later on failure (a host can open a session on demand).
- `readLoginBinding(sessionFile)` — read a pi session file's full binding
  (all held names + pending releases) without opening the session; use it
  at service startup to find managed sessions and their names.
- `MAILBOX_EXTENSION_ID` (`"pi-mailbox"`) — identify and EXCLUDE the
  plugin extension when your host loads pi's installed extensions, so the
  same identity is not logged in twice.

The core chain (`src/core/**`, `src/client.ts`, `src/daemon.ts`,
`src/protocol.ts`) passes tsc under the strictest vendoring config —
`tsconfig.core.json` (`strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`,
`erasableSyntaxOnly`, `allowImportingTsExtensions`, `isolatedModules`,
`module/moduleResolution: nodenext`, `noEmit`); `npm run check:core`
runs the same check.

**Version coexistence**: a submodule-pinned host and a `pi update`d
plugin may run different versions against the SAME daemon. The wire
protocol (v2) is stable and bidirectionally compatible within a major
version: the core only connects to an already-running daemon (probing the
registry first) and never replaces a running one; it spawns a daemon only
when the host asks explicitly (`controller.ensureDaemon()` — the pi shell
wires it to `/mailbox start service` / `restart service` and nothing else)
— using the binary resolved by `findMailboxdBinary()` relative to ITS OWN
sources (i.e. the submodule's copy; override with `$PI_MAILBOXD`). Multi-login needs mailboxd >= v1.0.0; an older daemon
simply keeps rejecting second logins with `session_bound` (single-login
behavior, clean error paths).

**Test isolation**: `PI_MAILBOXD_DIR` redirects the whole daemon state
triple — registry (`mailboxd.json`, the port file), singleton lock
(`mailboxd.leader`), and host identity (`mailbox-host-id`) — so hosts run
a fully isolated mailboxd in a temp dir. The daemon listens on
`127.0.0.1:0` (random port) by default and writes the actual port into
the registry file; `--listen host:port` pins one, `--registry`/`--lock`
override paths explicitly. `test/smoke.mjs` and `test/core-test.mjs` both
run this way and never touch `~/.pi`.

**Other platforms**: `mailboxd/` always carries the full Go source —
a single static binary, no cgo. `cd mailboxd && go build` on any
platform; cross-compile with `CGO_ENABLED=0 GOOS=<os> GOARCH=<arch> go
build`. The Windows `mailboxd.exe` in-repo is a convenience only;
`findMailboxdBinary()` picks `mailboxd`/`mailboxd.exe` per platform.

## mailboxd

The Go daemon (`mailboxd/`) is a single static binary. Build it with
`go build` in `mailboxd/`; cross-compile with the usual `GOOS`/`GOARCH`
(plus `CGO_ENABLED=0`).

**Local mode (default)**: listens on `127.0.0.1` with a random port, holds
an exclusive flock on `~/.pi/mailboxd.leader` for singleton election, and
writes its address to `~/.pi/mailboxd.json`. Data lives in each project's
`.pi/mailbox/` directory (the client supplies the project root). Exits after
`--idle-exit` (default 5m) with zero connected clients.

**Web UI**: `mailboxd view` prints (and with `--open` opens) the address of
the running daemon's read-only web UI — a viewer for projects, sessions,
mailboxes, and mails (unread markers, refs, full meta). Remote daemons
require `--host` and a token; the token travels in the URL fragment and is
moved into an Authorization header by the page. In pi, `/mailbox view` does
the same from an extension session. The UI never mutates agent state: reading
through it does not mark mails read. Its write capabilities are the user's
own mail and mailbox deletion: the browser sends as 'user@<project>' (a
reserved session id per project; the first send implicitly registers the
user's mailbox there), agents can reply to or proactively mail
'user@<project>' like any session, and the user can delete an offline
session's mailbox entirely (mails, meta, registration — hard delete, the pi
session file is never touched; refs from other mailboxes simply stop
resolving and surface as orphan roots).

**Remote mode** (`--listen` on a non-loopback address): serves external
  machines, requires `--token`/`--token-file`, stores all projects under
  `--data-dir` (client paths are never trusted), and stays up (idle exit is
  disabled unless `--idle-exit` is set explicitly). `/mailbox login` dials
  the local daemon; to log in on a remote daemon, first connect with
  `/mailbox host:port token` using a session that already carries a stored
  login binding (tags are set afterwards via `/mailbox tag`).

Note on identity changes: ids are derivations, so any change to the
  derivation inputs (agent kind, session id, host id, project path) maps a
  session to a new mailbox. The old mailbox file is not migrated — its mails
  stay on disk, invisible to the relocated session; delete it manually if
  no longer wanted.

The wire protocol is protocol v2: `hello` carries the short project id,
  the project root (local mode), and the session's origin id (the full pi
  session id, stored as the `_origin` system meta), plus an optional token;
  `welcome`/`pong` carry a `protocolVersion`.
  Cross-project sends are allowed when the target project is also registered
  on the daemon. See `mailboxd/protocol.go`.

The extension locates the `mailboxd` binary via `$PI_MAILBOXD`, then
`<package>/mailboxd/mailboxd[.exe]`. Build it with `go build` in `mailboxd/`
(or cross-compile with `CGO_ENABLED=0 GOOS=... GOARCH=... go build`).
The daemon's registry lives under `$PI_MAILBOXD_DIR` (default `~/.pi`).
When spawning a daemon, the extension routes its stderr (startup,
shutdown, takeover log lines) to `$PI_MAILBOXD_LOG` when set — useful
for diagnosing spawn-related issues; unset, stderr is discarded.

## Install

Install from GitHub (see [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)):

```
pi install git:github.com/rexzhao/pi-mailbox
```

Or from a local checkout: `pi install ./pi-mailbox`.
