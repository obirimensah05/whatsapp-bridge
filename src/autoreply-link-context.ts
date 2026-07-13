import { execFile } from 'node:child_process'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const MAX_BODY_BYTES = 2_000_000
const MAX_REDIRECTS = 5

// SSRF guard: link URLs come from inbound (attacker-controlled) WhatsApp
// messages, so before fetching we reject any host that resolves to a
// loopback/private/link-local/ULA/metadata address. Public links still work -
// only internal targets are blocked.
function ipIsPrivate(ip: string): boolean {
  const v = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(ip.lastIndexOf(':') + 1) : ip
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number)
    if (a === 0 || a === 127 || a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }
  const l = ip.toLowerCase()
  if (l === '::1' || l === '::' || l === '::0') return true
  if (l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true
  return false
}

async function assertSafePublicUrl(raw: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('invalid url')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported scheme')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (ipIsPrivate(host)) throw new Error('blocked private address')
    return u
  }
  const resolved = await lookup(host, { all: true })
  if (resolved.length === 0) throw new Error('host did not resolve')
  if (resolved.some((r) => ipIsPrivate(r.address))) throw new Error('host resolves to a private address')
  return u
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return (await res.text()).slice(0, maxBytes)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* ignore */ }
        break
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Fetch text with per-hop SSRF validation (manual redirects, so a public URL
// cannot 302 into internal space), a size cap, and a content-type gate.
async function safeFetchText(startUrl: string): Promise<{ url: string; contentType: string; text: string }> {
  let current = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertSafePublicUrl(current)
    const res = await fetch(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; whatsapp-bridge-autoreply/1.0)',
        'Accept': 'text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8,*/*;q=0.5',
      },
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error(`redirect ${res.status} without location`)
      current = new URL(location, u).toString()
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (contentType && !/text\/html|text\/plain|application\/xhtml/.test(contentType)) {
      throw new Error(`unsupported content-type: ${contentType.split(';')[0]}`)
    }
    const declaredLen = Number(res.headers.get('content-length') || '0')
    if (declaredLen && declaredLen > MAX_BODY_BYTES) throw new Error('response too large')
    const text = await readCapped(res, MAX_BODY_BYTES)
    return { url: u.toString(), contentType, text }
  }
  throw new Error('too many redirects')
}

// Optional external YouTube-transcript fetcher, configured out-of-band so no
// machine-specific path lives in source. Expected to accept
// `<url> --text-only --timestamps` and print the transcript to stdout. When
// unset, YouTube links fall back to the generic page fetch (og:description etc).
function youtubeTranscriptScript(): string | null {
  return process.env.AUTOREPLY_YT_TRANSCRIPT_SCRIPT?.trim() || null
}

function extractUrls(text: string, max = 3): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()\[\]{}"']+/gi) ?? []
  const cleaned = matches
    .map((url) => url.replace(/[),.!?]+$/, ''))
    .filter(Boolean)
  return Array.from(new Set(cleaned)).slice(0, max)
}

function isYoutubeUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
    return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')
  } catch {
    return false
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTag(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html)
  return match?.[1]?.trim() || null
}

async function fetchGenericLinkContext(url: string): Promise<string> {
  const { contentType, text: raw } = await safeFetchText(url)
  if (!raw.trim()) return `Linked URL: ${url}\n(No readable body returned)`

  if (contentType.includes('text/plain')) {
    return `Linked URL: ${url}\nPlain text:\n${raw.replace(/\s+/g, ' ').trim().slice(0, 5000)}`
  }

  const title = extractTag(raw, /<title[^>]*>([\s\S]*?)<\/title>/i)
  const description = extractTag(raw, /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)
  const bodyText = stripHtml(raw).slice(0, 5000)
  return [
    `Linked URL: ${url}`,
    title ? `Title: ${title}` : null,
    description ? `Description: ${description}` : null,
    `Body excerpt: ${bodyText}`,
  ].filter(Boolean).join('\n')
}

async function fetchYoutubeContext(url: string): Promise<string> {
  const script = youtubeTranscriptScript()
  // No external fetcher configured -> fall back to the generic page fetch so
  // YouTube links still yield the video title/description via og: tags.
  if (!script) return fetchGenericLinkContext(url)
  const { stdout } = await execFileAsync('uv', [
    'run',
    '--with',
    'youtube-transcript-api',
    'python3',
    script,
    url,
    '--text-only',
    '--timestamps',
  ], {
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  })
  const transcript = stdout.replace(/\s+$/,'').slice(0, 12000)
  return `Linked YouTube URL: ${url}\nTranscript:\n${transcript}`
}

export async function buildLinkContext(incomingText: string): Promise<string> {
  const urls = extractUrls(incomingText)
  if (urls.length === 0) return ''

  const chunks: string[] = []
  for (const url of urls) {
    try {
      const context = isYoutubeUrl(url)
        ? await fetchYoutubeContext(url)
        : await fetchGenericLinkContext(url)
      chunks.push(context)
    } catch (error) {
      chunks.push(`Linked URL: ${url}\n(Read failed: ${error instanceof Error ? error.message : String(error)})`)
    }
  }

  return chunks.join('\n\n---\n\n').slice(0, 18000)
}
