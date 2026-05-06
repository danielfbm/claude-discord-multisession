import { createServer, createConnection, type Server, type Socket } from 'net'
import { mkdirSync, unlinkSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { readFrames, writeFrame } from './framing'
import { parseShimMsg } from './protocol'
import type { DiscordOps } from './discord-ops'
import { loadAccess, saveAccess } from './access'
import { loadBindings, saveBindings } from './bindings'
import { deriveThreadName } from './session-id'

export type DaemonOpts = {
  stateDir: string
  ops: DiscordOps
  idleExitMs: number
}

export type DaemonHandle = {
  shutdown(): Promise<void>
}

type Session = {
  session_id: string
  mode: 'dm' | 'thread'
  thread_id: string | null
  sock: Socket
}

async function probeStaleSocket(sockPath: string): Promise<void> {
  const result = await new Promise<'alive' | 'stale'>(res => {
    const probe = createConnection(sockPath)
    probe.once('connect', () => { probe.destroy(); res('alive') })
    probe.once('error', () => { probe.destroy(); res('stale') })
  })
  if (result === 'alive') throw new Error(`daemon already running at ${sockPath}`)
  try { unlinkSync(sockPath) } catch {}
}

export async function startDaemon(opts: DaemonOpts): Promise<DaemonHandle> {
  const { stateDir, ops, idleExitMs } = opts
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const sockPath = join(stateDir, 'daemon.sock')
  const pidPath = join(stateDir, 'daemon.pid')
  const accessFile = join(stateDir, 'access.json')
  const bindingsFile = join(stateDir, 'bindings.json')

  if (existsSync(sockPath)) await probeStaleSocket(sockPath)

  const server: Server = createServer()
  await new Promise<void>((res, rej) => {
    server.once('error', rej); server.once('listening', () => res())
    server.listen(sockPath)
  })
  try { chmodSync(sockPath, 0o600) } catch {}
  writeFileSync(pidPath, String(process.pid) + '\n', { mode: 0o600 })

  const sessions = new Map<string, Session>()    // by session_id
  const threadIndex = new Map<string, string>()  // thread_id → session_id
  let dmSessionId: string | null = null

  const clients = new Set<Socket>()
  let idleTimer: NodeJS.Timeout | null = null
  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer)
    if (clients.size === 0) {
      idleTimer = setTimeout(() => { void shutdown() }, idleExitMs)
      idleTimer.unref()
    }
  }

  let stopped = false
  async function shutdown(): Promise<void> {
    if (stopped) return
    stopped = true
    if (idleTimer) clearTimeout(idleTimer)
    for (const c of clients) { try { c.destroy() } catch {} }
    await new Promise<void>(r => server.close(() => r()))
    try { unlinkSync(sockPath) } catch {}
    try { unlinkSync(pidPath) } catch {}
  }

  async function handleConnection(sock: Socket): Promise<void> {
    let mySessionId: string | null = null
    try {
      for await (const raw of readFrames(sock)) {
        let msg
        try { msg = parseShimMsg(raw) } catch (err) {
          writeFrame(sock, { type: 'error', message: String(err) })
          continue
        }

        if (msg.type === 'ping') {
          writeFrame(sock, { type: 'pong', id: msg.id })
          continue
        }

        if (msg.type === 'unregister') {
          writeFrame(sock, { type: 'pong', id: msg.id })
          return
        }

        if (msg.type === 'register') {
          const access = loadAccess(accessFile)
          const bindings = loadBindings(bindingsFile)

          if (sessions.has(msg.session_id)) {
            writeFrame(sock, {
              type: 'register_err', id: msg.id,
              code: msg.mode === 'dm' ? 'dm_session_taken' : 'thread_session_taken',
              message: 'this session_id is already registered',
            })
            continue
          }

          if (msg.mode === 'dm') {
            if (dmSessionId !== null) {
              writeFrame(sock, {
                type: 'register_err', id: msg.id, code: 'dm_session_taken',
                message: 'a DM-mode shim is already registered',
              })
              continue
            }
            dmSessionId = msg.session_id
            sessions.set(msg.session_id, { session_id: msg.session_id, mode: 'dm', thread_id: null, sock })
            mySessionId = msg.session_id
            writeFrame(sock, { type: 'register_ack', id: msg.id, session_id: msg.session_id, thread_id: null })
            continue
          }

          // thread mode
          let threadId = msg.thread_id!
          if (threadId === 'auto') {
            const existing = bindings[msg.session_id]
            if (existing) {
              threadId = existing.thread_id
            } else {
              if (!access.parentChannelId) {
                writeFrame(sock, {
                  type: 'register_err', id: msg.id, code: 'parent_channel_unset',
                  message: 'parentChannelId is not set in access.json',
                })
                continue
              }
              const name = deriveThreadName(msg.cwd, msg.session_id)
              try {
                const t = await ops.createThread(access.parentChannelId, name)
                threadId = t.thread_id
                bindings[msg.session_id] = {
                  thread_id: threadId, cwd: msg.cwd,
                  created_at: Date.now(), last_seen_at: Date.now(),
                }
                saveBindings(bindingsFile, bindings)
              } catch (err) {
                writeFrame(sock, {
                  type: 'register_err', id: msg.id, code: 'discord_unavailable',
                  message: `createThread failed: ${err instanceof Error ? err.message : String(err)}`,
                })
                continue
              }
            }
          } else {
            // Verify the supplied thread snowflake is under an opted-in parent.
            const parent = await ops.verifyThreadParent(threadId)
            if (!parent || !(parent in access.groups)) {
              writeFrame(sock, {
                type: 'register_err', id: msg.id, code: 'thread_not_allowed',
                message: 'thread parent is not opted in via /discord:access group add',
              })
              continue
            }
            bindings[msg.session_id] = {
              thread_id: threadId, cwd: msg.cwd,
              created_at: bindings[msg.session_id]?.created_at ?? Date.now(),
              last_seen_at: Date.now(),
            }
            saveBindings(bindingsFile, bindings)
          }

          if (threadIndex.has(threadId)) {
            writeFrame(sock, {
              type: 'register_err', id: msg.id, code: 'thread_session_taken',
              message: 'this thread is already bound to another session',
            })
            continue
          }
          threadIndex.set(threadId, msg.session_id)
          sessions.set(msg.session_id, { session_id: msg.session_id, mode: 'thread', thread_id: threadId, sock })
          mySessionId = msg.session_id
          writeFrame(sock, { type: 'register_ack', id: msg.id, session_id: msg.session_id, thread_id: threadId })
          continue
        }

        // tool_call / permission_request handled in later tasks
        writeFrame(sock, { type: 'error', message: `not implemented yet: ${(msg as any).type}` })
      }
    } finally {
      if (mySessionId) {
        const s = sessions.get(mySessionId)
        if (s?.thread_id) threadIndex.delete(s.thread_id)
        if (dmSessionId === mySessionId) dmSessionId = null
        sessions.delete(mySessionId)
      }
    }
  }

  server.on('connection', (sock: Socket) => {
    clients.add(sock)
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    void handleConnection(sock)
      .catch(err => { try { sock.destroy(err as Error) } catch {} })
      .finally(() => { clients.delete(sock); armIdle() })
  })

  armIdle()

  return { shutdown }
}
