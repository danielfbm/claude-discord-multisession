import { test, expect, describe } from 'bun:test'
import { shouldSkipRegister } from '../src/shim'

describe('shouldSkipRegister (register-mode gate)', () => {
  // Truth table:
  //   registerMode missing/"always" → never skip, env doesn't matter.
  //   registerMode "marked-only" + neither env set → skip.
  //   registerMode "marked-only" + at least one env set → register.

  test('absent registerMode never skips (historical default)', () => {
    expect(shouldSkipRegister({}, {})).toBe(false)
    expect(shouldSkipRegister({}, { DISCORD_THREAD_ID: 'auto' })).toBe(false)
  })

  test('"always" mode never skips', () => {
    const a = { registerMode: 'always' } as const
    expect(shouldSkipRegister(a, {})).toBe(false)
    expect(shouldSkipRegister(a, { DISCORD_THREAD_ID: 'auto' })).toBe(false)
    expect(shouldSkipRegister(a, { DISCORD_THREAD_NAME: 'foo' })).toBe(false)
  })

  test('"marked-only" skips when neither thread env is set', () => {
    const a = { registerMode: 'marked-only' } as const
    expect(shouldSkipRegister(a, {})).toBe(true)
    expect(shouldSkipRegister(a, { DISCORD_THREAD_ID: undefined, DISCORD_THREAD_NAME: undefined })).toBe(true)
  })

  test('"marked-only" registers when DISCORD_THREAD_ID is set', () => {
    const a = { registerMode: 'marked-only' } as const
    expect(shouldSkipRegister(a, { DISCORD_THREAD_ID: 'auto' })).toBe(false)
    expect(shouldSkipRegister(a, { DISCORD_THREAD_ID: '1234567890' })).toBe(false)
  })

  test('"marked-only" registers when DISCORD_THREAD_NAME is set', () => {
    const a = { registerMode: 'marked-only' } as const
    expect(shouldSkipRegister(a, { DISCORD_THREAD_NAME: 'claude/foo' })).toBe(false)
  })

  test('"marked-only" registers when both thread envs are set', () => {
    const a = { registerMode: 'marked-only' } as const
    expect(shouldSkipRegister(a, {
      DISCORD_THREAD_ID: 'auto',
      DISCORD_THREAD_NAME: 'claude/foo',
    })).toBe(false)
  })

  test('empty-string env values count as absent (skip)', () => {
    // Shells typically don't export empty values, but if a wrapper sets
    // DISCORD_THREAD_ID="" the gate must treat it as "no marker" — otherwise
    // `unset DISCORD_THREAD_ID` and `export DISCORD_THREAD_ID=""` would
    // diverge in a confusing way.
    const a = { registerMode: 'marked-only' } as const
    expect(shouldSkipRegister(a, { DISCORD_THREAD_ID: '', DISCORD_THREAD_NAME: '' })).toBe(true)
  })
})
