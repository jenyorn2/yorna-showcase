#!/usr/bin/env node
/**
 * DB COPY — run a command against a throwaway copy of the local database.
 *
 *   npm test                              # the whole suite, on a copy (this script)
 *   npm run db:copy -- git push           # the pre-push tests run on a copy too
 *   npm run db:copy -- npx tsx scripts/some-probe.ts
 *   npm run db:copy -- npm run side -- start hold15 3003
 *   node scripts/with-db-copy.mjs --keep-switches <command…>
 *
 * It copies the SQLite file DATABASE_URL names (prisma/dev.db when unset) to
 * the system temp folder, points DATABASE_URL at the copy for that one command,
 * and deletes the copy when the command ends. The real file is read once, to
 * copy it; the command never opens it.
 *
 * In the COPY only, it also removes the saved feature switches (Admin ›
 * Features), so a feature switched off on this machine cannot fail the tests
 * for that feature. `--keep-switches` leaves them.
 *
 * With no local database (a fresh clone, CI) or a PostgreSQL DATABASE_URL there
 * is nothing to protect, and the command runs unchanged.
 *
 * Why it exists: the database tests have no database of their own. Beside a
 * local server they share its file — on 11 Nov 2026 a run left `next start`
 * answering 200 and saving nothing, and on 13 Nov a push emptied the local
 * FeedEvent table (9,370 rows, repaired from a copy). The rule since then was a
 * ritual typed by hand before every run and every push, and it was forgotten
 * once. This is the ritual as one command, and `npm test` goes through it.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(SELF), '..')
const COPY_DIR = path.join(os.tmpdir(), 'yorna-db-copy')
const SIDECARS = ['-journal', '-wal', '-shm']
const DAY = 24 * 60 * 60 * 1000

const say = (message) => console.error(`db:copy — ${message}`)

const argv = process.argv.slice(2)

/* ── helper mode: clear the saved feature switches in ONE database file ────
   Its own process, on purpose. The SQLite driver keeps a file open until the
   process that opened it ends — `close()` does not release it on Windows — so
   a copy opened by the main process below could never be deleted by it. */
if (argv[0] === '--clear-switches') {
  try {
    const { createClient } = await import('@libsql/client')
    const db = createClient({ url: argv[1] })
    await db.execute("DELETE FROM SiteSetting WHERE key = 'featureSwitches'")
    db.close()
  } catch (e) {
    // An older database without the table has no switches to clear.
    if (!/no such table/i.test(String(e?.message))) {
      say(`could not clear the feature switches in the copy — ${e?.message ?? e}`)
      process.exit(1)
    }
  }
  process.exit(0)
}

let keepSwitches = false
while (argv[0]?.startsWith('--')) {
  const flag = argv.shift()
  if (flag === '--keep-switches') keepSwitches = true
  else if (flag === '--') break
  else { say(`unknown option ${flag}`); process.exit(2) }
}
if (argv.length === 0) {
  console.error('npm run db:copy -- <command…>     (for example: npm run db:copy -- git push)')
  process.exit(2)
}

/** The file a `file:` database URL names, or null for any other kind of URL. */
function sqliteFileOf(url) {
  if (!url.startsWith('file:')) return null
  let p = url.slice('file:'.length).split('?')[0]
  if (p.startsWith('//')) p = p.replace(/^\/\/[^/]*/, '') // file://host/path → /path
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1) // /C:/x → C:/x
  return path.resolve(REPO, p)
}

const url = (process.env.DATABASE_URL ?? '').trim() || 'file:./prisma/dev.db'
const source = sqliteFileOf(url)
const env = { ...process.env }
let copy = null

if (!source) {
  say('DATABASE_URL is not a local SQLite file — running the command unchanged.')
} else if (!fs.existsSync(source)) {
  say(`${path.relative(REPO, source) || source} does not exist — nothing to copy, running the command unchanged.`)
} else {
  fs.mkdirSync(COPY_DIR, { recursive: true })
  // A run that was killed outright could not delete its copy. Sweep old ones.
  for (const name of fs.readdirSync(COPY_DIR)) {
    const p = path.join(COPY_DIR, name)
    try { if (Date.now() - fs.statSync(p).mtimeMs > DAY) fs.rmSync(p, { force: true }) } catch { /* in use */ }
  }

  copy = path.join(COPY_DIR, `${path.basename(source, '.db')}-${process.pid}-${Date.now().toString(36)}.db`)
  fs.copyFileSync(source, copy)
  // A write caught mid-flight lives in the journal; SQLite rolls it back when
  // the copy is opened, but only if the journal came along.
  for (const suffix of ['-journal', '-wal']) {
    if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, copy + suffix)
  }

  const copyUrl = `file:${copy.split(path.sep).join('/')}`
  if (!keepSwitches) {
    spawnSync(process.execPath, [SELF, '--clear-switches', copyUrl], { stdio: ['ignore', 'inherit', 'inherit'] })
  }
  env.DATABASE_URL = copyUrl
  const megabytes = (fs.statSync(copy).size / 1024 ** 2).toFixed(1)
  say(`${path.relative(REPO, source).split(path.sep).join('/')} (${megabytes} MB) copied; the command runs on the copy and the real file is not opened.`)
}

/** A short blocking wait — this runs while the process is exiting. */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function cleanUp() {
  if (!copy) return
  for (const p of [copy, ...SIDECARS.map((s) => copy + s)]) {
    // A test worker can take a moment to let go of the file. (rmSync's own
    // retry option only applies to folders.) What is still held after two
    // seconds is swept by a later run.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.rmSync(p, { force: true }); break } catch { pause(200) }
    }
  }
  copy = null
}

/** One argument, quoted for the shell that will read it. */
const quoted = (arg) => {
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg
  return process.platform === 'win32' ? `"${arg.replace(/"/g, '\\"')}"` : `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * npm's own JavaScript for `npm` or `npx`, when this script was started by npm
 * (npm tells its scripts where it lives); null otherwise.
 *
 * ⚠ On Windows `npm` and `npx` are BATCH FILES, and an interrupted batch file
 * stops to ask "Terminate batch job (Y/N)?". With nobody to answer — a tool, a
 * background run — that shell waits for ever, this script waits on it, and the
 * copy is never deleted (measured: Ctrl+C on `db:copy -- npm run side -- build`
 * left the copy and two processes behind). Running npm's JavaScript in this
 * same Node involves no batch file.
 */
function npmCli(name) {
  const cli = process.env.npm_execpath
  if (!cli || path.basename(cli) !== 'npm-cli.js') return null
  const file = name === 'npm' ? cli : path.join(path.dirname(cli), 'npx-cli.js')
  return fs.existsSync(file) ? file : null
}

const [command, ...rest] = argv
const cli = command === 'npm' || command === 'npx' ? npmCli(command) : null
let child
if (command === 'node') {
  // `node …` runs in this same Node, with no shell in between.
  child = spawn(process.execPath, rest, { stdio: 'inherit', env })
} else if (cli) {
  child = spawn(process.execPath, [cli, ...rest], { stdio: 'inherit', env })
} else {
  // Anything else (git, a tool on the PATH) is a command line the developer
  // typed, and goes to the shell that would have run it.
  child = spawn([command, ...rest].map(quoted).join(' '), { stdio: 'inherit', env, shell: true })
}

// Ctrl+C reaches the command as well; wait for it, then delete the copy.
process.on('SIGINT', () => {})
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => child.kill())
process.on('exit', cleanUp)

child.on('error', (e) => {
  say(`could not run "${command}" — ${e.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  cleanUp()
  process.exit(code ?? (signal ? 130 : 1))
})
