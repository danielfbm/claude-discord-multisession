import { test, expect, describe } from 'bun:test'
import { realpathSync } from 'fs'
import { deriveSessionId, deriveThreadName } from '../src/session-id'

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
