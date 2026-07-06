// Context from the bridge's own message store, used when no external notes
// source ("second brain") is configured: the model gets recent conversation
// history with the chat plus keyword matches from all stored messages, so
// drafts are grounded in what was actually said before.
//
// Also auto-builds the style corpus from outbound (sent) messages when the
// corpus file does not exist yet, so drafting works out of the box.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { AUTOREPLY_DEFAULT_SESSION, AUTOREPLY_STYLE_CORPUS_PATH } from './autoreply-env.js'
import { db, expandJidGroup } from './db.js'

type HistoryRow = {
  ts: number
  direction: string
  chat_jid: string
  content: string
}

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'what', 'when', 'where', 'your', 'about',
  'would', 'could', 'should', 'there', 'their', 'they', 'them', 'then', 'than',
  'aber', 'auch', 'noch', 'sind', 'oder', 'nicht', 'eine', 'einen', 'schon',
  'kannst', 'gerade', 'heute', 'morgen', 'danke', 'bitte', 'hallo',
])

function extractKeywords(query: string, max = 5): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word))
  return Array.from(new Set(words)).slice(0, max)
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function formatRow(row: HistoryRow): string {
  const who = row.direction === 'out' ? 'me' : 'them'
  const text = row.content.replace(/\s+/g, ' ').trim().slice(0, 300)
  return `- [${new Date(row.ts).toISOString().slice(0, 10)}] ${who}: ${text}`
}

// Synchronous by design - better-sqlite3 is synchronous and the queries are
// index-backed and cheap.
export function fetchWhatsAppHistoryContext(params: {
  query: string
  chatJid?: string | null
  session?: string | null
}): string {
  const session = params.session?.trim() || AUTOREPLY_DEFAULT_SESSION
  const sections: string[] = []

  try {
    if (params.chatJid) {
      const jids = expandJidGroup(session, params.chatJid)
      const placeholders = jids.map(() => '?').join(',')
      const rows = db.prepare(`
        SELECT ts, direction, chat_jid, COALESCE(body, transcript) AS content
        FROM messages
        WHERE session = ? AND chat_jid IN (${placeholders})
          AND COALESCE(body, transcript) IS NOT NULL
          AND TRIM(COALESCE(body, transcript)) != ''
        ORDER BY ts DESC
        LIMIT 25
      `).all(session, ...jids) as HistoryRow[]
      if (rows.length > 0) {
        sections.push('Recent conversation with this chat (oldest first):')
        sections.push(...rows.reverse().map(formatRow))
      }
    }

    const keywords = extractKeywords(params.query)
    const seen = new Set<string>()
    const matches: string[] = []
    for (const keyword of keywords) {
      const pattern = `%${escapeLike(keyword)}%`
      const rows = db.prepare(`
        SELECT ts, direction, chat_jid, COALESCE(body, transcript) AS content
        FROM messages
        WHERE session = ?
          AND (body LIKE ? ESCAPE '\\' OR transcript LIKE ? ESCAPE '\\')
        ORDER BY ts DESC
        LIMIT 4
      `).all(session, pattern, pattern) as HistoryRow[]
      for (const row of rows) {
        const key = `${row.ts}:${row.content.slice(0, 80)}`
        if (seen.has(key)) continue
        seen.add(key)
        matches.push(formatRow(row))
      }
    }
    if (matches.length > 0) {
      sections.push('')
      sections.push('Related past messages (keyword matches, newest first):')
      sections.push(...matches.slice(0, 15))
    }
  } catch {
    return ''
  }

  return sections.join('\n').slice(0, 6000)
}

// Builds a WhatsApp-only style corpus from the operator's own sent messages
// when no corpus file exists yet. `npm run autoreply:build-corpus` still
// produces the richer version; this is the zero-setup fallback.
export function ensureStyleCorpus(): void {
  try {
    if (existsSync(AUTOREPLY_STYLE_CORPUS_PATH) && statSync(AUTOREPLY_STYLE_CORPUS_PATH).size > 0) return

    const rows = db.prepare(`
      SELECT ts, chat_jid, type, COALESCE(body, transcript) AS content
      FROM messages
      WHERE direction = 'out'
        AND COALESCE(body, transcript) IS NOT NULL
        AND TRIM(COALESCE(body, transcript)) != ''
      ORDER BY ts DESC
      LIMIT 1200
    `).all() as Array<{ ts: number; chat_jid: string; type: string; content: string }>
    if (rows.length === 0) return

    const lines = [
      '# Autoreply style corpus (auto-built from WhatsApp outbound history)',
      '',
      `Generated at: ${new Date().toISOString()}`,
      `Sampled messages: ${rows.length}`,
      '',
      'Recent outbound samples (newest first):',
      '',
      ...rows.map((row) => {
        const clean = row.content.replace(/\s+/g, ' ').trim()
        return `- ts=${row.ts} chat=${row.chat_jid} type=${row.type} text=${JSON.stringify(clean)}`
      }),
      '',
    ]

    mkdirSync(dirname(AUTOREPLY_STYLE_CORPUS_PATH), { recursive: true })
    writeFileSync(AUTOREPLY_STYLE_CORPUS_PATH, lines.join('\n'))
  } catch {
    // Non-fatal: drafting still works without a corpus, just less in-voice.
  }
}
