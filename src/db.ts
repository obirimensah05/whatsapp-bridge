import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DB_PATH = process.env.WA_DB_PATH ?? './data/wa.db'

// data/ holds the full message store + media — block traversal by other local users.
mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 })
try {
  chmodSync(dirname(DB_PATH), 0o700)
} catch {}

export const db = new Database(DB_PATH)
try {
  chmodSync(DB_PATH, 0o600)
} catch {}
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    jid TEXT PRIMARY KEY,
    push_name TEXT,
    is_lid INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    from_jid TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    type TEXT NOT NULL,
    body TEXT,
    media_path TEXT,
    ts INTEGER NOT NULL,
    raw_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_chat_ts
    ON messages(session, chat_jid, ts DESC);

  CREATE INDEX IF NOT EXISTS idx_messages_session_ts
    ON messages(session, ts DESC);

  CREATE TABLE IF NOT EXISTS jid_aliases (
    session   TEXT NOT NULL,
    alias     TEXT NOT NULL,
    canonical TEXT NOT NULL,
    ts        INTEGER NOT NULL,
    PRIMARY KEY (session, alias)
  );

  CREATE INDEX IF NOT EXISTS idx_jid_aliases_canonical
    ON jid_aliases(session, canonical);

  CREATE TABLE IF NOT EXISTS chats (
    session       TEXT NOT NULL,
    jid           TEXT NOT NULL,
    name          TEXT,
    is_group      INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0,
    pinned        INTEGER NOT NULL DEFAULT 0,
    mute_until    INTEGER,
    unread_count  INTEGER,
    last_msg_ts   INTEGER,
    raw_json      TEXT,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (session, jid)
  );

  CREATE INDEX IF NOT EXISTS idx_chats_session_last_ts
    ON chats(session, last_msg_ts DESC);

  CREATE TABLE IF NOT EXISTS reactions (
    session     TEXT NOT NULL,
    message_id  TEXT NOT NULL,
    from_jid    TEXT NOT NULL,
    emoji       TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    PRIMARY KEY (session, message_id, from_jid)
  );

  CREATE INDEX IF NOT EXISTS idx_reactions_message
    ON reactions(session, message_id);

  CREATE TABLE IF NOT EXISTS message_receipts (
    session     TEXT NOT NULL,
    message_id  TEXT NOT NULL,
    participant TEXT NOT NULL,
    status      TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    PRIMARY KEY (session, message_id, participant, status)
  );

  CREATE INDEX IF NOT EXISTS idx_receipts_msg
    ON message_receipts(session, message_id);
`)

// Idempotent column migrations for messages and chats
const migrations = [
  `ALTER TABLE messages ADD COLUMN sent_by TEXT`,
  `ALTER TABLE messages ADD COLUMN delivery_status TEXT`,
  `ALTER TABLE messages ADD COLUMN quoted_id TEXT`,
  `ALTER TABLE messages ADD COLUMN edited_at INTEGER`,
  `ALTER TABLE messages ADD COLUMN deleted_at INTEGER`,
  `ALTER TABLE messages ADD COLUMN media_mime TEXT`,
  `ALTER TABLE messages ADD COLUMN media_size INTEGER`,
  `ALTER TABLE messages ADD COLUMN transcript TEXT`,
  `ALTER TABLE chats ADD COLUMN profile_pic_url TEXT`,
  `ALTER TABLE contacts ADD COLUMN profile_pic_url TEXT`,
  `ALTER TABLE chats ADD COLUMN participant_count INTEGER`,
]
for (const sql of migrations) {
  try { db.exec(sql) } catch { /* column already exists */ }
}

const upsertContactStmt = db.prepare(`
  INSERT INTO contacts (jid, push_name, is_lid, first_seen, last_seen)
  VALUES (@jid, @push_name, @is_lid, @ts, @ts)
  ON CONFLICT(jid) DO UPDATE SET
    push_name = COALESCE(excluded.push_name, contacts.push_name),
    last_seen = excluded.last_seen
`)

const insertMessageStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, session, chat_jid, from_jid, direction, type, body, media_path,
     ts, raw_json, sent_by, delivery_status, quoted_id, media_mime, media_size)
  VALUES
    (@id, @session, @chat_jid, @from_jid, @direction, @type, @body, @media_path,
     @ts, @raw_json, @sent_by, @delivery_status, @quoted_id, @media_mime, @media_size)
`)

const upsertAliasStmt = db.prepare(`
  INSERT INTO jid_aliases (session, alias, canonical, ts)
  VALUES (@session, @alias, @canonical, @ts)
  ON CONFLICT(session, alias) DO UPDATE SET
    canonical = excluded.canonical,
    ts        = excluded.ts
`)

const removeAliasStmt = db.prepare(`
  DELETE FROM jid_aliases WHERE session = ? AND alias = ?
`)

const findCanonicalStmt = db.prepare(`
  SELECT canonical FROM jid_aliases WHERE session = ? AND alias = ?
`)

const findAliasesOfStmt = db.prepare(`
  SELECT alias FROM jid_aliases WHERE session = ? AND canonical = ?
`)

const listAliasesStmt = db.prepare(`
  SELECT alias, canonical, ts FROM jid_aliases
  WHERE session = ?
  ORDER BY ts DESC
`)

const upsertChatStmt = db.prepare(`
  INSERT INTO chats
    (session, jid, name, is_group, archived, pinned, mute_until,
     unread_count, last_msg_ts, raw_json, updated_at)
  VALUES
    (@session, @jid, @name, @is_group, @archived, @pinned, @mute_until,
     @unread_count, @last_msg_ts, @raw_json, @updated_at)
  ON CONFLICT(session, jid) DO UPDATE SET
    name         = COALESCE(excluded.name,         chats.name),
    is_group     = excluded.is_group,
    archived     = excluded.archived,
    pinned       = excluded.pinned,
    mute_until   = COALESCE(excluded.mute_until,   chats.mute_until),
    unread_count = COALESCE(excluded.unread_count, chats.unread_count),
    last_msg_ts  = COALESCE(
                     CASE WHEN excluded.last_msg_ts > IFNULL(chats.last_msg_ts, 0)
                          THEN excluded.last_msg_ts END,
                     chats.last_msg_ts
                   ),
    raw_json     = excluded.raw_json,
    updated_at   = excluded.updated_at
`)

export type Direction = 'in' | 'out'

export interface ContactInput {
  jid: string
  push_name: string | null
  is_lid: number
  ts: number
}

export type SentBy = 'user' | 'agent' | 'api' | 'unknown'
export type DeliveryStatus = 'pending' | 'server' | 'delivered' | 'read' | 'played'

export interface MessageInput {
  id: string
  session: string
  chat_jid: string
  from_jid: string
  direction: Direction
  type: string
  body: string | null
  media_path: string | null
  ts: number
  raw_json: string | null
  sent_by: SentBy | null
  delivery_status: DeliveryStatus | null
  quoted_id: string | null
  media_mime: string | null
  media_size: number | null
}

export function upsertContact(c: ContactInput): void {
  upsertContactStmt.run(c)
}

export interface ChatInput {
  session: string
  jid: string
  name: string | null
  is_group: number
  archived: number
  pinned: number
  mute_until: number | null
  unread_count: number | null
  last_msg_ts: number | null
  raw_json: string | null
}

export function upsertChat(c: ChatInput): void {
  upsertChatStmt.run({ ...c, updated_at: Date.now() })
}

export function upsertChatsBatch(chats: ChatInput[]): void {
  const tx = db.transaction((rows: ChatInput[]) => {
    for (const c of rows) upsertChat(c)
  })
  tx(chats)
}

const updateMessageStatusStmt = db.prepare(`
  UPDATE messages SET delivery_status = ? WHERE id = ?
`)
const updateMessageMediaStmt = db.prepare(`
  UPDATE messages SET media_path = ?, media_mime = ?, media_size = ? WHERE id = ?
`)
const updateMessageEditedStmt = db.prepare(`
  UPDATE messages SET body = ?, edited_at = ? WHERE id = ?
`)
const updateMessageDeletedStmt = db.prepare(`
  UPDATE messages SET deleted_at = ? WHERE id = ?
`)
const updateMessageTranscriptStmt = db.prepare(`
  UPDATE messages SET transcript = ? WHERE id = ?
`)
const upsertReactionStmt = db.prepare(`
  INSERT INTO reactions (session, message_id, from_jid, emoji, ts)
  VALUES (@session, @message_id, @from_jid, @emoji, @ts)
  ON CONFLICT(session, message_id, from_jid) DO UPDATE SET
    emoji = excluded.emoji,
    ts    = excluded.ts
`)
const deleteReactionStmt = db.prepare(`
  DELETE FROM reactions WHERE session = ? AND message_id = ? AND from_jid = ?
`)
const reactionsForStmt = db.prepare(`
  SELECT from_jid, emoji, ts FROM reactions
  WHERE session = ? AND message_id = ?
  ORDER BY ts ASC
`)
const updateChatPicStmt = db.prepare(`
  UPDATE chats SET profile_pic_url = ?, updated_at = ? WHERE session = ? AND jid = ?
`)
const updateChatParticipantCountStmt = db.prepare(`
  UPDATE chats SET participant_count = ?, updated_at = ? WHERE session = ? AND jid = ?
`)
const updateContactPicStmt = db.prepare(`
  UPDATE contacts SET profile_pic_url = ?, last_seen = ? WHERE jid = ?
`)

export function updateMessageStatus(id: string, status: DeliveryStatus): void {
  updateMessageStatusStmt.run(status, id)
}

const getMessageStatusStmt = db.prepare(
  `SELECT delivery_status FROM messages WHERE id = ?`,
)

export function getMessageDeliveryStatus(id: string): DeliveryStatus | null {
  const row = getMessageStatusStmt.get(id) as { delivery_status: DeliveryStatus | null } | undefined
  return row?.delivery_status ?? null
}

export function updateMessageMedia(
  id: string,
  mediaPath: string,
  mime: string | null,
  size: number | null,
): void {
  updateMessageMediaStmt.run(mediaPath, mime, size, id)
}

export function markMessageEdited(id: string, newBody: string | null): void {
  updateMessageEditedStmt.run(newBody, Date.now(), id)
}

export function markMessageDeleted(id: string): void {
  updateMessageDeletedStmt.run(Date.now(), id)
}

export function setMessageTranscript(id: string, transcript: string | null): void {
  updateMessageTranscriptStmt.run(transcript, id)
}

export interface ReactionInput {
  session: string
  message_id: string
  from_jid: string
  emoji: string
  ts: number
}

export function upsertReaction(r: ReactionInput): void {
  if (r.emoji === '') {
    deleteReactionStmt.run(r.session, r.message_id, r.from_jid)
    return
  }
  upsertReactionStmt.run(r)
}

export function reactionsFor(session: string, messageId: string) {
  return reactionsForStmt.all(session, messageId) as Array<{
    from_jid: string
    emoji: string
    ts: number
  }>
}

const upsertReceiptStmt = db.prepare(`
  INSERT OR IGNORE INTO message_receipts
    (session, message_id, participant, status, ts)
  VALUES
    (@session, @message_id, @participant, @status, @ts)
`)

const receiptsForStmt = db.prepare(`
  SELECT participant, status, ts FROM message_receipts
  WHERE session = ? AND message_id = ?
  ORDER BY ts ASC
`)

export type ReceiptStatus = 'delivered' | 'read' | 'played'

export interface ReceiptInput {
  session: string
  message_id: string
  participant: string
  status: ReceiptStatus
  ts: number
}

export function upsertReceipt(r: ReceiptInput): void {
  upsertReceiptStmt.run(r)
}

export function receiptsFor(session: string, messageId: string) {
  return receiptsForStmt.all(session, messageId) as Array<{
    participant: string
    status: ReceiptStatus
    ts: number
  }>
}

export function setChatProfilePic(session: string, jid: string, url: string | null): void {
  updateChatPicStmt.run(url, Date.now(), session, jid)
}

export function setChatParticipantCount(session: string, jid: string, count: number | null): void {
  updateChatParticipantCountStmt.run(count, Date.now(), session, jid)
}

export function setContactProfilePic(jid: string, url: string | null): void {
  updateContactPicStmt.run(url, Date.now(), jid)
}

export function insertMessage(m: MessageInput): { changes: number } {
  return insertMessageStmt.run(m)
}

export function upsertAlias(session: string, alias: string, canonical: string): void {
  if (!alias || !canonical) throw new Error('alias and canonical are required')
  if (alias === canonical) return
  upsertAliasStmt.run({ session, alias, canonical, ts: Date.now() })
}

export function removeAlias(session: string, alias: string): { changes: number } {
  return removeAliasStmt.run(session, alias)
}

export function listAliases(session: string) {
  return listAliasesStmt.all(session) as Array<{
    alias: string
    canonical: string
    ts: number
  }>
}

export function expandJidGroup(session: string, jid: string): string[] {
  const aliasRow = findCanonicalStmt.get(session, jid) as { canonical: string } | undefined
  const canonical = aliasRow?.canonical ?? jid
  const aliases = findAliasesOfStmt.all(session, canonical) as Array<{ alias: string }>
  return Array.from(new Set([canonical, ...aliases.map((a) => a.alias)]))
}

const pushNameByJidStmt = db.prepare(
  `SELECT push_name FROM contacts WHERE jid = ? AND push_name IS NOT NULL`,
)

export function pushNameFor(session: string, jid: string): string | null {
  for (const j of expandJidGroup(session, jid)) {
    const row = pushNameByJidStmt.get(j) as { push_name: string } | undefined
    if (row?.push_name) return row.push_name
  }
  return null
}

export function extractPhone(jid: string): string | null {
  if (!jid.endsWith('@s.whatsapp.net')) return null
  const digits = jid.split('@')[0].split(':')[0]
  if (!/^\d+$/.test(digits)) return null
  return `+${digits}`
}

export function phoneFor(session: string, jid: string): string | null {
  for (const j of expandJidGroup(session, jid)) {
    const phone = extractPhone(j)
    if (phone) return phone
  }
  return null
}

const chatNameByJidStmt = db.prepare(
  `SELECT name FROM chats WHERE session = ? AND jid = ? AND name IS NOT NULL`,
)

export function chatNameFor(session: string, jid: string): string | null {
  for (const j of expandJidGroup(session, jid)) {
    const row = chatNameByJidStmt.get(session, j) as { name: string } | undefined
    if (row?.name) return row.name
  }
  return null
}

export function displayNameFor(session: string, jid: string): string {
  if (jid.endsWith('@g.us')) {
    return chatNameFor(session, jid) ?? jid
  }
  return pushNameFor(session, jid) ?? phoneFor(session, jid) ?? jid
}

// ---- contact resolution (LID / phone / name → unified contact view) ----

export interface ResolvedContact {
  query: string
  matched: boolean
  display_name: string | null
  canonical_jid: string | null
  is_lid: boolean
  phone: string | null
  jids: string[]            // canonical first, then alias forms
  alias_jids: string[]      // jids excluding canonical
  push_name: string | null
  profile_pic_url: string | null
  first_seen: number | null
  last_seen: number | null
}

const contactRowStmt = db.prepare(
  `SELECT jid, push_name, is_lid, profile_pic_url, first_seen, last_seen
   FROM contacts WHERE jid = ?`,
)

const searchContactsByNameStmt = db.prepare(
  `SELECT jid, push_name, last_seen
   FROM contacts
   WHERE push_name IS NOT NULL AND push_name LIKE ? COLLATE NOCASE
   ORDER BY last_seen DESC
   LIMIT ?`,
)

// @s.whatsapp.net wins (carries the phone), then @lid, then any other shape.
function pickCanonical(jids: string[]): string {
  const pn = jids.find((j) => j.endsWith('@s.whatsapp.net'))
  if (pn) return pn
  const lid = jids.find((j) => j.endsWith('@lid'))
  if (lid) return lid
  return jids[0]
}

function emptyResolved(query: string): ResolvedContact {
  return {
    query,
    matched: false,
    display_name: null,
    canonical_jid: null,
    is_lid: false,
    phone: null,
    jids: [],
    alias_jids: [],
    push_name: null,
    profile_pic_url: null,
    first_seen: null,
    last_seen: null,
  }
}

function buildResolvedFromJid(query: string, session: string, anchorJid: string): ResolvedContact {
  const group = expandJidGroup(session, anchorJid)
  const canonical = pickCanonical(group)
  const ordered = [canonical, ...group.filter((j) => j !== canonical)]
  const alias_jids = ordered.slice(1)

  let push_name: string | null = null
  let profile_pic_url: string | null = null
  let first_seen: number | null = null
  let last_seen: number | null = null
  let anyContactRow = false
  for (const j of ordered) {
    const row = contactRowStmt.get(j) as
      | { jid: string; push_name: string | null; is_lid: number; profile_pic_url: string | null; first_seen: number; last_seen: number }
      | undefined
    if (!row) continue
    anyContactRow = true
    if (!push_name && row.push_name) push_name = row.push_name
    if (!profile_pic_url && row.profile_pic_url) profile_pic_url = row.profile_pic_url
    if (first_seen == null || row.first_seen < first_seen) first_seen = row.first_seen
    if (last_seen == null || row.last_seen > last_seen) last_seen = row.last_seen
  }

  return {
    query,
    matched: anyContactRow || alias_jids.length > 0,
    display_name: push_name,
    canonical_jid: canonical,
    is_lid: canonical.endsWith('@lid'),
    phone: phoneFor(session, canonical),
    jids: ordered,
    alias_jids,
    push_name,
    profile_pic_url,
    first_seen,
    last_seen,
  }
}

export function searchContacts(session: string, q: string, limit = 20): ResolvedContact[] {
  const trimmed = q.trim()
  if (!trimmed) return []
  // pull a wider slice so that when collapsing aliases we still end up with
  // ~limit distinct people.
  const rows = searchContactsByNameStmt.all(`%${trimmed}%`, limit * 4) as Array<{
    jid: string
    push_name: string
    last_seen: number
  }>
  const seen = new Set<string>()
  const out: ResolvedContact[] = []
  for (const r of rows) {
    const resolved = buildResolvedFromJid(trimmed, session, r.jid)
    if (!resolved.canonical_jid) continue
    if (seen.has(resolved.canonical_jid)) continue
    seen.add(resolved.canonical_jid)
    out.push(resolved)
    if (out.length >= limit) break
  }
  return out
}

// Accepts a JID, a phone (digits or +digits), or a contact-name substring and
// returns the best single match. For ambiguous name queries this returns the
// most recently seen contact; use `searchContacts` to enumerate alternatives.
export function resolveContact(session: string, q: string): ResolvedContact {
  const trimmed = q.trim()
  if (!trimmed) return emptyResolved(trimmed)

  if (trimmed.includes('@')) {
    return buildResolvedFromJid(trimmed, session, trimmed)
  }

  // Phone: digits-only, or +digits, optionally with separator chars
  const stripped = trimmed.replace(/[\s().-]/g, '')
  const digitsOnly = /^\+?\d{7,}$/.test(stripped)
  if (digitsOnly) {
    const digits = stripped.replace(/^\+/, '')
    return buildResolvedFromJid(trimmed, session, `${digits}@s.whatsapp.net`)
  }

  const matches = searchContacts(session, trimmed, 20)
  if (matches.length > 0) return matches[0]
  return emptyResolved(trimmed)
}

export function recentMessages(session: string, limit = 20) {
  return db
    .prepare(
      `SELECT ts, direction, chat_jid, from_jid, type, body
       FROM messages
       WHERE session = ?
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(session, limit) as Array<{
      ts: number
      direction: Direction
      chat_jid: string
      from_jid: string
      type: string
      body: string | null
    }>
}

export function listConversations(session: string, limit = 100) {
  return db
    .prepare(
      `WITH msg_canon AS (
         SELECT m.body, m.transcript, m.direction, m.type, m.ts,
                COALESCE(a.canonical, m.chat_jid) AS canonical_jid
         FROM messages m
         LEFT JOIN jid_aliases a
           ON a.session = m.session AND a.alias = m.chat_jid
         WHERE m.session = @session
       ),
       last_msg AS (
         SELECT canonical_jid, body, transcript, direction, type, ts,
                ROW_NUMBER() OVER (PARTITION BY canonical_jid ORDER BY ts DESC) AS rn
         FROM msg_canon
       ),
       chat_canon AS (
         SELECT COALESCE(a.canonical, ch.jid) AS canonical_jid,
                ch.name, ch.is_group, ch.archived, ch.pinned,
                ch.unread_count, ch.last_msg_ts, ch.participant_count
         FROM chats ch
         LEFT JOIN jid_aliases a
           ON a.session = ch.session AND a.alias = ch.jid
         WHERE ch.session = @session
       ),
       all_jids AS (
         SELECT canonical_jid FROM last_msg WHERE rn = 1
         UNION
         SELECT canonical_jid FROM chat_canon
       )
       SELECT
         j.canonical_jid                          AS chat_jid,
         cc.name                                  AS chat_name,
         COALESCE(cc.is_group, 0)                 AS is_group,
         COALESCE(cc.archived, 0)                 AS archived,
         COALESCE(cc.pinned, 0)                   AS pinned,
         cc.unread_count,
         cc.participant_count,
         co.push_name,
         COALESCE(co.profile_pic_url, ch_pic.profile_pic_url) AS profile_pic_url,
         lm.body                                  AS last_body,
         lm.transcript                            AS last_transcript,
         lm.direction                             AS last_direction,
         lm.type                                  AS last_type,
         COALESCE(lm.ts, cc.last_msg_ts)          AS last_ts
       FROM all_jids j
       LEFT JOIN last_msg lm
         ON lm.canonical_jid = j.canonical_jid AND lm.rn = 1
       LEFT JOIN chat_canon cc
         ON cc.canonical_jid = j.canonical_jid
       LEFT JOIN contacts co
         ON co.jid = j.canonical_jid
       LEFT JOIN chats ch_pic
         ON ch_pic.session = @session AND ch_pic.jid = j.canonical_jid
       WHERE COALESCE(lm.ts, cc.last_msg_ts) IS NOT NULL
         AND j.canonical_jid NOT LIKE '%@broadcast'
       ORDER BY COALESCE(lm.ts, cc.last_msg_ts) DESC
       LIMIT @limit`,
    )
    .all({ session, limit }) as Array<{
      chat_jid: string
      chat_name: string | null
      is_group: number
      archived: number
      pinned: number
      unread_count: number | null
      participant_count: number | null
      push_name: string | null
      profile_pic_url: string | null
      last_body: string | null
      last_transcript: string | null
      last_direction: Direction | null
      last_type: string | null
      last_ts: number | null
    }>
}

export function listMessages(
  session: string,
  chatJid: string,
  limit = 50,
  before?: number,
) {
  const jids = expandJidGroup(session, chatJid)
  const placeholders = jids.map(() => '?').join(',')
  const sql = `
    SELECT id, ts, direction, from_jid, chat_jid, type, body,
           media_path, media_mime, media_size, transcript,
           sent_by, delivery_status, quoted_id, edited_at, deleted_at
    FROM messages
    WHERE session = ?
      AND chat_jid IN (${placeholders})
      AND (? IS NULL OR ts < ?)
    ORDER BY ts DESC
    LIMIT ?
  `
  return db.prepare(sql).all(
    session,
    ...jids,
    before ?? null,
    before ?? null,
    limit,
  ) as Array<{
    id: string
    ts: number
    direction: Direction
    from_jid: string
    chat_jid: string
    type: string
    body: string | null
    media_path: string | null
    media_mime: string | null
    media_size: number | null
    transcript: string | null
    sent_by: SentBy | null
    delivery_status: DeliveryStatus | null
    quoted_id: string | null
    edited_at: number | null
    deleted_at: number | null
  }>
}
