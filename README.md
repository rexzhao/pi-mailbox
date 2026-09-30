# pi-mailbox

A mailbox service and [pi](https://github.com/earendil-works/pi) extension for
cross-session agent messaging within a project.

## How it works

- Each project gets its own mailbox service. Leadership is a crash-safe
  lease: the leader holds an exclusive OS file lock (`flock` on Unix,
  `LockFileEx` on Windows, via [@lickle/lock](https://www.npmjs.com/package/@lickle/lock))
  on `<project>/.pi/mailbox.leader` for its service lifetime. The OS releases
  the lock automatically when the process dies, so handover needs no
  timeouts or liveness heuristics, and a second service can never exist
  while the leader lives. Other sessions connect as clients to the address
  recorded in `<project>/.pi/mailbox.json` (alongside a stable project UUID).
  Requires a platform with a prebuilt native binding: win32-x64,
  darwin-x64/arm64, or linux-x64 (glibc).
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
  or `name`/`tag` persist server-side and survive reconnects and host
  handover; registration-time defaults never overwrite an existing user
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

- `/mailbox` — connect (host or client) and list this session's mail (the
  list line is suffixed with `[server]` when this session hosts the service)
- `/mailbox host:port` — connect to a remote mailbox service
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
- `/mailbox off` — disconnect
- `/mailbox status` — connection status

## Agent tools

Activated only while the mailbox is connected (exposure is `deferred` until
`/mailbox` succeeds):

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
```

## Install

Install from GitHub (see [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)):

```
pi install git:github.com/rexzhao/pi-mailbox
```

Or from a local checkout: `pi install ./pi-mailbox`.
