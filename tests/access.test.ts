import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, symlinkSync, lstatSync, readlinkSync } from 'fs'
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

  test('registerMode is absent when not set (preserves "always" default)', () => {
    saveAccess(file, defaultAccess())
    expect(loadAccess(file).registerMode).toBeUndefined()
  })

  test('registerMode roundtrips both string values', () => {
    // Both values must survive a roundtrip — the shim's gate distinguishes
    // them strictly, so a silent value drop would invert the user's intent.
    for (const mode of ['always', 'marked-only'] as const) {
      const a: Access = { ...defaultAccess(), registerMode: mode }
      saveAccess(file, a)
      expect(loadAccess(file).registerMode).toBe(mode)
    }
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

  // Regression: ~/.claude/channels/discord/access.json is commonly symlinked
  // into a dotfiles repo for host-aware management. A naive atomic write
  // would rename(2) the tmp file over the symlink path, dereferencing the
  // link and orphaning the repo source. Verify the symlink survives saves
  // and the target file picks up the new content.
  test('preserves symlink at file path on save', () => {
    const target = join(dir, 'real-access.json')
    writeFileSync(target, JSON.stringify(defaultAccess()))
    const link = join(dir, 'access.json')
    symlinkSync(target, link)

    const updated: Access = { ...defaultAccess(), parentChannelId: '999' }
    saveAccess(link, updated)

    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(target)
    expect(loadAccess(target).parentChannelId).toBe('999')
  })

  // Initial-write edge case: dotfiles apply step may not have run yet when
  // the daemon first boots on a new machine. realpathSync would throw — we
  // must fall back to the literal path so the file is created normally.
  test('saveAccess still creates the file when path does not yet exist', () => {
    const fresh = join(dir, 'never-existed.json')
    saveAccess(fresh, defaultAccess())
    expect(statSync(fresh).isFile()).toBe(true)
  })

  // Regression (review of the first symlink-preserve patch): if the dotfiles
  // setup pre-creates the symlink before the daemon ever writes the target,
  // the very first save must materialize the target file instead of
  // overwriting the symlink with a regular file.
  test('preserves a dangling symlink and creates its target on first save', () => {
    const target = join(dir, 'real-access.json')
    const link = join(dir, 'access.json')
    symlinkSync(target, link)
    // Sanity: target really does not exist yet.
    expect(() => statSync(target)).toThrow()

    const a: Access = { ...defaultAccess(), parentChannelId: '777' }
    saveAccess(link, a)

    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(target)
    expect(statSync(target).isFile()).toBe(true)
    expect(loadAccess(target).parentChannelId).toBe('777')
  })

  // Regression (third reviewer pass): chained dangling layout where the
  // entry-point link goes through an intermediate "current" pointer to
  // the not-yet-created host file. The earlier single-step readlink path
  // would have rename(2)d over `current` and destroyed it.
  test('preserves a chained dangling symlink (link → link → file)', () => {
    const final = join(dir, 'host', 'access.json') // does not exist yet
    const middle = join(dir, 'current')             // symlink → final
    const entry = join(dir, 'access.json')          // symlink → middle
    symlinkSync(final, middle)
    symlinkSync(middle, entry)

    const a: Access = { ...defaultAccess(), parentChannelId: '888' }
    saveAccess(entry, a)

    // Both symlinks in the chain are intact.
    expect(lstatSync(entry).isSymbolicLink()).toBe(true)
    expect(lstatSync(middle).isSymbolicLink()).toBe(true)
    expect(readlinkSync(entry)).toBe(middle)
    expect(readlinkSync(middle)).toBe(final)
    // The terminal file got the new content.
    expect(statSync(final).isFile()).toBe(true)
    expect(loadAccess(final).parentChannelId).toBe('888')
  })
})
