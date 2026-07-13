// Terminal control for the autoreply model.
//
//   npm run autoreply:model                       # show active model + providers
//   npm run autoreply:model -- list               # list all providers + readiness
//   npm run autoreply:model -- test [provider] [model]
//   npm run autoreply:model -- use <provider> [model] [flags]
//
// Flags for `use`:
//   --base-url <url>   openai-compatible endpoint override (OpenRouter, Ollama, ...)
//   --key <api-key>    write this key into .env for the provider (openai/anthropic)
//   --force            switch even if the connectivity check fails
//
// The switch is gated on a live connectivity check: the provider must be
// authed/reachable AND the model must actually respond before it is persisted.
// Changes take effect on the next draft - the sidecar reads the config fresh
// per message, so no restart is needed.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

import { ENV_FILE_PATH } from './autoreply-env.js'
import {
  type ModelConfigInput,
  type Provider,
  PROVIDERS,
  apiKeyEnvName,
  describeProviders,
  isProvider,
  readModelConfig,
  verifyModel,
  writeModelConfig,
} from './autoreply-model.js'
import { appendAudit } from './autoreply-store.js'

interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next
        i++
      } else {
        flags[name] = true
      }
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, flags }
}

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

function upsertEnvVar(name: string, value: string): void {
  const line = `${name}=${value}`
  let contents = existsSync(ENV_FILE_PATH) ? readFileSync(ENV_FILE_PATH, 'utf8') : ''
  const pattern = new RegExp(`^${name}=.*$`, 'm')
  if (pattern.test(contents)) {
    contents = contents.replace(pattern, line)
  } else {
    if (contents.length && !contents.endsWith('\n')) contents += '\n'
    contents += `${line}\n`
  }
  writeFileSync(ENV_FILE_PATH, contents)
  try {
    chmodSync(ENV_FILE_PATH, 0o600)
  } catch {
    /* best effort */
  }
  // Make it visible to this process so the verify step below picks it up.
  process.env[name] = value
}

function printConfig(): void {
  const config = readModelConfig()
  console.log(`active provider : ${config.provider}`)
  console.log(`active model    : ${config.model ?? '(provider default)'}`)
  if (config.base_url) console.log(`base url        : ${config.base_url}`)
  console.log(`updated at      : ${config.updated_at}`)
}

function printProviders(): void {
  console.log('providers:')
  for (const p of describeProviders()) {
    const marker = p.active ? '*' : ' '
    const key = p.kind === 'cli' ? 'CLI auth' : p.key_configured ? 'key set' : 'no key'
    const model = p.default_model ?? '(provider default)'
    console.log(`  ${marker} ${p.provider.padEnd(10)} ${p.kind.padEnd(3)}  ${key.padEnd(9)}  default: ${model}`)
  }
  console.log('\n(* = active. Switch with: npm run autoreply:model -- use <provider> [model])')
}

async function cmdTest(args: ParsedArgs): Promise<void> {
  const current = readModelConfig()
  const providerArg = args.positionals[0]
  if (providerArg && !isProvider(providerArg)) fail(`unknown provider "${providerArg}" (one of: ${PROVIDERS.join(', ')})`)
  const target: ModelConfigInput = {
    provider: (providerArg as Provider | undefined) ?? current.provider,
    model: args.positionals[1] ?? (providerArg ? null : current.model),
    base_url: typeof args.flags['base-url'] === 'string' ? args.flags['base-url'] : (providerArg ? null : current.base_url),
  }
  console.log(`testing ${target.provider} / ${target.model ?? '(default)'} ...`)
  const result = await verifyModel(target)
  console.log(result.ok ? `OK: ${result.detail}` : `FAIL: ${result.detail}`)
  if (result.available_models?.length) {
    console.log(`available models: ${result.available_models.slice(0, 40).join(', ')}`)
  }
  process.exit(result.ok ? 0 : 1)
}

async function cmdUse(args: ParsedArgs): Promise<void> {
  const providerArg = args.positionals[0]
  if (!providerArg) fail(`usage: use <provider> [model] [--base-url url] [--key key] [--force]\nproviders: ${PROVIDERS.join(', ')}`)
  if (!isProvider(providerArg)) fail(`unknown provider "${providerArg}" (one of: ${PROVIDERS.join(', ')})`)
  const provider = providerArg

  const keyFlag = args.flags['key']
  if (keyFlag) {
    if (typeof keyFlag !== 'string') fail('--key requires a value')
    const envName = apiKeyEnvName(provider)
    if (!envName) fail(`provider "${provider}" uses its own CLI auth - no API key needed`)
    upsertEnvVar(envName, keyFlag)
    console.log(`wrote ${envName} to .env (chmod 600)`)
  }

  const target: ModelConfigInput = {
    provider,
    model: args.positionals[1] ?? null,
    base_url: typeof args.flags['base-url'] === 'string' ? args.flags['base-url'] : null,
  }

  console.log(`verifying ${target.provider} / ${target.model ?? '(default)'} ...`)
  const verify = await verifyModel(target)
  const force = args.flags['force'] === true

  if (!verify.ok && !force) {
    console.error(`FAIL: ${verify.detail}`)
    console.error('not switched. Fix the issue, or re-run with --force to switch anyway.')
    process.exit(1)
  }
  if (!verify.ok && force) {
    console.warn(`WARN: ${verify.detail}`)
    console.warn('switching anyway (--force).')
  } else {
    console.log(`OK: ${verify.detail}`)
  }

  const previous = readModelConfig()
  const next = writeModelConfig(target)
  appendAudit('model_updated', { source: 'cli', previous, next, verify, forced: force })
  console.log(`\nswitched -> ${next.provider} / ${next.model ?? '(provider default)'}`)
  if (next.base_url) console.log(`base url: ${next.base_url}`)
  console.log('takes effect on the next draft (no restart needed).')
}

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv
  const args = parseArgs(rest)

  switch (sub) {
    case undefined:
    case 'current':
    case 'status':
      printConfig()
      console.log('')
      printProviders()
      return
    case 'list':
    case 'providers':
      printProviders()
      return
    case 'test':
      await cmdTest(args)
      return
    case 'use':
    case 'set':
    case 'switch':
      await cmdUse(args)
      return
    default:
      fail(`unknown command "${sub}" (use: current | list | test | use)`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
