import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AUTOREPLY_DATA_DIR } from './autoreply-env.js'

export type AutoReplyMode = 'draft' | 'auto' | 'off'
export type AutoReplyScope = 'all' | 'contacts' | 'groups' | 'mixed'

export interface ActiveHours {
  start: string
  end: string
  timezone: string
}

export interface AutoReplyPolicy {
  mode: AutoReplyMode
  scope: AutoReplyScope
  contacts: string[]
  groups: string[]
  active_until: string | null
  active_hours: ActiveHours | null
  notes: string | null
  updated_at: string
}

export interface AutoReplyAuditEntry {
  ts: string
  event:
    | 'webhook_received'
    | 'webhook_enrichment_failed'
    | 'policy_read'
    | 'policy_updated'
    | 'draft_logged'
    | 'auto_sent'
    | 'safety_blocked'
  data: Record<string, unknown>
}

export interface DecisionContext {
  chat_jid?: string | null
  is_group?: boolean | null
  now?: Date
}

const POLICY_PATH = join(AUTOREPLY_DATA_DIR, 'policy.json')
const AUDIT_PATH = join(AUTOREPLY_DATA_DIR, 'audit.ndjson')
const DRAFTS_PATH = join(AUTOREPLY_DATA_DIR, 'drafts.ndjson')

function readNdjson(path: string, limit = 500): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
  return lines.slice(-limit).flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}

const DEFAULT_POLICY: AutoReplyPolicy = {
  mode: 'draft',
  scope: 'all',
  contacts: [],
  groups: [],
  active_until: null,
  active_hours: null,
  notes: 'Default draft-only mode for all chats.',
  updated_at: new Date(0).toISOString(),
}

function ensureDataDir(): void {
  mkdirSync(AUTOREPLY_DATA_DIR, { recursive: true })
}

export function getDefaultPolicy(): AutoReplyPolicy {
  return structuredClone(DEFAULT_POLICY)
}

export function readPolicy(): AutoReplyPolicy {
  ensureDataDir()
  if (!existsSync(POLICY_PATH)) return getDefaultPolicy()
  try {
    const raw = JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as Partial<AutoReplyPolicy>
    return {
      ...getDefaultPolicy(),
      ...raw,
      contacts: Array.isArray(raw.contacts) ? raw.contacts : [],
      groups: Array.isArray(raw.groups) ? raw.groups : [],
      active_hours: raw.active_hours ?? null,
      active_until: raw.active_until ?? null,
      notes: raw.notes ?? null,
      updated_at: raw.updated_at ?? getDefaultPolicy().updated_at,
    }
  } catch {
    return getDefaultPolicy()
  }
}

export function writePolicy(next: Omit<AutoReplyPolicy, 'updated_at'>): AutoReplyPolicy {
  ensureDataDir()
  const policy: AutoReplyPolicy = {
    ...next,
    contacts: Array.from(new Set(next.contacts.map((v) => v.trim()).filter(Boolean))),
    groups: Array.from(new Set(next.groups.map((v) => v.trim()).filter(Boolean))),
    updated_at: new Date().toISOString(),
  }
  writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2))
  return policy
}

export function appendAudit(event: AutoReplyAuditEntry['event'], data: Record<string, unknown>): void {
  ensureDataDir()
  const entry: AutoReplyAuditEntry = {
    ts: new Date().toISOString(),
    event,
    data,
  }
  appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n')
}

export function appendDraft(data: Record<string, unknown>): void {
  ensureDataDir()
  appendFileSync(
    DRAFTS_PATH,
    JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n',
  )
}

export function hasDraftForMessage(messageId: string | null | undefined): boolean {
  if (!messageId) return false
  return readNdjson(DRAFTS_PATH, 500).some((entry) => entry.message_id === messageId)
}

export function hasRecentAutoSend(chatJid: string | null | undefined, windowMs: number): boolean {
  if (!chatJid || windowMs <= 0) return false
  const cutoff = Date.now() - windowMs
  return readNdjson(AUDIT_PATH, 500).some((entry) => {
    if (entry.event !== 'auto_sent') return false
    const data = entry.data as Record<string, unknown> | undefined
    if (!data || data.chat_jid !== chatJid) return false
    const ts = typeof data.ts === 'number' ? data.ts : Date.parse(String(entry.ts ?? ''))
    return Number.isFinite(ts) && ts >= cutoff
  })
}

function isWithinUntil(activeUntil: string | null, now: Date): boolean {
  if (!activeUntil) return true
  const untilMs = Date.parse(activeUntil)
  return Number.isFinite(untilMs) && now.getTime() <= untilMs
}

function toMinutes(hhmm: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function isWithinHours(activeHours: ActiveHours | null, now: Date): boolean {
  if (!activeHours) return true
  const start = toMinutes(activeHours.start)
  const end = toMinutes(activeHours.end)
  if (start == null || end == null) return false

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: activeHours.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  const current = hour * 60 + minute

  if (start === end) return true
  if (start < end) return current >= start && current <= end
  return current >= start || current <= end
}

function scopeAllows(policy: AutoReplyPolicy, chatJid: string | null | undefined, isGroup: boolean | null | undefined): boolean {
  if (policy.scope === 'all') return true
  if (!chatJid) return false
  if (policy.scope === 'contacts') return !isGroup && policy.contacts.includes(chatJid)
  if (policy.scope === 'groups') return !!isGroup && policy.groups.includes(chatJid)
  if (policy.scope === 'mixed') {
    if (isGroup) return policy.groups.includes(chatJid)
    return policy.contacts.includes(chatJid)
  }
  return false
}

export function evaluatePolicy(policy: AutoReplyPolicy, context: DecisionContext): {
  active: boolean
  mode: AutoReplyMode
  reason: string
} {
  const now = context.now ?? new Date()
  if (policy.mode === 'off') return { active: false, mode: 'off', reason: 'policy mode is off' }
  if (!isWithinUntil(policy.active_until, now)) {
    return { active: false, mode: policy.mode, reason: 'outside active_until window' }
  }
  if (!isWithinHours(policy.active_hours, now)) {
    return { active: false, mode: policy.mode, reason: 'outside active_hours window' }
  }
  if (!scopeAllows(policy, context.chat_jid, context.is_group)) {
    return { active: false, mode: policy.mode, reason: 'chat is outside configured scope' }
  }
  return { active: true, mode: policy.mode, reason: 'policy active' }
}
