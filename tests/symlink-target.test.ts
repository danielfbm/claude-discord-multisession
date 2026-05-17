import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveAtomicTarget } from '../src/symlink-target'

let dir: string

beforeEach(() => {
  // On macOS, /tmp is itself a symlink to /private/tmp; resolve it up front
  // so test-time path comparisons match what realpathSync returns inside the
  // helper. Otherwise an absolute readlink that points "into" the tmpdir
  // would compare as inequal even though it names the same on-disk path.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'symlink-target-test-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('resolveAtomicTarget', () => {
  test('returns the input path verbatim when nothing exists at it', () => {
    // First-time write into a fresh directory. realpathSync throws ENOENT,
    // lstat throws too, and we must fall back to the literal path so the
    // caller can create the file.
    const fresh = join(dir, 'absent.json')
    expect(resolveAtomicTarget(fresh)).toBe(fresh)
  })

  test('returns the realpath when the file already exists', () => {
    // Real file with no symlinks involved — realpathSync wins outright.
    const file = join(dir, 'plain.json')
    writeFileSync(file, '{}')
    expect(resolveAtomicTarget(file)).toBe(file)
  })

  test('follows a symlink to an existing target', () => {
    // The "happy path" symlink case the original patch already handled:
    // realpathSync resolves the link in one step and returns the target.
    const target = join(dir, 'real.json')
    writeFileSync(target, '{}')
    const link = join(dir, 'link.json')
    symlinkSync(target, link)
    expect(resolveAtomicTarget(link)).toBe(target)
  })

  test('preserves an absolute dangling symlink by recovering the link target', () => {
    // The regression this commit fixes: link in place, target not yet
    // created. realpathSync throws, so the helper must lstat + readlink
    // to recover the intended absolute path.
    const target = join(dir, 'not-yet.json')
    const link = join(dir, 'link.json')
    symlinkSync(target, link)
    expect(resolveAtomicTarget(link)).toBe(target)
  })

  test('resolves a relative dangling symlink against the symlink dir', () => {
    // POSIX: a relative symlink target is interpreted relative to the
    // directory holding the symlink, not the process cwd. Verify the helper
    // honors that so a dotfiles-style `ln -s sibling.json ./link.json`
    // resolves correctly even when the daemon's cwd is elsewhere.
    const subdir = join(dir, 'sub')
    rmSync(subdir, { recursive: true, force: true })
    // Recreate via mkdir indirectly through writeFileSync below
    writeFileSync(join(dir, 'placeholder'), '')
    const link = join(dir, 'link.json')
    // Use a relative target that does not exist yet.
    symlinkSync('./sibling.json', link)
    expect(resolveAtomicTarget(link)).toBe(join(dir, 'sibling.json'))
  })

  test('walks a chained dangling symlink down to its terminal target', () => {
    // The case the b19eb0f patch missed: a multi-hop dotfiles layout where
    // the entry-point link points at another link which points at the
    // not-yet-created host-specific file. Single-step readlink would
    // return the middle link and rename(2) would destroy it; the bounded
    // walk must follow the chain all the way to the missing terminal.
    const final = join(dir, 'host', 'access.json') // does not exist
    const middle = join(dir, 'current')            // symlink → final
    const entry = join(dir, 'access.json')         // symlink → middle
    symlinkSync(final, middle)
    symlinkSync(middle, entry)

    // Terminal — neither intermediate symlink — is what we expect back.
    expect(resolveAtomicTarget(entry)).toBe(final)
  })

  test('walks a deeply chained dangling symlink (5 hops)', () => {
    // Belt-and-braces: more than two hops just to make sure the loop
    // isn't accidentally writing "two steps" instead of "all steps".
    const terminal = join(dir, 'terminal.json') // does not exist
    let prev = terminal
    for (let i = 0; i < 5; i++) {
      const next = join(dir, `hop-${i}.json`)
      symlinkSync(prev, next)
      prev = next
    }
    // `prev` is now the entry-point symlink; resolving it must land on
    // the terminal path.
    expect(resolveAtomicTarget(prev)).toBe(terminal)
  })

  test('bails out without hanging on a symlink cycle', () => {
    // a -> b -> a. realpathSync throws ELOOP; the manual walk would spin
    // forever without the depth cap. Verify the cap fires and the
    // function returns *something* (the literal entry path is fine —
    // the user's link graph is already broken).
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    symlinkSync(b, a)
    symlinkSync(a, b)

    // Must complete in a bounded number of steps. Bun's test runner has
    // its own per-test timeout; if the cap leaks, this test will hang
    // rather than silently pass.
    const result = resolveAtomicTarget(a)
    // We don't pin the exact return value — only that it returned at all
    // and named one of the cycle members so callers see a plausible
    // path. Anything else would over-constrain the loop-bail policy.
    expect([a, b]).toContain(result)
  })
})
