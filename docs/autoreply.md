# WhatsApp Autoreply MVP

This repo includes a local autoreply service that sits beside `whatsapp-bridge`.

## What it does now

- runs a local HTTP service for autoreply control
- accepts immediate webhook calls from `whatsapp-bridge`
- builds a style corpus from outbound WhatsApp history plus second-brain content
- generates draft replies in the operator's voice with Claude CLI
- sends live draft notifications to Telegram
- can auto-send through the local `whatsapp-bridge` API when policy + safety checks allow it
- stores policy in `data/autoreply/policy.json`
- logs drafts to `data/autoreply/drafts.ndjson`
- logs audit events to `data/autoreply/audit.ndjson`

## Current status

Implemented and verified:

- `draft` / `auto` / `off` policy modes
- scope targeting for all / contacts / groups / mixed
- time-window controls
- webhook delivery from `whatsapp-bridge` into the autoreply service
- transcript-aware enrichment for inbound messages
- Telegram draft notification delivery
- basic auto-send safety gates:
  - model confidence threshold
  - model `should_send` / `needs_review` flags
  - sensitive-topic regex blocks
  - per-chat auto-send cooldown
  - duplicate inbound-message protection
  - group auto-send disabled by default

Still worth improving later:

- more granular risk profiles per contact/group
- richer corpus retrieval by topic/contact/recency
- operator UI/commands for toggles
- stronger ambiguity/business-critical detection

## Environment variables

Add these to `.env`:

```bash
AUTOREPLY_TOKEN=<32+ char secret>
AUTOREPLY_PORT=8081
AUTOREPLY_HOST=127.0.0.1
AUTOREPLY_DATA_DIR=./data/autoreply
AUTOREPLY_STYLE_CORPUS_PATH=./data/autoreply/style-corpus.md
AUTOREPLY_DEFAULT_SESSION=main
AUTOREPLY_SECOND_BRAIN_ROOT=/path/to/your/notes
AUTOREPLY_MODEL=sonnet
AUTOREPLY_MIN_CONFIDENCE=0.78
AUTOREPLY_AUTO_SEND_COOLDOWN_MS=600000
AUTOREPLY_ALLOW_GROUP_AUTO=0

# local whatsapp-bridge API
AUTOREPLY_WA_API_BASE=http://127.0.0.1:8080/v1
AUTOREPLY_WA_API_TOKEN=<whatsapp-bridge bearer token>

# draft notification options
AUTOREPLY_NOTIFY_WEBHOOK_URL=
AUTOREPLY_NOTIFY_WEBHOOK_TOKEN=
AUTOREPLY_TELEGRAM_BOT_TOKEN=
AUTOREPLY_TELEGRAM_CHAT_ID=

# whatsapp-bridge -> autoreply webhook wiring
WEBHOOK_URL=http://127.0.0.1:8081/webhook
WEBHOOK_TOKEN=<same as AUTOREPLY_TOKEN>
```

## Run

Start `whatsapp-bridge` as usual:

```bash
npm run start
```

Start the autoreply service in a second process:

```bash
npm run autoreply
```

## Build the style corpus

```bash
npm run autoreply:build-corpus
# optional overrides
npm run autoreply:build-corpus -- 1500 120
```

This writes the combined WhatsApp + second-brain corpus to the path in `AUTOREPLY_STYLE_CORPUS_PATH`.

## Routes

### `GET /health`
No auth. Returns basic health and current policy.

### `GET /policy`
Bearer auth required.

```bash
curl -H "Authorization: Bearer $AUTOREPLY_TOKEN" http://127.0.0.1:8081/policy
```

### `PUT /policy`
Bearer auth required.

Example: draft mode for all chats

```bash
curl -X PUT \
  -H "Authorization: Bearer $AUTOREPLY_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8081/policy \
  -d '{
    "mode": "draft",
    "scope": "all",
    "contacts": [],
    "groups": [],
    "active_until": null,
    "active_hours": null,
    "notes": "default draft mode"
  }'
```

Example: temporary auto mode for one contact

```bash
curl -X PUT \
  -H "Authorization: Bearer $AUTOREPLY_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8081/policy \
  -d '{
    "mode": "auto",
    "scope": "contacts",
    "contacts": ["15551234567@s.whatsapp.net"],
    "groups": [],
    "active_until": "2026-05-15T20:00:00+02:00",
    "active_hours": null,
    "notes": "temporary auto mode"
  }'
```

### `POST /webhook`
Bearer auth required.

This is the route `whatsapp-bridge` calls for inbound events. It now accepts both real message payloads and `/v1/webhook/test` test pings from the bridge.

## Verification

- `npm run typecheck`
- `POST /v1/webhook/test` through the local bridge API
- inspect:
  - `data/autoreply/audit.ndjson`
  - `data/autoreply/drafts.ndjson`

## Practical rollout recommendation

1. Keep global mode on `draft`
2. Use Telegram notifications to review generated replies
3. Enable `auto` only for narrow contact scopes + time windows
4. Leave group auto-send disabled unless you explicitly want it
