import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Rotate the REST/MCP bearer token: mint a new one, overwrite (and de-duplicate)
// the API_TOKEN line in .env, and re-lock the file. Resolves .env relative to
// this module so it works regardless of the caller's cwd.
const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env')

const token = randomBytes(32).toString('hex')
const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : []
const kept = existing.filter((line) => !/^API_TOKEN=/.test(line.trim()))
while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
kept.push(`API_TOKEN=${token}`)
writeFileSync(ENV_PATH, kept.join('\n') + '\n')
try {
  chmodSync(ENV_PATH, 0o600)
} catch {}

console.log('[rotate-token] new API_TOKEN written to .env\n')
console.log(`New token: ${token}\n`)
console.log('Apply it:')
console.log('  1) restart the daemon                     (e.g. npm run restart)')
console.log('  2) restart the autoreply sidecar if used  (npm run autoreply:restart)')
console.log('  3) re-login the web UI with the new token')
console.log('  MCP needs no action — it reads .env on spawn.')
