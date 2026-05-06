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

  test('deriveThreadName uses basename + short id', () => {
    expect(deriveThreadName('/home/me/my-project', 'abcdef0123ab')).toBe('my-project-abcdef')
  })

  test('deriveThreadName truncates basename to 80 chars', () => {
    const long = '/x/' + 'a'.repeat(200)
    const name = deriveThreadName(long, 'abcdef0123ab')
    expect(name.length).toBeLessThanOrEqual(100)
    expect(name.endsWith('-abcdef')).toBe(true)
  })

  test('deriveThreadName falls back when basename empty', () => {
    expect(deriveThreadName('/', 'abcdef0123ab')).toBe('claude-abcdef')
  })
})
