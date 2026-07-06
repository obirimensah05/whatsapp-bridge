# SOP (human): connect autoreply draft notifications to Telegram, Slack, or your own WhatsApp number

Follow this top to bottom. Total time: 3-10 minutes depending on the channel.

**What you'll have at the end:** every time the autoreply sidecar drafts a reply
(or an inbound WhatsApp message arrives), you get a notification in the channel
you picked, showing the incoming message, the drafted reply, and the model's
confidence score.

## Before you start

- The bridge is paired and running (`npm run start`, check with `npm run health`).
- The autoreply sidecar is set up per [autoreply.md](autoreply.md).
- You are in the repo root in a terminal.

## The fast path: run the wizard

```bash
npm run autoreply:setup-notify
```

The wizard asks which channel you want, walks you through getting the
credentials, writes them to `.env`, and sends a test notification. If you use
the wizard you do not need the manual sections below - they exist in case you
prefer to do it by hand or the wizard cannot reach an API from your network.

After the wizard finishes, restart the sidecar so it picks up the new channel:

```bash
npm run autoreply              # foreground
# or, if installed as a service:
npm run autoreply:restart
```

That's it. The sections below are the manual equivalents.

---

## Option 1: Telegram (recommended - free, instant, works on every device)

1. In Telegram, search for **@BotFather** and open it.
2. Send `/newbot`. Give it a display name (e.g. "WA Drafts") and a username
   ending in `bot` (e.g. `my_wa_drafts_bot`).
3. BotFather replies with a token like `123456789:AAH4...xyz`. Copy it.
4. Open your new bot (BotFather's reply has a `t.me/...` link) and send it any
   message, e.g. "hi". This is required - bots cannot message you first.
5. Get your chat id: open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and find
   `"chat":{"id":123456789,...}` in the response.
6. Add to `.env`:

   ```bash
   AUTOREPLY_NOTIFY_CHANNEL=telegram
   AUTOREPLY_TELEGRAM_BOT_TOKEN=123456789:AAH4...xyz
   AUTOREPLY_TELEGRAM_CHAT_ID=123456789
   ```

7. Restart the sidecar.

## Option 2: Slack

**Webhook variant (simpler):**

1. Go to <https://api.slack.com/apps> > **Create New App** > **From scratch**.
2. Name it (e.g. "WA Drafts") and pick your workspace.
3. In the app sidebar: **Incoming Webhooks** > toggle **On**.
4. Click **Add New Webhook to Workspace**, pick the channel or DM that should
   receive drafts, and **Allow**.
5. Copy the webhook URL (`https://hooks.slack.com/services/...`).
6. Add to `.env`:

   ```bash
   AUTOREPLY_NOTIFY_CHANNEL=slack
   AUTOREPLY_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
   ```

7. Restart the sidecar.

**Bot-token variant (if your workspace restricts incoming webhooks):**

1. Create the app as above, then in **OAuth & Permissions** add the bot scope
   `chat:write` and click **Install to Workspace**.
2. Copy the **Bot User OAuth Token** (`xoxb-...`).
3. In Slack, `/invite` the bot into the target channel.
4. Get the channel id: channel name > **View channel details** > the id at the
   bottom (starts with `C`).
5. Add to `.env`:

   ```bash
   AUTOREPLY_NOTIFY_CHANNEL=slack
   AUTOREPLY_SLACK_BOT_TOKEN=xoxb-...
   AUTOREPLY_SLACK_CHANNEL=C0123456789
   ```

6. Restart the sidecar.

## Option 3: your own WhatsApp number (no extra app needed)

The bridge sends each notification as a normal WhatsApp message **from the
paired number** to a chat you choose:

- Enter your **own paired number** and notifications land in WhatsApp's
  built-in **"Message yourself"** chat.
- Enter a **second number you own** (old phone, second SIM) and they land in
  that chat.

1. Add to `.env` (country code + digits, no `+`, no spaces):

   ```bash
   AUTOREPLY_NOTIFY_CHANNEL=whatsapp
   AUTOREPLY_NOTIFY_WA_TO=491761234567
   # only needed if you run a non-default session name:
   # AUTOREPLY_NOTIFY_WA_SESSION=main
   ```

2. Restart the sidecar. The bridge daemon must be running, since notifications
   go out through its `/v1/send` API.

**Two things to know:**

- Messages you type into that chat are **ignored** by the autoreply service.
  This is deliberate loop protection - otherwise a notification about a draft
  could itself generate a draft. Treat the chat as a read-only feed.
- Notifications count as normal outbound WhatsApp messages from your paired
  number. Volume is low (one per inbound message), but they are visible in
  that chat's history like any other message.

## Option 4: generic webhook

For piping notifications into your own system (n8n, Make, a small server):

```bash
AUTOREPLY_NOTIFY_CHANNEL=webhook
AUTOREPLY_NOTIFY_WEBHOOK_URL=https://your-endpoint.example/notify
AUTOREPLY_NOTIFY_WEBHOOK_TOKEN=optional-bearer-token
```

The payload is the raw JSON notification object (kind, chat, incoming text,
draft, confidence, reasons).

---

## Verify it works

1. Send a WhatsApp message to the paired number from another phone, or run:

   ```bash
   TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
   curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/webhook/test
   ```

   (The test ping confirms webhook wiring; only a real inbound message
   produces a draft notification.)

2. Watch the channel you configured. A draft notification shows the incoming
   message, the draft, and a confidence value.
3. If nothing arrives, check `data/autoreply/audit.ndjson` (last lines) and
   the sidecar logs.

## Switching channels later

Run `npm run autoreply:setup-notify` again, or edit
`AUTOREPLY_NOTIFY_CHANNEL` in `.env` by hand. When
`AUTOREPLY_NOTIFY_CHANNEL` is set, **only** that channel is used - other
configured channels stay idle until you switch back. Restart the sidecar
after any change.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No notification at all | Sidecar not restarted after `.env` change | `npm run autoreply:restart` or re-run `npm run autoreply` |
| Telegram: nothing arrives | You never messaged the bot first | Send the bot "hi", re-check chat id via `getUpdates` |
| Slack webhook returns 404 | Webhook was revoked / app removed | Create a new webhook, update `.env` |
| Slack bot: `not_in_channel` | Bot not invited | `/invite @yourbot` in the channel |
| WhatsApp: nothing arrives | Bridge daemon not running | `npm run start`, then check `npm run health` |
| WhatsApp: drafts stopped for one contact | That contact is your notify number | Expected - the notify chat is excluded from autoreply |
