import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createConnection, type Socket } from 'net'
import { startDaemon, type DaemonHandle } from '../src/daemon'
import { FakeDiscordOps } from '../src/discord-ops'
import { writeFrame, readFrames } from '../src/framing'

let dir: string
let daemon: DaemonHandle | null = null
const liveSockets: Socket[] = []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'discord-daemon-')) })
afterEach(async () => {
  for (const s of liveSockets) { try { s.destroy() } catch {} }
  liveSockets.length = 0
  if (daemon) { await daemon.shutdown(); daemon = null }
  rmSync(dir, { recursive: true, force: true })
})

async function connect(sockPath: string): Promise<Socket> {
  const sock = await new Promise<Socket>((res, rej) => {
    const s = createConnection(sockPath)
    s.once('connect', () => res(s))
    s.once('error', rej)
  })
  liveSockets.push(sock)
  return sock
}

/**
 * Open a long-lived iterator over a socket. Caller must `frames.return()`
 * (or destroy the socket) when done. Pulling one frame via .next() does NOT
 * terminate the iterator (whereas `for await ... break` does in Bun).
 */
function frameIterator(sock: Socket) {
  return readFrames(sock)[Symbol.asyncIterator]() as AsyncIterator<unknown>
}

async function recv(it: AsyncIterator<unknown>): Promise<any> {
  const { value, done } = await it.next()
  if (done) throw new Error('iterator ended unexpectedly')
  return value
}

describe('daemon: socket', () => {
  test('binds the socket file and accepts connections', async () => {
    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'ping', id: 1 })
    const pong = await recv(it)
    expect(pong).toEqual({ type: 'pong', id: 1 })
  })

  test('second startDaemon on same dir errors', async () => {
    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    let threw = false
    try {
      await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    } catch { threw = true }
    expect(threw).toBe(true)
  })

  test('shutdown invokes onShutdown after unlinking sock/pid', async () => {
    let onShutdownCalled = false
    let sockPathAtCallback = true
    let pidPathAtCallback = true
    const sockPath = join(dir, 'daemon.sock')
    const pidPath = join(dir, 'daemon.pid')

    const d = await startDaemon({
      stateDir: dir,
      ops: new FakeDiscordOps(),
      idleExitMs: 60_000,
      onShutdown: () => {
        onShutdownCalled = true
        sockPathAtCallback = existsSync(sockPath)
        pidPathAtCallback = existsSync(pidPath)
      },
    })
    expect(existsSync(sockPath)).toBe(true)
    expect(existsSync(pidPath)).toBe(true)

    await d.shutdown()
    // Don't let afterEach call shutdown again.
    daemon = null

    expect(onShutdownCalled).toBe(true)
    expect(sockPathAtCallback).toBe(false)
    expect(pidPathAtCallback).toBe(false)
  })

  test('onShutdown errors are swallowed (do not throw from shutdown)', async () => {
    daemon = await startDaemon({
      stateDir: dir,
      ops: new FakeDiscordOps(),
      idleExitMs: 60_000,
      onShutdown: () => { throw new Error('boom') },
    })
    await daemon.shutdown()
    daemon = null
    // Reaching here means shutdown didn't reject.
  })
})

describe('daemon: register', () => {
  async function reg(sockPath: string, session_id: string, mode: 'dm' | 'thread', thread_id?: string) {
    const sock = await connect(sockPath)
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id, mode, cwd: '/x', thread_id })
    const ack = await recv(it)
    return { sock, it, ack }
  }

  test('DM register succeeds; second DM register errors', async () => {
    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    const sockPath = join(dir, 'daemon.sock')

    const a = await reg(sockPath, 's1', 'dm')
    expect(a.ack.type).toBe('register_ack')

    const b = await reg(sockPath, 's2', 'dm')
    expect(b.ack.type).toBe('register_err')
    expect(b.ack.code).toBe('dm_session_taken')
  })

  test('thread register with auto and parentChannelId set creates a thread', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: true, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 7, session_id: 'sess-thread', mode: 'thread', cwd: '/repo/cool-app', thread_id: 'auto' })
    const ack = await recv(it)
    expect(ack.type).toBe('register_ack')
    expect(ack.thread_id).toMatch(/^fake-thread-/)
    expect(ops.calls.find(c => c.kind === 'createThread')).toBeTruthy()
  })

  test('thread register with auto but no parentChannelId errors', async () => {
    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 's1', mode: 'thread', cwd: '/x', thread_id: 'auto' })
    const ack = await recv(it)
    expect(ack.type).toBe('register_err')
    expect(ack.code).toBe('parent_channel_unset')
  })

  test('reply tool_call forwards to ops.reply and returns tool_result', async () => {
    const ops = new FakeDiscordOps()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })

    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 's-tool', mode: 'dm', cwd: '/x' })
    const ack = await recv(it)
    expect(ack.type).toBe('register_ack')

    writeFrame(sock, { type: 'tool_call', id: 2, name: 'reply', args: { chat_id: 'dm-1', text: 'hi' } })
    const result = await recv(it)
    expect(result.type).toBe('tool_result')
    expect(result.id).toBe(2)
    expect(result.isError).toBeUndefined()
    expect(ops.calls.find(c => c.kind === 'reply')).toMatchObject({ chat_id: 'dm-1', text: 'hi' })
  })

  test('react tool_call returns success', async () => {
    const ops = new FakeDiscordOps()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 's-tool', mode: 'dm', cwd: '/x' })
    await recv(it)
    writeFrame(sock, { type: 'tool_call', id: 2, name: 'react', args: { chat_id: 'c', message_id: 'm', emoji: '👀' } })
    const result = await recv(it)
    expect(result.type).toBe('tool_result')
    expect(result.content[0].text).toBe('reacted')
  })

  test('inbound thread message routes to bound thread shim', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 'st', mode: 'thread', cwd: '/repo/x', thread_id: 'auto' })
    const ack = await recv(it)
    expect(ack.type).toBe('register_ack')
    const threadId = ack.thread_id

    daemon!.deliverInbound!({
      chat_id: threadId, message_id: 'm1', user: 'alice', user_id: 'u1',
      ts: '2026-01-01T00:00:00Z', content: 'hi', isDM: false, parentChannelId: 'parent-1',
      hasBotMention: false, isReplyToBot: false, attachments: [],
    })

    const inbound = await recv(it)
    expect(inbound.type).toBe('inbound')
    expect(inbound.chat_id).toBe(threadId)
    expect(inbound.content).toBe('hi')
  })

  test('inbound DM routes to dm-mode shim', async () => {
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.allowFrom = ['user-1']
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 's-dm', mode: 'dm', cwd: '/x' })
    await recv(it)

    daemon!.deliverInbound!({
      chat_id: 'dm-channel-1', message_id: 'm1', user: 'alice', user_id: 'user-1',
      ts: '2026-01-01T00:00:00Z', content: 'hi', isDM: true,
      hasBotMention: false, isReplyToBot: false, attachments: [],
    })

    const inbound = await recv(it)
    expect(inbound.type).toBe('inbound')
    expect(inbound.chat_id).toBe('dm-channel-1')
  })

  test('inbound unbound thread message is dropped', async () => {
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 's-dm', mode: 'dm', cwd: '/x' })
    await recv(it)

    daemon!.deliverInbound!({
      chat_id: 'unknown-thread', message_id: 'm1', user: 'alice', user_id: 'u1',
      ts: '2026-01-01T00:00:00Z', content: 'hi', isDM: false, parentChannelId: 'parent-1',
      hasBotMention: false, isReplyToBot: false, attachments: [],
    })

    // No inbound should arrive within 100ms.
    const got = await Promise.race([
      recv(it),
      new Promise(r => setTimeout(() => r(null), 100)),
    ])
    expect(got).toBeNull()
  })

  test('thread permission_request posts in bound thread', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 'sp', mode: 'thread', cwd: '/x', thread_id: 'auto' })
    const ack = await recv(it)
    const threadId = ack.thread_id

    writeFrame(sock, {
      type: 'permission_request', id: 2, request_id: 'abcde',
      tool_name: 'Bash', description: 'rm', input_preview: '{"cmd":"rm"}',
    })

    // Wait briefly for the permission post to happen.
    await new Promise(r => setTimeout(r, 30))
    const promptCall = ops.calls.find(c => c.kind === 'permPrompt')
    expect(promptCall).toMatchObject({ chat_id: threadId, request_id: 'abcde' })

    daemon!.permissionDecision!('abcde', 'allow')
    const decision = await recv(it)
    expect(decision.type).toBe('permission_decision')
    expect(decision.behavior).toBe('allow')
  })

  test('dm permission_request fans out to allowFrom DMs', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.allowFrom = ['user-1', 'user-2']
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 'sd', mode: 'dm', cwd: '/x' })
    await recv(it)
    writeFrame(sock, {
      type: 'permission_request', id: 2, request_id: 'aaaaa',
      tool_name: 'Bash', description: 'd', input_preview: '{}',
    })
    await new Promise(r => setTimeout(r, 30))
    const dmCall = ops.calls.find(c => c.kind === 'permPromptDM')
    expect(dmCall).toMatchObject({ allowFrom: ['user-1', 'user-2'], request_id: 'aaaaa' })
  })

  test('inbound DM in pairing policy issues code via reply', async () => {
    const ops = new FakeDiscordOps()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 'sd', mode: 'dm', cwd: '/x' })
    await recv(it)

    daemon!.deliverInbound!({
      chat_id: 'dm-1', message_id: 'm', user: 'bob', user_id: 'user-x',
      ts: '2026-01-01T00:00:00Z', content: 'hi', isDM: true,
      hasBotMention: false, isReplyToBot: false, attachments: [],
    })

    await new Promise(r => setTimeout(r, 30))
    const replyCall = ops.calls.find(c => c.kind === 'reply') as any
    expect(replyCall).toBeTruthy()
    expect(replyCall.text).toMatch(/Pairing required/)
    expect(replyCall.text).toMatch(/[0-9a-f]{6}/)
  })

  test('regression: DM-mode register never calls createThread', async () => {
    // Even with parentChannelId configured (so the daemon is *capable* of
    // creating a thread), a shim that registers as DM mode — i.e. did not
    // set DISCORD_THREAD_ID — must not trigger thread creation.
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: true, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 's-dm', mode: 'dm', cwd: '/x' })
    const ack = await recv(it)
    expect(ack.type).toBe('register_ack')
    expect(ack.thread_id).toBeNull()
    expect(ops.calls.filter(c => c.kind === 'createThread')).toHaveLength(0)
  })

  test('happy path: thread-mode auto register calls createThread exactly once', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: true, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, {
      type: 'register', id: 1, session_id: 's-thread',
      mode: 'thread', cwd: '/repo/x', thread_id: 'auto',
    })
    const ack = await recv(it)
    expect(ack.type).toBe('register_ack')
    expect(ack.thread_id).toMatch(/^fake-thread-/)
    expect(ops.calls.filter(c => c.kind === 'createThread')).toHaveLength(1)
  })

  test('thread register reuses existing binding for same session_id', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: true, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sockPath = join(dir, 'daemon.sock')

    // First register creates a thread, then we close the socket so the
    // daemon clears in-memory routes; bindings.json persists.
    {
      const sock = await connect(sockPath)
      const it = frameIterator(sock)
      writeFrame(sock, { type: 'register', id: 1, session_id: 'sess', mode: 'thread', cwd: '/x', thread_id: 'auto' })
      const ack = await recv(it)
      expect(ack.type).toBe('register_ack')
      sock.destroy()
      await new Promise(r => setTimeout(r, 50))
    }

    // Second register reuses the same thread.
    const sock2 = await connect(sockPath)
    const it2 = frameIterator(sock2)
    writeFrame(sock2, { type: 'register', id: 1, session_id: 'sess', mode: 'thread', cwd: '/x', thread_id: 'auto' })
    const ack2 = await recv(it2)
    expect(ack2.type).toBe('register_ack')
    expect(ops.calls.filter(c => c.kind === 'createThread')).toHaveLength(1)
  })
})
