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
})
