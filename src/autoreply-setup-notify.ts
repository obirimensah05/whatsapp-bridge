// Interactive wizard: pick where autoreply draft notifications go
// (Telegram, Slack, your own WhatsApp number, or a generic webhook),
// walk through obtaining the credentials, write them to .env, and
// send a test notification through the chosen channel.
//
// Run with: npm run autoreply:setup-notify
//
// Deliberately imports nothing from autoreply-env.ts at module scope:
// the wizard mutates process.env first and only then dynamically imports
// the notifier, so the test message uses the values just entered.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const ENV_PATH = '.env'

type Channel = 'telegram' | 'slack' | 'whatsapp' | 'webhook'

function say(lines: string | string[]): void {
  for (const line of Array.isArray(lines) ? lines : [lines]) console.log(line)
}

// Buffered line reader instead of readline/promises question(): with piped
// stdin all lines arrive at once and question() drops the ones emitted while
// no question is pending, which breaks scripted (agent-driven) runs.
const rl = createInterface({ input: process.stdin })
const lineBuffer: string[] = []
const lineWaiters: Array<(line: string) => void> = []
let stdinClosed = false
rl.on('line', (line) => {
  const waiter = lineWaiters.shift()
  if (waiter) waiter(line)
  else lineBuffer.push(line)
})
rl.on('close', () => {
  stdinClosed = true
  while (lineWaiters.length > 0) lineWaiters.shift()!('')
})

async function ask(question: string): Promise<string> {
  process.stdout.write(question)
  const buffered = lineBuffer.shift()
  if (buffered !== undefined) {
    if (!process.stdin.isTTY) process.stdout.write(buffered + '\n')
    return buffered.trim()
  }
  if (stdinClosed) {
    say('\nInput ended before the wizard finished. Nothing was changed beyond what was already saved.')
    process.exit(1)
  }
  const line = await new Promise<string>((resolve) => lineWaiters.push(resolve))
  if (stdinClosed && line === '' && lineBuffer.length === 0 && !process.stdin.isTTY) {
    say('\nInput ended before the wizard finished. Nothing was changed beyond what was already saved.')
    process.exit(1)
  }
  return line.trim()
}

async function askRequired(question: string): Promise<string> {
  while (true) {
    const answer = await ask(question)
    if (answer) return answer
    say('  A value is required here.')
  }
}

function upsertEnv(updates: Record<string, string>): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : []
  const pending = new Map(Object.entries(updates))
  const next = lines.map((line) => {
    const key = line.split('=')[0]?.trim()
    if (key && pending.has(key)) {
      const value = pending.get(key)!
      pending.delete(key)
      return `${key}=${value}`
    }
    return line
  })
  while (next.length > 0 && next[next.length - 1] === '') next.pop()
  for (const [key, value] of pending) next.push(`${key}=${value}`)
  writeFileSync(ENV_PATH, next.join('\n') + '\n')
  try {
    chmodSync(ENV_PATH, 0o600)
  } catch {}
}

function readEnvValue(key: string): string | null {
  if (!existsSync(ENV_PATH)) return null
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim() || null
  }
  return null
}

async function pickChannel(): Promise<Channel> {
  say([
    '',
    'Where should draft notifications be delivered?',
    '',
    '  1) Telegram          - a bot messages you (recommended: free, fast setup)',
    '  2) Slack             - posts into a Slack channel or DM',
    '  3) Your own WhatsApp - the bridge messages your own number (no extra app)',
    '  4) Generic webhook   - raw JSON POST to any URL you control',
    '',
  ])
  while (true) {
    const answer = await ask('Choose 1-4: ')
    if (answer === '1') return 'telegram'
    if (answer === '2') return 'slack'
    if (answer === '3') return 'whatsapp'
    if (answer === '4') return 'webhook'
    say('  Please enter 1, 2, 3 or 4.')
  }
}

async function setupTelegram(): Promise<Record<string, string>> {
  say([
    '',
    '── Telegram setup ─────────────────────────────────────────',
    '',
    '1. Open Telegram and search for @BotFather (blue checkmark).',
    '2. Send it: /newbot',
    '3. Pick a display name (e.g. "WA Drafts") and a username ending in "bot".',
    '4. BotFather replies with an HTTP API token like 123456789:AAH4...xyz',
    '',
  ])
  const token = await askRequired('Paste the bot token: ')

  say([
    '',
    'Now the wizard needs your chat id. Easiest way:',
    '  Open your new bot in Telegram (BotFather message has a t.me link)',
    '  and send it any message, e.g. "hi".',
    '',
  ])
  let chatId = ''
  while (!chatId) {
    await ask('Press Enter once you have messaged the bot... ')
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`)
      const body = await res.json() as {
        ok?: boolean
        result?: Array<{ message?: { chat?: { id?: number; first_name?: string; username?: string } } }>
      }
      const chats = (body.result ?? [])
        .map((u) => u.message?.chat)
        .filter((c): c is NonNullable<typeof c> => Boolean(c?.id))
      const last = chats[chats.length - 1]
      if (last?.id) {
        chatId = String(last.id)
        say(`  Found chat id ${chatId} (${last.first_name ?? last.username ?? 'you'}).`)
      } else {
        say('  No message found yet. Send the bot a message and try again,')
        say('  or type the chat id manually below (leave empty to retry).')
        const manual = await ask('  Chat id (optional): ')
        if (manual) chatId = manual
      }
    } catch {
      say('  Could not reach the Telegram API. Check the token and your connection.')
      const manual = await ask('  Chat id (optional, leave empty to retry): ')
      if (manual) chatId = manual
    }
  }

  return {
    AUTOREPLY_NOTIFY_CHANNEL: 'telegram',
    AUTOREPLY_TELEGRAM_BOT_TOKEN: token,
    AUTOREPLY_TELEGRAM_CHAT_ID: chatId,
  }
}

async function setupSlack(): Promise<Record<string, string>> {
  say([
    '',
    '── Slack setup ────────────────────────────────────────────',
    '',
    'Two ways to connect. The incoming webhook is simpler.',
    '',
    '  a) Incoming webhook (recommended)',
    '  b) Bot token + channel (if your workspace restricts webhooks)',
    '',
  ])
  const variant = (await ask('Choose a or b: ')).toLowerCase()

  if (variant !== 'b') {
    say([
      '',
      '1. Open https://api.slack.com/apps and click "Create New App" > "From scratch".',
      '2. Name it (e.g. "WA Drafts") and pick your workspace.',
      '3. In the app sidebar open "Incoming Webhooks" and toggle it On.',
      '4. Click "Add New Webhook to Workspace" and pick the channel or DM',
      '   that should receive the drafts.',
      '5. Copy the webhook URL (starts with https://hooks.slack.com/services/...).',
      '',
    ])
    const url = await askRequired('Paste the webhook URL: ')
    return {
      AUTOREPLY_NOTIFY_CHANNEL: 'slack',
      AUTOREPLY_SLACK_WEBHOOK_URL: url,
    }
  }

  say([
    '',
    '1. Open https://api.slack.com/apps and create an app "From scratch".',
    '2. In "OAuth & Permissions" add the bot token scope: chat:write',
    '3. Click "Install to Workspace" and approve.',
    '4. Copy the "Bot User OAuth Token" (starts with xoxb-).',
    '5. In Slack, open the target channel and /invite the bot into it.',
    '6. Get the channel id: channel name > "View channel details" >',
    '   the id at the bottom (starts with C...).',
    '',
  ])
  const token = await askRequired('Paste the bot token (xoxb-...): ')
  const channel = await askRequired('Paste the channel id (C...): ')
  return {
    AUTOREPLY_NOTIFY_CHANNEL: 'slack',
    AUTOREPLY_SLACK_BOT_TOKEN: token,
    AUTOREPLY_SLACK_CHANNEL: channel,
  }
}

async function setupWhatsApp(): Promise<Record<string, string>> {
  say([
    '',
    '── WhatsApp (your own number) setup ───────────────────────',
    '',
    'The bridge sends each draft notification as a normal WhatsApp',
    'message from the paired number to a chat you choose. Two options:',
    '',
    '  - Your OWN paired number  -> lands in the "Message yourself" chat.',
    '  - A SECOND number you own -> lands in that normal chat.',
    '',
    'Enter the number as country code + digits, no "+", no spaces',
    '(e.g. 491761234567).',
    '',
    'Note: replies you type in that chat are ignored by the autoreply',
    'service (loop protection) - it is a notification feed, not a control',
    'channel.',
    '',
  ])
  const digitsRaw = await askRequired('Number to notify: ')
  const digits = digitsRaw.replace(/\D/g, '')
  if (!digits) {
    say('  That did not contain any digits. Aborting.')
    process.exit(1)
  }
  const session = await ask('Bridge session name [main]: ')
  return {
    AUTOREPLY_NOTIFY_CHANNEL: 'whatsapp',
    AUTOREPLY_NOTIFY_WA_TO: digits,
    ...(session ? { AUTOREPLY_NOTIFY_WA_SESSION: session } : {}),
  }
}

async function setupWebhook(): Promise<Record<string, string>> {
  say([
    '',
    '── Generic webhook setup ──────────────────────────────────',
    '',
    'Every notification is POSTed as JSON to your URL. If you set a',
    'token it arrives as "Authorization: Bearer <token>".',
    '',
  ])
  const url = await askRequired('Webhook URL: ')
  const token = await ask('Bearer token (optional): ')
  return {
    AUTOREPLY_NOTIFY_CHANNEL: 'webhook',
    AUTOREPLY_NOTIFY_WEBHOOK_URL: url,
    ...(token ? { AUTOREPLY_NOTIFY_WEBHOOK_TOKEN: token } : {}),
  }
}

async function sendTest(updates: Record<string, string>): Promise<void> {
  // Make the new values visible to autoreply-env.ts, which reads process.env
  // on first import. .env values never override existing process.env keys.
  for (const [key, value] of Object.entries(updates)) process.env[key] = value

  if (updates.AUTOREPLY_NOTIFY_CHANNEL === 'whatsapp') {
    // The WhatsApp channel sends through the local bridge API.
    const health = await fetch('http://127.0.0.1:8080/v1/health').catch(() => null)
    if (!health?.ok) {
      say([
        '',
        'The bridge daemon is not reachable on 127.0.0.1:8080, so the test',
        'message cannot be sent now. Start it with: npm run start',
        'Config was still written - notifications will work once it runs.',
      ])
      return
    }
  }

  say('')
  const answer = (await ask('Send a test notification now? [Y/n] ')).toLowerCase()
  if (answer === 'n' || answer === 'no') return

  const { sendDraftNotification } = await import('./autoreply-notify.js')
  const ok = await sendDraftNotification({
    kind: 'whatsapp_draft',
    session: 'main',
    contact_label: 'Setup wizard',
    incoming_text: 'This is a test message from the notification setup wizard.',
    draft_reply: 'If you can read this, draft notifications are wired up correctly.',
    confidence: 0.99,
    should_send: false,
    needs_review: false,
    reasons: ['setup-wizard test'],
  }).catch((error: unknown) => {
    say(`  Test failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  })

  say(ok ? '  Test notification sent - check the channel.' : '  Test notification FAILED - re-check the values in .env.')
}

async function main(): Promise<void> {
  say([
    '',
    'whatsapp-bridge autoreply - notification channel setup',
    '=================================================',
  ])

  const current = readEnvValue('AUTOREPLY_NOTIFY_CHANNEL')
  if (current) say(`\nCurrently configured channel: ${current}`)

  const channel = await pickChannel()
  const updates =
    channel === 'telegram' ? await setupTelegram()
    : channel === 'slack' ? await setupSlack()
    : channel === 'whatsapp' ? await setupWhatsApp()
    : await setupWebhook()

  upsertEnv(updates)
  say([
    '',
    `Saved to ${ENV_PATH}:`,
    ...Object.keys(updates).map((key) => `  ${key}`),
  ])

  await sendTest(updates)

  say([
    '',
    'Done. If the autoreply sidecar is already running, restart it so it',
    'picks up the new channel:',
    '  npm run autoreply           (foreground)',
    '  npm run autoreply:restart   (if installed as a launchd service)',
    '',
  ])
  rl.close()
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
