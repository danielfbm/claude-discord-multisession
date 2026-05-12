import { createServer, createConnection, type Server, type Socket } from 'net'
import { mkdirSync, unlinkSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { readFrames, writeFrame } from './framing'
import { parseShimMsg } from './protocol'
import type { DiscordOps } from './discord-ops'
import { loadAccess, saveAccess, pruneExpired } from './access'
import { loadBindings, upsertBinding } from './bindings'
import { deriveThreadName } from './session-id'
import { gate, type GateInput } from './gate'

export type InboundEvent = {
  chat_id: string
  message_id: string
  user: string
  user_id: string
  ts: string
  content: string
  isDM: boolean
  parentChannelId?: string
  hasBotMention: boolean
  isReplyToBot: boolean
  attachments: { name: string; type: string; bytes: number }[]
}

export type PendingPermission = { tool_name: string; description: string; input_preview: string }

export type DaemonOpts = {
  stateDir: string
  ops: DiscordOps
  idleExitMs: number
  /**
   * Called after the internal shutdown unlinks sock + pid. The entrypoint
   * uses this to destroy the discord.js client and call `process.exit(0)`,
   * because discord.js's gateway WebSocket otherwise keeps the event loop
   * alive — leaving a zombie daemon with no IPC socket.
   */
  onShutdown?: () => void | Promise<void>
}

export type DaemonHandle = {
  shutdown(): Promise<void>
  deliverInbound(ev: InboundEvent): void
  permissionDecision(request_id: string, behavior: 'allow' | 'deny'): void
  pendingPermissions: Map<string, PendingPermission>
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
  const { stateDir, ops, idleExitMs, onShutdown } = opts
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
  const permRoutes = new Map<string, string>()   // request_id → session_id
  const pendingPermissions = new Map<string, PendingPermission>()
  let dmSessionId: string | null = null

  function deliverInbound(ev: InboundEvent): void {
    const access = loadAccess(accessFile)
    const pruned = pruneExpired(access)
    const input: GateInput = {
      senderId: ev.user_id,
      isDM: ev.isDM,
      channelId: ev.chat_id,
      parentChannelId: ev.parentChannelId,
      content: ev.content,
      hasBotMention: ev.hasBotMention,
      isReplyToBot: ev.isReplyToBot,
    }
    const result = gate(input, access)
    if (result.action === 'pair' || pruned) saveAccess(accessFile, access)

    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      void ops.reply(ev.chat_id, `${lead} — run in Claude Code:\n\n/discord:access pair ${result.code}`)
        .catch(err => process.stderr.write(`discord daemon: pair reply failed: ${err}\n`))
      return
    }
    if (result.action !== 'deliver') return

    let target: Session | undefined
    if (ev.isDM) {
      if (dmSessionId) target = sessions.get(dmSessionId)
    } else {
      const bound = threadIndex.get(ev.chat_id)
      if (bound) target = sessions.get(bound)
      else if (!ev.parentChannelId) {
        // Non-thread guild message → fall back to DM session.
        if (dmSessionId) target = sessions.get(dmSessionId)
      } else {
        // Unbound thread message → drop. Production driver may add a ❓ reaction.
        return
      }
    }
    if (!target) return

    const atts = ev.attachments
    writeFrame(target.sock, {
      type: 'inbound',
      chat_id: ev.chat_id, message_id: ev.message_id,
      user: ev.user, user_id: ev.user_id, ts: ev.ts,
      content: ev.content,
      ...(atts.length > 0 ? {
        attachment_count: atts.length,
        attachments: atts.map(a => `${a.name} (${a.type}, ${(a.bytes / 1024).toFixed(0)}KB)`).join('; '),
      } : {}),
    })
  }

  function permissionDecision(request_id: string, behavior: 'allow' | 'deny'): void {
    const sid = permRoutes.get(request_id)
    pendingPermissions.delete(request_id)
    if (!sid) return
    permRoutes.delete(request_id)
    const s = sessions.get(sid)
    if (!s) return
    writeFrame(s.sock, { type: 'permission_decision', request_id, behavior })
  }

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
    if (onShutdown) {
      try { await onShutdown() } catch (err) {
        process.stderr.write(`daemon: onShutdown failed: ${err}\n`)
      }
    }
  }

  async function runTool(name: string, args: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    try {
      switch (name) {
        case 'reply': {
          const ids = await ops.reply(
            String(args.chat_id),
            String(args.text),
            { reply_to: args.reply_to as string | undefined, files: args.files as string[] | undefined },
          )
          const text = ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(', ')})`
          return { content: [{ type: 'text', text }] }
        }
        case 'react':
          await ops.react(String(args.chat_id), String(args.message_id), String(args.emoji))
          return { content: [{ type: 'text', text: 'reacted' }] }
        case 'edit_message': {
          const id = await ops.edit(String(args.chat_id), String(args.message_id), String(args.text))
          return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
        }
        case 'fetch_messages': {
          const limit = Number(args.limit ?? 20)
          const arr = await ops.fetch(String(args.channel ?? args.chat_id), limit)
          const out = arr.length === 0
            ? '(no messages)'
            : arr.map(m =>
                `[${m.ts}] ${m.author_name}: ${m.content.replace(/[\r\n]+/g, ' ⏎ ')}  (id: ${m.id}${m.attachment_count > 0 ? ` +${m.attachment_count}att` : ''})`
              ).join('\n')
          return { content: [{ type: 'text', text: out }] }
        }
        case 'download_attachment': {
          const inboxDir = join(stateDir, 'inbox')
          const out = await ops.downloadAttachments(String(args.chat_id), String(args.message_id), inboxDir)
          if (out.length === 0) return { content: [{ type: 'text', text: 'message has no attachments' }] }
          const lines = out.map(f => `  ${f.path}  (${f.name}, ${f.type}, ${(f.bytes / 1024).toFixed(0)}KB)`)
          return { content: [{ type: 'text', text: `downloaded ${out.length} attachment(s):\n${lines.join('\n')}` }] }
        }
        default:
          return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `${name} failed: ${m}` }], isError: true }
    }
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
          // Read-only snapshot of bindings; the auto-mode lookup below only
          // needs to know whether this session was previously bound. Writes
          // go through upsertBinding(), which re-reads + merges inside a
          // per-file mutex so this snapshot's staleness cannot lose data.
          //
          // Guarded with try/catch because a corrupt or unreadable
          // bindings.json must NOT take down the entire daemon message loop
          // — that would punish every other connected shim for one bad file.
          // The error is reported as bindings_load_failed and only this
          // register fails.
          let bindings: ReturnType<typeof loadBindings>
          try {
            bindings = loadBindings(bindingsFile)
          } catch (err) {
            writeFrame(sock, {
              type: 'register_err', id: msg.id, code: 'bindings_load_failed',
              message: `bindings load failed: ${err instanceof Error ? err.message : String(err)}`,
            })
            continue
          }

          if (sessions.has(msg.session_id)) {
            writeFrame(sock, {
              type: 'register_err', id: msg.id,
              code: msg.mode === 'dm' ? 'dm_session_taken' : 'thread_session_taken',
              message: 'this session_id is already registered',
            })
            continue
          }

          // Reserve the session_id synchronously so a concurrent register
          // with the same session_id (which would otherwise also pass the
          // sessions.has() check above before any await yields) fails fast
          // instead of doubly-creating threads + double-acking. The
          // placeholder uses thread_id=null; inbound routing keys off
          // threadIndex (still unset) or dmSessionId (also still unset), so
          // no traffic can land on this half-registered session yet.
          sessions.set(msg.session_id, { session_id: msg.session_id, mode: msg.mode, thread_id: null, sock })

          // reservedThreadId tracks the thread_id we have synchronously
          // claimed in threadIndex on behalf of this session, so the
          // `finally` block can release it on any failure path.
          let reservedThreadId: string | null = null
          let committed = false
          try {
            if (msg.mode === 'dm') {
              if (dmSessionId !== null) {
                writeFrame(sock, {
                  type: 'register_err', id: msg.id, code: 'dm_session_taken',
                  message: 'a DM-mode shim is already registered',
                })
                continue
              }
              // Send the ack BEFORE claiming dmSessionId / mySessionId. If
              // writeFrame throws synchronously (e.g. the shim already
              // disconnected), neither identifier has clean-up logic in the
              // finally block, so a pre-emptive assignment would permanently
              // leak the DM slot for the rest of the daemon's lifetime.
              writeFrame(sock, { type: 'register_ack', id: msg.id, session_id: msg.session_id, thread_id: null })
              dmSessionId = msg.session_id
              mySessionId = msg.session_id
              committed = true
              continue
            }

            // thread mode
            let threadId = msg.thread_id!
            if (threadId === 'auto') {
              const existing = bindings[msg.session_id]
              if (existing) {
                threadId = existing.thread_id
                // Reusing a previously-persisted binding. Claim the thread
                // synchronously to fail fast on a concurrent reuse race.
                if (threadIndex.has(threadId)) {
                  writeFrame(sock, {
                    type: 'register_err', id: msg.id, code: 'thread_session_taken',
                    message: 'this thread is already bound to another session',
                  })
                  continue
                }
                threadIndex.set(threadId, msg.session_id)
                reservedThreadId = threadId
              } else {
                if (!access.parentChannelId) {
                  writeFrame(sock, {
                    type: 'register_err', id: msg.id, code: 'parent_channel_unset',
                    message: 'parentChannelId is not set in access.json',
                  })
                  continue
                }
                const name = deriveThreadName(msg.cwd, msg.session_id, msg.thread_name)
                try {
                  const t = await ops.createThread(access.parentChannelId, name)
                  threadId = t.thread_id
                } catch (err) {
                  writeFrame(sock, {
                    type: 'register_err', id: msg.id, code: 'discord_unavailable',
                    message: `createThread failed: ${err instanceof Error ? err.message : String(err)}`,
                  })
                  continue
                }
                // Brand-new thread id from Discord — collision impossible,
                // but claim threadIndex uniformly so cleanup paths are
                // symmetric.
                threadIndex.set(threadId, msg.session_id)
                reservedThreadId = threadId
                // Persist the new binding. upsertBinding does load-merge-write
                // inside a per-file mutex; failures surface as a distinct
                // error code rather than masquerading as a Discord failure.
                try {
                  await upsertBinding(bindingsFile, msg.session_id, {
                    thread_id: threadId, cwd: msg.cwd,
                    created_at: Date.now(), last_seen_at: Date.now(),
                  })
                } catch (err) {
                  writeFrame(sock, {
                    type: 'register_err', id: msg.id, code: 'bindings_save_failed',
                    message: `bindings save failed: ${err instanceof Error ? err.message : String(err)}`,
                  })
                  continue
                }
              }
            } else {
              // Explicit thread snowflake. Claim threadIndex BEFORE persisting
              // the binding — previously the order was reversed, which left
              // a stale binding on disk whenever the second registration of
              // an already-bound thread was rejected.
              //
              // Fast-path reject: this pre-await check skips the Discord
              // verifyThreadParent round-trip when the thread is already
              // known to be bound. It is an optimization, NOT the
              // correctness gate — the post-await recheck below is what
              // actually prevents concurrent claims from racing past us.
              if (threadIndex.has(threadId)) {
                writeFrame(sock, {
                  type: 'register_err', id: msg.id, code: 'thread_session_taken',
                  message: 'this thread is already bound to another session',
                })
                continue
              }
              const parent = await ops.verifyThreadParent(threadId)
              if (!parent || !(parent in access.groups)) {
                writeFrame(sock, {
                  type: 'register_err', id: msg.id, code: 'thread_not_allowed',
                  message: 'thread parent is not opted in via /discord:access group add',
                })
                continue
              }
              // Recheck post-await: a concurrent register could have claimed
              // this thread while we were verifying its parent.
              if (threadIndex.has(threadId)) {
                writeFrame(sock, {
                  type: 'register_err', id: msg.id, code: 'thread_session_taken',
                  message: 'this thread is already bound to another session',
                })
                continue
              }
              threadIndex.set(threadId, msg.session_id)
              reservedThreadId = threadId
              try {
                await upsertBinding(bindingsFile, msg.session_id, {
                  thread_id: threadId, cwd: msg.cwd,
                  created_at: bindings[msg.session_id]?.created_at ?? Date.now(),
                  last_seen_at: Date.now(),
                })
              } catch (err) {
                writeFrame(sock, {
                  type: 'register_err', id: msg.id, code: 'bindings_save_failed',
                  message: `bindings save failed: ${err instanceof Error ? err.message : String(err)}`,
                })
                continue
              }
            }

            // Send the ack BEFORE the final commit assignments. If writeFrame
            // throws synchronously, the finally block still cleans up
            // `sessions` and `threadIndex` (committed stays false), and
            // `mySessionId` is never assigned to a now-released session_id.
            writeFrame(sock, { type: 'register_ack', id: msg.id, session_id: msg.session_id, thread_id: threadId })
            // Finalize: upgrade the placeholder session entry to the real one
            // and bind this connection's outbound identity.
            sessions.set(msg.session_id, { session_id: msg.session_id, mode: 'thread', thread_id: threadId, sock })
            mySessionId = msg.session_id
            committed = true
          } finally {
            if (!committed) {
              // Release every reservation we made before the failure point.
              // `continue` from inside the try block runs this finally before
              // moving to the next message, so subsequent registers see a
              // clean state. `dmSessionId` and `mySessionId` are only
              // assigned after a successful writeFrame, so they cannot leak
              // here even if writeFrame throws.
              sessions.delete(msg.session_id)
              if (reservedThreadId !== null) threadIndex.delete(reservedThreadId)
            }
          }
          continue
        }

        if (msg.type === 'tool_call') {
          const result = await runTool(msg.name, msg.args as Record<string, unknown>)
          writeFrame(sock, { type: 'tool_result', id: msg.id, ...result })
          continue
        }

        if (msg.type === 'permission_request') {
          if (!mySessionId) {
            writeFrame(sock, { type: 'error', message: 'permission_request requires register first' })
            continue
          }
          permRoutes.set(msg.request_id, mySessionId)
          pendingPermissions.set(msg.request_id, {
            tool_name: msg.tool_name, description: msg.description, input_preview: msg.input_preview,
          })
          const s = sessions.get(mySessionId)!
          if (s.mode === 'thread' && s.thread_id) {
            void ops.postPermissionPrompt(s.thread_id, msg.request_id, msg.tool_name)
              .catch(err => process.stderr.write(`postPermissionPrompt failed: ${err}\n`))
          } else {
            const access = loadAccess(accessFile)
            void ops.postPermissionPromptDM(access.allowFrom, msg.request_id, msg.tool_name)
              .catch(err => process.stderr.write(`postPermissionPromptDM failed: ${err}\n`))
          }
          continue
        }

        writeFrame(sock, { type: 'error', message: `unhandled msg type: ${(msg as any).type}` })
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

  return { shutdown, deliverInbound, permissionDecision, pendingPermissions }
}
