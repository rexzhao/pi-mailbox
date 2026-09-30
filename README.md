# pi-mailbox

A mailbox service and [pi](https://github.com/earendil-works/pi) extension for
cross-session agent messaging within a project.

## How it works

- Each project gets its own mailbox service. The service is hosted in-process
  by whichever pi session connects first (`/mailbox`); other sessions connect
  as clients. When the hosting session exits, remaining sessions re-elect a
  host. All traffic is WebSocket on `127.0.0.1` with a random port recorded in
  `<project>/.pi/mailbox.json` (alongside a stable project UUID).
- Mails are immutable: send, read, and reference only. No editing, no
  comments, no deletion (yet). A mail is addressed by the triple
  `{project, session, mail}`; knowing the triple is the capability to read it.
  "Comments" are modeled as new mails that reference the original via `refs`.
- Storage is a per-session JSONL event log at
  `<project>/.pi/mailbox/<sessionId>.jsonl` (`send` / `read` / `meta` events),
  lazily loaded, replayed on service start. Session metadata (display name,
  tags) persists alongside the mails and survives host handover.
- Lifecycle GC: mailboxes are collected only for sessions whose pi session
  file is gone. Three safety layers, because pi session files are lazily
  created: the GC runs ~30s after the service starts (after reconnecting
  clients have re-registered), skips currently online sessions, and only
  collects files idle for over an hour. Collected files land in
  `<project>/.pi/mailbox/.trash/`; unreadable or empty session directories
  disable the GC entirely.
- Delivery: while the agent is running, new mail steers a short notice
  ("你有 N 封新邮件"); while idle, the same message is submitted directly.
  After reconnect, the unread count is backfilled.

## Commands

- `/mailbox` — connect (host or client) and list this session's mail (the
  list line is suffixed with `[server]` when this session hosts the service)
- `/mailbox host:port` — connect to a remote mailbox service
- `/mailbox name <name>` — set this session's display name (`/mailbox name` shows it)
- `/mailbox tag <a,b,...>` — set this session's tags (`/mailbox tag` shows them)
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
- `mailbox_send <session> <subject> [body] [refs]` — send to an online session
- `mailbox_sessions` — list online sessions (with name and tags)

## Protocol

See `src/protocol.ts` for the full message set. Requests carry a `rid`;
responses echo it. `notify` is the only unsolicited push. Send validates
sizes: subject <= 256 chars, body <= 64 KiB, at most 16 refs. Inbox queries
are paginated: `limit` (default 20, max 100) plus an opaque `cursor` token.

## Development

```
npm install --ignore-scripts
npm run check          # tsc --noEmit
node --experimental-strip-types --no-warnings test/smoke.mjs
```

To try it in pi: `pi --extension F:/work/pi-mailbox` (or link/symlink this
directory into `~/.pi/agent/extensions/`).
