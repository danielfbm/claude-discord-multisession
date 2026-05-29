import { test, expect, describe } from 'bun:test'
import { realpathSync } from 'fs'
import { createHash } from 'crypto'
import {
  deriveSessionId,
  deriveSessionIdInfo,
  deriveShimIdentity,
  deriveThreadName,
  parseCwdRewriteRules,
  applyCwdRewrite,
  CWD_REWRITE_ENV,
} from '../src/session-id'

const sha12 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)

describe('session-id', () => {
  test('deriveSessionId is 12 lowercase hex chars', () => {
    const id = deriveSessionId('/tmp')
    expect(id).toMatch(/^[0-9a-f]{12}$/)
  })

  test('deriveSessionId is stable for the same realpath', () => {
    const a = deriveSessionId(realpathSync('/tmp'))
    const b = deriveSessionId(realpathSync('/tmp'))
    expect(a).toBe(b)
  })

  test('deriveSessionId differs for different paths', () => {
    expect(deriveSessionId('/tmp/a')).not.toBe(deriveSessionId('/tmp/b'))
  })

  // #2: session identity is keyed on the THREAD, not just the cwd, so the
  // same project can host multiple concurrent sessions.
  describe('deriveShimIdentity', () => {
    test('CLAUDE_SESSION_ID override wins verbatim, no migration hints', () => {
      const id = deriveShimIdentity({ cwd: '/repo/a', override: 'pinned-id', threadEnv: 'auto', ccToken: '999' })
      expect(id.sessionId).toBe('pinned-id')
      expect(id.rewriteApplied).toBe(false)
      expect(id.legacySessionId).toBeUndefined()
    })

    test('explicit thread_id keys identity on the thread, independent of cwd', () => {
      const a = deriveShimIdentity({ cwd: '/repo/a', threadEnv: '1502536668958162977' })
      const b = deriveShimIdentity({ cwd: '/repo/DIFFERENT', threadEnv: '1502536668958162977' })
      // Same explicit thread → same identity regardless of cwd → reconnect/takeover.
      expect(a.sessionId).toBe(b.sessionId)
      expect(a.sessionId).toBe(sha12('thread:1502536668958162977'))
      expect(a.rewriteApplied).toBe(false)
    })

    test('different explicit threads in the SAME cwd are distinct sessions', () => {
      const a = deriveShimIdentity({ cwd: '/repo/a', threadEnv: '111' })
      const b = deriveShimIdentity({ cwd: '/repo/a', threadEnv: '222' })
      expect(a.sessionId).not.toBe(b.sessionId)
    })

    test('auto identity is 12-hex, carries no migration hints, distinct from the cwd-only id', () => {
      const a = deriveShimIdentity({ cwd: '/tmp', threadEnv: 'auto', ccToken: '4321' })
      expect(a.sessionId).toMatch(/^[0-9a-f]{12}$/)
      expect(a.rewriteApplied).toBe(false)
      expect(a.legacySessionId).toBeUndefined()
      // Must not collide with the legacy DM identity for the same cwd,
      // otherwise an auto session and a DM session would fight for one slot.
      const dm = deriveShimIdentity({ cwd: '/tmp', ccToken: '4321' })
      expect(a.sessionId).not.toBe(dm.sessionId)
    })

    test('auto: same cwd + same CC token is stable (reuse across /clear)', () => {
      const a = deriveShimIdentity({ cwd: '/tmp', threadEnv: 'auto', ccToken: '4321' })
      const b = deriveShimIdentity({ cwd: '/tmp', threadEnv: 'auto', ccToken: '4321' })
      expect(a.sessionId).toBe(b.sessionId)
    })

    test('auto: same cwd, different CC token = different session (concurrent CC → own thread)', () => {
      const a = deriveShimIdentity({ cwd: '/tmp', threadEnv: 'auto', ccToken: '4321' })
      const b = deriveShimIdentity({ cwd: '/tmp', threadEnv: 'auto', ccToken: '9999' })
      expect(a.sessionId).not.toBe(b.sessionId)
    })

    test('DM (no thread env) keeps legacy cwd-based identity + migration hints', () => {
      const id = deriveShimIdentity({ cwd: '/tmp', ccToken: '4321' })
      const info = deriveSessionIdInfo('/tmp', {})
      expect(id.sessionId).toBe(info.sessionId)
      // Migration plumbing for CWD_REWRITE is preserved on the DM/legacy path.
      expect(id.legacySessionId).toBe(info.legacySessionId)
    })
  })

  test('deriveThreadName uses basename', () => {
    expect(deriveThreadName('/home/me/my-project', 'abcdef0123ab')).toBe('my-project')
  })

  test('deriveThreadName truncates basename to 90 chars', () => {
    const long = '/x/' + 'a'.repeat(200)
    const name = deriveThreadName(long, 'abcdef0123ab')
    expect(name.length).toBeLessThanOrEqual(90)
  })

  test('deriveThreadName falls back when basename empty', () => {
    expect(deriveThreadName('/', 'abcdef0123ab')).toBe('claude')
  })

  test('deriveThreadName honors override and sanitizes', () => {
    expect(deriveThreadName('/home/me/foo', 'abcdef0123ab', 'My Custom Thread')).toBe('My Custom Thread')
    expect(deriveThreadName('/home/me/foo', 'abcdef0123ab', '  bad,chars\n!  ')).toBe('badchars')
    expect(deriveThreadName('/home/me/foo', 'abcdef0123ab', 'claude/catalog-incubator')).toBe('claude/catalog-incubator')
  })

  test('deriveThreadName falls back to basename when override is blank after sanitization', () => {
    expect(deriveThreadName('/home/me/foo', 'abcdef0123ab', '!!!')).toBe('foo')
  })
})

describe('parseCwdRewriteRules', () => {
  test('returns [] for empty / undefined / null', () => {
    expect(parseCwdRewriteRules(undefined)).toEqual([])
    expect(parseCwdRewriteRules(null)).toEqual([])
    expect(parseCwdRewriteRules('')).toEqual([])
    expect(parseCwdRewriteRules('   ')).toEqual([])
  })

  test('parses a single rule', () => {
    expect(parseCwdRewriteRules('/a=/b')).toEqual([{ from: '/a', to: '/b' }])
  })

  test('parses multiple rules and sorts by from-length desc', () => {
    const rules = parseCwdRewriteRules('/a=/A,/aa/bb=/X')
    expect(rules).toEqual([
      { from: '/aa/bb', to: '/X' },
      { from: '/a', to: '/A' },
    ])
  })

  test('strips trailing slashes on both sides for boundary cleanliness', () => {
    expect(parseCwdRewriteRules('/a/=/b/')).toEqual([{ from: '/a', to: '/b' }])
  })

  test('skips malformed segments (no =, blank from) without throwing', () => {
    expect(parseCwdRewriteRules('garbage,=,/=/x,/from=/to')).toEqual([
      { from: '/from', to: '/to' },
    ])
  })

  test('allows empty `to` for stripping a prefix outright', () => {
    expect(parseCwdRewriteRules('/strip-me=')).toEqual([{ from: '/strip-me', to: '' }])
  })
})

describe('applyCwdRewrite', () => {
  const rules = parseCwdRewriteRules('/mnt/external/work=/home/u/work,/long/path=/L')

  test('returns input unchanged when no rules match', () => {
    expect(applyCwdRewrite('/elsewhere/foo', rules)).toBe('/elsewhere/foo')
  })

  test('replaces a matching prefix at a directory boundary', () => {
    expect(applyCwdRewrite('/mnt/external/work/foo/bar', rules))
      .toBe('/home/u/work/foo/bar')
  })

  test('does NOT substitute mid-component (boundary check)', () => {
    // `/long/path-suffix` shares chars with `/long/path` but is not a
    // descendant — the rewrite must not rewrite arbitrary substrings.
    expect(applyCwdRewrite('/long/path-suffix', rules)).toBe('/long/path-suffix')
  })

  test('exact match (no trailing chars) still rewrites', () => {
    expect(applyCwdRewrite('/long/path', rules)).toBe('/L')
  })

  test('longest prefix wins when multiple rules could match', () => {
    const r = parseCwdRewriteRules('/code=/SHORT,/code/team-a=/LONG')
    expect(applyCwdRewrite('/code/team-a/proj', r)).toBe('/LONG/proj')
    expect(applyCwdRewrite('/code/other/proj', r)).toBe('/SHORT/other/proj')
  })

  test('empty rules array is a no-op', () => {
    expect(applyCwdRewrite('/anything', [])).toBe('/anything')
  })

  // Boundary regression: rewriting to '/' must NOT produce '//proj'. The
  // canonical descendant of a rewrite-to-root rule is just the suffix, so
  // sha1(canonical) matches what a machine without the rewrite sees for
  // '/proj'. Anything else silently breaks cross-machine reuse.
  test('rewrite to "/" descendant returns single-slash path', () => {
    const r = parseCwdRewriteRules('/mnt/ssd=/')
    expect(applyCwdRewrite('/mnt/ssd/project', r)).toBe('/project')
    expect(applyCwdRewrite('/mnt/ssd/a/b/c', r)).toBe('/a/b/c')
  })

  test('rewrite to "/" exact match returns "/"', () => {
    const r = parseCwdRewriteRules('/mnt/ssd=/')
    expect(applyCwdRewrite('/mnt/ssd', r)).toBe('/')
  })
})

describe('deriveSessionIdInfo', () => {
  test('without rewrite env: sessionId == legacy, rewriteApplied=false', () => {
    const info = deriveSessionIdInfo('/tmp', {})
    expect(info.rewriteApplied).toBe(false)
    expect(info.sessionId).toBe(info.legacySessionId)
    // canonicalCwd equals realpath('/tmp') on this host.
    expect(info.canonicalCwd).toBe(realpathSync('/tmp'))
  })

  test('with rewrite env: sessionId differs from legacy, canonicalCwd reflects rewrite', () => {
    const real = realpathSync('/tmp')
    const env = { [CWD_REWRITE_ENV]: `${real}=/canonical/tmp` }
    const info = deriveSessionIdInfo('/tmp', env)
    expect(info.rewriteApplied).toBe(true)
    expect(info.canonicalCwd).toBe('/canonical/tmp')
    expect(info.sessionId).not.toBe(info.legacySessionId)
    // Hard contract: sessionId is sha1(canonical_cwd)[:12]. The docs and
    // scripts/derive-binding-key.sh both promise this so consumers can
    // verify a binding key without the rewrite env configured locally.
    const expectedHash = createHash('sha1').update('/canonical/tmp').digest('hex').slice(0, 12)
    expect(info.sessionId).toBe(expectedHash)
    // Sanity: deriveSessionId (which reads process.env) with no rewrite
    // configured equals the legacy hash, since there's no rule to apply.
    expect(deriveSessionId('/tmp')).toBe(info.legacySessionId)
  })

  test('rewrite that does not match leaves sessionId == legacy', () => {
    const env = { [CWD_REWRITE_ENV]: '/nope=/x' }
    const info = deriveSessionIdInfo('/tmp', env)
    expect(info.rewriteApplied).toBe(false)
    expect(info.sessionId).toBe(info.legacySessionId)
  })
})
