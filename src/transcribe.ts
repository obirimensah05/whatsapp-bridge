import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

import { OPENAI_API_KEY } from './env.js'

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'
const MODEL = 'whisper-1'
const MAX_BYTES = 25 * 1024 * 1024 // OpenAI rejects > 25 MB anyway

export class TranscribeError extends Error {}

export async function transcribeAudio(
  filePath: string,
  opts: { mime?: string | null; language?: string } = {},
): Promise<string> {
  if (!OPENAI_API_KEY) throw new TranscribeError('OPENAI_API_KEY not set')

  const info = await stat(filePath)
  if (info.size > MAX_BYTES) throw new TranscribeError(`audio too large (${info.size} bytes)`)

  const buf = await readFile(filePath)
  // WhatsApp PTT is OPUS in OGG; standard audio can be m4a/aac.
  const mime = opts.mime ?? 'audio/ogg'
  // Use a generic filename — the original carries `<session>:<msg_id>` which we
  // don't want to send to a third party.
  const ext = extname(filePath).slice(1) || 'ogg'
  const filename = `audio.${ext}`

  const form = new FormData()
  form.append('file', new Blob([buf], { type: mime }), filename)
  form.append('model', MODEL)
  if (opts.language) form.append('language', opts.language)
  form.append('response_format', 'json')

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new TranscribeError(`OpenAI ${res.status}: ${detail.slice(0, 300)}`)
  }
  const json = (await res.json()) as { text?: string }
  const text = (json.text ?? '').trim()
  return text
}
