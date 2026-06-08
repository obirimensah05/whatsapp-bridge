import { recentMessages, displayNameFor, pushNameFor, phoneFor } from './db.js'
import { TIMEZONE } from './env.js'
import { formatLocal } from './time.js'

const session = process.argv[2] ?? 'main'
const limit = Number(process.argv[3] ?? 20)

const rows = recentMessages(session, limit)

if (rows.length === 0) {
  console.log(`(no messages yet for session "${session}")`)
  process.exit(0)
}

function label(chat_jid: string, from_jid: string): string {
  const chat = displayNameFor(session, chat_jid)
  if (!chat_jid.endsWith('@g.us')) return chat
  const sender = pushNameFor(session, from_jid) ?? phoneFor(session, from_jid) ?? from_jid
  return `${chat} · ${sender}`
}

console.log(`# session=${session}  tz=${TIMEZONE}`)
for (const r of rows.reverse()) {
  const time = formatLocal(r.ts)
  const arrow = r.direction === 'in' ? '<-' : '->'
  const body = r.body ?? `[${r.type}]`
  const who = label(r.chat_jid, r.from_jid)
  console.log(`${time}  ${arrow}  ${who}  |  ${body}`)
}
