import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
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
  // Restore writable mode in case a test chmod-ed the state dir read-only —
  // otherwise shutdown's sock/pid unlink and the rmSync below would EACCES.
  try { chmodSync(dir, 0o700) } catch {}
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

  // Regression: two concurrent thread-mode auto registers with the same
  // session_id used to both pass the `sessions.has()` check (it ran before
  // any await yielded), both await createThread, both upsert, both ack —
  // leaving two Discord threads and two ack frames for one logical session.
  // Fix reserves session_id synchronously after the check, so the second
  // call sees the placeholder and fails fast.
  test('concurrent same session_id auto register: exactly one ack, one err', async () => {
    // Wrap FakeDiscordOps so createThread yields long enough for both
    // handlers to reach the await without one finishing first.
    class SlowOps extends FakeDiscordOps {
      override async createThread(parent_channel_id: string, name: string) {
        await new Promise(r => setTimeout(r, 30))
        return super.createThread(parent_channel_id, name)
      }
    }
    const ops = new SlowOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sockPath = join(dir, 'daemon.sock')

    const launch = async () => {
      const sock = await connect(sockPath)
      const it = frameIterator(sock)
      writeFrame(sock, { type: 'register', id: 1, session_id: 'dup', mode: 'thread', cwd: '/x', thread_id: 'auto' })
      return recv(it)
    }
    const [a1, a2] = await Promise.all([launch(), launch()])
    const types = [a1.type, a2.type].sort()
    expect(types).toEqual(['register_ack', 'register_err'])
    const errFrame = a1.type === 'register_err' ? a1 : a2
    expect(errFrame.code).toBe('thread_session_taken')
    // Exactly one Discord thread should have been created.
    expect(ops.calls.filter(c => c.kind === 'createThread')).toHaveLength(1)
    // bindings.json has only the one successful registration.
    const { loadBindings } = await import('../src/bindings')
    const onDisk = loadBindings(join(dir, 'bindings.json'))
    expect(Object.keys(onDisk)).toEqual(['dup'])
  })

  // Regression: explicit-thread register used to call upsertBinding BEFORE
  // checking threadIndex.has(threadId). When a second session tried to bind
  // an already-bound thread, the daemon would reject with
  // `thread_session_taken` but still leave that session's binding on disk.
  // Fix moves the threadIndex check (and a synchronous reservation) ahead of
  // the upsert.
  test('explicit thread already taken: rejection leaves no binding on disk', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const acc = defaultAccess()
    acc.parentChannelId = 'parent-1'
    acc.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), acc)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sockPath = join(dir, 'daemon.sock')

    // First, create a thread via auto so we have a real, opted-in thread id.
    const sock1 = await connect(sockPath)
    const it1 = frameIterator(sock1)
    writeFrame(sock1, { type: 'register', id: 1, session_id: 's1', mode: 'thread', cwd: '/x', thread_id: 'auto' })
    const ack1 = await recv(it1)
    expect(ack1.type).toBe('register_ack')
    const threadId: string = ack1.thread_id

    // Now try to register a second session against the same explicit thread.
    const sock2 = await connect(sockPath)
    const it2 = frameIterator(sock2)
    writeFrame(sock2, { type: 'register', id: 1, session_id: 's2', mode: 'thread', cwd: '/x', thread_id: threadId })
    const ack2 = await recv(it2)
    expect(ack2.type).toBe('register_err')
    expect(ack2.code).toBe('thread_session_taken')

    // Critical: s2 must NOT have left a binding on disk.
    const { loadBindings } = await import('../src/bindings')
    const onDisk = loadBindings(join(dir, 'bindings.json'))
    expect(Object.keys(onDisk).sort()).toEqual(['s1'])
    expect(onDisk.s1.thread_id).toBe(threadId)
  })

  // Regression: when upsertBinding throws (disk full, EACCES, etc.), the
  // daemon must emit `bindings_save_failed` AND roll back every reservation
  // it made — placeholder session entry, reserved threadIndex slot — so the
  // shim can retry the registration without colliding with a stale claim.
  test('bindings_save_failed: register fails cleanly and state is rolled back', async () => {
    // Slow down createThread so the test can chmod the state dir read-only
    // after register starts but before upsertBinding runs. With a stable
    // ordering we don't depend on any other implicit timing.
    class SlowOps extends FakeDiscordOps {
      override async createThread(parent_channel_id: string, name: string) {
        await new Promise(r => setTimeout(r, 50))
        return super.createThread(parent_channel_id, name)
      }
    }
    const ops = new SlowOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const acc = defaultAccess()
    acc.parentChannelId = 'parent-1'
    acc.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), acc)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sockPath = join(dir, 'daemon.sock')

    const sock = await connect(sockPath)
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 'sess', mode: 'thread', cwd: '/x', thread_id: 'auto' })

    // Make the state dir read-execute only after the register has been
    // dispatched. upsertBinding's writeFileSync(tmp, ...) will then EACCES
    // when the daemon reaches it, hitting the bindings_save_failed branch.
    await new Promise(r => setTimeout(r, 10))
    chmodSync(dir, 0o500)

    const ack = await recv(it)
    expect(ack.type).toBe('register_err')
    expect(ack.code).toBe('bindings_save_failed')

    // Restore write access so the rollback verification below can succeed,
    // and so afterEach can clean up.
    chmodSync(dir, 0o700)

    // Roll-back verification: a second register with the SAME session_id
    // must succeed end-to-end. If `sessions` still held the placeholder, it
    // would short-circuit with "this session_id is already registered". If
    // `threadIndex` still held the previously-reserved thread, the new
    // createThread would yield a fresh id but a stale claim would persist
    // (not directly observable through this socket, so we focus on the
    // session-level invariant first).
    sock.destroy()
    const sock2 = await connect(sockPath)
    const it2 = frameIterator(sock2)
    writeFrame(sock2, { type: 'register', id: 1, session_id: 'sess', mode: 'thread', cwd: '/x', thread_id: 'auto' })
    const ack2 = await recv(it2)
    expect(ack2.type).toBe('register_ack')
    expect(ack2.thread_id).toBeTruthy()

    // The first attempt's threadIndex reservation must have been released —
    // otherwise registering the second time would re-claim against a
    // dangling entry. We assert indirectly: the second attempt also lands
    // its binding cleanly on disk, with exactly one entry for `sess`.
    const { loadBindings } = await import('../src/bindings')
    const onDisk = loadBindings(join(dir, 'bindings.json'))
    expect(Object.keys(onDisk)).toEqual(['sess'])
    expect(onDisk.sess.thread_id).toBe(ack2.thread_id)
  })

  // Regression: a corrupt or unreadable bindings.json must not crash the
  // daemon message loop for every other shim. The offending register gets
  // bindings_load_failed; the daemon stays up and other connections work.
  test('bindings_load_failed: bad bindings.json fails one register, daemon stays up', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const acc = defaultAccess()
    acc.parentChannelId = 'parent-1'
    acc.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), acc)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sockPath = join(dir, 'daemon.sock')

    // Replace bindings.json with a directory so readFileSync throws EISDIR
    // (loadBindings can't auto-recover from this the way it does for
    // unparseable JSON — there's nothing to rename).
    mkdirSync(join(dir, 'bindings.json'))

    const sock = await connect(sockPath)
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 's1', mode: 'thread', cwd: '/x', thread_id: 'auto' })
    const ack = await recv(it)
    expect(ack.type).toBe('register_err')
    expect(ack.code).toBe('bindings_load_failed')

    // The daemon's message loop must still be alive: ping/pong should work
    // on this same connection. (Before the loadBindings try/catch, the
    // exception would have bubbled out of the loop and the daemon would
    // stop processing this connection entirely.)
    writeFrame(sock, { type: 'ping', id: 2 })
    const pong = await recv(it)
    expect(pong).toEqual({ type: 'pong', id: 2 })
  })

  // Migration: when CLAUDE_DISCORD_CWD_REWRITE is active on a new machine,
  // the shim re-keys the binding from sha1(realpath) to sha1(canonical_cwd).
  // The legacy entry must be renamed to the new key (preserving thread_id
  // and created_at), gain a canonical_cwd marker, and disappear under the
  // old key — all atomically before the auto-mode lookup reuses it.
  test('migrates legacy binding to new key when shim sends legacy_session_id', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    // Pre-seed a legacy (pre-rewrite) binding directly on disk.
    const { saveBindings, loadBindings } = await import('../src/bindings')
    await saveBindings(join(dir, 'bindings.json'), {
      'legacy-key-12': {
        thread_id: 'fake-thread-pre-existing',
        cwd: '/mnt/external/work/proj',
        created_at: 111,
        last_seen_at: 222,
      },
    })

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, {
      type: 'register', id: 1, session_id: 'new-key-canon',
      mode: 'thread', cwd: '/home/u/code/proj', thread_id: 'auto',
      legacy_session_id: 'legacy-key-12',
      canonical_cwd: '/home/u/code/proj',
    })
    const ack = await recv(it)
    expect(ack.type).toBe('register_ack')
    // Critical: the daemon must reuse the migrated thread, not create a new one.
    expect(ack.thread_id).toBe('fake-thread-pre-existing')
    expect(ops.calls.find(c => c.kind === 'createThread')).toBeFalsy()

    const onDisk = loadBindings(join(dir, 'bindings.json'))
    expect(onDisk['legacy-key-12']).toBeUndefined()
    expect(onDisk['new-key-canon']).toMatchObject({
      thread_id: 'fake-thread-pre-existing',
      cwd: '/home/u/code/proj',
      canonical_cwd: '/home/u/code/proj',
      created_at: 111, // preserved across migration
    })
    expect(onDisk['new-key-canon'].last_seen_at).toBeGreaterThan(222)
  })

  // Once an entry already has canonical_cwd, the daemon must NOT re-migrate
  // from a (now-stale) legacy_session_id hint. This guards against
  // accidentally clobbering a properly-keyed binding on a third-time
  // register where the shim happens to still report a legacy key.
  test('skips migration when target entry already has canonical_cwd', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    const { saveBindings, loadBindings } = await import('../src/bindings')
    await saveBindings(join(dir, 'bindings.json'), {
      'new-key': {
        thread_id: 'fake-thread-already-migrated',
        cwd: '/home/u/code/proj',
        canonical_cwd: '/home/u/code/proj',
        created_at: 111, last_seen_at: 222,
      },
      'stale-legacy': {
        thread_id: 'fake-thread-stale',
        cwd: '/old/realpath',
        created_at: 9, last_seen_at: 10,
      },
    })

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, {
      type: 'register', id: 1, session_id: 'new-key',
      mode: 'thread', cwd: '/home/u/code/proj', thread_id: 'auto',
      legacy_session_id: 'stale-legacy',
      canonical_cwd: '/home/u/code/proj',
    })
    const ack = await recv(it)
    expect(ack.type).toBe('register_ack')
    expect(ack.thread_id).toBe('fake-thread-already-migrated')

    // The stale legacy entry should remain untouched — we don't garbage-
    // collect entries that aren't ours to migrate. The user can clean
    // them up manually if needed.
    const onDisk = loadBindings(join(dir, 'bindings.json'))
    expect(onDisk['stale-legacy']).toBeDefined()
    expect(onDisk['stale-legacy'].thread_id).toBe('fake-thread-stale')
  })

  // Regression: when the legacy session is still live (its thread is held
  // in threadIndex by another connection), a second register with
  // legacy_session_id must fail AND leave bindings.json untouched. The
  // previous design committed the legacy→canonical rename before the
  // thread claim check, so a thread_session_taken failure here would
  // delete the legacy key from disk while no Discord-side migration had
  // actually happened — stranding the still-alive original session.
  test('does not mutate bindings.json when legacy thread is still claimed', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    // Pre-seed a legacy binding pointing to a stable thread_id we control.
    const { saveBindings, loadBindings } = await import('../src/bindings')
    await saveBindings(join(dir, 'bindings.json'), {
      'legacy-key': {
        thread_id: 'thread-still-claimed',
        cwd: '/old/path',
        created_at: 111, last_seen_at: 222,
      },
    })

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })

    // session1: register under the legacy key in auto mode. The daemon
    // reuses the seeded binding and claims `thread-still-claimed` in
    // threadIndex. The socket stays open so the claim persists when
    // session2 arrives below.
    const sock1 = await connect(join(dir, 'daemon.sock'))
    const it1 = frameIterator(sock1)
    writeFrame(sock1, {
      type: 'register', id: 1, session_id: 'legacy-key',
      mode: 'thread', cwd: '/old/path', thread_id: 'auto',
    })
    const ack1 = await recv(it1)
    expect(ack1.type).toBe('register_ack')
    expect(ack1.thread_id).toBe('thread-still-claimed')

    // session2: tries to migrate the legacy binding to a new canonical key
    // while session1 is still holding the thread. Auto-mode resolves
    // `thread-still-claimed` via the legacy entry, sees the in-memory
    // claim, and fails. Disk state must be exactly what we seeded.
    const sock2 = await connect(join(dir, 'daemon.sock'))
    const it2 = frameIterator(sock2)
    writeFrame(sock2, {
      type: 'register', id: 1, session_id: 'new-key-canon',
      mode: 'thread', cwd: '/home/u/code/proj', thread_id: 'auto',
      legacy_session_id: 'legacy-key',
      canonical_cwd: '/home/u/code/proj',
    })
    const ack2 = await recv(it2)
    expect(ack2.type).toBe('register_err')
    expect(ack2.code).toBe('thread_session_taken')

    const onDisk = loadBindings(join(dir, 'bindings.json'))
    // Legacy entry exactly as seeded — no rename, no canonical_cwd
    // injection, no last_seen_at refresh.
    expect(onDisk['legacy-key']).toEqual({
      thread_id: 'thread-still-claimed',
      cwd: '/old/path',
      created_at: 111, last_seen_at: 222,
    })
    expect(onDisk['new-key-canon']).toBeUndefined()
  })

  // Negative: when the shim happens to send legacy_session_id equal to the
  // current session_id (a degenerate no-op hint that should never trigger
  // migration), the daemon must not rewrite the entry under itself or
  // otherwise touch it. Locks the `legacy_session_id !== session_id` guard
  // in src/daemon.ts so a future refactor cannot regress it.
  test('skips migration when legacy_session_id equals session_id', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    const { saveBindings, loadBindings } = await import('../src/bindings')
    await saveBindings(join(dir, 'bindings.json'), {
      'same-key': {
        thread_id: 'fake-thread-same',
        cwd: '/home/u/code/proj',
        created_at: 100, last_seen_at: 200,
      },
    })

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, {
      type: 'register', id: 1, session_id: 'same-key',
      mode: 'thread', cwd: '/home/u/code/proj', thread_id: 'auto',
      legacy_session_id: 'same-key',
      canonical_cwd: '/home/u/code/proj',
    })
    const ack = await recv(it)
    expect(ack.type).toBe('register_ack')
    expect(ack.thread_id).toBe('fake-thread-same')

    const onDisk = loadBindings(join(dir, 'bindings.json'))
    // Entry must still be under the same key. created_at must not be
    // touched (migration would have refreshed last_seen_at; a no-op auto
    // reuse leaves both timestamps as-is).
    expect(onDisk['same-key']).toBeDefined()
    expect(onDisk['same-key'].thread_id).toBe('fake-thread-same')
    expect(onDisk['same-key'].created_at).toBe(100)
    // No spurious canonical_cwd was added by a phantom migration.
    expect('canonical_cwd' in onDisk['same-key']).toBe(false)
  })

  // Regression: an empty-string canonical_cwd (legitimately produced by a
  // `/strip-me=` exact-match rewrite) must be persisted on the binding, not
  // dropped by a truthy check. If it were dropped the entry would look
  // unmigrated on the next register and self-contained verification would
  // fail because consumers can't see what was sha1'd.
  test('persists empty-string canonical_cwd on fresh auto-mode register', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, {
      type: 'register', id: 1, session_id: 'sid-empty-canon',
      mode: 'thread', cwd: '/strip-me', thread_id: 'auto',
      canonical_cwd: '',
    })
    const ack = await recv(it)
    expect(ack.type).toBe('register_ack')

    const { loadBindings } = await import('../src/bindings')
    const onDisk = loadBindings(join(dir, 'bindings.json'))
    expect(onDisk['sid-empty-canon']).toBeDefined()
    // The field must be present AND equal to '' — `toHaveProperty` plus an
    // explicit `===` check rejects both "missing field" and "undefined".
    expect('canonical_cwd' in onDisk['sid-empty-canon']).toBe(true)
    expect(onDisk['sid-empty-canon'].canonical_cwd).toBe('')
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

  test('discord_ask in thread mode uses the parent group allowFrom (not DM allowFrom)', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: ['thread-user-a', 'thread-user-b'] }
    a.allowFrom = ['user-dm-only']
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 'ask-t', mode: 'thread', cwd: '/x', thread_id: 'auto' })
    const ack = await recv(it)
    expect(ack.type).toBe('register_ack')
    const threadId = ack.thread_id

    writeFrame(sock, {
      type: 'tool_call', id: 2, name: 'discord_ask',
      args: {
        questions: [
          { question: 'Pick a backend', options: [{ label: 'Go' }, { label: 'Rust' }] },
          { question: 'How many shards?', multiSelect: true, options: [{ label: 'one' }, { label: 'two' }, { label: 'three' }] },
        ],
      },
    })

    await new Promise(r => setTimeout(r, 30))
    const askCall = ops.calls.find(c => c.kind === 'ask') as any
    expect(askCall).toBeTruthy()
    expect(askCall.route).toEqual({ kind: 'thread', chat_id: threadId })
    expect(askCall.allowFrom).toEqual(['thread-user-a', 'thread-user-b'])
    ops.resolveAsk(askCall.request_id, {
      answers: [{ selection: 'Rust' }, { selection: ['two', 'three'], notes: undefined }],
    })

    const result = await recv(it)
    expect(result.type).toBe('tool_result')
    expect(result.id).toBe(2)
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toMatch(/Q1: Rust/)
    expect(result.content[0].text).toMatch(/Q2: two, three/)
  })

  test('discord_ask in thread mode with open group allowFrom passes empty allowFrom (no restriction)', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    a.allowFrom = ['user-x']
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 'ask-open', mode: 'thread', cwd: '/x', thread_id: 'auto' })
    await recv(it)

    writeFrame(sock, {
      type: 'tool_call', id: 2, name: 'discord_ask',
      args: { questions: [{ question: 'q', options: [{ label: 'A' }] }] },
    })
    await new Promise(r => setTimeout(r, 30))
    const askCall = ops.calls.find(c => c.kind === 'ask') as any
    expect(askCall.allowFrom).toEqual([])
    ops.resolveAsk(askCall.request_id, { answers: [{ selection: 'A' }] })
    await recv(it)
  })

  test('discord_ask in dm mode routes via allowFrom users', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.allowFrom = ['u-primary', 'u-secondary']
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 'ask-dm', mode: 'dm', cwd: '/x' })
    await recv(it)

    writeFrame(sock, {
      type: 'tool_call', id: 2, name: 'discord_ask',
      args: { questions: [{ question: 'q', options: [{ label: 'A' }, { label: 'B' }] }] },
    })
    await new Promise(r => setTimeout(r, 30))
    const askCall = ops.calls.find(c => c.kind === 'ask') as any
    expect(askCall.route).toEqual({ kind: 'dm', user_ids: ['u-primary', 'u-secondary'] })
    ops.resolveAsk(askCall.request_id, { answers: [{ selection: 'A' }] })
    const result = await recv(it)
    expect(result.type).toBe('tool_result')
    expect(result.content[0].text).toMatch(/Q1: A/)
  })

  test('discord_ask cancellation surfaces as tool_result text', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.allowFrom = ['u']
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 's-cancel', mode: 'dm', cwd: '/x' })
    await recv(it)
    writeFrame(sock, {
      type: 'tool_call', id: 2, name: 'discord_ask',
      args: { questions: [{ question: 'q', options: [{ label: 'A' }] }] },
    })
    await new Promise(r => setTimeout(r, 30))
    const askCall = ops.calls.find(c => c.kind === 'ask') as any
    ops.resolveAsk(askCall.request_id, { cancelled: true, reason: 'timeout' })
    const result = await recv(it)
    expect(result.type).toBe('tool_result')
    expect(result.content[0].text).toMatch(/did not answer/)
    expect(result.content[0].text).toMatch(/timeout/)
  })

  test('discord_ask rejects invalid questions shape', async () => {
    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    const sock = await connect(join(dir, 'daemon.sock'))
    const it = frameIterator(sock)
    writeFrame(sock, { type: 'register', id: 1, session_id: 's-bad', mode: 'dm', cwd: '/x' })
    await recv(it)
    writeFrame(sock, { type: 'tool_call', id: 2, name: 'discord_ask', args: { questions: 'nope' } })
    const result = await recv(it)
    expect(result.type).toBe('tool_result')
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/invalid questions/)
  })

  test('hook_ask routes to bound session and returns answers', async () => {
    const ops = new FakeDiscordOps()
    const { saveAccess, defaultAccess } = await import('../src/access')
    const a = defaultAccess()
    a.parentChannelId = 'parent-1'
    a.groups['parent-1'] = { requireMention: false, allowFrom: [] }
    a.allowFrom = ['user-5']
    saveAccess(join(dir, 'access.json'), a)

    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000 })

    const shimSock = await connect(join(dir, 'daemon.sock'))
    const shimIt = frameIterator(shimSock)
    writeFrame(shimSock, { type: 'register', id: 1, session_id: 'hooked', mode: 'thread', cwd: '/x', thread_id: 'auto' })
    const ack = await recv(shimIt)
    expect(ack.type).toBe('register_ack')
    const threadId = ack.thread_id

    const hookSock = await connect(join(dir, 'daemon.sock'))
    const hookIt = frameIterator(hookSock)
    writeFrame(hookSock, {
      type: 'hook_ask', id: 42, session_id: 'hooked',
      questions: [{ question: 'go ahead?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    })
    await new Promise(r => setTimeout(r, 30))
    const askCall = ops.calls.find(c => c.kind === 'ask') as any
    expect(askCall.route).toEqual({ kind: 'thread', chat_id: threadId })
    ops.resolveAsk(askCall.request_id, { answers: [{ selection: 'Yes' }] })

    const reply = await recv(hookIt)
    expect(reply.type).toBe('hook_ask_result')
    expect(reply.id).toBe(42)
    expect(reply.ok).toBe(true)
    expect(reply.answers).toEqual(['Yes'])
  })

  test('hook_ask with unknown session returns ok:false', async () => {
    daemon = await startDaemon({ stateDir: dir, ops: new FakeDiscordOps(), idleExitMs: 60_000 })
    const hookSock = await connect(join(dir, 'daemon.sock'))
    const hookIt = frameIterator(hookSock)
    writeFrame(hookSock, {
      type: 'hook_ask', id: 1, session_id: 'no-such-session',
      questions: [{ question: 'q', options: [{ label: 'A' }] }],
    })
    const reply = await recv(hookIt)
    expect(reply.type).toBe('hook_ask_result')
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/no registered session/)
  })
})
