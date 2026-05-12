import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadBindings,
  saveBindings,
  upsertBinding,
  migrateBindingKey,
  type Bindings,
} from '../src/bindings'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bindings-test-'))
  file = join(dir, 'bindings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('bindings', () => {
  test('load returns empty when file absent', () => {
    expect(loadBindings(file)).toEqual({})
  })

  test('roundtrips entries', async () => {
    const b: Bindings = {
      sess1: { thread_id: 't1', cwd: '/a', created_at: 100, last_seen_at: 200 },
      sess2: { thread_id: 't2', cwd: '/b', created_at: 300, last_seen_at: 400 },
    }
    await saveBindings(file, b)
    expect(loadBindings(file)).toEqual(b)
  })

  test('save chmods 0600', async () => {
    await saveBindings(file, {})
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('corrupt file returns empty and renames aside', () => {
    writeFileSync(file, '{not json')
    expect(loadBindings(file)).toEqual({})
    const corrupt = readdirSync(dir).filter(f => f.startsWith('bindings.json.corrupt-'))
    expect(corrupt).toHaveLength(1)
  })

  // Regression: 5 parallel saves each adding their own entry to the same
  // shared object must not lose any entry on disk. This is the exact pattern
  // the daemon uses when N shims register simultaneously.
  test('concurrent saves on shared object do not lose entries', async () => {
    const shared: Bindings = {}
    const writes: Promise<void>[] = []
    for (let i = 0; i < 10; i++) {
      const sid = `sess-${i}`
      shared[sid] = {
        thread_id: `t-${i}`,
        cwd: `/cwd-${i}`,
        created_at: 1000 + i,
        last_seen_at: 2000 + i,
      }
      writes.push(saveBindings(file, shared))
    }
    await Promise.all(writes)
    const onDisk = loadBindings(file)
    expect(Object.keys(onDisk).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `sess-${i}`).sort(),
    )
    for (let i = 0; i < 10; i++) {
      expect(onDisk[`sess-${i}`].thread_id).toBe(`t-${i}`)
    }
    // No leftover tmp files.
    const stray = readdirSync(dir).filter(f => f.includes('.tmp.'))
    expect(stray).toEqual([])
  })

  // Compatibility contract: the file write completes before saveBindings
  // returns. A prior revision queued the write through the upsertBinding
  // mutex, which broke this contract — callers that did not `await` saw an
  // empty/missing file on the next read. Lock the historical sync semantic.
  test('saveBindings writes synchronously; file visible without await', () => {
    const entry = { thread_id: 't1', cwd: '/a', created_at: 1, last_seen_at: 2 }
    // Intentionally NOT awaiting: the returned promise is allowed to exist
    // (to keep `await` callers compiling), but the write must have already
    // happened by the time control returns here.
    const p = saveBindings(file, { s1: entry })
    expect(p).toBeInstanceOf(Promise)
    expect(existsSync(file)).toBe(true)
    expect(loadBindings(file)).toEqual({ s1: entry })
  })

  // Snapshot-on-call: mutating the bindings object AFTER saveBindings returns
  // must not change what was written. With sync writes this is automatic
  // (JSON.stringify ran inside the call), but the test pins the semantic so
  // a future refactor cannot regress it.
  test('save snapshots payload at call time', async () => {
    const b: Bindings = {
      a: { thread_id: 'ta', cwd: '/a', created_at: 1, last_seen_at: 2 },
    }
    const p = saveBindings(file, b)
    // Mutate after scheduling — must not appear in the persisted file.
    b.b = { thread_id: 'tb', cwd: '/b', created_at: 3, last_seen_at: 4 }
    await p
    const onDisk = loadBindings(file)
    expect(onDisk).toEqual({
      a: { thread_id: 'ta', cwd: '/a', created_at: 1, last_seen_at: 2 },
    })
  })

  describe('upsertBinding', () => {
    // The exact daemon scenario: N parallel register handlers, each adding a
    // distinct session. With delta-merge upsert, every entry must survive.
    test('10 concurrent upserts all land on disk', async () => {
      const writes: Promise<void>[] = []
      for (let i = 0; i < 10; i++) {
        writes.push(upsertBinding(file, `sess-${i}`, {
          thread_id: `t-${i}`,
          cwd: `/cwd-${i}`,
          created_at: 1000 + i,
          last_seen_at: 2000 + i,
        }))
      }
      await Promise.all(writes)
      const onDisk = loadBindings(file)
      expect(Object.keys(onDisk).sort()).toEqual(
        Array.from({ length: 10 }, (_, i) => `sess-${i}`).sort(),
      )
    })

    // External edits made to bindings.json while the daemon is running must
    // not be clobbered by a subsequent upsert. This is the property the prior
    // "shared in-memory bindings" fix violated.
    test('preserves external manual edits to other entries', async () => {
      // Pre-existing entry written by some external actor.
      await saveBindings(file, {
        manual: { thread_id: 't-manual', cwd: '/m', created_at: 1, last_seen_at: 2 },
      })
      await upsertBinding(file, 'auto', {
        thread_id: 't-auto', cwd: '/a', created_at: 10, last_seen_at: 20,
      })
      const onDisk = loadBindings(file)
      expect(onDisk).toEqual({
        manual: { thread_id: 't-manual', cwd: '/m', created_at: 1, last_seen_at: 2 },
        auto: { thread_id: 't-auto', cwd: '/a', created_at: 10, last_seen_at: 20 },
      })
    })

    // Regression: upsertBinding used to capture `entry` by reference into the
    // queued microtask, so caller-side mutations between call and execution
    // leaked onto disk. Snapshot semantics must match saveBindings.
    test('snapshots entry at call time', async () => {
      const entry = {
        thread_id: 't-original', cwd: '/o', created_at: 1, last_seen_at: 2,
      }
      const p = upsertBinding(file, 'sid', entry)
      // Mutate after scheduling — must not appear in the persisted file.
      entry.thread_id = 't-mutated'
      entry.last_seen_at = 99
      await p
      const onDisk = loadBindings(file)
      expect(onDisk.sid).toEqual({
        thread_id: 't-original', cwd: '/o', created_at: 1, last_seen_at: 2,
      })
    })

    // Even when an external edit lands between two queued upserts, the second
    // upsert re-reads inside its critical section and merges on top of the
    // latest disk state.
    test('migrateBindingKey renames legacy entry and merges patch', async () => {
      // Seed a legacy-style entry (no canonical_cwd).
      await upsertBinding(file, 'legacy-key', {
        thread_id: 't-old', cwd: '/old/path', created_at: 100, last_seen_at: 200,
      })
      await migrateBindingKey(file, 'legacy-key', 'new-key', {
        canonical_cwd: '/canonical/path',
        cwd: '/new/path',
        last_seen_at: 999,
      })
      const onDisk = loadBindings(file)
      expect(onDisk['legacy-key']).toBeUndefined()
      expect(onDisk['new-key']).toEqual({
        thread_id: 't-old',
        cwd: '/new/path',
        canonical_cwd: '/canonical/path',
        created_at: 100, // preserved
        last_seen_at: 999, // overridden by patch
      })
    })

    test('migrateBindingKey is a no-op when legacy key absent', async () => {
      await upsertBinding(file, 'unrelated', {
        thread_id: 't', cwd: '/u', created_at: 1, last_seen_at: 2,
      })
      await migrateBindingKey(file, 'never-existed', 'new-key', {})
      expect(loadBindings(file)).toEqual({
        unrelated: { thread_id: 't', cwd: '/u', created_at: 1, last_seen_at: 2 },
      })
    })

    test('migrateBindingKey drops legacy when new key already exists', async () => {
      // The "both exist" case: trust the new key as authoritative and just
      // garbage-collect the stale legacy entry so it doesn't shadow forever.
      await saveBindings(file, {
        legacy: { thread_id: 't-leg', cwd: '/l', created_at: 1, last_seen_at: 2 },
        canon: { thread_id: 't-can', cwd: '/c', created_at: 3, last_seen_at: 4, canonical_cwd: '/c' },
      })
      await migrateBindingKey(file, 'legacy', 'canon', { last_seen_at: 999 })
      const onDisk = loadBindings(file)
      expect(onDisk.legacy).toBeUndefined()
      // canon is untouched — the patch is only meant for fresh migrations.
      expect(onDisk.canon).toEqual({
        thread_id: 't-can', cwd: '/c', created_at: 3, last_seen_at: 4, canonical_cwd: '/c',
      })
    })

    test('mid-flight external edit between upserts is preserved', async () => {
      await upsertBinding(file, 'first', {
        thread_id: 't1', cwd: '/1', created_at: 1, last_seen_at: 2,
      })
      // User edits the file by hand between two daemon writes.
      const bag = loadBindings(file)
      bag.external = { thread_id: 't-ext', cwd: '/x', created_at: 99, last_seen_at: 100 }
      await saveBindings(file, bag)
      // Next daemon-side upsert must not wipe `external`.
      await upsertBinding(file, 'second', {
        thread_id: 't2', cwd: '/2', created_at: 3, last_seen_at: 4,
      })
      const onDisk = loadBindings(file)
      expect(Object.keys(onDisk).sort()).toEqual(['external', 'first', 'second'])
      expect(onDisk.external.thread_id).toBe('t-ext')
    })
  })
})
