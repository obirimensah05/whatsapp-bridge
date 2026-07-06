// Provider-agnostic LLM completion for draft generation.
//
// AUTOREPLY_LLM_PROVIDER selects the backend:
//   claude-cli (default) - shells out to the local `claude` CLI (no API key needed)
//   anthropic            - Anthropic Messages API via the official SDK
//   openai               - any OpenAI-compatible chat-completions endpoint
//                          (OpenAI, OpenRouter, Groq, Mistral, Ollama, LM Studio, ...)

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import Anthropic from '@anthropic-ai/sdk'

import {
  AUTOREPLY_CLAUDE_BIN,
  AUTOREPLY_LLM_API_KEY,
  AUTOREPLY_LLM_BASE_URL,
  AUTOREPLY_LLM_MODEL,
  AUTOREPLY_LLM_PROVIDER,
  AUTOREPLY_MODEL,
} from './autoreply-env.js'

const execFileAsync = promisify(execFile)

async function completeViaClaudeCli(prompt: string): Promise<string> {
  const { stdout } = await execFileAsync(AUTOREPLY_CLAUDE_BIN, ['--model', AUTOREPLY_MODEL, '-p', prompt], {
    maxBuffer: 1024 * 1024,
    timeout: 120000,
  })
  return stdout
}

async function completeViaAnthropic(prompt: string): Promise<string> {
  // Falls back to ANTHROPIC_API_KEY (or an `ant auth login` profile) when
  // AUTOREPLY_LLM_API_KEY is not set.
  const client = new Anthropic({
    ...(AUTOREPLY_LLM_API_KEY ? { apiKey: AUTOREPLY_LLM_API_KEY } : {}),
  })
  const response = await client.messages.create({
    model: AUTOREPLY_LLM_MODEL ?? 'claude-opus-4-8',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

async function completeViaOpenAiCompatible(prompt: string): Promise<string> {
  if (!AUTOREPLY_LLM_MODEL) {
    throw new Error('[autoreply/llm] AUTOREPLY_LLM_MODEL is required when AUTOREPLY_LLM_PROVIDER=openai')
  }
  // No Authorization header when no key is set - local endpoints (Ollama,
  // LM Studio) do not require one.
  const res = await fetch(`${AUTOREPLY_LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AUTOREPLY_LLM_API_KEY ? { Authorization: `Bearer ${AUTOREPLY_LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: AUTOREPLY_LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`[autoreply/llm] LLM request failed (${res.status}): ${text.slice(0, 500)}`)
  }
  const payload = await res.json() as { choices?: Array<{ message?: { content?: string | null } }> }
  const text = payload.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('[autoreply/llm] LLM response contained no message content')
  return text
}

export async function completeDraftPrompt(prompt: string): Promise<string> {
  if (AUTOREPLY_LLM_PROVIDER === 'anthropic') return completeViaAnthropic(prompt)
  if (AUTOREPLY_LLM_PROVIDER === 'openai') return completeViaOpenAiCompatible(prompt)
  return completeViaClaudeCli(prompt)
}
