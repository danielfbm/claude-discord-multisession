import { test, expect, describe } from 'bun:test'
import { registerWithRetry, isRetryableRegisterCode } from '../src/shim'

const noSleep = async () => {}

describe('isRetryableRegisterCode', () => {
  test('session-taken codes are retryable (race with takeover)', () => {
    expect(isRetryableRegisterCode('dm_session_taken')).toBe(true)
    expect(isRetryableRegisterCode('thread_session_taken')).toBe(true)
  })

  test('terminal config / data errors are NOT retryable', () => {
    expect(isRetryableRegisterCode('parent_channel_unset')).toBe(false)
    expect(isRetryableRegisterCode('thread_not_allowed')).toBe(false)
    expect(isRetryableRegisterCode('bindings_load_failed')).toBe(false)
    expect(isRetryableRegisterCode('bindings_save_failed')).toBe(false)
    expect(isRetryableRegisterCode(undefined)).toBe(false)
  })
})

describe('registerWithRetry', () => {
  test('retries a session_taken error, then returns the eventual ack', async () => {
    let n = 0
    const send = async () => {
      n++
      return n < 3
        ? { type: 'register_err' as const, code: 'thread_session_taken' }
        : { type: 'register_ack' as const, session_id: 's', thread_id: 't' }
    }
    const ack = await registerWithRetry(send, { retries: 5, delayMs: 1, sleep: noSleep })
    expect(ack.type).toBe('register_ack')
    expect(n).toBe(3)
  })

  test('does not retry a terminal error — returns it after one attempt', async () => {
    let n = 0
    const send = async () => {
      n++
      return { type: 'register_err' as const, code: 'parent_channel_unset' }
    }
    const ack = await registerWithRetry(send, { retries: 5, delayMs: 1, sleep: noSleep })
    expect(ack.type).toBe('register_err')
    expect(n).toBe(1)
  })

  test('gives up after exhausting retries on a persistent session_taken', async () => {
    let n = 0
    const send = async () => {
      n++
      return { type: 'register_err' as const, code: 'dm_session_taken' }
    }
    const ack = await registerWithRetry(send, { retries: 3, delayMs: 1, sleep: noSleep })
    expect(ack.type).toBe('register_err')
    expect(n).toBe(4) // initial attempt + 3 retries
  })

  test('succeeds on the first attempt without sleeping', async () => {
    let slept = 0
    let n = 0
    const send = async () => {
      n++
      return { type: 'register_ack' as const, session_id: 's' }
    }
    const ack = await registerWithRetry(send, { retries: 5, delayMs: 1, sleep: async () => { slept++ } })
    expect(ack.type).toBe('register_ack')
    expect(n).toBe(1)
    expect(slept).toBe(0)
  })
})
