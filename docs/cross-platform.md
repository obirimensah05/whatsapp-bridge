# Running wa-bridge on Windows or Linux

The bridge is developed and operated on macOS. The core stack (Node 20+, Baileys,
better-sqlite3 with prebuilt binaries, Fastify, the web UI, REST API, MCP server,
webhook dispatcher, autoreply sidecar) is fully cross-platform. What is NOT
portable is the operational tooling around it. This file is the single source of
truth for what must change per OS.

Audience: both humans deciding how to run it, and AI agents executing the port.
Each patch below states the file, the exact change, and an acceptance check.
Do not apply patches for an OS you are not running on.

## TL;DR by OS

| OS | Code patches required | Effort |
|---|---|---|
| macOS | 0 | reference platform |
| Linux | 1 code patch + 1 doc/service setup (patches L1, L2) | ~15 min |
| Windows via WSL2 | 0 code patches (follow the Linux column inside WSL2) | ~30 min |
| Windows native | 5 patches (W1-W5), +1 in the private repo (W6) | ~2-3 h |

**Recommendation for Windows users: use WSL2.** Inside WSL2 everything behaves
like Linux and only L1/L2 apply. Only go native Windows if WSL2 is not an option.

## What already works everywhere (do not "fix" these)

- `Browsers.macOS('Safari')` in `src/wa.ts` is a protocol identifier sent to
  WhatsApp's servers, not a local OS check. It is required for pairing codes to
  work and must stay exactly as is on every OS.
- better-sqlite3 ships prebuilt binaries for Windows/Linux/macOS. `npm install`
  handles it; no patch.
- All runtime paths go through `node:path` `join()`/`resolve()` or relative
  `./data/...` paths. No separator patches needed.
- `src/transcribe.ts` / `transcribe-backlog` call the OpenAI HTTP API. Portable.
- `src/updates.ts` shells out to `git` only. Portable wherever git is installed.

---

## Linux patches

### L1 - guard `import-contacts` behind a platform check

`src/import-contacts.ts` shells out to `osascript` to dump macOS Contacts.app.
On Linux the spawn fails with a raw ENOENT.

- Change: at the top of the CLI entry, if `process.platform !== 'darwin'`, print
  "contacts import requires macOS (Contacts.app); skipping - display names still
  resolve from WhatsApp push names" and `process.exit(0)`.
- Acceptance: `npm run import-contacts -- --session=main` on Linux exits 0 with
  the friendly message. On macOS behavior is unchanged.
- Note: this is a nice-to-have feature, not a dependency. Name resolution works
  without it via WhatsApp push names.

### L2 - service supervision via systemd user units

The `stop` / `restart` / `status` / `autoreply:stop|start|restart` npm scripts
call `launchctl` against launchd plists. On Linux, create two systemd user units
instead and do not use those npm scripts:

```ini
# ~/.config/systemd/user/wa-bridge.service
[Unit]
Description=wa-bridge daemon
[Service]
WorkingDirectory=%h/apps/wa-bridge
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=10
[Install]
WantedBy=default.target
```

Duplicate as `wa-autoreply.service` with `ExecStart=/usr/bin/npm run autoreply`.
Then `systemctl --user daemon-reload && systemctl --user enable --now wa-bridge wa-autoreply`.

- Acceptance: `systemctl --user status wa-bridge` shows active; `npm run health`
  returns `{ ok: true, ... }`.
- Everything else on Linux is fine as-is: `chmod` 0600/0700 hardening is real,
  the POSIX one-liners in `health` / `logs` / `autoreply:status` / `autoreply:off`
  (grep/cut/tail/id) all work, and the Claude CLI spawns normally.

---

## Windows (native) patches

Apply L1 as well (same reason). Then:

### W1 - replace launchd npm scripts with a Windows service

Same scripts as L2 (`stop` / `restart` / `status` / `autoreply:*` lifecycle).
Options, in order of preference:

1. NSSM: `nssm install wa-bridge "C:\Program Files\nodejs\npm.cmd" run start`
   with AppDirectory set to the repo; second service for the autoreply sidecar.
2. Task Scheduler task "At log on" running `npm run start` in the repo dir.
3. Development only: two terminals running `npm run start` and `npm run autoreply`.

- Acceptance: after a reboot the bridge answers `GET /v1/health` without manual
  intervention.

### W2 - rewrite POSIX shell one-liners in package.json

These npm scripts break under cmd.exe because they use `grep`, `cut`, `tail`,
`$(id -u)`, and `$(...)` substitution: `health`, `logs`, `logs:err`,
`autoreply:status`, `autoreply:off`, `autoreply:health`, `autoreply:logs`.

- Change: port each to a small Node script (e.g. `scripts/health.mjs` reading
  `.env` itself and calling fetch), and point the npm script at
  `node scripts/health.mjs`. This also un-forks the scripts from macOS so the
  same command works on all three OSes.
- Acceptance: `npm run health` and `npm run autoreply:status` print JSON on
  Windows PowerShell and cmd.exe.

### W3 - Claude CLI spawn in the autoreply generator

`src/autoreply-generate.ts` does `execFile(AUTOREPLY_CLAUDE_BIN, ...)` with the
default `claude`. On Windows the CLI is installed as a `.cmd`/`.exe` shim, and
Node's `execFile` does not resolve `.cmd` shims without `shell: true`.

- Change (pick one):
  a. Document that Windows users must set `AUTOREPLY_CLAUDE_BIN` in `.env` to
     the full path of `claude.exe`; or
  b. In `autoreply-generate.ts`, when `process.platform === 'win32'` and the
     bin has no extension, spawn via `{ shell: true }` (keep the prompt as a
     single argv element; do not string-concatenate it into a shell line).
- Acceptance: send a test webhook (`POST /v1/webhook/test` then a real inbound)
  and confirm a draft appears in `data/autoreply/drafts.ndjson`.

### W4 - file-permission hardening is a silent no-op

`chmodSync(..., 0o600/0o700)` calls in `src/env.ts`, `src/autoreply-env.ts`,
`src/db.ts`, `src/rotate-token.ts`, `src/wa.ts`, `src/autoreply-setup-notify.ts`
do not throw on Windows but only toggle the read-only bit. Secrets in `.env`,
`auth/`, and `data/wa.db` are NOT protected from other local users.

- Change: no code change required to run. For hardening, either document an
  `icacls` command (`icacls .env /inheritance:r /grant:r "%USERNAME%:F"`) in the
  Windows setup notes, or add a `process.platform === 'win32'` branch that
  spawns icacls best-effort.
- Acceptance (if hardened): `icacls .env` lists only the owning user.

### W5 - README / docs service section

The README documents launchd only (and mentions systemd for Linux). Add a
Windows subsection referencing W1 and this file.

- Acceptance: README "Running as a service" covers macOS, Linux, Windows.

### W6 - second-brain integration (PRIVATE repo only)

`src/autoreply-second-brain.ts` hardcodes `<root>/.venv/bin/python` and the
default root is an absolute macOS home path. Windows venvs use
`.venv\Scripts\python.exe`.

- Change: derive the interpreter per platform
  (`win32 ? '.venv/Scripts/python.exe' : '.venv/bin/python'`) and require
  `AUTOREPLY_SECOND_BRAIN_ROOT` to be set instead of defaulting to a personal
  path. The public mirror defaults this root to empty, so the public repo does
  not need this patch.
- Acceptance: draft generation on Windows includes second-brain context when
  the root is configured, and degrades silently when it is not.

---

## Suggested execution order for an agent

1. Confirm target OS and whether WSL2 is acceptable (if yes on Windows: stop,
   follow the Linux path inside WSL2).
2. Linux: L1 then L2. Windows native: L1, W1, W2, W3, then W4/W5 (docs), W6 only
   in the private repo.
3. After each patch run `npx tsc --noEmit`, then the patch's acceptance check.
4. Nothing here touches `auth/`, `data/`, or `.env` contents; if a patch seems
   to require deleting any of those, stop - it does not.
