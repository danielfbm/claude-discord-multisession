import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { dirname } from 'path'

export type BindingEntry = {
  thread_id: string
  cwd: string
  created_at: number
  last_seen_at: number
}

export type Bindings = Record<string, BindingEntry>

export function loadBindings(file: string): Bindings {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Bindings
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
    return {}
  }
}

// Per-target serialization queue. Concurrent upsertBinding() calls for the
// same file are chained so each "load → merge → write" sequence runs without
// interleaving. The queue lives in-process; the daemon is the only writer in
// practice, but external manual edits to the file are preserved because every
// upsert re-reads the file inside the queued critical section instead of
// overwriting with a stale in-memory snapshot.
const writeQueues = new Map<string, Promise<void>>()
let tmpCounter = 0

function nextTmp(file: string): string {
  // Unique tmp name per attempt — guards against any accidental overlap and
  // makes leftover tmp files traceable.
  tmpCounter = (tmpCounter + 1) >>> 0
  return `${file}.tmp.${process.pid}.${Date.now()}.${tmpCounter}`
}

function writeAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = nextTmp(file)
  try {
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    // Best-effort cleanup so a failed write does not leave stray tmp files.
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

function enqueue(file: string, work: () => void): Promise<void> {
  const prev = writeQueues.get(file) ?? Promise.resolve()
  // Swallow upstream errors so one failed write does not poison the chain for
  // unrelated subsequent callers; each caller still sees its own write's
  // success/failure via the returned promise.
  const next = prev.catch(() => {}).then(work)
  writeQueues.set(file, next)
  next.finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file)
  }).catch(() => {})
  return next
}

/**
 * Upsert a single binding entry, preserving everything else on disk.
 *
 * Implementation: inside a per-file serialized critical section, re-read the
 * current file from disk, merge the new entry, then atomic-write the result.
 * This fixes the prior lost-update race (N parallel register handlers each
 * holding their own stale in-memory snapshot and overwriting each other) AND
 * preserves any external manual edits to bindings.json — the daemon never
 * stomps entries it did not author.
 */
export function upsertBinding(file: string, sessionId: string, entry: BindingEntry): Promise<void> {
  // Snapshot `entry` at call time. The write executes later in a queued
  // microtask, so any caller-side mutation between this call and the actual
  // write would otherwise leak into the persisted state. BindingEntry is
  // flat (only primitives), so a shallow copy is sufficient. This mirrors
  // saveBindings()'s call-time JSON.stringify snapshot.
  const snapshot: BindingEntry = { ...entry }
  return enqueue(file, () => {
    const current = loadBindings(file)
    current[sessionId] = snapshot
    writeAtomic(file, JSON.stringify(current, null, 2) + '\n')
  })
}

/**
 * Whole-state write. Kept for tests and tooling that legitimately want to
 * replace the entire file (e.g. fixtures, migrations). Production daemon code
 * paths should prefer `upsertBinding` so they do not clobber external edits.
 *
 * Compatibility contract: the file write completes BEFORE this function
 * returns. The signature is `Promise<void>` only so callers that `await` it
 * keep type-checking; the returned promise is already settled when handed
 * out. Earlier versions of this function were strictly synchronous, and
 * callers (including any out-of-tree tooling) that do not `await` it must
 * still see the file on disk immediately after the call returns.
 *
 * saveBindings deliberately bypasses the upsertBinding write queue: it is a
 * full-state replace and is allowed to clobber anything, including pending
 * queued upserts. Subsequent upserts re-read disk inside their own critical
 * section, so they still produce a sane merge result on top of whatever
 * saveBindings wrote.
 */
export function saveBindings(file: string, b: Bindings): Promise<void> {
  // JSON.stringify runs synchronously, capturing the value of `b` at call
  // time; subsequent mutations cannot affect the persisted bytes.
  writeAtomic(file, JSON.stringify(b, null, 2) + '\n')
  return Promise.resolve()
}
