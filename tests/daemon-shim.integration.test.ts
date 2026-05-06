import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
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
