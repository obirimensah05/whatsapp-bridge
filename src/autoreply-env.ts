import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ENV_PATH = '.env'

function loadDotEnv(): void {
  if (!existsSync(ENV_PATH)) return
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadDotEnv()
// .env holds bearer tokens + provider keys — keep it unreadable to other local users.
if (existsSync(ENV_PATH)) {
  try {
    chmodSync(ENV_PATH, 0o600)
  } catch {}
}

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`[autoreply/env] ${key} is required but not set`)
  return value
}

export const AUTOREPLY_TOKEN = process.env.AUTOREPLY_TOKEN?.trim() || null
export const AUTOREPLY_PORT = Number(process.env.AUTOREPLY_PORT ?? 8081)
export const AUTOREPLY_HOST = process.env.AUTOREPLY_HOST ?? '127.0.0.1'
export const AUTOREPLY_DATA_DIR = process.env.AUTOREPLY_DATA_DIR?.trim() || './data/autoreply'

export const WHATSAPP_BRIDGE_BASE = (process.env.WHATSAPP_BRIDGE_BASE?.trim() || 'http://127.0.0.1:8080').replace(/\/$/, '')
export const WHATSAPP_BRIDGE_TOKEN = process.env.WHATSAPP_BRIDGE_TOKEN?.trim() || process.env.API_TOKEN?.trim() || null

export const AUTOREPLY_NOTIFY_WEBHOOK_URL = process.env.AUTOREPLY_NOTIFY_WEBHOOK_URL?.trim() || null
export const AUTOREPLY_NOTIFY_WEBHOOK_TOKEN = process.env.AUTOREPLY_NOTIFY_WEBHOOK_TOKEN?.trim() || null
export const AUTOREPLY_TELEGRAM_BOT_TOKEN = process.env.AUTOREPLY_TELEGRAM_BOT_TOKEN?.trim() || null
export const AUTOREPLY_TELEGRAM_CHAT_ID = process.env.AUTOREPLY_TELEGRAM_CHAT_ID?.trim() || null
export const AUTOREPLY_STYLE_CORPUS_PATH = process.env.AUTOREPLY_STYLE_CORPUS_PATH?.trim() || join(AUTOREPLY_DATA_DIR, 'style-corpus.md')
export const AUTOREPLY_CLAUDE_BIN = process.env.AUTOREPLY_CLAUDE_BIN?.trim() || 'claude'
export const AUTOREPLY_MODEL = process.env.AUTOREPLY_MODEL?.trim() || 'sonnet'
export const AUTOREPLY_MIN_CONFIDENCE = Number(process.env.AUTOREPLY_MIN_CONFIDENCE ?? '0.78')
export const AUTOREPLY_AUTO_SEND_COOLDOWN_MS = Number(process.env.AUTOREPLY_AUTO_SEND_COOLDOWN_MS ?? `${10 * 60 * 1000}`)
export const AUTOREPLY_ALLOW_GROUP_AUTO = process.env.AUTOREPLY_ALLOW_GROUP_AUTO === '1'
export const AUTOREPLY_WA_API_BASE = process.env.AUTOREPLY_WA_API_BASE?.trim()
  || `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? '8080'}/v1`
export const AUTOREPLY_WA_API_TOKEN = process.env.AUTOREPLY_WA_API_TOKEN?.trim() || process.env.API_TOKEN?.trim() || null
export const AUTOREPLY_DEFAULT_SESSION = process.env.AUTOREPLY_DEFAULT_SESSION?.trim() || 'main'
export const AUTOREPLY_SECOND_BRAIN_ROOT = process.env.AUTOREPLY_SECOND_BRAIN_ROOT?.trim()
  || ''
