// In-process sliding-window rate limiter for the bridge API.
//
// Purpose: bound the blast radius of a runaway agent loop or a leaked bearer
// token, and keep programmatic send velocity under WhatsApp's observed
// spam-detection thresholds (2026 field data, unofficial clients):
//   send velocity  safe < 30 msgs/hour | warning 30-60/hr | danger > 60/hr
// The bridge only gates API-driven traffic - messages typed on the phone are
// not affected. Reads (/v1/messages, /v1/conversations, ...) are not limited.
//
// Every limit is env-configurable; set a variable to 0 to disable that limit.
//   RATE_LIMIT_SEND_PER_MIN    default 20   burst cap on POST /v1/send
//   RATE_LIMIT_SEND_PER_HOUR   default 60   sustained cap on POST /v1/send
//   RATE_LIMIT_CHECK_PER_MIN   default 300  GET /v1/check (bulk contact import)
//   RATE_LIMIT_SEARCH_PER_MIN  default 60   /v1/contacts/search + /v1/groups/participants
//
// Single-process, loopback-only service -> one window per rule (no per-IP
// keying needed). Windows are timestamp arrays pruned on each hit; memory is
// bounded by the largest max.

interface WindowRule {
  windowMs: number
  max: number
  hits: number[]
}

export interface RateVerdict {
  ok: boolean
  retryAfterSeconds?: number
  rule?: string
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function makeRules(name: string, specs: Array<{ env: string; fallback: number; windowMs: number }>): { name: string; rules: WindowRule[] } {
  return {
    name,
    rules: specs
      .map(({ env, fallback, windowMs }) => ({ windowMs, max: envInt(env, fallback), hits: [] as number[] }))
      .filter((r) => r.max > 0), // 0 = that limit disabled
  }
}

const MINUTE = 60_000
const HOUR = 3_600_000

const limiters = {
  send: makeRules('send', [
    { env: 'RATE_LIMIT_SEND_PER_MIN', fallback: 20, windowMs: MINUTE },
    { env: 'RATE_LIMIT_SEND_PER_HOUR', fallback: 60, windowMs: HOUR },
  ]),
  check: makeRules('check', [
    { env: 'RATE_LIMIT_CHECK_PER_MIN', fallback: 300, windowMs: MINUTE },
  ]),
  search: makeRules('search', [
    { env: 'RATE_LIMIT_SEARCH_PER_MIN', fallback: 60, windowMs: MINUTE },
  ]),
}

export type LimiterName = keyof typeof limiters

function take(name: LimiterName, now: number): RateVerdict {
  const limiter = limiters[name]
  // Check all windows first so a blocked request consumes no budget.
  for (const rule of limiter.rules) {
    const cutoff = now - rule.windowMs
    while (rule.hits.length && rule.hits[0] <= cutoff) rule.hits.shift()
    if (rule.hits.length >= rule.max) {
      const retryAfterMs = rule.hits[0] + rule.windowMs - now
      return {
        ok: false,
        rule: `${limiter.name}:${rule.windowMs === MINUTE ? 'per-minute' : 'per-hour'}`,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      }
    }
  }
  for (const rule of limiter.rules) rule.hits.push(now)
  return { ok: true }
}

// Maps a request path (query already stripped) to the limiter that governs it.
// Returns null for unlimited routes (all reads, health, media, webhook-test).
export function limiterForPath(method: string, path: string): LimiterName | null {
  if (method === 'POST' && path === '/v1/send') return 'send'
  if (path === '/v1/check') return 'check'
  if (path === '/v1/contacts/search' || path === '/v1/groups/participants') return 'search'
  return null
}

export function checkRateLimit(method: string, path: string, now = Date.now()): RateVerdict {
  const name = limiterForPath(method, path)
  if (!name) return { ok: true }
  return take(name, now)
}
