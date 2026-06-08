import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

import {
  AUTOREPLY_SECOND_BRAIN_ROOT,
  AUTOREPLY_STYLE_CORPUS_PATH,
} from './autoreply-env.js'

interface BrainEnv {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
}

function loadDotEnvAt(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
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
    out[key] = value
  }
  return out
}

function loadBrainEnv(): BrainEnv {
  const envPath = `${AUTOREPLY_SECOND_BRAIN_ROOT}/.env`
  const vars = loadDotEnvAt(envPath)
  const url = vars.SUPABASE_URL?.trim()
  const key = vars.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) {
    throw new Error(`[autoreply/corpus] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${envPath}`)
  }
  return { SUPABASE_URL: url.replace(/\/$/, ''), SUPABASE_SERVICE_ROLE_KEY: key }
}

function parseArgs(): { waLimit: number; noteLimit: number } {
  const waLimitRaw = Number(process.argv[2] ?? 1200)
  const noteLimitRaw = Number(process.argv[3] ?? 80)
  const waLimit = Number.isFinite(waLimitRaw) && waLimitRaw > 0 ? Math.floor(waLimitRaw) : 1200
  const noteLimit = Number.isFinite(noteLimitRaw) && noteLimitRaw > 0 ? Math.floor(noteLimitRaw) : 80
  return { waLimit, noteLimit }
}

function buildWhatsAppSection(waLimit: number): string {
  const db = new Database('./data/wa.db', { readonly: true })
  try {
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total_messages,
        SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END) AS outbound_messages,
        SUM(CASE WHEN direction='out' AND (COALESCE(body, transcript) IS NOT NULL) THEN 1 ELSE 0 END) AS outbound_with_text,
        COUNT(DISTINCT CASE WHEN direction='out' THEN chat_jid END) AS outbound_chats
      FROM messages
    `).get() as {
      total_messages: number
      outbound_messages: number
      outbound_with_text: number
      outbound_chats: number
    }

    const rows = db.prepare(`
      SELECT
        id,
        ts,
        chat_jid,
        type,
        COALESCE(body, transcript) AS content,
        transcript
      FROM messages
      WHERE direction='out'
        AND COALESCE(body, transcript) IS NOT NULL
        AND TRIM(COALESCE(body, transcript)) != ''
      ORDER BY ts DESC
      LIMIT ?
    `).all(waLimit) as Array<{
      id: string
      ts: number
      chat_jid: string
      type: string
      content: string
      transcript: string | null
    }>

    const header = [
      '## WhatsApp outbound corpus',
      '',
      `- total_messages: ${counts.total_messages}`,
      `- outbound_messages: ${counts.outbound_messages}`,
      `- outbound_with_text: ${counts.outbound_with_text}`,
      `- outbound_chats: ${counts.outbound_chats}`,
      `- sampled_messages: ${rows.length}`,
      '',
      'Recent outbound samples (newest first):',
      '',
    ]

    const samples = rows.map((row) => {
      const clean = row.content.replace(/\s+/g, ' ').trim()
      return `- ts=${row.ts} chat=${row.chat_jid} type=${row.type} text=${JSON.stringify(clean)}`
    })

    return [...header, ...samples].join('\n')
  } finally {
    db.close()
  }
}

async function buildSecondBrainSection(noteLimit: number): Promise<string> {
  const env = loadBrainEnv()
  const url = `${env.SUPABASE_URL}/rest/v1/documents?select=notion_id,title,last_edited_time,url,body_text&order=last_edited_time.desc.nullslast&limit=${noteLimit}`
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'count=exact',
    },
  })
  if (!res.ok) {
    throw new Error(`[autoreply/corpus] second-brain fetch failed: HTTP ${res.status}`)
  }
  const notes = (await res.json()) as Array<{
    notion_id: string
    title: string | null
    last_edited_time: string | null
    url: string | null
    body_text: string | null
  }>

  const lines = [
    '## Second-brain writing corpus',
    '',
    `- sampled_notes: ${notes.length}`,
    '',
  ]

  for (const note of notes) {
    const title = (note.title ?? 'Untitled').replace(/\s+/g, ' ').trim()
    const body = (note.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1800)
    lines.push(`### ${title}`)
    lines.push(`- notion_id: ${note.notion_id}`)
    lines.push(`- last_edited_time: ${note.last_edited_time ?? 'unknown'}`)
    if (note.url) lines.push(`- url: ${note.url}`)
    lines.push(body || '[empty body]')
    lines.push('')
  }

  return lines.join('\n')
}

async function main(): Promise<void> {
  const { waLimit, noteLimit } = parseArgs()
  const generatedAt = new Date().toISOString()
  const sections = [
    '# Operator autoreply style corpus',
    '',
    `Generated at: ${generatedAt}`,
    '',
    'This corpus is intended for local style-learning and draft/autoreply generation.',
    '',
    buildWhatsAppSection(waLimit),
    '',
    await buildSecondBrainSection(noteLimit),
    '',
  ]

  mkdirSync(dirname(AUTOREPLY_STYLE_CORPUS_PATH), { recursive: true })
  writeFileSync(AUTOREPLY_STYLE_CORPUS_PATH, sections.join('\n'))
  console.log(JSON.stringify({
    ok: true,
    output_path: AUTOREPLY_STYLE_CORPUS_PATH,
    wa_limit: waLimit,
    note_limit: noteLimit,
    generated_at: generatedAt,
  }, null, 2))
}

void main().catch((err: unknown) => {
  console.error((err as Error).message)
  process.exit(1)
})
