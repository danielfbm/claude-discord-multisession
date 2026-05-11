import { test, expect, describe } from 'bun:test'
import {
  RegisterMsg,
  ToolCallMsg,
  parseShimMsg,
  parseDaemonMsg,
} from '../src/protocol'

describe('protocol', () => {
  test('valid register parses', () => {
    const v = RegisterMsg.parse({ type: 'register', id: 1, session_id: 'abc', mode: 'dm', cwd: '/x' })
    expect(v.mode).toBe('dm')
  })

  test('register requires thread_id when mode=thread', () => {
    expect(() => RegisterMsg.parse({ type: 'register', id: 1, session_id: 'abc', mode: 'thread', cwd: '/x' })).toThrow()
  })

  test('thread mode allows literal "auto" or snowflake', () => {
    expect(RegisterMsg.parse({ type: 'register', id: 1, session_id: 'abc', mode: 'thread', cwd: '/x', thread_id: 'auto' })).toBeTruthy()
    expect(RegisterMsg.parse({ type: 'register', id: 1, session_id: 'abc', mode: 'thread', cwd: '/x', thread_id: '12345' })).toBeTruthy()
  })

  test('tool_call accepts known tool names', () => {
    for (const name of ['reply', 'react', 'edit_message', 'fetch_messages', 'download_attachment'] as const) {
      expect(ToolCallMsg.parse({ type: 'tool_call', id: 2, name, args: {} }).name).toBe(name)
    }
  })

  test('parseShimMsg dispatches on type', () => {
    const m = parseShimMsg({ type: 'ping', id: 3 })
    expect(m).toEqual({ type: 'ping', id: 3 })
  })

  test('parseShimMsg throws on unknown type', () => {
    expect(() => parseShimMsg({ type: 'bogus' })).toThrow()
  })

  test('parseDaemonMsg parses inbound', () => {
    const m = parseDaemonMsg({
      type: 'inbound', chat_id: 'c', message_id: 'm', user: 'u', user_id: 'uid', ts: '2026-01-01T00:00:00Z', content: 'hi',
    })
    expect(m.type).toBe('inbound')
  })

  test('parseDaemonMsg accepts every register_err code the daemon emits', () => {
    // Regression: when the daemon adds a new register_err code but the
    // protocol enum is not updated, the shim's parseDaemonMsg() rejects the
    // frame, the shim treats it as malformed, and the register request hangs
    // until the 30s timeout. Keep this list in sync with all err sites in
    // src/daemon.ts (grep "register_err" there).
    const codes = [
      'dm_session_taken',
      'thread_session_taken',
      'parent_channel_unset',
      'thread_not_allowed',
      'discord_unavailable',
      'bindings_save_failed',
      'bindings_load_failed',
    ]
    for (const code of codes) {
      const m = parseDaemonMsg({ type: 'register_err', id: 1, code, message: 'x' })
      expect(m).toMatchObject({ type: 'register_err', code })
    }
  })
})
