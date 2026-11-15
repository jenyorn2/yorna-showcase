/**
 * SIDE-BUILD LOCKS — who is using a side build right now. Shared by
 * scripts/side-build.mjs (which writes the locks) and scripts/clean.mjs (which
 * must not delete what is in use). Not a command: nothing runs it directly.
 *
 *   .next-side/.building              a side build is being written
 *   .next-side/<name>/.serving.json   `npm run side -- start` is serving it
 *
 * ⚠ A PROCESS ID ALONE DOES NOT SAY WHO OWNS A LOCK. Windows hands a dead
 * process's number to the next process that starts. After a crash, a power cut
 * or a restart, "pid 8168 is alive" is true of a stranger: `build` would refuse
 * for as long as that stranger lives, `clean` would keep every side build, and
 * `stop` would stop somebody else's program.
 *
 * ⭐ So the owner also RENEWS its lock — the file's modified time, every few
 * seconds — and a lock nobody renews does not count. A stranger that was
 * handed the same number cannot renew it. The content is written once and
 * never rewritten, so a reader cannot catch the file half-written.
 */
import fs from 'node:fs'
import net from 'node:net'

/** How often an owner renews its lock, and how long an unrenewed one still counts. */
const RENEW_MS = 5_000
const STALE_MS = 60_000

export const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

/** True when the process exists (signal 0 only asks). */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** True when something accepts a connection on this machine's port. */
export function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = (answer) => { socket.destroy(); resolve(answer) }
    socket.setTimeout(500, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * Write a lock and keep renewing it while this process lives. Returns the
 * function that lets go: it stops renewing and removes the file.
 */
export function hold(file, data) {
  fs.writeFileSync(file, JSON.stringify(data))
  const timer = setInterval(() => {
    const now = new Date()
    try { fs.utimesSync(file, now, now) } catch { /* the folder went first */ }
  }, RENEW_MS)
  timer.unref()
  return () => {
    clearInterval(timer)
    try { fs.rmSync(file, { force: true }) } catch { /* the folder went first */ }
  }
}

/** The lock at this path — only while its owner is alive and still renewing it. */
export function heldLock(file) {
  const lock = readJson(file)
  if (!lock || !alive(lock.pid)) return null
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > STALE_MS) return null
  } catch {
    return null
  }
  return lock
}
