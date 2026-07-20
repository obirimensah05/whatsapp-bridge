import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { AUTOREPLY_SECOND_BRAIN_ROOT } from './autoreply-env.js'

const execFileAsync = promisify(execFile)
const STYLE_RAG_SCRIPT = join(process.cwd(), 'scripts', 'wa_style_rag.py')

export const COMPACT_STYLE_GUIDE = [
  'Write one concise, natural WhatsApp reply in the operator\'s voice.',
  'Match the incoming language and keep the tone casual, direct, and human.',
  'Prefer clear everyday wording over formal or salesy language.',
  'Do not over-explain, use filler, or force a reply when the conversation naturally ends.',
  'Style examples demonstrate phrasing only. They are never facts about the current chat.',
].join('\n')

function pythonBin(): string {
  const localStyleRuntime = join(process.cwd(), '.style-rag-venv', 'bin', 'python')
  if (existsSync(localStyleRuntime)) return localStyleRuntime
  if (AUTOREPLY_SECOND_BRAIN_ROOT) {
    const managed = join(AUTOREPLY_SECOND_BRAIN_ROOT, '.venv', 'bin', 'python')
    if (existsSync(managed)) return managed
  }
  return process.env.PYTHON_BIN?.trim() || 'python3'
}

export function inferStyleLanguage(text: string): string {
  const lower = ` ${text.toLowerCase()} `
  const german = [' ich ', ' und ', ' nicht ', ' danke ', ' kann ', ' morgen ', ' bitte ']
    .reduce((count, word) => count + Number(lower.includes(word)), 0)
  const english = [' the ', ' and ', ' thanks ', ' can ', ' tomorrow ', ' please ']
    .reduce((count, word) => count + Number(lower.includes(word)), 0)
  if (german > english) return 'de'
  if (english > german) return 'en'
  return 'unknown'
}

export async function fetchStyleExamples(params: {
  incomingText: string
  isGroup: boolean
}): Promise<string> {
  if (!AUTOREPLY_SECOND_BRAIN_ROOT || !existsSync(STYLE_RAG_SCRIPT)) return ''
  const { stdout } = await execFileAsync(
    pythonBin(),
    [
      STYLE_RAG_SCRIPT,
      'query',
      '--query', params.incomingText,
      '--language', inferStyleLanguage(params.incomingText),
      '--chat-kind', params.isGroup ? 'group' : 'direct',
      '--limit', '4',
    ],
    { cwd: process.cwd(), timeout: 60000, maxBuffer: 128 * 1024 },
  )
  return stdout.trim()
}
