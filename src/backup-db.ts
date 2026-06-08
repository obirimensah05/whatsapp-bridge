import Database from 'better-sqlite3'
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

const SRC = process.env.WA_DB_PATH ?? './data/wa.db'
const DEST_DIR = process.env.WA_BACKUP_DIR ?? './data/backups'
const KEEP = Number(process.env.WA_BACKUP_KEEP ?? 14) // keep last N

function tsName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `wa-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.db`
}

function pruneOld(dir: string, keep: number): void {
  if (!existsSync(dir)) return
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('wa-') && f.endsWith('.db'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { f } of files.slice(keep)) {
    try {
      unlinkSync(join(dir, f))
      console.log(`[backup] pruned ${f}`)
    } catch (err) {
      console.warn(`[backup] failed to prune ${f}: ${(err as Error).message}`)
    }
  }
}

async function main() {
  if (!existsSync(SRC)) {
    console.error(`[backup] source not found: ${SRC}`)
    process.exit(1)
  }
  mkdirSync(DEST_DIR, { recursive: true })
  const dest = join(DEST_DIR, tsName())

  // open read-only — won't trigger WAL recovery and won't block the live writer
  const src = new Database(SRC, { readonly: true, fileMustExist: true })
  try {
    // better-sqlite3 returns a thenable from .backup() that resolves on completion
    await src.backup(dest)
  } finally {
    src.close()
  }

  const size = statSync(dest).size
  console.log(`[backup] wrote ${dest} (${(size / 1024 / 1024).toFixed(2)} MB)`)

  pruneOld(DEST_DIR, KEEP)
}

main().catch((err) => {
  console.error('[backup] fatal', err)
  process.exit(1)
})
