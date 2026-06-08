import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import pino from 'pino'

const log = pino({ level: 'info' }).child({ mod: 'updates' })

export interface BaileysCheck {
  current: string
  latest: string | null
  behind: boolean
}

export interface WaBridgeCheck {
  current_sha: string
  latest_sha: string | null
  behind: boolean
}

export interface UpdateCheck {
  baileys: BaileysCheck | null
  wabridge: WaBridgeCheck | null
  checked_at: number | null
}

let cache: UpdateCheck = { baileys: null, wabridge: null, checked_at: null }

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // daily
const FETCH_TIMEOUT_MS = 8_000

async function fetchJson(url: string): Promise<unknown | null> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'whatsapp-bridge-update-check' },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

function isPreRelease(v: string): boolean {
  return v.includes('-') // 7.0.0-rc.9, 1.2.3-beta.1, etc.
}

async function checkBaileys(): Promise<BaileysCheck | null> {
  const pkgPath = './node_modules/@whiskeysockets/baileys/package.json'
  if (!existsSync(pkgPath)) return null
  const current = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version

  // Pick "newest stable that the publisher has released" by publication time,
  // not by semver. Baileys' versioning has been inconsistent — pure semver can
  // point at an abandoned older branch with a higher minor number. The npm
  // `latest` dist-tag is also unreliable here (currently a pre-release).
  const meta = await fetchJson('https://registry.npmjs.org/@whiskeysockets/baileys')
  const times = (meta as { time?: Record<string, string> })?.time ?? {}
  const stable = Object.entries(times)
    .filter(([k, v]) => k !== 'created' && k !== 'modified' && !isPreRelease(k) && typeof v === 'string')
    .sort(([, a], [, b]) => Date.parse(b) - Date.parse(a))
  const latest = stable[0]?.[0] ?? null
  if (!latest) return { current, latest: null, behind: false }
  // "behind" only when the publisher's most-recent stable differs from ours.
  // If we're on a pre-release and the most-recent stable is older, don't nag.
  const currentPubMs = Date.parse(times[current] ?? '') || 0
  const latestPubMs = Date.parse(times[latest] ?? '') || 0
  const behind = current !== latest && latestPubMs > currentPubMs
  return { current, latest, behind }
}

// Parse "git+https://github.com/owner/repo.git" / "owner/repo" into "owner/repo".
function parseRepoSlug(repoField: unknown): string | null {
  if (!repoField) return null
  const raw =
    typeof repoField === 'string'
      ? repoField
      : typeof (repoField as { url?: string }).url === 'string'
        ? (repoField as { url: string }).url
        : null
  if (!raw) return null
  const m = raw.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/)
  if (m) return m[1]
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return raw
  return null
}

async function checkWaBridge(): Promise<WaBridgeCheck | null> {
  // Local HEAD: read .git/HEAD to find the current branch ref, then resolve it.
  const headPath = './.git/HEAD'
  if (!existsSync(headPath)) return null
  let current_sha: string
  const head = readFileSync(headPath, 'utf8').trim()
  if (head.startsWith('ref: ')) {
    const refPath = `./.git/${head.slice(5).trim()}`
    if (!existsSync(refPath)) return null
    current_sha = readFileSync(refPath, 'utf8').trim()
  } else {
    current_sha = head // detached HEAD
  }

  // Repository slug from package.json.
  let pkg: { repository?: unknown } = {}
  try { pkg = JSON.parse(readFileSync('./package.json', 'utf8')) } catch { return null }
  const slug = parseRepoSlug(pkg.repository)
  if (!slug) return null

  const branch = process.env.WA_UPDATE_BRANCH ?? 'main'
  const remote = await fetchJson(`https://api.github.com/repos/${slug}/commits/${branch}`)
  if (!remote || typeof (remote as any).sha !== 'string') {
    return { current_sha, latest_sha: null, behind: false }
  }
  const latest_sha = (remote as { sha: string }).sha

  let behind = current_sha !== latest_sha
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', current_sha, latest_sha], {
      stdio: 'ignore',
      cwd: process.cwd(),
    })
    behind = current_sha !== latest_sha
  } catch {
    behind = false
  }

  return { current_sha, latest_sha, behind }
}

export async function refreshUpdates(): Promise<UpdateCheck> {
  const [baileys, wabridge] = await Promise.allSettled([checkBaileys(), checkWaBridge()])
  cache = {
    baileys: baileys.status === 'fulfilled' ? baileys.value : null,
    wabridge: wabridge.status === 'fulfilled' ? wabridge.value : null,
    checked_at: Date.now(),
  }
  if (cache.baileys?.behind) {
    log.warn(
      { current: cache.baileys.current, latest: cache.baileys.latest },
      'baileys is out of date — `npm install @whiskeysockets/baileys@latest && restart`',
    )
  }
  if (cache.wabridge?.behind) {
    log.warn(
      { current: cache.wabridge.current_sha.slice(0, 7), latest: cache.wabridge.latest_sha?.slice(0, 7) },
      'whatsapp-bridge is behind origin — `git pull && npm install && restart`',
    )
  }
  return cache
}

export function getUpdates(): UpdateCheck {
  return cache
}

export function startUpdateWatcher(): void {
  void refreshUpdates()
  setInterval(() => void refreshUpdates(), CHECK_INTERVAL_MS).unref()
}
