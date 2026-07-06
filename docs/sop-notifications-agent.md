# SOP (agent): configure autoreply notification channels

Audience: an AI coding agent (Claude Code, Codex, etc.) asked to set up or
change where autoreply draft notifications are delivered. Follow exactly;
do not improvise credentials flows.

## Contract

- Channels: `telegram` | `slack` | `whatsapp` | `webhook`.
- Selection lives in `.env` as `AUTOREPLY_NOTIFY_CHANNEL`. When set, that
  channel is used **exclusively** (no fallback). When unset, legacy fallback
  order is webhook -> telegram -> slack -> whatsapp, first configured wins.
- All channel code is in `src/autoreply-notify.ts`; env parsing in
  `src/autoreply-env.ts`. Do not add channels elsewhere.
- Never print or commit values from `.env`. It must stay mode 0600.

## Decision tree

1. User states a channel preference -> configure that channel (below).
2. User has no preference -> ask once. If they cannot answer, prefer
   `telegram` (no dependency on the bridge being up to deliver).
3. User is interactive at a terminal -> prefer handing them the wizard:
   `npm run autoreply:setup-notify` (it guides credential creation and sends
   a test). Only fall back to manual `.env` editing when the wizard is
   unsuitable (headless, scripted setup, credentials already known).

## Required `.env` keys per channel

| Channel | Keys |
|---|---|
| telegram | `AUTOREPLY_NOTIFY_CHANNEL=telegram`, `AUTOREPLY_TELEGRAM_BOT_TOKEN`, `AUTOREPLY_TELEGRAM_CHAT_ID` |
| slack (webhook) | `AUTOREPLY_NOTIFY_CHANNEL=slack`, `AUTOREPLY_SLACK_WEBHOOK_URL` |
| slack (bot) | `AUTOREPLY_NOTIFY_CHANNEL=slack`, `AUTOREPLY_SLACK_BOT_TOKEN`, `AUTOREPLY_SLACK_CHANNEL` |
| whatsapp | `AUTOREPLY_NOTIFY_CHANNEL=whatsapp`, `AUTOREPLY_NOTIFY_WA_TO` (digits only), optional `AUTOREPLY_NOTIFY_WA_SESSION` |
| webhook | `AUTOREPLY_NOTIFY_CHANNEL=webhook`, `AUTOREPLY_NOTIFY_WEBHOOK_URL`, optional `AUTOREPLY_NOTIFY_WEBHOOK_TOKEN` |

Credentials the agent cannot mint itself (Telegram bot token, Slack app) must
come from the user; give them the exact steps from
[sop-notifications-human.md](sop-notifications-human.md) and wait.

## Channel-specific rules

**telegram** - chat id can be discovered after the user messages the bot:
`GET https://api.telegram.org/bot<TOKEN>/getUpdates`, take
`result[last].message.chat.id`.

**slack** - webhook variant needs no channel id (the webhook is bound to a
channel at creation). Bot variant requires the bot invited to the channel;
`not_in_channel` in the API response means it is not.

**whatsapp** - `AUTOREPLY_NOTIFY_WA_TO` must be digits only (strip `+`,
spaces, `@s.whatsapp.net`). The bridge daemon must be running for delivery.
The server excludes the notify chat from autoreply processing
(`isNotifyWhatsAppChat` in `src/autoreply-notify.ts`, guard in
`src/autoreply-server.ts`); this is load-bearing loop protection - never
remove it, and never point `AUTOREPLY_NOTIFY_WA_TO` at a chat the user
actively converses in with someone else.

**webhook** - do not invent an endpoint; only use a URL the user supplies.

## Procedure (manual path)

1. Read current state: `grep '^AUTOREPLY_' .env` (values may be shown to the
   user only as key names, never full secrets).
2. Upsert the keys for the chosen channel (edit lines in place; append if
   missing). Preserve all other lines. Keep file mode 0600.
3. Typecheck is not needed for `.env`-only changes. If you touched source:
   `npx tsc --noEmit`.
4. Restart the sidecar: `npm run autoreply:restart` (launchd) or instruct the
   user to re-run `npm run autoreply`.
5. Verify:
   - `npm run autoreply:health` returns `ok: true`.
   - Trigger a real inbound message, or ask the user to; then check the last
     line of `data/autoreply/audit.ndjson` and confirm the notification
     arrived in the channel.
   - For a synthetic delivery test without an inbound message, run the wizard
     (`npm run autoreply:setup-notify`) which offers a test send, or one-off:

     ```bash
     npx tsx -e "import('./src/autoreply-notify.js').then(m => m.sendDraftNotification({kind:'whatsapp_draft',contact_label:'agent test',incoming_text:'test',draft_reply:'test',confidence:0.99,reasons:['agent verification']}).then(ok => console.log('sent:', ok)))"
     ```

6. Report to the user: channel configured, test result, and that replies in a
   WhatsApp notify chat are intentionally ignored.

## Failure modes

| Signal | Meaning | Action |
|---|---|---|
| `AUTOREPLY_NOTIFY_CHANNEL must be one of ...` on boot | Typo in channel value | Fix `.env`, restart |
| Telegram API 401 | Bad bot token | Ask user to re-copy from BotFather |
| Telegram sends but user sees nothing | Wrong chat id | Re-derive via `getUpdates` after user messages the bot |
| Slack 404 on webhook | Webhook revoked | User must create a new webhook |
| Slack `channel_not_found` | Wrong channel id or bot lacks access | Verify id, `/invite` the bot |
| WhatsApp send throws `ECONNREFUSED` | Bridge daemon down | `npm run start` first |
| Draft notifications stop for one contact | Contact JID equals notify number | Expected (loop guard); pick a different notify target if unwanted |

## Do not

- Do not set more than one channel's credentials "just in case" when
  `AUTOREPLY_NOTIFY_CHANNEL` is unset - the legacy fallback order would pick
  the first configured one, which surprises users.
- Do not use the operator's active conversations as the WhatsApp notify
  target.
- Do not log secrets to the console, commit `.env`, or loosen its file mode.
- Do not bypass `sendDraftNotification` / `sendInboundNotification` with
  direct API calls inside server code.
