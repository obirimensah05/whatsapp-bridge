import pino from 'pino'

import { WEBHOOK_URL, WEBHOOK_TOKEN } from './env.js'
import { pushNameFor, phoneFor, type MessageInput } from './db.js'

const log = pino({ level: 'info' }).child({ mod: 'webhook' })

const RETRY_DELAYS_MS = [1_000, 3_000]
const PER_ATTEMPT_TIMEOUT_MS = 5_000

async function postOnce(url: string, body: unknown): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (WEBHOOK_TOKEN) headers['Authorization'] = `Bearer ${WEBHOOK_TOKEN}`
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      // Operator-set URL, but don't follow redirects to private hosts via 30x.
      redirect: 'manual',
    })
  } finally {
    clearTimeout(timer)
  }
}

async function postWithRetry(url: string, body: unknown): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await postOnce(url, body)
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    } catch (err) {
      lastErr = err
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
    }
  }
  throw lastErr
}

function extractMentionJids(rawJson: string | null): string[] {
  if (!rawJson) return []

  const seen = new Set<string>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }

    const record = value as Record<string, unknown>
    const mentioned = record.mentionedJid
    if (Array.isArray(mentioned)) {
      for (const jid of mentioned) {
        if (typeof jid === 'string' && jid.trim()) seen.add(jid.trim())
      }
    }

    for (const nested of Object.values(record)) visit(nested)
  }

  try {
    visit(JSON.parse(rawJson))
  } catch {
    return []
  }

  return Array.from(seen)
}

export function buildPayload(message: MessageInput) {
  return {
    event: 'message',
    session: message.session,
    message: {
      id: message.id,
      ts: message.ts,
      direction: message.direction,
      chat_jid: message.chat_jid,
      from_jid: message.from_jid,
      type: message.type,
      body: message.body,
      from_display_name: pushNameFor(message.session, message.from_jid),
      from_phone: phoneFor(message.session, message.from_jid),
      chat_phone: phoneFor(message.session, message.chat_jid),
      mention_jids: extractMentionJids(message.raw_json),
    },
  }
}

export function dispatchInbound(message: MessageInput): void {
  if (!WEBHOOK_URL) return
  const payload = buildPayload(message)
  postWithRetry(WEBHOOK_URL, payload).catch((err) => {
    log.error(
      { err: (err as Error).message, message_id: message.id },
      'webhook dispatch failed after retries',
    )
  })
}

export async function dispatchTest(): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!WEBHOOK_URL) return { ok: false, error: 'WEBHOOK_URL not configured' }
  try {
    const res = await postOnce(WEBHOOK_URL, {
      event: 'test',
      ts: Date.now(),
      message: 'whatsapp-bridge webhook test ping',
    })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
