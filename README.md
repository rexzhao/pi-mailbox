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
  is delivered as unread on the target's next connection. Delivery is
  best-effort: once a session's pi session is deleted and its mailbox is
  collected by the GC, mail to it fails (no_mailbox) and previously sent
  mail becomes unreachable.
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
- Lifecycle GC: mailboxes are collected only for sessions whose pi session
  file is gone. Three safety layers, because pi session files are lazily
  created: the GC runs ~30s after the service starts (after reconnecting
  clients have re-registered), skips currently online sessions, and only
  collects files idle for over an hour. Collected files land in
  `<project>/.pi/mailbox/.trash/`; unreadable or empty session directories
  disable the GC entirely.
- Delivery: while the agent is running, a new-mail notice is steered in
  ("You have N new mail(s). Finish your current task, then check with
  mailbox_list."); while idle, a shorter notice is submitted directly
  ("You have N new mail(s); use mailbox_list to read them."). After
  reconnect, the unread count is backfilled.

## Commands

- `/mailbox` — show a one-line status summary (mail counts, clients
  online); requires an active connection
- `/mailbox host:port [token]` — connect to a remote mailboxd (token
  required by remote-mode daemons)
- `/mailbox list [client [all]|mail]` — list online sessions, all
  mailboxes (with `all`, including offline ones marked `-`), or this
  session's mail (default: mail, same as `/mailbox`)
- `/mailbox name <name>` — set this session's display name (persists across
  reconnects; a name set once is not overwritten by later registration
  defaults)
- `/mailbox tag <a,b,...>` — set this session's tags
- `/mailbox set k=v [k2=v2 ...]` — set meta values (cookie-like key/value)
- `/mailbox unset k [k2 ...]` — remove meta values
- `/mailbox meta` — show this session's full meta
- `/mailbox read <mailId>` — view one mail
- `/mailbox start service` — connect (spawns the daemon if needed)
- `/mailbox stop service` — disconnect (the daemon itself keeps running
  until its idle timeout, or `mailboxd --stop`)
- `/mailbox restart service` — disconnect and reconnect
- `/mailbox status` — connection status

## Agent tools

`mailbox_connect` is declared from the start so the agent can enable the
mailbox on its own when it needs to talk to other sessions; calling it
connects and activates the tools below (they are `deferred` until then,
or until the user runs `/mailbox`):

- `mailbox_list [unreadOnly] [since] [limit] [cursor]` — list this session's
  mail, newest first, paginated (default page 20, max 100); the reply carries
  a `cursor` token to fetch older mails
- `mailbox_read <mail> [session] [project]` — read a mail by triple
- `mailbox_send <session> <subject> [body] [refs]` — send to a registered
  session (online or offline)
- `mailbox_reply <mail> <body>` — reply to a mail (auto recipient, refs,
  and `Re:` subject)
- `mailbox_sessions [includeOffline]` — list sessions with name, tags, and
  meta; offline mailboxes included on request

## Protocol

See `src/protocol.ts` for the full message set. Requests carry a `rid`;
responses echo it. `notify` is the only unsolicited push. Send validates
sizes: subject <= 256 chars, body <= 64 KiB, at most 16 refs. Inbox queries
are paginated: `limit` (default 20, max 100) plus an opaque `cursor`
token; every reply also carries mailbox-wide `total` / `totalUnread`.

## Development

```
npm install --ignore-scripts
npm run check          # tsc --noEmit
node --experimental-strip-types --no-warnings test/smoke.mjs
cd mailboxd && go test ./...
```

## mailboxd

The Go daemon (`mailboxd/`) is a single static binary. Build it with
`go build` in `mailboxd/`; cross-compile with the usual `GOOS`/`GOARCH`
(plus `CGO_ENABLED=0`).

**Local mode (default)**: listens on `127.0.0.1` with a random port, holds
an exclusive flock on `~/.pi/mailboxd.leader` for singleton election, and
writes its address to `~/.pi/mailboxd.json`. Data lives in each project's
`.pi/mailbox/` directory (the client supplies the project root). Exits after
`--idle-exit` (default 5m) with zero connected clients.

**Remote mode** (`--listen` on a non-loopback address): serves external
  machines, requires `--token`/`--token-file`, stores all projects under
  `--data-dir` (client paths are never trusted), and stays up (idle exit is
  disabled unless `--idle-exit` is set explicitly).

The wire protocol is protocol v2: `hello` carries the short project id,
  the project root (local mode), an optional pi session directory (lifecycle
  GC), the session's origin id (the full pi session id, stored as the
  `_origin` system meta for the lifecycle GC), and an optional token; `welcome`/`pong` carry a `protocolVersion`.
  Cross-project sends are allowed when the target project is also registered
  on the daemon. See `mailboxd/protocol.go`.

The extension locates the `mailboxd` binary via `$PI_MAILBOXD`, then
`<package>/mailboxd/mailboxd[.exe]`. Build it with `go build` in `mailboxd/`
(or cross-compile with `CGO_ENABLED=0 GOOS=... GOARCH=... go build`).

## Install

Install from GitHub (see [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)):

```
pi install git:github.com/rexzhao/pi-mailbox
```

Or from a local checkout: `pi install ./pi-mailbox`.
