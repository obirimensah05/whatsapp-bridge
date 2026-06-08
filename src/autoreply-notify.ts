import {
  AUTOREPLY_NOTIFY_WEBHOOK_TOKEN,
  AUTOREPLY_NOTIFY_WEBHOOK_URL,
  AUTOREPLY_TELEGRAM_BOT_TOKEN,
  AUTOREPLY_TELEGRAM_CHAT_ID,
} from './autoreply-env.js'

function escapeTelegram(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&')
}

function renderTelegramMessage(payload: Record<string, unknown>): string {
  const kind = String(payload.kind ?? '').trim()
  const incoming = String(payload.incoming_text ?? '').trim()
  const chat = String(payload.contact_label ?? payload.chat_jid ?? 'unknown').trim()

  if (kind === 'whatsapp_inbound') {
    const session = String(payload.session ?? 'main').trim()
    const messageType = String(payload.message_type ?? 'text').trim()
    return [
      '📩 *WhatsApp inbound*',
      `chat: ${escapeTelegram(chat || 'unknown')}`,
      `session: ${escapeTelegram(session || 'main')}`,
      `type: ${escapeTelegram(messageType || 'text')}`,
      '',
      '*Message*',
      escapeTelegram(incoming || '(empty)'),
    ].join('\n')
  }

  const draft = String(payload.draft_reply ?? '').trim()
  const confidence = payload.confidence == null ? 'n/a' : String(payload.confidence)
  const reasons = Array.isArray(payload.reasons) ? payload.reasons.map((v) => `- ${String(v)}`).join('\n') : ''

  return [
    '🟢 *WhatsApp draft*',
    `chat: ${escapeTelegram(chat || 'unknown')}`,
    '',
    '*Incoming*',
    escapeTelegram(incoming || '(empty)'),
    '',
    '*Draft as operator*',
    escapeTelegram(draft || '(empty)'),
    '',
    `confidence: *${escapeTelegram(confidence)}*`,
    reasons ? `reasons:\n${escapeTelegram(reasons)}` : '',
  ].filter(Boolean).join('\n')
}

async function sendWebhookNotification(payload: Record<string, unknown>): Promise<boolean> {
  if (!AUTOREPLY_NOTIFY_WEBHOOK_URL) return false
  const res = await fetch(AUTOREPLY_NOTIFY_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AUTOREPLY_NOTIFY_WEBHOOK_TOKEN ? { Authorization: `Bearer ${AUTOREPLY_NOTIFY_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
  })
  return res.ok
}

async function sendTelegramNotification(payload: Record<string, unknown>): Promise<boolean> {
  if (!AUTOREPLY_TELEGRAM_BOT_TOKEN || !AUTOREPLY_TELEGRAM_CHAT_ID) return false
  const res = await fetch(`https://api.telegram.org/bot${AUTOREPLY_TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: AUTOREPLY_TELEGRAM_CHAT_ID,
      text: renderTelegramMessage(payload),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
  })
  return res.ok
}

export async function sendDraftNotification(payload: Record<string, unknown>): Promise<boolean> {
  if (await sendWebhookNotification(payload)) return true
  return await sendTelegramNotification(payload)
}

export async function sendInboundNotification(payload: Record<string, unknown>): Promise<boolean> {
  if (await sendWebhookNotification(payload)) return true
  return await sendTelegramNotification(payload)
}
