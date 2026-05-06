import { test, expect, describe } from 'bun:test'
import { gate, type GateInput, type GateResult } from '../src/gate'
import { defaultAccess } from '../src/access'

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    senderId: 'user-1',
    isDM: true,
    channelId: 'chan-1',
    parentChannelId: undefined,
    content: '',
    isReplyToBot: false,
    hasBotMention: false,
    ...over,
  }
}

describe('gate', () => {
  test('disabled policy drops everything', () => {
    const access = defaultAccess()
    access.dmPolicy = 'disabled'
    expect(gate(input(), access).action).toBe('drop')
  })

  test('allowlisted DM sender delivers', () => {
    const access = defaultAccess()
    access.allowFrom = ['user-1']
    const r = gate(input(), access) as GateResult
    expect(r.action).toBe('deliver')
  })

  test('non-allowlisted DM in allowlist policy drops', () => {
    const access = defaultAccess()
    access.dmPolicy = 'allowlist'
    expect(gate(input(), access).action).toBe('drop')
  })

  test('pairing policy issues a code and stores pending', () => {
    const access = defaultAccess()
    const r = gate(input(), access)
    expect(r.action).toBe('pair')
    if (r.action !== 'pair') return
    expect(r.code).toMatch(/^[0-9a-f]{6}$/)
    expect(r.isResend).toBe(false)
    expect(Object.keys(access.pending)).toHaveLength(1)
  })

  test('pairing reissue is marked as resend after first', () => {
    const access = defaultAccess()
    gate(input(), access)
    const r = gate(input(), access)
    expect(r.action).toBe('pair')
    if (r.action === 'pair') expect(r.isResend).toBe(true)
  })

  test('pairing goes silent after replies cap', () => {
    const access = defaultAccess()
    gate(input(), access)
    gate(input(), access)
    expect(gate(input(), access).action).toBe('drop')
  })

  test('group message without mention is dropped when requireMention=true', () => {
    const access = defaultAccess()
    access.groups['chan-1'] = { requireMention: true, allowFrom: [] }
    const r = gate(input({ isDM: false }), access)
    expect(r.action).toBe('drop')
  })

  test('group message with mention delivers', () => {
    const access = defaultAccess()
    access.groups['chan-1'] = { requireMention: true, allowFrom: [] }
    const r = gate(input({ isDM: false, hasBotMention: true }), access)
    expect(r.action).toBe('deliver')
  })

  test('reply to bot in group counts as mention', () => {
    const access = defaultAccess()
    access.groups['chan-1'] = { requireMention: true, allowFrom: [] }
    const r = gate(input({ isDM: false, isReplyToBot: true }), access)
    expect(r.action).toBe('deliver')
  })

  test('thread message uses parent channel for group lookup', () => {
    const access = defaultAccess()
    access.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    const r = gate(input({ isDM: false, channelId: 'thread-1', parentChannelId: 'parent-1' }), access)
    expect(r.action).toBe('deliver')
  })

  test('group sender allowlist excludes other senders', () => {
    const access = defaultAccess()
    access.groups['chan-1'] = { requireMention: false, allowFrom: ['someone-else'] }
    const r = gate(input({ isDM: false }), access)
    expect(r.action).toBe('drop')
  })

  test('mention pattern regex triggers delivery', () => {
    const access = defaultAccess()
    access.groups['chan-1'] = { requireMention: true, allowFrom: [] }
    access.mentionPatterns = ['^hey claude\\b']
    const r = gate(input({ isDM: false, content: 'hey claude what time is it?' }), access)
    expect(r.action).toBe('deliver')
  })
})
