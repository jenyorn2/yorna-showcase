#!/usr/bin/env node
/**
 * CLEAN — remove what builds, test runs and measuring sessions leave behind.
 *
 *   npm run clean               # side builds, test reports, coverage, TypeScript build info
 *   npm run clean -- --dry      # list what would go; delete nothing
 *   npm run clean -- --cache    # also the main build's caches (.next/cache, .next/dev)
 *
 * WRITES: it deletes folders — but only output a command can make again. It
 * never touches `.next` itself (the build `npm start` serves), `node_modules`,
 * a database, `.env`, uploads, or any path git tracks (checked, not assumed).
 *
 * A side build that `npm run side -- start` is serving right now is skipped and
 * named, and so is one that is still being built. ⚠ A side server started by
 * hand (NEXT_DIST_DIR=… next start) cannot be seen from here — stop it first.
 *
 * Why it exists: every side build is about 1.1 GB and nothing removed them.
 * Twelve sat at the repository root in Nov 2026 — 13.4 GB, and twelve folders
 * above `src/` in the editor.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { heldLock, listening } from './side-locks.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SIDE_ROOT = '.next-side'
const MAIN_PORT = 3001

const OPTIONS = new Set(['--dry', '--cache'])
const flags = process.argv.slice(2)
for (const f of flags) {
  if (!OPTIONS.has(f)) {
    console.error(`clean: unknown option ${f}\n  npm run clean [-- --dry] [-- --cache]`)
    process.exit(2)
  }
}
const DRY = flags.includes('--dry')
const CACHE = flags.includes('--cache')

const abs = (rel) => path.join(REPO, rel)
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }

/** Bytes under a path. Links are not followed. */
function sizeOf(p) {
  let st
  try { st = fs.lstatSync(p) } catch { return 0 }
  if (!st.isDirectory()) return st.isFile() ? st.size : 0
  let total = 0
  for (const name of fs.readdirSync(p)) total += sizeOf(path.join(p, name))
  return total
}

function human(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${bytes > 0 ? Math.max(1, Math.round(bytes / 1024)) : 0} KB`
}

/** A folder `next build` wrote: the id it stamps, or the folders it always makes. */
const looksLikeNextBuild = (p) =>
  fs.existsSync(path.join(p, 'BUILD_ID')) || isDir(path.join(p, 'server')) || isDir(path.join(p, 'cache'))

/* ── 1 · what could go ─────────────────────────────────────────────────── */

/** @type {{ rel: string, what: string, keep?: string }[]} */
const targets = []

// A side build still being written: leave the whole folder alone. "Still" is
// a lock its owner keeps renewing, never a process id alone (side-locks.mjs).
const building = heldLock(abs(`${SIDE_ROOT}/.building`))
const buildRunning = Boolean(building)

for (const name of fs.readdirSync(REPO).sort()) {
  if (!name.startsWith('.next-') || !isDir(abs(name))) continue
  if (name === SIDE_ROOT) {
    for (const child of fs.readdirSync(abs(name)).sort()) {
      const rel = `${SIDE_ROOT}/${child}`
      if (!isDir(abs(rel))) continue
      const target = { rel, what: 'side build' }
      if (buildRunning) target.keep = `a side build is running (pid ${building.pid})`
      else {
        const lock = heldLock(abs(`${rel}/.serving.json`))
        if (lock && await listening(lock.port)) {
          target.keep = `serving on :${lock.port} (pid ${lock.pid}) — npm run side -- stop ${child}`
        }
      }
      targets.push(target)
    }
  } else {
    // Made by hand with NEXT_DIST_DIR=.next-<name>, before `npm run side` existed.
    const target = { rel: name, what: 'side build (loose)' }
    if (!looksLikeNextBuild(abs(name))) target.keep = 'does not look like a Next build — left alone'
    targets.push(target)
  }
}

for (const [rel, what] of [
  ['test-results', 'Playwright output'],
  ['playwright-report', 'Playwright report'],
  ['coverage', 'coverage report'],
]) {
  if (fs.existsSync(abs(rel))) targets.push({ rel, what })
}

for (const name of fs.readdirSync(REPO).sort()) {
  if (name.endsWith('.tsbuildinfo')) targets.push({ rel: name, what: 'TypeScript build info' })
}

if (CACHE) {
  // `next dev` writes into .next/dev while it runs, and `next start` keeps its
  // image and fetch caches in .next/cache. Not under a running server.
  const busy = await listening(MAIN_PORT)
  for (const [rel, what] of [['.next/cache', 'main build cache'], ['.next/dev', 'dev server output']]) {
    if (!fs.existsSync(abs(rel))) continue
    targets.push(busy ? { rel, what, keep: `something is listening on :${MAIN_PORT} — stop it first` } : { rel, what })
  }
}

/* ── 2 · never a path git tracks ───────────────────────────────────────── */

const candidates = targets.filter((t) => !t.keep)
if (candidates.length > 0) {
  let tracked = []
  try {
    tracked = execFileSync('git', ['ls-files', '--', ...candidates.map((t) => t.rel)], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter(Boolean)
  } catch { /* not a git checkout: nothing can be tracked */ }
  for (const t of candidates) {
    const hit = tracked.find((f) => f === t.rel || f.startsWith(`${t.rel}/`))
    if (hit) t.keep = `git tracks ${hit} — left alone`
  }
}

/* ── 3 · remove, and say what happened ─────────────────────────────────── */

if (targets.length === 0) {
  console.log(CACHE ? 'clean — nothing to remove.' : 'clean — nothing to remove. (--cache also clears the main build cache.)')
  process.exit(0)
}

const width = Math.max(...targets.map((t) => t.rel.length))
let freed = 0
let failed = 0

for (const t of targets) {
  const bytes = sizeOf(abs(t.rel))
  let verb
  if (t.keep) verb = 'kept    '
  else if (DRY) { verb = 'would go'; freed += bytes }
  else {
    try {
      fs.rmSync(abs(t.rel), { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
      verb = 'removed '
      freed += bytes
    } catch (e) {
      verb = 'FAILED  '
      t.keep = e.code === 'EBUSY' || e.code === 'EPERM' ? 'a running program has it open' : e.message
      failed += 1
    }
  }
  console.log(`  ${verb}  ${t.rel.padEnd(width)}  ${human(bytes).padStart(9)}  ${t.what}${t.keep ? `  ← ${t.keep}` : ''}`)
}

// The folder that held the side builds, once the last one has gone. A stale
// `.building` mark may go with it; `.restore.json` may not — it is what puts
// tsconfig.json back after an interrupted side build (scripts/side-build.mjs).
if (!DRY && isDir(abs(SIDE_ROOT)) && !buildRunning) {
  const left = fs.readdirSync(abs(SIDE_ROOT)).filter((n) => n !== '.building')
  if (left.length === 0) fs.rmSync(abs(SIDE_ROOT), { recursive: true, force: true })
}

console.log(DRY ? `clean — would free ${human(freed)}. Nothing was deleted (--dry).` : `clean — freed ${human(freed)}.`)
process.exit(failed > 0 ? 1 : 0)
