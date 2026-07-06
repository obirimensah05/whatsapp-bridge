# WhatsApp Autoreply MVP

This repo includes a local autoreply service that sits beside `whatsapp-bridge`.

## What it does now

- runs a local HTTP service for autoreply control
- accepts immediate webhook calls from `whatsapp-bridge`
- builds a style corpus from outbound WhatsApp history plus second-brain content
- generates draft replies in the operator's voice with a configurable LLM (Claude CLI by default, Anthropic API, or any OpenAI-compatible API)
- sends live draft notifications to Telegram, Slack, your own WhatsApp number, or a generic webhook (selectable)
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

# LLM provider for draft generation - claude-cli (default) | anthropic | openai
# claude-cli: shells out to the local `claude` CLI (uses AUTOREPLY_CLAUDE_BIN / AUTOREPLY_MODEL).
# anthropic:  Anthropic API via the official SDK (key from AUTOREPLY_LLM_API_KEY or ANTHROPIC_API_KEY;
#             model defaults to claude-opus-4-8).
# openai:     ANY OpenAI-compatible chat-completions endpoint - OpenAI, OpenRouter, Groq,
#             Mistral, Ollama, LM Studio... Set AUTOREPLY_LLM_BASE_URL + AUTOREPLY_LLM_MODEL.
AUTOREPLY_LLM_PROVIDER=claude-cli
AUTOREPLY_LLM_API_KEY=
AUTOREPLY_LLM_BASE_URL=
AUTOREPLY_LLM_MODEL=
AUTOREPLY_MIN_CONFIDENCE=0.78
AUTOREPLY_AUTO_SEND_COOLDOWN_MS=600000
AUTOREPLY_ALLOW_GROUP_AUTO=0

# local whatsapp-bridge API
AUTOREPLY_WA_API_BASE=http://127.0.0.1:8080/v1
AUTOREPLY_WA_API_TOKEN=<whatsapp-bridge bearer token>

# draft notification channel - run `npm run autoreply:setup-notify` for a guided setup.
# One of: telegram | slack | whatsapp | webhook. When set, ONLY that channel is used.
# When unset, legacy fallback order applies: webhook -> telegram -> slack -> whatsapp.
AUTOREPLY_NOTIFY_CHANNEL=

# telegram
AUTOREPLY_TELEGRAM_BOT_TOKEN=
AUTOREPLY_TELEGRAM_CHAT_ID=

# slack (either an incoming webhook URL, or bot token + channel id)
AUTOREPLY_SLACK_WEBHOOK_URL=
AUTOREPLY_SLACK_BOT_TOKEN=
AUTOREPLY_SLACK_CHANNEL=

# your own whatsapp number (digits only, no +) - delivered via the bridge itself.
# Replies typed in that chat are ignored by autoreply (loop protection).
AUTOREPLY_NOTIFY_WA_TO=
AUTOREPLY_NOTIFY_WA_SESSION=

# generic webhook
AUTOREPLY_NOTIFY_WEBHOOK_URL=
AUTOREPLY_NOTIFY_WEBHOOK_TOKEN=

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

## LLM providers

Draft generation goes through `src/autoreply-llm.ts` and supports three providers via `AUTOREPLY_LLM_PROVIDER`:

| Provider | What it uses | Needs |
|---|---|---|
| `claude-cli` (default) | the local `claude` CLI | Claude Code installed, no API key |
| `anthropic` | Anthropic Messages API | `AUTOREPLY_LLM_API_KEY` (or `ANTHROPIC_API_KEY`); optional `AUTOREPLY_LLM_MODEL` (default `claude-opus-4-8`) |
| `openai` | any OpenAI-compatible `/chat/completions` endpoint | `AUTOREPLY_LLM_MODEL` required; `AUTOREPLY_LLM_BASE_URL` (default `https://api.openai.com/v1`); key optional for local endpoints like Ollama |

Example - OpenRouter:

```bash
AUTOREPLY_LLM_PROVIDER=openai
AUTOREPLY_LLM_BASE_URL=https://openrouter.ai/api/v1
AUTOREPLY_LLM_API_KEY=sk-or-...
AUTOREPLY_LLM_MODEL=anthropic/claude-sonnet-4.6
```

Example - local Ollama:

```bash
AUTOREPLY_LLM_PROVIDER=openai
AUTOREPLY_LLM_BASE_URL=http://127.0.0.1:11434/v1
AUTOREPLY_LLM_MODEL=llama3.1
```

## Context sources (second brain optional)

Each draft is grounded in two things, and neither requires setup beyond the bridge itself:

1. **Style corpus** - built from your own sent WhatsApp messages
   (`npm run autoreply:build-corpus`). If the corpus file does not exist when the
   first draft is generated, it is auto-built from outbound history. The
   second-brain section of the corpus is optional; without one the corpus is
   WhatsApp-only.
2. **Reference context** - relevant excerpts from **your own WhatsApp history**:
   the recent conversation with that chat plus keyword matches across all stored
   messages (`src/autoreply-context.ts`). No external notes source is required.

## Notification channels

Draft and inbound notifications can go to **Telegram**, **Slack**, **your own
WhatsApp number** (self-chat or a second number, sent through the bridge
itself), or a **generic webhook**. Pick one with the guided wizard:

```bash
npm run autoreply:setup-notify
```

Step-by-step setup guides:

- [sop-notifications-human.md](sop-notifications-human.md) - for a person following along
- [sop-notifications-agent.md](sop-notifications-agent.md) - for an AI agent doing the setup

When `AUTOREPLY_NOTIFY_CHANNEL` is set, only that channel is used. The
WhatsApp channel excludes its own notify chat from autoreply processing so
notifications can never loop back into new drafts.

## Practical rollout recommendation

1. Keep global mode on `draft`
2. Pick a notification channel (`npm run autoreply:setup-notify`) and review generated replies there
3. Enable `auto` only for narrow contact scopes + time windows
4. Leave group auto-send disabled unless you explicitly want it
