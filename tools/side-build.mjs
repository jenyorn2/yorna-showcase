#!/usr/bin/env node
/**
 * SIDE BUILD — a second production build beside the main one, in a known place.
 *
 *   npm run side -- build <name>          # → .next-side/<name>; the main .next is not touched
 *   npm run side -- start <name> [port]   # serve it; the port defaults to 3003 and is never 3001
 *   npm run side -- list                  # every side build: size, commit, whether it is serving
 *   npm run side -- stop <name>           # stop the server `start` launched
 *   npm run side -- rm <name>             # delete one (npm run clean deletes them all)
 *
 * What it is for: measuring a change against the build somebody is using. The
 * main server keeps `.next` and port 3001; a side build has its own folder and
 * its own port, so neither can break the other.
 *
 *   npm run db:copy -- npm run side -- start hold15 3003
 *   serves a throwaway copy of the local database instead of prisma/dev.db.
 *
 * WRITES: under `.next-side/` only. ⚠ `next build` itself rewrites two TRACKED
 * files when the output folder is not `.next`: `tsconfig.json` (it adds the
 * folder's types to `include`) and `next-env.d.ts` (its two import lines).
 * `build` puts both back exactly as they were — when the build passes, when it
 * fails, and when it is stopped with Ctrl+C. If the build is killed outright,
 * the next `npm run side` command puts them back first.
 *
 * "In use" — a build being written, a build being served — is a lock its owner
 * keeps renewing, never a process id alone: scripts/side-locks.mjs says why.
 *
 * `build` clears that side build's own webpack cache first: a side build reused
 * across two changes has served the OLD globals.css with the new JavaScript
 * (docs/claude/profile-and-account.md). `--reuse-cache` skips that, for speed.
 *
 * `start` stops by itself when the terminal that started it goes away, so no
 * server is left listening with nobody owning it. `--stay` keeps it running;
 * stop that one with `npm run side -- stop <name>`.
 *
 * Why it exists: side builds were made by hand with NEXT_DIST_DIR=.next-<name>.
 * Each is about 1.1 GB and nothing removed them — twelve sat at the repository
 * root in Nov 2026 (13.4 GB) — and the two rewritten files had to be restored
 * by hand before every commit.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { alive, heldLock, hold, listening, readJson } from './side-locks.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SIDE_ROOT = '.next-side'
const NEXT_BIN = path.join(REPO, 'node_modules', 'next', 'dist', 'bin', 'next')
/** The tracked files `next build` rewrites for a non-default output folder. */
const REWRITTEN = ['tsconfig.json', 'next-env.d.ts']
const MAIN_PORT = 3001
const DEFAULT_PORT = 3003

const abs = (rel) => path.join(REPO, rel)
const sideDir = (name) => `${SIDE_ROOT}/${name}`
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const remove = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
const BUILDING = abs(`${SIDE_ROOT}/.building`)

function fail(message) {
  console.error(`side: ${message}`)
  process.exit(1)
}

function usage() {
  console.log([
    'npm run side -- build <name> [--reuse-cache]',
    'npm run side -- start <name> [port] [--stay] [next start options]',
    'npm run side -- list',
    'npm run side -- stop <name>',
    'npm run side -- rm <name>',
  ].join('\n'))
}

function validName(name) {
  if (!name) { usage(); process.exit(2) }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    fail(`"${name}" is not a usable name — lower-case letters, digits and "-" (it becomes a folder).`)
  }
  return name
}

function sizeOf(p) {
  let st
  try { st = fs.lstatSync(p) } catch { return 0 }
  if (!st.isDirectory()) return st.isFile() ? st.size : 0
  let total = 0
  for (const entry of fs.readdirSync(p)) total += sizeOf(path.join(p, entry))
  return total
}

const human = (bytes) => bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
  : `${(bytes / 1024 ** 2).toFixed(1)} MB`

/** `2026-11-15 09:34` in this machine's time, from what `toISOString()` stored. */
function localTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/**
 * The server `start` launched for this build, if it is still up: its lock is
 * held (scripts/side-locks.mjs) and its port answers.
 */
async function serving(name) {
  const lock = heldLock(abs(`${sideDir(name)}/.serving.json`))
  return lock && (await listening(lock.port)) ? lock : null
}

function git(...args) {
  try { return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim() } catch { return '' }
}

/** Processes that outlive any one terminal: the chain is not followed past them. */
const SESSION_ROOTS = new Set([
  'explorer.exe', 'services.exe', 'wininit.exe', 'winlogon.exe', 'svchost.exe', 'system',
  'init', 'systemd', 'launchd',
])

/**
 * The chain that launched this process: its parent, the parent's parent, and so
 * on up to the terminal (or the tool) that typed the command.
 *
 * ⚠ The direct parent alone is not enough. `npm run` puts two processes
 * between the terminal and this one, and killing a process on Windows does not
 * take its children with it — so the one that gets stopped is rarely the one
 * directly above.
 */
function launchChain() {
  /** @type {Map<number, { parent: number, name: string, born: number }>} */
  const table = new Map()
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.Ticks) $($_.Name)" }',
      ], { encoding: 'utf8', timeout: 15000, windowsHide: true })
      for (const line of out.split(/\r?\n/)) {
        const m = /^(\d+) (\d+) (\d+) (.+)$/.exec(line.trim())
        if (m) table.set(Number(m[1]), { parent: Number(m[2]), born: Number(m[3]), name: m[4].toLowerCase() })
      }
    } else {
      const out = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 15000 })
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
        if (m) table.set(Number(m[1]), { parent: Number(m[2]), born: 0, name: path.basename(m[3]).toLowerCase() })
      }
    }
  } catch { return [process.ppid] }

  const chain = []
  let child = table.get(process.pid)
  let pid = process.ppid
  while (pid > 4 && table.has(pid) && !chain.includes(pid)) {
    const entry = table.get(pid)
    if (SESSION_ROOTS.has(entry.name)) break
    // Windows never re-parents: a parent id can belong to a NEWER, unrelated
    // process that was handed the dead parent's number. Stop there.
    if (child && entry.born > child.born) break
    chain.push(pid)
    child = entry
    pid = entry.parent
  }
  return chain.length > 0 ? chain : [process.ppid]
}

/* ── the two files `next build` rewrites ───────────────────────────────── */

const RESTORE = abs(`${SIDE_ROOT}/.restore.json`)
/** tsconfig's include, or next-env's imports, naming a side build's folder. */
const namesASideBuild = (text) => /["'/]\.next-[^"'/]+\//.test(text)

function snapshot() {
  const files = {}
  for (const rel of REWRITTEN) {
    try { files[rel] = fs.readFileSync(abs(rel), 'utf8') } catch { /* not present: nothing to put back */ }
  }
  return files
}

/** Put back whichever of the two files changed. Returns the names it rewrote. */
function restore(files) {
  const put = []
  for (const [rel, before] of Object.entries(files)) {
    let now = null
    try { now = fs.readFileSync(abs(rel), 'utf8') } catch { /* removed: write it back */ }
    if (now !== before) { fs.writeFileSync(abs(rel), before); put.push(rel) }
  }
  return put
}

/**
 * A build that was killed outright never reached its own restore. Its snapshot
 * is still on disk; use it — but only for a file that still names a side build.
 * A file that does not has been put right already (or edited since) and wins.
 */
function recover() {
  if (heldLock(BUILDING)) return // that build is still running, and will restore itself
  // A mark nobody holds belongs to a build that died. Remove it, so it can
  // never be taken for a build in progress.
  fs.rmSync(BUILDING, { force: true })
  const saved = readJson(RESTORE)
  if (!saved) return
  const stale = {}
  for (const [rel, before] of Object.entries(saved.files ?? {})) {
    let now = ''
    try { now = fs.readFileSync(abs(rel), 'utf8') } catch { /* removed */ }
    if (now !== before && namesASideBuild(now)) stale[rel] = before
  }
  const put = restore(stale)
  remove(RESTORE)
  if (put.length > 0) console.log(`side: an earlier side build was interrupted — put back ${put.join(' and ')}.`)
}

/** Refuse to start from a tree that already carries a side build's rewrite. */
function refuseIfRewritten() {
  for (const rel of REWRITTEN) {
    let text
    try { text = fs.readFileSync(abs(rel), 'utf8') } catch { continue }
    if (namesASideBuild(text)) {
      fail(`${rel} names a side build's folder — a build made by hand left it rewritten.\n` +
        `  Put it back first:  git checkout -- ${REWRITTEN.join(' ')}`)
    }
  }
}

/* ── build ─────────────────────────────────────────────────────────────── */

async function build(name, flags) {
  const unknown = flags.filter((f) => f !== '--reuse-cache')
  if (unknown.length > 0) fail(`build does not take ${unknown.join(' ')}`)
  if (!fs.existsSync(NEXT_BIN)) fail('next is not installed — run npm install first.')

  const dist = sideDir(name)
  const live = isDir(abs(dist)) ? await serving(name) : null
  if (live) fail(`${dist} is being served on :${live.port} — npm run side -- stop ${name} first.`)

  const other = heldLock(BUILDING)
  if (other) fail(`another side build is running (pid ${other.pid}) — two would fight over tsconfig.json.`)

  refuseIfRewritten()
  fs.mkdirSync(abs(SIDE_ROOT), { recursive: true })
  if (!flags.includes('--reuse-cache')) remove(abs(`${dist}/cache/webpack`))

  // The mark first, the snapshot second: another `npm run side` command that
  // finds a snapshot without a held mark takes it for a dead build's and
  // removes it (recover) — and this build would then have nothing to restore
  // from if it were killed.
  const files = snapshot()
  const letGo = hold(BUILDING, { name, pid: process.pid })
  fs.writeFileSync(RESTORE, JSON.stringify({ name, pid: process.pid, files }))

  const started = Date.now()
  let code
  try {
    code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [NEXT_BIN, 'build', '--webpack'], {
        cwd: REPO,
        stdio: 'inherit',
        env: { ...process.env, NEXT_DIST_DIR: dist },
      })
      // Ctrl+C reaches the build as well; stay alive long enough to restore.
      process.on('SIGINT', () => {})
      for (const signal of ['SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => child.kill())
      child.on('error', (e) => { console.error(`side: could not start next build — ${e.message}`); resolve(1) })
      child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 130 : 1)))
    })
  } finally {
    const put = restore(files)
    remove(RESTORE)
    letGo()
    if (put.length > 0) console.log(`side: put back ${put.join(' and ')} (next build rewrites them for a side folder).`)
  }

  if (code !== 0) {
    console.error(`side: the build failed (exit ${code}). ${dist} is not usable.`)
    process.exit(code)
  }

  const commit = git('rev-parse', '--short', 'HEAD')
  const dirty = git('status', '--porcelain') !== ''
  fs.writeFileSync(abs(`${dist}/.side.json`), JSON.stringify({ name, builtAt: new Date().toISOString(), commit, dirty }))
  const seconds = Math.round((Date.now() - started) / 1000)
  console.log(
    `side: built ${dist} — ${human(sizeOf(abs(dist)))} in ${Math.floor(seconds / 60)}m ${seconds % 60}s, ` +
    `from ${commit || 'an unknown commit'}${dirty ? ' + uncommitted changes' : ''}.\n` +
    `      serve it:  npm run side -- start ${name} ${DEFAULT_PORT}`,
  )
}

/* ── start ─────────────────────────────────────────────────────────────── */

async function start(name, rest) {
  const dist = sideDir(name)
  if (!fs.existsSync(abs(`${dist}/BUILD_ID`))) fail(`${dist} has no build — npm run side -- build ${name} first.`)

  const stay = rest.includes('--stay')
  const args = rest.filter((a) => a !== '--stay')
  let port = DEFAULT_PORT
  if (args[0] && /^\d+$/.test(args[0])) port = Number(args.shift())
  if (port === MAIN_PORT) fail(`port ${MAIN_PORT} belongs to the main server (npm start / npm run dev). Pick another.`)
  if (port < 1024 || port > 65535) fail(`port ${port} is out of range (1024–65535).`)

  const live = await serving(name)
  if (live) fail(`${dist} is already being served on :${live.port} (pid ${live.pid}).`)
  if (await listening(port)) fail(`port ${port} is in use — pick another, or stop what is there.`)

  const letGo = hold(abs(`${dist}/.serving.json`), { name, pid: process.pid, port, startedAt: new Date().toISOString() })
  process.on('exit', letGo)

  if (!stay) {
    // No owner, no server: when the terminal (or the tool) that started this
    // goes away, stop. A killed launcher used to leave the server listening,
    // and the next start on that port died while the old one served a rebuilt
    // folder.
    const owners = launchChain()
    setInterval(() => {
      if (owners.every(alive)) return
      console.log('side: what started this server has gone — stopping. (--stay keeps it running.)')
      process.exit(0)
    }, 2000).unref()
  }

  const meta = readJson(abs(`${dist}/.side.json`))
  console.log(`side: serving ${dist}${meta?.commit ? ` (built from ${meta.commit}${meta.dirty ? ' + uncommitted changes' : ''})` : ''} on http://localhost:${port}`)

  // The Next CLI, in THIS process: one process to stop, and it is the one
  // listening. (`next start` runs its server in-process; it does not fork.)
  process.env.NEXT_DIST_DIR = dist
  process.chdir(REPO)
  process.argv = [process.execPath, NEXT_BIN, 'start', '-p', String(port), ...args]
  createRequire(import.meta.url)(NEXT_BIN)
}

/* ── list · stop · rm ──────────────────────────────────────────────────── */

async function list() {
  const rows = []
  if (isDir(abs(SIDE_ROOT))) {
    const beingBuilt = heldLock(BUILDING)?.name
    for (const name of fs.readdirSync(abs(SIDE_ROOT)).sort()) {
      if (!isDir(abs(sideDir(name)))) continue
      const meta = readJson(abs(`${sideDir(name)}/.side.json`))
      const live = await serving(name)
      let state = 'not finished'
      if (name === beingBuilt) state = 'being built now'
      else if (meta) state = `${meta.commit || '?'}${meta.dirty ? '+changes' : ''}  ${localTime(meta.builtAt)}`
      rows.push([
        sideDir(name),
        human(sizeOf(abs(sideDir(name)))),
        state,
        live ? `serving on :${live.port} (pid ${live.pid})` : '',
      ])
    }
  }
  // Made by hand with NEXT_DIST_DIR=.next-<name>: shown so they are not forgotten.
  for (const name of fs.readdirSync(REPO).sort()) {
    if (name.startsWith('.next-') && name !== SIDE_ROOT && isDir(abs(name))) {
      rows.push([name, human(sizeOf(abs(name))), 'made by hand', ''])
    }
  }
  if (rows.length === 0) { console.log('side: no side builds.'); return }
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)))
  for (const r of rows) console.log(`  ${r[0].padEnd(widths[0])}  ${r[1].padStart(widths[1])}  ${r[2].padEnd(widths[2])}  ${r[3]}`.trimEnd())
  console.log('side: remove one with  npm run side -- rm <name>  — or all of them with  npm run clean')
}

async function stop(name) {
  const live = await serving(name)
  if (!live) { console.log(`side: ${sideDir(name)} is not being served.`); return }
  try { process.kill(live.pid) } catch (e) { fail(`could not stop pid ${live.pid} — ${e.message}`) }
  for (let i = 0; i < 25 && (await listening(live.port)); i += 1) await new Promise((r) => setTimeout(r, 200))
  if (await listening(live.port)) fail(`pid ${live.pid} was stopped but :${live.port} still answers — something else is there.`)
  fs.rmSync(abs(`${sideDir(name)}/.serving.json`), { force: true })
  console.log(`side: stopped ${sideDir(name)} (:${live.port}).`)
}

async function rm(name) {
  const dist = sideDir(name)
  if (!isDir(abs(dist))) { console.log(`side: ${dist} does not exist.`); return }
  const live = await serving(name)
  if (live) fail(`${dist} is being served on :${live.port} — npm run side -- stop ${name} first.`)
  const bytes = sizeOf(abs(dist))
  remove(abs(dist))
  console.log(`side: removed ${dist} (${human(bytes)}).`)
}

/* ── entry ─────────────────────────────────────────────────────────────── */

const [command, name, ...rest] = process.argv.slice(2)
recover()

if (command === 'build') await build(validName(name), rest)
else if (command === 'start') await start(validName(name), rest)
else if (command === 'list') await list()
else if (command === 'stop') await stop(validName(name))
else if (command === 'rm') await rm(validName(name))
else { usage(); process.exit(command ? 2 : 0) }
