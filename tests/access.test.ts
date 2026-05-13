import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  defaultAccess,
  loadAccess,
  saveAccess,
  pruneExpired,
  type Access,
} from '../src/access'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'access-test-'))
  file = join(dir, 'access.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('access', () => {
  test('defaultAccess returns pairing policy with empty lists', () => {
    expect(defaultAccess()).toEqual({
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: {},
      pending: {},
    })
  })

  test('loadAccess returns default when file missing', () => {
    expect(loadAccess(file)).toEqual(defaultAccess())
  })

  test('roundtrips a populated access object', () => {
    const a: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['111'],
      groups: { '222': { requireMention: false, allowFrom: ['333'] } },
      pending: {},
      ackReaction: '👀',
      parentChannelId: '444',
      reactionGuidance: false,
    }
    saveAccess(file, a)
    expect(loadAccess(file)).toEqual(a)
  })

  test('reactionGuidance survives an explicit-true roundtrip', () => {
    // Explicit `true` is semantically distinct from "field absent":
    // both render identically at runtime today, but a future change
    // that flips the default would diverge. Pin the value preservation.
    const a = { ...defaultAccess(), reactionGuidance: true }
    saveAccess(file, a)
    expect(loadAccess(file).reactionGuidance).toBe(true)
  })

  test('reactionGuidance is absent when not set', () => {
    saveAccess(file, defaultAccess())
    expect(loadAccess(file).reactionGuidance).toBeUndefined()
  })

  test('saveAccess writes atomically and chmods 0600', () => {
    saveAccess(file, defaultAccess())
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('pruneExpired removes only expired pending entries', () => {
    const a = defaultAccess()
    const now = Date.now()
    a.pending = {
      old: { senderId: 's1', chatId: 'c1', createdAt: now - 1e7, expiresAt: now - 1e6, replies: 1 },
      new: { senderId: 's2', chatId: 'c2', createdAt: now, expiresAt: now + 1e6, replies: 1 },
    }
    expect(pruneExpired(a)).toBe(true)
    expect(Object.keys(a.pending)).toEqual(['new'])
  })

  test('corrupt file is renamed aside and default returned', () => {
    writeFileSync(file, '{not json')
    const a = loadAccess(file)
    expect(a).toEqual(defaultAccess())
    const corruptFiles = readdirSync(dir).filter(f => f.startsWith('access.json.corrupt-'))
    expect(corruptFiles).toHaveLength(1)
  })
})
