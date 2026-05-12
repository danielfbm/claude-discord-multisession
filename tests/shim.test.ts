import { test, expect, describe } from 'bun:test'
import { deriveRegisterFields } from '../src/shim'

describe('deriveRegisterFields', () => {
  test('unset DISCORD_THREAD_ID → DM mode, no thread_id', () => {
    expect(deriveRegisterFields({})).toEqual({ mode: 'dm' })
  })

  test('empty DISCORD_THREAD_ID → DM mode', () => {
    expect(deriveRegisterFields({ DISCORD_THREAD_ID: '' })).toEqual({ mode: 'dm' })
  })

  test('whitespace-only DISCORD_THREAD_ID → DM mode', () => {
    expect(deriveRegisterFields({ DISCORD_THREAD_ID: '   ' })).toEqual({ mode: 'dm' })
    expect(deriveRegisterFields({ DISCORD_THREAD_ID: '\t\n' })).toEqual({ mode: 'dm' })
  })

  test("DISCORD_THREAD_ID='auto' → thread mode with thread_id='auto'", () => {
    expect(deriveRegisterFields({ DISCORD_THREAD_ID: 'auto' })).toEqual({
      mode: 'thread',
      thread_id: 'auto',
    })
  })

  test('DISCORD_THREAD_ID=<snowflake> → thread mode with that snowflake', () => {
    expect(deriveRegisterFields({ DISCORD_THREAD_ID: '1502195236900966400' })).toEqual({
      mode: 'thread',
      thread_id: '1502195236900966400',
    })
  })

  test('DISCORD_THREAD_ID is trimmed before being sent', () => {
    expect(deriveRegisterFields({ DISCORD_THREAD_ID: '  auto  ' })).toEqual({
      mode: 'thread',
      thread_id: 'auto',
    })
  })

  test('DISCORD_THREAD_NAME alone (no THREAD_ID) → still DM mode, thread_name dropped', () => {
    expect(deriveRegisterFields({ DISCORD_THREAD_NAME: 'Sprint 42' })).toEqual({ mode: 'dm' })
  })

  test('thread mode forwards DISCORD_THREAD_NAME (trimmed)', () => {
    expect(deriveRegisterFields({
      DISCORD_THREAD_ID: 'auto',
      DISCORD_THREAD_NAME: '  Sprint 42  ',
    })).toEqual({
      mode: 'thread',
      thread_id: 'auto',
      thread_name: 'Sprint 42',
    })
  })

  test('thread mode with whitespace-only DISCORD_THREAD_NAME drops the field', () => {
    expect(deriveRegisterFields({
      DISCORD_THREAD_ID: 'auto',
      DISCORD_THREAD_NAME: '   ',
    })).toEqual({
      mode: 'thread',
      thread_id: 'auto',
    })
  })
})
