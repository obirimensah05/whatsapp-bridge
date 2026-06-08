import {
  AUTOREPLY_DEFAULT_SESSION,
  AUTOREPLY_WA_API_BASE,
  AUTOREPLY_WA_API_TOKEN,
} from './autoreply-env.js'

export type WaMessageRecord = {
  id: string
  chat_jid: string
  from_me: number | boolean
  participant_jid?: string | null
  sender_jid?: string | null
  body?: string | null
  transcript?: string | null
  type?: string | null
  ts: number
}

type MessagesResponse = {
  session: string
  jid: string
  messages: WaMessageRecord[]
}

type SendResponse = {
  ok: boolean
  id: string
  jid: string
  ts: number
}

type ResolvedContact = {
  matched?: boolean
  display_name?: string | null
  phone?: string | null
}

function authHeaders(): HeadersInit {
  if (!AUTOREPLY_WA_API_TOKEN) {
    throw new Error('[autoreply/wa] AUTOREPLY_WA_API_TOKEN or API_TOKEN is required')
  }
  return { Authorization: `Bearer ${AUTOREPLY_WA_API_TOKEN}` }
}

export async function fetchRecentMessages(jid: string, session = AUTOREPLY_DEFAULT_SESSION, limit = 15): Promise<WaMessageRecord[]> {
  const url = new URL(`${AUTOREPLY_WA_API_BASE}/messages`)
  url.searchParams.set('session', session)
  url.searchParams.set('jid', jid)
  url.searchParams.set('limit', String(limit))

  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`[autoreply/wa] failed to fetch messages (${res.status}): ${text}`)
  }
  const payload = await res.json() as MessagesResponse
  return payload.messages ?? []
}

export async function resolvePreferredChatLabel(
  jid: string | null | undefined,
  session = AUTOREPLY_DEFAULT_SESSION,
): Promise<string | null> {
  if (!jid) return null
  const url = new URL(`${AUTOREPLY_WA_API_BASE}/contacts/resolve`)
  url.searchParams.set('session', session)
  url.searchParams.set('q', jid)

  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`[autoreply/wa] failed to resolve contact (${res.status}): ${text}`)
  }
  const payload = await res.json() as ResolvedContact
  return payload.display_name?.trim() || payload.phone?.trim() || null
}

export async function sendTextReply(params: {
  to: string
  text: string
  session?: string
  quoted_id?: string | null
}): Promise<SendResponse> {
  const res = await fetch(`${AUTOREPLY_WA_API_BASE}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      session: params.session ?? AUTOREPLY_DEFAULT_SESSION,
      to: params.to,
      text: params.text,
      quoted_id: params.quoted_id ?? undefined,
      sent_by: 'agent',
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`[autoreply/wa] failed to send text (${res.status}): ${text}`)
  }
  return await res.json() as SendResponse
}

export async function waitForInboundMessageContext(params: {
  jid: string
  messageId: string
  session?: string
  desiredType?: string | null
  attempts?: number
  delayMs?: number
}): Promise<WaMessageRecord | null> {
  const {
    jid,
    messageId,
    session = AUTOREPLY_DEFAULT_SESSION,
    desiredType,
    attempts = desiredType === 'audio' ? 6 : 3,
    delayMs = desiredType === 'audio' ? 2000 : 700,
  } = params

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const messages = await fetchRecentMessages(jid, session, 20)
    const match = messages.find((message) => message.id === messageId)
    if (match) {
      const text = (match.transcript || match.body || '').trim()
      if (desiredType !== 'audio' || text) return match
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  return null
}
