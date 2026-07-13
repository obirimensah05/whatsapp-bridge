// Runtime-switchable model configuration for the autoreply drafter.
//
// The active provider + model live in data/autoreply/model-config.json so they
// can be changed at runtime (via the CLI or the HTTP /model routes) without a
// code change or an env edit. When the file is absent, the env defaults apply
// (AUTOREPLY_LLM_PROVIDER / AUTOREPLY_LLM_MODEL / AUTOREPLY_MODEL), so existing
// installs keep their previous behaviour.
//
// Providers:
//   claude-cli - shells out to the local `claude` CLI (uses its own auth)
//   codex-cli  - shells out to the local `codex` CLI (uses its ChatGPT/codex auth)
//   anthropic  - Anthropic Messages API (needs ANTHROPIC_API_KEY / AUTOREPLY_LLM_API_KEY)
//   openai     - any OpenAI-compatible chat endpoint (needs OPENAI_API_KEY /
//                AUTOREPLY_LLM_API_KEY, or none for a local endpoint)
//
// API keys are NEVER written into model-config.json - they stay in .env
// (chmod 600, gitignored). resolveApiKey re-reads .env so a freshly added key
// is picked up on the next draft without a full restart.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import Anthropic from '@anthropic-ai/sdk'

import {
  AUTOREPLY_CLAUDE_BIN,
  AUTOREPLY_CODEX_BIN,
  AUTOREPLY_DATA_DIR,
  AUTOREPLY_LLM_BASE_URL,
  AUTOREPLY_LLM_MODEL,
  AUTOREPLY_LLM_PROVIDER,
  AUTOREPLY_MODEL,
  ENV_FILE_PATH,
  readEnvFile,
} from './autoreply-env.js'

const execFileAsync = promisify(execFile)

export const PROVIDERS = ['claude-cli', 'codex-cli', 'anthropic', 'openai'] as const
export type Provider = (typeof PROVIDERS)[number]

export const CLI_PROVIDERS: readonly Provider[] = ['claude-cli', 'codex-cli']
export const API_PROVIDERS: readonly Provider[] = ['anthropic', 'openai']

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
}

export interface ModelConfig {
  provider: Provider
  // null => let the provider/CLI use its own default model
  model: string | null
  // openai-compatible base URL override; null => AUTOREPLY_LLM_BASE_URL / default
  base_url: string | null
  updated_at: string
}

export type ModelConfigInput = Pick<ModelConfig, 'provider' | 'model' | 'base_url'>

const MODEL_PATH = join(AUTOREPLY_DATA_DIR, 'model-config.json')
const EPOCH = new Date(0).toISOString()

function defaultModelFor(provider: Provider): string | null {
  if (provider === 'claude-cli') return AUTOREPLY_MODEL
  if (provider === 'openai') return AUTOREPLY_LLM_MODEL ?? 'gpt-5'
  if (provider === 'anthropic') return AUTOREPLY_LLM_MODEL ?? 'claude-opus-4-8'
  return AUTOREPLY_LLM_MODEL // codex-cli: null => codex default
}

export function envDefaultConfig(): ModelConfig {
  const provider = isProvider(AUTOREPLY_LLM_PROVIDER) ? AUTOREPLY_LLM_PROVIDER : 'claude-cli'
  return {
    provider,
    model: defaultModelFor(provider),
    base_url: null,
    updated_at: EPOCH,
  }
}

function ensureDataDir(): void {
  mkdirSync(AUTOREPLY_DATA_DIR, { recursive: true })
}

export function readModelConfig(): ModelConfig {
  ensureDataDir()
  if (!existsSync(MODEL_PATH)) return envDefaultConfig()
  try {
    const raw = JSON.parse(readFileSync(MODEL_PATH, 'utf8')) as Partial<ModelConfig>
    const provider = isProvider(raw.provider) ? raw.provider : envDefaultConfig().provider
    const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null
    const baseUrl = typeof raw.base_url === 'string' && raw.base_url.trim() ? raw.base_url.trim() : null
    return {
      provider,
      model,
      base_url: baseUrl,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : EPOCH,
    }
  } catch {
    return envDefaultConfig()
  }
}

export function writeModelConfig(next: ModelConfigInput): ModelConfig {
  ensureDataDir()
  const config: ModelConfig = {
    provider: next.provider,
    model: next.model && next.model.trim() ? next.model.trim() : null,
    base_url: next.base_url && next.base_url.trim() ? next.base_url.trim() : null,
    updated_at: new Date().toISOString(),
  }
  writeFileSync(MODEL_PATH, JSON.stringify(config, null, 2))
  return config
}

// --- API key resolution ----------------------------------------------------

function readEnvVar(name: string, fileEnv: Record<string, string>): string | null {
  const fromProcess = process.env[name]?.trim()
  if (fromProcess) return fromProcess
  const fromFile = fileEnv[name]?.trim()
  return fromFile || null
}

// Resolves the API key for a provider from process.env, falling back to a fresh
// read of .env so a key added after boot is picked up without a restart.
export function resolveApiKey(provider: Provider): string | null {
  const fileEnv = readEnvFile(ENV_FILE_PATH)
  const generic = readEnvVar('AUTOREPLY_LLM_API_KEY', fileEnv)
  if (provider === 'openai') return readEnvVar('OPENAI_API_KEY', fileEnv) ?? generic
  if (provider === 'anthropic') return readEnvVar('ANTHROPIC_API_KEY', fileEnv) ?? generic
  return null // CLI providers use their own auth
}

// The env var name a provider's key belongs in (used by the CLI when the
// operator supplies a key inline).
export function apiKeyEnvName(provider: Provider): string | null {
  if (provider === 'openai') return 'OPENAI_API_KEY'
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY'
  return null
}

export function resolveBaseUrl(config: Pick<ModelConfig, 'base_url'>): string {
  return (config.base_url ?? AUTOREPLY_LLM_BASE_URL).replace(/\/$/, '')
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

// The provider API key is sent as a Bearer token to base_url. Refuse to ship it
// in plaintext to a non-local host over http (which would also be an
// authenticated SSRF primitive) - require https for anything but localhost.
export function assertSafeBaseUrl(baseUrl: string): void {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    throw new Error(`[autoreply/model] invalid base_url: ${baseUrl}`)
  }
  if (u.protocol === 'https:') return
  if (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname.replace(/^\[|\]$/g, ''))) return
  throw new Error(`[autoreply/model] refusing to send the API key to ${baseUrl} over http - use https, or a localhost endpoint`)
}

function isLocalEndpoint(url: string): boolean {
  return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(url)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- Connectivity / model verification -------------------------------------

export interface VerifyResult {
  ok: boolean
  provider: Provider
  model: string | null
  detail: string
  available_models?: string[]
}

const VERIFY_TIMEOUT_MS = 20000

async function verifyClaudeCli(config: ModelConfigInput): Promise<VerifyResult> {
  try {
    const { stdout } = await execFileAsync(AUTOREPLY_CLAUDE_BIN, ['--version'], { timeout: VERIFY_TIMEOUT_MS })
    return {
      ok: true,
      provider: config.provider,
      model: config.model ?? AUTOREPLY_MODEL,
      detail: `claude CLI ready (${stdout.trim().split('\n')[0] || 'ok'}); model name not independently verifiable for CLI`,
    }
  } catch (error) {
    return { ok: false, provider: config.provider, model: config.model, detail: `claude CLI not runnable: ${errorMessage(error)}` }
  }
}

async function verifyCodexCli(config: ModelConfigInput): Promise<VerifyResult> {
  // codex login status confirms the CLI is authed (the real "LLM connected"
  // signal for this provider). Binary presence alone is not enough.
  try {
    // codex login status writes to stderr, not stdout - read both.
    const { stdout, stderr } = await execFileAsync(AUTOREPLY_CODEX_BIN, ['login', 'status'], { timeout: VERIFY_TIMEOUT_MS })
    const text = `${stdout}\n${stderr}`.trim()
    if (!/logged in/i.test(text)) {
      return { ok: false, provider: config.provider, model: config.model, detail: `codex not logged in (run: codex login). Status: ${text || 'unknown'}` }
    }
    return {
      ok: true,
      provider: config.provider,
      model: config.model,
      detail: `codex CLI ready (${text}); model name not independently verifiable for CLI`,
    }
  } catch (error) {
    return { ok: false, provider: config.provider, model: config.model, detail: `codex CLI not runnable: ${errorMessage(error)}` }
  }
}

async function verifyAnthropic(config: ModelConfigInput): Promise<VerifyResult> {
  const key = resolveApiKey('anthropic')
  const model = config.model ?? defaultModelFor('anthropic')
  if (!key) {
    return { ok: false, provider: config.provider, model, detail: 'no API key (set ANTHROPIC_API_KEY or AUTOREPLY_LLM_API_KEY)' }
  }
  try {
    const client = new Anthropic({ apiKey: key })
    // A 1-token generation proves key + model together, not just reachability.
    await client.messages.create({
      model: model ?? 'claude-opus-4-8',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    })
    return { ok: true, provider: config.provider, model, detail: `anthropic reachable, model "${model}" responded` }
  } catch (error) {
    return { ok: false, provider: config.provider, model, detail: `anthropic check failed: ${errorMessage(error)}` }
  }
}

// Primary reachability check: GET /models proves the key is valid and the
// endpoint is up, and lets us confirm the requested model is actually available
// - all param-free, so it sidesteps the max_tokens vs max_completion_tokens
// incompatibility across OpenAI model generations and compatible servers.
async function fetchOpenAiModels(baseUrl: string, key: string | null): Promise<{ ok: boolean; status: number; ids: string[]; body: string }> {
  const headers: Record<string, string> = {}
  if (key) headers.Authorization = `Bearer ${key}`
  const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, status: res.status, ids: [], body: body.slice(0, 300) }
  }
  const payload = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string }> }
  const ids = (payload.data ?? []).map((m) => m.id).filter((v): v is string => typeof v === 'string')
  return { ok: true, status: res.status, ids, body: '' }
}

// Fallback for OpenAI-compatible servers that do not implement /models. Some
// newer OpenAI models reject `max_tokens` and want `max_completion_tokens`;
// older / compatible endpoints (Ollama, LM Studio) want `max_tokens`. Try both.
async function openAiChatPing(baseUrl: string, key: string | null, model: string): Promise<{ ok: boolean; detail: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  const tryCap = async (capField: 'max_completion_tokens' | 'max_tokens') => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], [capField]: 16 }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    if (res.ok) return { ok: true, status: res.status, body: '' }
    const body = await res.text().catch(() => '')
    return { ok: false, status: res.status, body: body.slice(0, 200) }
  }
  const a = await tryCap('max_completion_tokens')
  if (a.ok) return { ok: true, detail: 'chat ping ok' }
  const b = await tryCap('max_tokens')
  if (b.ok) return { ok: true, detail: 'chat ping ok' }
  return { ok: false, detail: `HTTP ${a.status}/${b.status} ${(a.body || b.body).trim()}`.trim() }
}

async function verifyOpenAi(config: ModelConfigInput): Promise<VerifyResult> {
  const baseUrl = resolveBaseUrl(config)
  const key = resolveApiKey('openai')
  const model = config.model ?? defaultModelFor('openai')
  const local = isLocalEndpoint(baseUrl)
  if (!key && !local) {
    return { ok: false, provider: config.provider, model, detail: `no API key for ${baseUrl} (set OPENAI_API_KEY or AUTOREPLY_LLM_API_KEY)` }
  }
  if (!model) {
    return { ok: false, provider: config.provider, model, detail: 'openai requires a model (e.g. gpt-5)' }
  }
  try {
    assertSafeBaseUrl(baseUrl)
  } catch (error) {
    return { ok: false, provider: config.provider, model, detail: errorMessage(error) }
  }
  try {
    const models = await fetchOpenAiModels(baseUrl, key)
    if (models.ok) {
      if (models.ids.length && !models.ids.includes(model)) {
        return {
          ok: false,
          provider: config.provider,
          model,
          detail: `model "${model}" not available for this key`,
          available_models: models.ids,
        }
      }
      return {
        ok: true,
        provider: config.provider,
        model,
        detail: `openai reachable, model "${model}" available`,
        available_models: models.ids.length ? models.ids : undefined,
      }
    }
    // /models unavailable (some compatible servers) - fall back to a chat ping.
    const ping = await openAiChatPing(baseUrl, key, model)
    if (ping.ok) {
      return { ok: true, provider: config.provider, model, detail: `openai reachable (chat ping), model "${model}" responded` }
    }
    return { ok: false, provider: config.provider, model, detail: `openai check failed: /models HTTP ${models.status}; ${ping.detail}` }
  } catch (error) {
    return { ok: false, provider: config.provider, model, detail: `openai unreachable at ${baseUrl}: ${errorMessage(error)}` }
  }
}

// Verifies that the provider is authed/reachable AND the requested model
// actually responds. This is the gate the switch enforces before persisting.
export async function verifyModel(config: ModelConfigInput): Promise<VerifyResult> {
  if (config.provider === 'claude-cli') return verifyClaudeCli(config)
  if (config.provider === 'codex-cli') return verifyCodexCli(config)
  if (config.provider === 'anthropic') return verifyAnthropic(config)
  return verifyOpenAi(config)
}

// A cheap, no-network snapshot of each provider's readiness for the `list`
// command: is a key/CLI configured, and is it the active provider.
export interface ProviderStatus {
  provider: Provider
  kind: 'cli' | 'api'
  active: boolean
  default_model: string | null
  key_configured: boolean | null // null for CLI providers (auth is external)
}

export function describeProviders(): ProviderStatus[] {
  const active = readModelConfig().provider
  return PROVIDERS.map((provider) => ({
    provider,
    kind: CLI_PROVIDERS.includes(provider) ? 'cli' : 'api',
    active: provider === active,
    default_model: defaultModelFor(provider),
    key_configured: CLI_PROVIDERS.includes(provider) ? null : Boolean(resolveApiKey(provider)),
  }))
}

// --- codex-cli completion (shared by the LLM layer) ------------------------

let codexTmpCounter = 0

export async function completeViaCodexCli(prompt: string, model: string | null): Promise<string> {
  const tmpPath = join(tmpdir(), `wa-autoreply-codex-${process.pid}-${codexTmpCounter++}.txt`)
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--output-last-message',
    tmpPath,
  ]
  if (model) args.push('-m', model)
  args.push(prompt)
  try {
    const { stdout } = await execFileAsync(AUTOREPLY_CODEX_BIN, args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120000,
    })
    if (existsSync(tmpPath)) {
      const out = readFileSync(tmpPath, 'utf8')
      if (out.trim()) return out
    }
    // Fallback: if the last-message file is empty, return raw stdout so the
    // JSON extractor downstream still has something to work with.
    return stdout
  } finally {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* best effort */
    }
  }
}
