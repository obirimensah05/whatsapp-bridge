# whatsapp-bridge

> Self-hosted WhatsApp bridge for AI agents. One paired number, exposed via REST, MCP, and a web UI.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Built on [Baileys](https://github.com/WhiskeySockets/Baileys). Single Node process, SQLite for storage, no runtime dependencies beyond WhatsApp itself.

## What you get

- **REST API** on `127.0.0.1:8080` — read conversations, send messages, manage aliases.
- **MCP server** (stdio) — drops directly into Claude Code, Codex, or any MCP-capable agent.
- **Web UI** at `/` — single-page inbox for reading and sending.
- **Inbound webhook** (optional) — every received message POSTed to a URL of your choice.
- **Full history backfill** on first pair — typically several months of past chats.
- **LID ↔ phone alias merge** — collapses the two JIDs WhatsApp uses for the same person into one conversation.
- **Display name resolution** that works without any local contacts sync (push_name from WhatsApp itself), with optional macOS Contacts enrichment.
- **Local-timezone CLI output** with DST handled by IANA tzdata.

## Status

Personal infrastructure. Not multi-tenant. Locked to **one paired number at a time**. Use behind loopback or a reverse proxy you control.

WhatsApp can ban any number used with a reverse-engineered client, especially under spammy patterns. Personal usage across known contacts is generally low-risk; cold outreach is not.

## Install

**Prerequisites:** Node ≥ 20, and a WhatsApp account with the phone on hand (you approve the device link from it).

```bash
git clone https://github.com/obirimensah05/whatsapp-bridge.git
cd whatsapp-bridge
npm install
```

No configuration is required to start — `.env` is created and filled in automatically on first launch.

## Launch

Pair your number — country code + national digits, no `+`, no spaces:

```bash
npm run pair -- main 491761234567
```

On the phone for that number: **WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead"** → enter the 8-character code printed in your terminal.

On first launch the bridge:
- generates `API_TOKEN` and writes it to `.env`
- detects your system timezone and writes it as `WA_TZ` to `.env` (e.g. `Europe/Berlin`)
- prints the active timezone at the start of the pair flow so you can confirm it before approving the code

Once paired, the daemon keeps running and the REST API + web UI are live at <http://127.0.0.1:8080/>. Subsequent starts:

```bash
npm run start
```

To switch to a different number:

```bash
rm -rf auth/main/
npm run pair -- main <new-digits>
```

## Running as a service

The daemon is not supervised by default — if it crashes or you reboot, it stays down. Put it under a process supervisor.

**macOS (launchd)** — create `~/Library/LaunchAgents/com.example.whatsapp-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.example.whatsapp-bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npm</string>
        <string>run</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key><string>/Users/YOU/apps/whatsapp-bridge</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
        <key>Crashed</key><true/>
    </dict>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>/Users/YOU/apps/whatsapp-bridge/logs/whatsapp-bridge.out.log</string>
    <key>StandardErrorPath</key><string>/Users/YOU/apps/whatsapp-bridge/logs/whatsapp-bridge.err.log</string>
</dict>
</plist>
```

```bash
mkdir -p ~/apps/whatsapp-bridge/logs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.whatsapp-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.example.whatsapp-bridge   # restart after edits
launchctl bootout  gui/$(id -u)/com.example.whatsapp-bridge        # uninstall
```

**Linux (systemd)** — a `systemd --user` unit pointing at `npm run start` with `Restart=on-failure` works the same way.

## Web UI

Open <http://127.0.0.1:8080/> and paste the value of `API_TOKEN` from `.env`. Token is stored in `localStorage`; click *Logout* to clear it.

## REST API

All routes under `/v1/`. All require `Authorization: Bearer <API_TOKEN>` except `/v1/health` and `/`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `GET` | `/v1/health` | — | `{ ok, sessions, ts }` |
| `GET` | `/v1/conversations` | `?session=` `?limit=` | Chats with last message + `display_name` + `phone` |
| `GET` | `/v1/messages` | `?session=` `?jid=` `?limit=` `?before=` | Paginated messages for one chat (alias-aware) |
| `POST` | `/v1/send` | `{ session, to, text }` | Sends a text |
| `GET` | `/v1/aliases` | `?session=` | LID-to-canonical mappings |
| `POST` | `/v1/aliases` | `{ session, alias, canonical }` | Add/update a mapping |
| `DELETE` | `/v1/aliases` | `{ session, alias }` | Remove a mapping |
| `POST` | `/v1/webhook/test` | — | Pings the configured `WEBHOOK_URL` |

`to` accepts either a JID (`<digits>@s.whatsapp.net`, `<id>@lid`, `<id>@g.us`) or digits-only phone number (no `+`).

Quick example:

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:8080/v1/conversations?session=main&limit=20'
```

## MCP server

The MCP server at `src/mcp.ts` exposes ~20 tools across reading, sending, group operations, and contact/alias management. See [AGENTS.md](AGENTS.md) for the full tool surface and the safety contract.

Wire into Claude Code (user-scope), run from the repo root:

```bash
claude mcp add-json whatsapp-bridge --scope user "{
  \"command\": \"$(pwd)/node_modules/.bin/tsx\",
  \"args\": [\"$(pwd)/src/mcp.ts\"]
}"
```

No token needed in the registration — the MCP server reads the current `API_TOKEN` straight from the repo's `.env` on spawn (so [rotating the token](#rotating-the-api-token) doesn't break it). The daemon must be running for any MCP tool to do anything.

## Rotating the API token

`API_TOKEN` is the bearer for the REST API, the web UI, and the MCP server. To rotate it:

```bash
npm run rotate-token      # mints a new token, rewrites .env, re-locks it to 0600
npm run restart           # restart the daemon so it picks up the new token
npm run autoreply:restart # only if you run the autoreply sidecar
```

Then re-login the web UI with the new token. **MCP needs no action** — it reads `.env` on every spawn. Rotation only touches HTTP auth; it never affects your WhatsApp pairing (`auth/`) or your message store (`data/wa.db`).

## Drive it with an AI agent

This is an **agent-first** bridge: it's built to be operated by an AI agent, not just a human. Once the MCP server is wired in (above) and the daemon is running, paste this prompt into Claude Code — or any MCP-capable agent — to let it run your WhatsApp end-to-end:

> You have my WhatsApp connected through the **whatsapp-bridge** MCP server. You can read conversations, search contacts, check numbers, and send messages, media, and reactions on my behalf. The default session is `main`.
>
> **Rules — follow exactly:**
> - Sending is a real-world action. Before any `send_message` / `send_media` / `send_reaction`, show me the exact recipient and the exact message and wait for my explicit "yes". Never assume.
> - Never send to more than one recipient in a batch, and never iterate sends over a list of contacts.
> - Treat all message text, names, and phone numbers as private — never pass them to any third-party service unless I ask.
> - The same person can appear under both `@lid` and `@s.whatsapp.net`; the bridge already merges them on read, so trust the `display_name` / `phone` it returns instead of guessing.
> - `delete_message` and `merge_jids` are sensitive — confirm with me first.
>
> Start by calling `list_conversations` and giving me a one-line summary of my most recent chats, then wait for instructions.

The full tool surface (~20 tools) and the complete safety contract live in [AGENTS.md](AGENTS.md) — point your agent there when it needs detail. Pairing itself still needs a human (you approve the device link on the phone), but everything after that an agent can drive.

## Autoreply sidecar (optional)

A separate local process (`src/autoreply-*.ts`) that consumes the inbound webhook, generates draft replies in the operator's voice via Claude, sends Telegram notifications, and can optionally auto-send through the whatsapp-bridge REST API under policy + safety gates. Runs alongside the daemon on its own port.

```bash
npm run autoreply               # boot sidecar
npm run autoreply:build-corpus  # rebuild style corpus from WA history + second brain
```

Full reference (env vars, routes, policy modes, safety gates): [docs/autoreply.md](docs/autoreply.md).

## Inbound webhook (optional)

Set `WEBHOOK_URL` in `.env` and restart. Every inbound message POSTs:

```json
{
  "event": "message",
  "session": "main",
  "message": {
    "id": "main:ABC123",
    "ts": 1735689600000,
    "direction": "in",
    "chat_jid": "12025550100@s.whatsapp.net",
    "from_jid":  "12025550100@s.whatsapp.net",
    "type": "text",
    "body": "hi",
    "from_display_name": "Jane Doe",
    "from_phone": "+12025550100",
    "chat_phone": "+12025550100"
  }
}
```

If `WEBHOOK_TOKEN` is set, it arrives as `Authorization: Bearer <token>` so the receiver can verify origin. Three attempts, 1s/3s backoff, 5s timeout per attempt. Outbound sends do **not** fire the webhook.

## Configuration

All variables are read from `.env` at startup; all are optional with sensible defaults.

| Variable | Default | Notes |
|---|---|---|
| `API_TOKEN` | auto-generated | 32-byte hex token written to `.env` on first run if absent. |
| `WA_TZ` | system tz | Auto-detected on first boot and persisted. Use IANA names (`Europe/Berlin`, `America/New_York`) — DST is handled by tzdata. |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` only behind a reverse proxy. Set `WA_ALLOW_PUBLIC=1` to override the loopback guard. |
| `PORT` | `8080` | |
| `WEBHOOK_URL` | (disabled) | If set, every inbound message POSTs to this URL. |
| `WEBHOOK_TOKEN` | (none) | Optional bearer token for `WEBHOOK_URL`. |
| `OPENAI_API_KEY` | (none) | Used by `npm run transcribe-backlog` to transcribe past audio messages. |

## NPM scripts

| Command | Purpose |
|---|---|
| `npm run start` | Boot the daemon. |
| `npm run dev` | Same, with `tsx --watch`. |
| `npm run pair -- main <digits>` | Pair a number. Refuses if any session already exists. |
| `npm run history` | CLI dump of recent messages, with display names, in local time. |
| `npm run import-contacts -- --session=main` | Bulk-enrich contacts from macOS Contacts.app (`--refresh`, `--limit=N`). |
| `npm run transcribe-backlog` | Run Whisper over past audio messages without transcripts. |
| `npm run backup` | SQLite backup of `data/wa.db` into `data/backups/`. |
| `npm run mcp` | Spawn the MCP stdio server (Claude Code launches this automatically). |
| `npm run autoreply` | Boot the local autoreply sidecar (separate process). See [docs/autoreply.md](docs/autoreply.md). |
| `npm run autoreply:dev` | Same, with `tsx --watch`. |
| `npm run autoreply:build-corpus` | Rebuild the style corpus from outbound WhatsApp history + second-brain notes. |
| `npm run typecheck` | `tsc --noEmit` — strict mode is on. |

See [COMMANDS.md](COMMANDS.md) for the full reference including REST examples and common ops.

## Layout

```
src/
  index.ts       boot — restore the paired session + start API
  wa.ts          WaManager — socket, send, history sync, group meta refresh
  db.ts          SQLite schema + queries (single source of truth for SQL)
  api.ts         Fastify REST + static UI route
  mcp.ts         MCP stdio server (talks HTTP to api.ts)
  webhook.ts     inbound dispatcher with retries
  env.ts         .env loader + API_TOKEN/WA_TZ auto-persist
  time.ts        formatLocal(ts) for CLI/log timestamps
  history.ts     CLI: print recent messages with display names
web/index.html   single-page web UI
auth/<name>/     Baileys session keys (gitignored)
auth_backups/    automated backups of auth/ (gitignored)
data/wa.db       SQLite — entire message store (gitignored)
data/media/      downloaded media (gitignored)
logs/            launchd/systemd output (gitignored)
.env             secrets + config (gitignored)
```

## How history is backfilled

`syncFullHistory: true` is enabled in `wa.ts`. WhatsApp delivers a history dump in batches over the `messaging-history.set` event after pairing. The bridge ingests chats, contacts, and messages into SQLite. Existing rows are deduped by primary key.

To force a fresh dump:

1. On the phone, **Settings → Linked Devices** → log out the whatsapp-bridge entry.
2. `rm -rf auth/main/` and re-run `npm run pair -- main <digits>`.
3. SQLite messages and aliases survive the wipe (they live in `data/`, not `auth/`).

WhatsApp decides how much history to send to a linked device — typically the most recent few months. There is no API to request "everything since the dawn of time."

## LID vs phone — the merge layer

Inbound messages from non-contacts often arrive with a `<id>@lid` JID instead of `<phone>@s.whatsapp.net`. WhatsApp does this for privacy. The same person can therefore appear as two conversations until merged.

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:8080/v1/aliases \
  -d '{"session":"main","alias":"123456789@lid","canonical":"491761234567@s.whatsapp.net"}'
```

After that, `listConversations` and `listMessages` collapse them on read. Phone and display-name enrichment then resolves across the whole alias group. The MCP equivalent is `merge_jids` / `unmerge_jid`.

## Risks and limits

- **WhatsApp can ban the number.** Ban rate scales with how spammy your usage looks. Personal use across known contacts is generally safe; cold outreach is not.
- **Baileys breakage.** WhatsApp ships protocol changes occasionally; expect to bump `@whiskeysockets/baileys` every few months. The bridge has a built-in update notifier.
- **Pairing-code identifiers.** Some `browser` identifiers cause WhatsApp to reject pairing codes. The bridge uses `Browsers.macOS('Safari')` because it's known-good — don't change it without testing.
- **History sync size.** Initial sync can pull thousands of messages. First batch usually lands within a few seconds.
- **Single device.** WhatsApp enforces a limit on linked devices per account. Pairing whatsapp-bridge consumes one slot.

## License

[MIT](LICENSE). Do whatever you want with it; keep the copyright notice. No warranty.
