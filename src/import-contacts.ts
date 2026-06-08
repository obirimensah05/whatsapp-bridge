import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'

import { API_TOKEN, HOST, PORT } from './env.js'
import { upsertContact, upsertAlias } from './db.js'

const DUMP_PATH = process.env.WA_CONTACTS_TSV ?? './data/contacts.tsv'
const APPLESCRIPT = `tell application "Contacts"
\tset output to ""
\trepeat with p in (get every person)
\t\tset personName to ""
\t\ttry
\t\t\tset personName to name of p as string
\t\tend try
\t\trepeat with ph in (get every phone of p)
\t\t\ttry
\t\t\t\tset phoneValue to value of ph as string
\t\t\t\tset output to output & personName & "\t" & phoneValue & linefeed
\t\t\tend try
\t\tend repeat
\tend repeat
\treturn output
end tell`

function parseArgs(): { session: string; refresh: boolean; limit: number | null } {
  const args = process.argv.slice(2)
  let session = 'main'
  let refresh = false
  let limit: number | null = null
  for (const a of args) {
    if (a.startsWith('--session=')) session = a.slice('--session='.length)
    else if (a === '--refresh') refresh = true
    else if (a.startsWith('--limit=')) limit = Number(a.slice('--limit='.length))
  }
  return { session, refresh, limit }
}

function dumpContacts(): string {
  if (existsSync(DUMP_PATH) && !process.env.WA_FORCE_REDUMP) {
    return readFileSync(DUMP_PATH, 'utf8')
  }
  console.log('[import] running osascript dump…')
  const out = execFileSync('osascript', ['-e', APPLESCRIPT], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  writeFileSync(DUMP_PATH, out)
  return out
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '')
  if (digits.length < 7) return null
  return digits
}

interface CheckResp { exists?: boolean; jid?: string | null; lid?: string | null; error?: string }

async function checkPhone(session: string, phone: string): Promise<CheckResp> {
  const url = `http://${HOST}:${PORT}/v1/check?session=${encodeURIComponent(session)}&phone=${encodeURIComponent(phone)}`
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  })
  if (!r.ok) return { error: `HTTP ${r.status}` }
  return (await r.json()) as CheckResp
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

async function main() {
  const { session, refresh, limit } = parseArgs()
  if (refresh && existsSync(DUMP_PATH)) {
    process.env.WA_FORCE_REDUMP = '1'
  }
  const raw = dumpContacts()
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  const map = new Map<string, string>() // phone -> name
  for (const line of lines) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const name = line.slice(0, tab).trim()
    const phone = normalizePhone(line.slice(tab + 1))
    if (!phone || !name) continue
    if (!map.has(phone)) map.set(phone, name)
  }
  const entries = Array.from(map.entries())
  const total = limit ? Math.min(entries.length, limit) : entries.length
  console.log(`[import] ${entries.length} unique phones (running ${total}) for session=${session}`)

  let exists = 0
  let aliased = 0
  let missing = 0
  let errors = 0
  for (let i = 0; i < total; i++) {
    const [phone, name] = entries[i]
    try {
      const r = await checkPhone(session, phone)
      if (r.error) { errors++; console.warn(`[import] ${name} +${phone} → ${r.error}`); continue }
      if (r.exists && r.jid) {
        const ts = Date.now()
        upsertContact({ jid: r.jid, push_name: name, is_lid: r.jid.endsWith('@lid') ? 1 : 0, ts })
        exists++
        if (r.lid && r.lid !== r.jid) {
          upsertContact({ jid: r.lid, push_name: name, is_lid: 1, ts })
          upsertAlias(session, r.lid, r.jid)
          aliased++
        }
        if ((exists % 10) === 0) console.log(`[import] +${exists} matched (last: ${name} → ${r.jid}${r.lid ? ` / ${r.lid}` : ''})`)
      } else {
        missing++
      }
    } catch (err) {
      errors++
      console.warn(`[import] ${name} +${phone} → ${(err as Error).message}`)
    }
    await sleep(120) // be gentle with WA presence subscribe
  }

  console.log(`[import] done — matched=${exists} lid-aliased=${aliased} not-on-wa=${missing} errors=${errors}`)

  // Wipe the dump — it contains every saved contact's name + phone and we no
  // longer need it once the DB is enriched. Set WA_KEEP_CONTACTS_TSV=1 to retain.
  if (process.env.WA_KEEP_CONTACTS_TSV !== '1' && existsSync(DUMP_PATH)) {
    try { unlinkSync(DUMP_PATH); console.log(`[import] wiped ${DUMP_PATH}`) } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('[import] fatal', err)
  process.exit(1)
})
