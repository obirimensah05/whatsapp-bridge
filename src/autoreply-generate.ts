import { existsSync, readFileSync } from 'node:fs'

import { ensureStyleCorpus, fetchWhatsAppHistoryContext } from './autoreply-context.js'
import { AUTOREPLY_MIN_CONFIDENCE, AUTOREPLY_STYLE_CORPUS_PATH } from './autoreply-env.js'
import { completeDraftPrompt } from './autoreply-llm.js'

export type DraftReply = {
  reply: string
  confidence: number
  should_send: boolean
  needs_review: boolean
  reasons: string[]
}

function loadCorpus(): string {
  if (!existsSync(AUTOREPLY_STYLE_CORPUS_PATH)) return ''
  const corpus = readFileSync(AUTOREPLY_STYLE_CORPUS_PATH, 'utf8')
  return corpus.slice(0, 24000)
}

function extractJson(text: string): DraftReply {
  const raw = text.trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw
  const parsed = JSON.parse(candidate) as Partial<DraftReply>
  const confidence = Number(parsed.confidence ?? 0)
  return {
    reply: String(parsed.reply ?? '').trim(),
    confidence: Number.isFinite(confidence) ? confidence : 0,
    should_send: Boolean(parsed.should_send),
    needs_review: parsed.needs_review ?? true,
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map((v) => String(v)) : [],
  }
}

export async function generateDraftReply(params: {
  incomingText: string
  contactName?: string | null
  isGroup?: boolean
  chatJid?: string | null
}): Promise<DraftReply> {
  ensureStyleCorpus()
  const corpus = loadCorpus()
  // Grounded in the operator's own WhatsApp history: recent conversation with
  // this chat plus keyword matches across all stored messages.
  const referenceContext = fetchWhatsAppHistoryContext({
    query: [params.contactName, params.incomingText].filter(Boolean).join('\n'),
    chatJid: params.chatJid ?? null,
  })

  const prompt = [
    'You are generating a WhatsApp reply draft in the operator\'s own voice.',
    'Use the style corpus and produce one natural reply only.',
    'Be concise, human, and message-like. No explanations.',
    'Match the language of the incoming message. If the incoming message is in German, reply in German.',
    'Reply exactly as the operator would — casual, first person, their voice. Never reveal or imply that this is an AI, an assistant, or automated. No disclosure text of any kind.',
    'If the reference context contains directly relevant facts, use them. If it does not, ignore it. Never say "according to my notes" or mention a database, notes, or message history as a source.',
    'If the message is ambiguous, sensitive, emotional, legal, financial, or requires facts you do not know even after checking context, set needs_review=true and should_send=false.',
    'Return JSON only with these keys and types: reply (string), confidence (number between 0 and 1), should_send (boolean), needs_review (boolean), reasons (array of strings).',
    'confidence MUST be a decimal number like 0.9, never a word.',
    `Minimum confidence for auto send is ${AUTOREPLY_MIN_CONFIDENCE}.`,
    '',
    `Contact: ${params.contactName ?? 'unknown'}`,
    `Is group: ${params.isGroup ? 'yes' : 'no'}`,
    `Incoming message: ${params.incomingText}`,
    '',
    'Reference context (prior WhatsApp history):',
    referenceContext || '(no relevant reference context available)',
    '',
    'Style corpus:',
    corpus || '(no corpus available)',
  ].filter(Boolean).join('\n')

  const stdout = await completeDraftPrompt(prompt)
  return extractJson(stdout)
}
