import { createServer, createConnection, type Server, type Socket } from 'net'
import { mkdirSync, unlinkSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { readFrames, writeFrame } from './framing'
import { parseShimMsg, AskQuestionSchema } from './protocol'
import type { DiscordOps, AskRoute, AskResult } from './discord-ops'
import { z } from 'zod'
import { loadAccess, saveAccess, pruneExpired } from './access'
import { loadBindings, upsertBinding, migrateBindingKey } from './bindings'
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
   * Resolves once the discord.js gateway is fully READY. The register
   * handler awaits this before any channel-fetching API call, otherwise
   * a shim connecting during the login window sees `channel not found`
   * because the client has no auth/cache yet.
   */
  waitReady?: () => Promise<void>
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
  parent_id: string | null
  sock: Socket
}

// Single-line key=value log emitted for every register attempt so daemon.log
// answers "which shim wrote this bindings.json entry, when, with which cwd
// and thread_id" without needing to cross-reference jsonl mtimes. Format is
// `discord daemon: register <k>=<v> ...` — matches the existing stderr
// prefix so `grep "register outcome=" daemon.log` works.
//
// Quoting trigger: empty strings (so `canonical_cwd=""` is visually distinct
// from a missing field), strings containing whitespace / `"` / newlines (so
// one register can't accidentally span multiple log lines and break the
// grep contract documented in README). Numeric / id fields stay unquoted
// for human scannability.
function logRegister(fields: Record<string, unknown>): void {
  const parts: string[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue
    const needsQuote = typeof v === 'string'
      && (v === '' || /[\s"]/.test(v))
    const s = needsQuote ? JSON.stringify(v) : String(v)
    parts.push(`${k}=${s}`)
  }
  process.stderr.write(`discord daemon: register ${parts.join(' ')}\n`)
}

// Tool-args validation. The Discord MCP `inputSchema` declares required
// fields and types, but the MCP SDK does NOT enforce those on the server
// side — schemas are advisory hints for the LLM, not runtime contracts.
// Without explicit validation here, a wrong-named field (e.g. an LLM
// confusing reply.text with react.message_id/content) silently coerces
// through `String(undefined)` to the literal "undefined", which then
// gets sent to Discord as a 9-byte message. fail-fast with isError so
// the LLM sees an actionable error frame and can self-correct, instead
// of polluting Discord with garbage content.
export type FieldSpec = {
  name: string
  // `'array'` is unknown[]; `'string[]'` adds element-type validation
  // so call sites get a typed string[] back without an `as` cast.
  type: 'string' | 'number' | 'array' | 'string[]'
  required: boolean
  // Optional legacy/compat names accepted in place of `name`. First match
  // wins, and the value is normalized onto `name` before the typed args
  // object is returned. Different from the `synonyms` map (4th arg of
  // validateToolArgs): an alias is silently accepted, while a synonym is
  // rejected with a "did you mean" hint. Use alias for stable backwards
  // compatibility, use synonym for LLM-misuse self-correction.
  aliases?: readonly string[]
}

// Map a FieldSpec.type literal back to its runtime TS type. Used to
// reconstruct a typed args object from a `readonly FieldSpec[]` after
// validation succeeds, so call sites can drop their `as string` casts.
type SpecType<T extends FieldSpec['type']> =
  T extends 'string' ? string
  : T extends 'number' ? number
  : T extends 'string[]' ? string[]
  : T extends 'array' ? unknown[]
  : never

// Build the typed args object from a const-asserted specs array. Required
// specs become required keys; non-required specs become optional keys.
// Requires the call site to pass specs `as const` — without it the
// literal `name`/`type` strings widen to `string` and this mapping
// degrades to a useless index signature.
export type SpecsToArgs<S extends readonly FieldSpec[]> =
  { [K in S[number] as K['required'] extends true  ? K['name'] : never]:  SpecType<K['type']> }
  & { [K in S[number] as K['required'] extends true ? never : K['name']]?: SpecType<K['type']> }

export function validateToolArgs<S extends readonly FieldSpec[]>(
  toolName: string,
  args: Record<string, unknown>,
  specs: S,
  // Map: wrong-named field (LLM may type by mistake) → the correct field
  // name it was probably meant to be. Used purely to enrich the error
  // hint; nothing is auto-fixed because semantics differ (e.g. react's
  // `message_id` is the target message, but reply's `reply_to` is the
  // quote-reply parent — silently swapping them would hide real bugs).
  //
  // Aliases (declared per-spec) are the inverse pattern: silently
  // accepted legacy names that get normalized onto the canonical field.
  // Use synonyms for LLM-misuse self-correction; use aliases for stable
  // backwards-compatible field renames.
  synonyms: Readonly<Record<string, string>> = {},
): { ok: true; args: SpecsToArgs<S> } | { ok: false; error: string } {
  const got = Object.keys(args)

  // Synonym pre-check: reject ANY wrong-named field whose canonical
  // target is absent — even when the canonical is optional. Optional
  // means "the LLM may legitimately omit it", NOT "it's OK to silently
  // drop the LLM's intent when it typed the wrong name". Without this
  // pre-check, `reply({chat_id, text, message_id: 'm'})` would pass
  // validation and send a non-quoting reply, because `reply_to` is
  // optional and missing — the quote target gets dropped without any
  // signal back to the caller. We surface it as a hard error so the
  // LLM self-corrects on the next turn instead of confusing the user
  // with a reply that ignores the message they pointed at.
  //
  // When BOTH the wrong key and the right key are present, we leave it
  // to the spec loop below: the right key wins, the wrong key gets
  // ignored, and that's a survivable misuse (no intent loss).
  for (const [wrong, right] of Object.entries(synonyms)) {
    if (wrong in args && !(right in args)) {
      return {
        ok: false,
        error: `${toolName} received unknown field '${wrong}'; did you mean '${right}'? got keys [${got.join(', ')}].`,
      }
    }
  }

  // We may need to normalize an alias hit onto the canonical key. To
  // avoid mutating the caller's args object, we lazily shallow-clone on
  // first hit and assign the local `args` reference to the clone.
  let normalized: Record<string, unknown> | null = null

  for (const spec of specs) {
    let v = args[spec.name]
    // Alias fallback: try each declared alias in order. Canonical name
    // is always preferred — we only look at aliases when canonical is
    // absent, mirroring the synonym-coexistence policy above.
    if (v === undefined && spec.aliases) {
      for (const alias of spec.aliases) {
        if (alias in args) {
          v = args[alias]
          // Lazily clone on first alias hit so we can assign the
          // canonical key without touching the caller's object.
          if (normalized === null) normalized = { ...args }
          normalized[spec.name] = v
          break
        }
      }
    }
    if (v === undefined) {
      if (!spec.required) continue
      // Required-missing path. Synonym substitution for this same field
      // has already been caught by the pre-check above, so we don't need
      // a per-field hint loop here — the error is "you forgot it", not
      // "you renamed it".
      return {
        ok: false,
        error: `${toolName} requires field '${spec.name}' (${spec.type}); got keys [${got.join(', ')}].`,
      }
    }
    if (spec.type === 'array' || spec.type === 'string[]') {
      if (!Array.isArray(v)) {
        return { ok: false, error: `${toolName} expects '${spec.name}' to be ${spec.type}, got ${typeof v}.` }
      }
      // Element-type guard for the typed-array variant. Without this,
      // SpecType<'string[]'> = string[] would be a lie at runtime — a
      // mixed array would flow through and trip the call site instead.
      if (spec.type === 'string[]' && v.some(e => typeof e !== 'string')) {
        return { ok: false, error: `${toolName} expects '${spec.name}' to be string[], got mixed/non-string elements.` }
      }
    } else if (typeof v !== spec.type) {
      return { ok: false, error: `${toolName} expects '${spec.name}' to be ${spec.type}, got ${typeof v}.` }
    }
  }
  // Cast is safe because every required spec.name has been confirmed
  // present with the right runtime type; optional fields are either
  // absent or typed-checked above. Return the alias-normalized object
  // when any alias fired, otherwise the original args reference.
  return { ok: true, args: (normalized ?? args) as SpecsToArgs<S> }
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
  const { stateDir, ops, idleExitMs, onShutdown, waitReady } = opts
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

  function routeForSession(s: Session): AskRoute {
    if (s.mode === 'thread' && s.thread_id) return { kind: 'thread', chat_id: s.thread_id }
    const access = loadAccess(accessFile)
    return { kind: 'dm', user_ids: access.allowFrom }
  }

  /**
   * Who is authorized to click an ask button for this session?
   * - DM mode: the global `access.allowFrom`.
   * - Thread mode: the parent group's `allowFrom` (empty array = anyone
   *   in the thread can answer, matching `gate.ts` inbound semantics).
   */
  function allowFromForSession(s: Session): string[] {
    const access = loadAccess(accessFile)
    if (s.mode === 'thread') {
      if (!s.parent_id) return []
      return access.groups[s.parent_id]?.allowFrom ?? []
    }
    return access.allowFrom
  }

  function newAskRequestId(): string {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz'
    let s = ''
    for (let i = 0; i < 5; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
    return s
  }

  function answerToText(ans: AskResult): string {
    if ('cancelled' in ans) return `User did not answer (${ans.reason}). Ask again or proceed without the answer.`
    return ans.answers.map((a, i) => {
      const sel = Array.isArray(a.selection) ? a.selection.join(', ') : a.selection
      return `Q${i + 1}: ${sel}${a.notes ? ` (notes: ${a.notes})` : ''}`
    }).join('\n')
  }

  async function runTool(name: string, args: Record<string, unknown>, session: Session | null): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })
    try {
      switch (name) {
        case 'reply': {
          // Synonyms target the historical LLM-misuse pattern that produced
          // "undefined" Discord messages: `text` typed as `content` (a key
          // from no real tool — pure hallucination), `text` as `message`
          // (one-off in May), and `reply_to` as `message_id` (the react /
          // edit_message field name leaking into reply).
          //
          // `as const` on the specs array is what lets validateToolArgs's
          // SpecsToArgs<S> infer literal field names and types, so v.args
          // below is fully typed without per-field casts.
          const v = validateToolArgs('reply', args, [
            { name: 'chat_id', type: 'string', required: true },
            { name: 'text', type: 'string', required: true },
            { name: 'reply_to', type: 'string', required: false },
            // `string[]` (vs plain `'array'`) lets the validator enforce
            // element type, so v.args.files is a real string[] and the
            // call site doesn't need an `as` cast.
            { name: 'files', type: 'string[]', required: false },
          ] as const, { content: 'text', message: 'text', message_id: 'reply_to' })
          if (!v.ok) return fail(v.error)
          const ids = await ops.reply(
            v.args.chat_id,
            v.args.text,
            { reply_to: v.args.reply_to, files: v.args.files },
          )
          const text = ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(', ')})`
          return { content: [{ type: 'text', text }] }
        }
        case 'react': {
          const v = validateToolArgs('react', args, [
            { name: 'chat_id', type: 'string', required: true },
            { name: 'message_id', type: 'string', required: true },
            { name: 'emoji', type: 'string', required: true },
          ] as const, { text: 'emoji', content: 'emoji', reply_to: 'message_id' })
          if (!v.ok) return fail(v.error)
          await ops.react(v.args.chat_id, v.args.message_id, v.args.emoji)
          return { content: [{ type: 'text', text: 'reacted' }] }
        }
        case 'edit_message': {
          const v = validateToolArgs('edit_message', args, [
            { name: 'chat_id', type: 'string', required: true },
            { name: 'message_id', type: 'string', required: true },
            { name: 'text', type: 'string', required: true },
          ] as const, { content: 'text', message: 'text', reply_to: 'message_id' })
          if (!v.ok) return fail(v.error)
          const id = await ops.edit(v.args.chat_id, v.args.message_id, v.args.text)
          return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
        }
        case 'fetch_messages': {
          // `chat_id` is the legacy alias for `channel`. The MCP schema
          // declares `channel`, but the rest of this API uses `chat_id`,
          // so older callers and confused LLMs may still emit it. The
          // alias is silently accepted and normalized onto `channel`, so
          // the downstream call site can stay uniform.
          const v = validateToolArgs('fetch_messages', args, [
            { name: 'channel', type: 'string', required: true, aliases: ['chat_id'] },
            { name: 'limit', type: 'number', required: false },
          ] as const)
          if (!v.ok) return fail(v.error)
          // limit is now guaranteed `number | undefined` by the validator,
          // so the previous `Number(args.limit ?? 20)` coercion is gone.
          const limit = v.args.limit ?? 20
          const arr = await ops.fetch(v.args.channel, limit)
          const out = arr.length === 0
            ? '(no messages)'
            : arr.map(m =>
                `[${m.ts}] ${m.author_name}: ${m.content.replace(/[\r\n]+/g, ' ⏎ ')}  (id: ${m.id}${m.attachment_count > 0 ? ` +${m.attachment_count}att` : ''})`
              ).join('\n')
          return { content: [{ type: 'text', text: out }] }
        }
        case 'download_attachment': {
          const v = validateToolArgs('download_attachment', args, [
            { name: 'chat_id', type: 'string', required: true },
            { name: 'message_id', type: 'string', required: true },
          ] as const, { reply_to: 'message_id' })
          if (!v.ok) return fail(v.error)
          const inboxDir = join(stateDir, 'inbox')
          const out = await ops.downloadAttachments(v.args.chat_id, v.args.message_id, inboxDir)
          if (out.length === 0) return { content: [{ type: 'text', text: 'message has no attachments' }] }
          const lines = out.map(f => `  ${f.path}  (${f.name}, ${f.type}, ${(f.bytes / 1024).toFixed(0)}KB)`)
          return { content: [{ type: 'text', text: `downloaded ${out.length} attachment(s):\n${lines.join('\n')}` }] }
        }
        case 'discord_ask': {
          if (!session) return fail('discord_ask requires a registered session')
          const parsed = z.array(AskQuestionSchema).min(1).max(4).safeParse(args.questions)
          if (!parsed.success) return fail(`invalid questions: ${parsed.error.message}`)
          const route = routeForSession(session)
          const allowFrom = allowFromForSession(session)
          const timeoutMs = Number(args.timeout_ms ?? 600_000)
          const request_id = newAskRequestId()
          const result = await ops.ask(route, request_id, parsed.data, { allowFrom, timeoutMs })
          return { content: [{ type: 'text', text: answerToText(result) }] }
        }
        default:
          return fail(`unknown tool: ${name}`)
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      return fail(`${name} failed: ${m}`)
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
            const message = `bindings load failed: ${err instanceof Error ? err.message : String(err)}`
            writeFrame(sock, { type: 'register_err', id: msg.id, code: 'bindings_load_failed', message })
            logRegister({ outcome: 'err', mode: msg.mode, session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, code: 'bindings_load_failed', message })
            continue
          }

          // One-shot legacy→canonical migration is *planned* here but
          // *committed* further down, after every check that could fail
          // this register has passed. The previous design committed the
          // migration at this point, which left bindings.json mutated
          // whenever a subsequent check rejected the register (most
          // visibly: an in-memory threadIndex collision when the legacy
          // session was still live on another connection). After such a
          // failure the legacy key was gone from disk but no Discord
          // effect had taken place, leaving callers stranded.
          //
          // Planning conditions (all of which must hold for migration
          // to even be eligible):
          //   - shim explicitly opted in via legacy_session_id + canonical_cwd
          //   - mode === 'thread' (DM never reads/writes bindings)
          //   - the legacy and new keys differ (degenerate hint guard)
          //   - the new key has no live binding yet
          //   - the legacy binding still lacks canonical_cwd (i.e. has
          //     not already been migrated by a prior register)
          //
          // The canonical_cwd presence guard prevents a buggy client
          // from causing repeated re-migrations: without it, the merged
          // patch would record `canonical_cwd: undefined`, JSON.stringify
          // would omit it, and the next register would think the entry
          // is pre-migration again.
          const migrationLegacyKey: string | undefined =
            msg.legacy_session_id
            && msg.canonical_cwd !== undefined
            && msg.mode === 'thread'
            && msg.legacy_session_id !== msg.session_id
            && !bindings[msg.session_id]
            && bindings[msg.legacy_session_id]
            && bindings[msg.legacy_session_id].canonical_cwd === undefined
              ? msg.legacy_session_id
              : undefined

          // Effective view of "the binding to inherit from". When a
          // migration is planned, the legacy entry stands in for
          // bindings[msg.session_id] for the rest of this register.
          // Reads only — the disk rename happens at commit time.
          const inheritedBinding = bindings[msg.session_id]
            ?? (migrationLegacyKey ? bindings[migrationLegacyKey] : undefined)

          if (sessions.has(msg.session_id)) {
            const code = msg.mode === 'dm' ? 'dm_session_taken' : 'thread_session_taken'
            const message = 'this session_id is already registered'
            writeFrame(sock, { type: 'register_err', id: msg.id, code, message })
            logRegister({ outcome: 'err', mode: msg.mode, session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, code, message })
            continue
          }

          // Reserve the session_id synchronously so a concurrent register
          // with the same session_id (which would otherwise also pass the
          // sessions.has() check above before any await yields) fails fast
          // instead of doubly-creating threads + double-acking. The
          // placeholder uses thread_id=null; inbound routing keys off
          // threadIndex (still unset) or dmSessionId (also still unset), so
          // no traffic can land on this half-registered session yet.
          sessions.set(msg.session_id, { session_id: msg.session_id, mode: msg.mode, thread_id: null, parent_id: null, sock })

          // reservedThreadId tracks the thread_id we have synchronously
          // claimed in threadIndex on behalf of this session, so the
          // `finally` block can release it on any failure path.
          let reservedThreadId: string | null = null
          // parent_id of the bound thread (null in DM mode); resolved per
          // branch below so ask-flow authorization can key off the right
          // per-group allowFrom on every interaction.
          let parentId: string | null = null
          let committed = false
          // reuseFlag distinguishes "we reused an existing bindings.json
          // entry" from "we just created (or are re-claiming via explicit
          // thread_id) the binding now". Set per branch, logged once at the
          // single thread-mode success site below.
          let reuseFlag = false
          try {
            if (msg.mode === 'dm') {
              if (dmSessionId !== null) {
                const errMessage = 'a DM-mode shim is already registered'
                writeFrame(sock, { type: 'register_err', id: msg.id, code: 'dm_session_taken', message: errMessage })
                logRegister({ outcome: 'err', mode: 'dm', session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, code: 'dm_session_taken', message: errMessage })
                continue
              }
              // Send the ack BEFORE claiming dmSessionId / mySessionId. If
              // writeFrame throws synchronously (e.g. the shim already
              // disconnected), neither identifier has clean-up logic in the
              // finally block, so a pre-emptive assignment would permanently
              // leak the DM slot for the rest of the daemon's lifetime.
              writeFrame(sock, { type: 'register_ack', id: msg.id, session_id: msg.session_id, thread_id: null })
              logRegister({ outcome: 'ok', mode: 'dm', session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, thread_id: null })
              dmSessionId = msg.session_id
              mySessionId = msg.session_id
              committed = true
              continue
            }

            // thread mode
            let threadId = msg.thread_id!
            if (threadId === 'auto') {
              // `inheritedBinding` already folds in the migration-pending
              // legacy entry, so this branch transparently handles both
              // plain reuse and "legacy entry waiting to be migrated".
              const existing = inheritedBinding
              if (existing) {
                threadId = existing.thread_id
                // Reusing a previously-persisted binding. Claim the thread
                // synchronously to fail fast on a concurrent reuse race.
                // If the claim fails here, no disk write has occurred yet —
                // the deferred migration further down is skipped because
                // we `continue` straight to the per-register finally block.
                if (threadIndex.has(threadId)) {
                  const errMessage = 'this thread is already bound to another session'
                  writeFrame(sock, { type: 'register_err', id: msg.id, code: 'thread_session_taken', message: errMessage })
                  logRegister({ outcome: 'err', mode: 'thread', session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, thread_id: threadId, code: 'thread_session_taken', message: errMessage })
                  continue
                }
                threadIndex.set(threadId, msg.session_id)
                reservedThreadId = threadId
                // Recover parent for a reused binding: bindings.json doesn't
                // persist parent_id, so a Discord API round-trip is required.
                if (waitReady) await waitReady()
                parentId = await ops.verifyThreadParent(threadId)
                reuseFlag = true
              } else {
                if (!access.parentChannelId) {
                  const errMessage = 'parentChannelId is not set in access.json'
                  writeFrame(sock, { type: 'register_err', id: msg.id, code: 'parent_channel_unset', message: errMessage })
                  logRegister({ outcome: 'err', mode: 'thread', session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, code: 'parent_channel_unset', message: errMessage })
                  continue
                }
                const name = deriveThreadName(msg.cwd, msg.session_id, msg.thread_name)
                try {
                  if (waitReady) await waitReady()
                  const t = await ops.createThread(access.parentChannelId, name)
                  threadId = t.thread_id
                  parentId = access.parentChannelId
                } catch (err) {
                  const errMessage = `createThread failed: ${err instanceof Error ? err.message : String(err)}`
                  writeFrame(sock, { type: 'register_err', id: msg.id, code: 'discord_unavailable', message: errMessage })
                  logRegister({ outcome: 'err', mode: 'thread', session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, code: 'discord_unavailable', message: errMessage })
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
                    // Presence check, not truthy: an empty-string
                    // canonical_cwd is legitimate (e.g. a `/strip-me=`
                    // rewrite of an exactly-matching path) and must be
                    // persisted so self-contained verification works.
                    ...(msg.canonical_cwd !== undefined ? { canonical_cwd: msg.canonical_cwd } : {}),
                  })
                } catch (err) {
                  const errMessage = `bindings save failed: ${err instanceof Error ? err.message : String(err)}`
                  writeFrame(sock, { type: 'register_err', id: msg.id, code: 'bindings_save_failed', message: errMessage })
                  logRegister({ outcome: 'err', mode: 'thread', session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, thread_id: threadId, code: 'bindings_save_failed', message: errMessage })
                  continue
                }
                // reuseFlag stays false: this is a brand-new binding.
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
                const errMessage = 'this thread is already bound to another session'
                writeFrame(sock, { type: 'register_err', id: msg.id, code: 'thread_session_taken', message: errMessage })
                logRegister({ outcome: 'err', mode: 'thread', session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, thread_id: threadId, code: 'thread_session_taken', message: errMessage })
                continue
              }
              const parent = await ops.verifyThreadParent(threadId)
              if (!parent || !(parent in access.groups)) {
                const errMessage = 'thread parent is not opted in via /discord:access group add'
                writeFrame(sock, { type: 'register_err', id: msg.id, code: 'thread_not_allowed', message: errMessage })
                logRegister({ outcome: 'err', mode: 'thread', session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, thread_id: threadId, code: 'thread_not_allowed', message: errMessage })
                continue
              }
              parentId = parent
              // Recheck post-await: a concurrent register could have claimed
              // this thread while we were verifying its parent.
              if (threadIndex.has(threadId)) {
                const errMessage = 'this thread is already bound to another session'
                writeFrame(sock, { type: 'register_err', id: msg.id, code: 'thread_session_taken', message: errMessage })
                logRegister({ outcome: 'err', mode: 'thread', session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, thread_id: threadId, code: 'thread_session_taken', message: errMessage })
                continue
              }
              threadIndex.set(threadId, msg.session_id)
              reservedThreadId = threadId
              // Explicit thread_id can be either a fresh claim or a re-bind
              // of an existing entry — distinguish via `inheritedBinding`,
              // which includes a migration-pending legacy entry so the
              // re-bind path preserves its created_at across the rename.
              reuseFlag = inheritedBinding !== undefined
              try {
                // Presence check (!== undefined) instead of truthy so an
                // empty-string canonical_cwd is preserved through both the
                // fresh-from-msg path and the fallback that inherits the
                // previous binding's value. Truthy checks here would silently
                // drop legitimate '' values produced by exact-match rules
                // like `/strip-me=`.
                const canonicalToPersist = msg.canonical_cwd !== undefined
                  ? msg.canonical_cwd
                  : inheritedBinding?.canonical_cwd
                await upsertBinding(bindingsFile, msg.session_id, {
                  thread_id: threadId, cwd: msg.cwd,
                  created_at: inheritedBinding?.created_at ?? Date.now(),
                  last_seen_at: Date.now(),
                  ...(canonicalToPersist !== undefined ? { canonical_cwd: canonicalToPersist } : {}),
                })
              } catch (err) {
                const errMessage = `bindings save failed: ${err instanceof Error ? err.message : String(err)}`
                writeFrame(sock, { type: 'register_err', id: msg.id, code: 'bindings_save_failed', message: errMessage })
                logRegister({ outcome: 'err', mode: 'thread', session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, thread_id: threadId, code: 'bindings_save_failed', message: errMessage })
                continue
              }
            }

            // Deferred migration commit. By the time we reach here, every
            // possibly-failing check (thread claim, parent verify, fresh
            // upsert) has succeeded — committing the legacy→canonical
            // rename now means we won't leave bindings.json mutated under
            // a failed register, which was the bug that motivated this
            // ordering.
            //
            // For auto-reuse the rename + patch lands the canonical_cwd,
            // cwd, and last_seen_at refresh that upsertBinding skipped on
            // this path. For explicit-thread the upsertBinding above has
            // already written msg.session_id, so migrateBindingKey falls
            // into its "newKey already exists" branch and just deletes
            // the now-stale legacy entry.
            //
            // The non-null assertion on msg.canonical_cwd is gated by the
            // migrationLegacyKey computation above (which required
            // canonical_cwd !== undefined).
            if (migrationLegacyKey) {
              try {
                await migrateBindingKey(bindingsFile, migrationLegacyKey, msg.session_id, {
                  canonical_cwd: msg.canonical_cwd!,
                  cwd: msg.cwd,
                  last_seen_at: Date.now(),
                })
                logRegister({ outcome: 'migrate', mode: msg.mode, session_id: msg.session_id, legacy_session_id: migrationLegacyKey, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd })
              } catch (err) {
                const errMessage = `bindings migrate failed: ${err instanceof Error ? err.message : String(err)}`
                writeFrame(sock, { type: 'register_err', id: msg.id, code: 'bindings_migrate_failed', message: errMessage })
                logRegister({ outcome: 'err', mode: 'thread', session_id: msg.session_id, legacy_session_id: migrationLegacyKey, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, thread_id: threadId, code: 'bindings_migrate_failed', message: errMessage })
                continue
              }
            }

            // Send the ack BEFORE the final commit assignments. If writeFrame
            // throws synchronously, the finally block still cleans up
            // `sessions` and `threadIndex` (committed stays false), and
            // `mySessionId` is never assigned to a now-released session_id.
            writeFrame(sock, { type: 'register_ack', id: msg.id, session_id: msg.session_id, thread_id: threadId })
            logRegister({ outcome: 'ok', mode: 'thread', session_id: msg.session_id, cwd: msg.cwd, canonical_cwd: msg.canonical_cwd, thread_id: threadId, reuse: reuseFlag })
            // Finalize: upgrade the placeholder session entry to the real one
            // and bind this connection's outbound identity.
            sessions.set(msg.session_id, { session_id: msg.session_id, mode: 'thread', thread_id: threadId, parent_id: parentId, sock })
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
          const s = mySessionId ? sessions.get(mySessionId) ?? null : null
          const result = await runTool(msg.name, msg.args as Record<string, unknown>, s)
          writeFrame(sock, { type: 'tool_result', id: msg.id, ...result })
          continue
        }

        if (msg.type === 'hook_ask') {
          const s = sessions.get(msg.session_id)
          if (!s) {
            writeFrame(sock, { type: 'hook_ask_result', id: msg.id, ok: false, error: 'no registered session for session_id' })
            continue
          }
          const route = routeForSession(s)
          const allowFrom = allowFromForSession(s)
          const request_id = newAskRequestId()
          const timeoutMs = msg.timeout_ms ?? 600_000
          try {
            const result = await ops.ask(route, request_id, msg.questions, { allowFrom, timeoutMs })
            if ('cancelled' in result) {
              writeFrame(sock, { type: 'hook_ask_result', id: msg.id, ok: false, error: result.reason })
            } else {
              writeFrame(sock, {
                type: 'hook_ask_result', id: msg.id, ok: true,
                answers: result.answers.map(a => a.selection),
                notes: result.answers.map(a => a.notes),
              })
            }
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err)
            writeFrame(sock, { type: 'hook_ask_result', id: msg.id, ok: false, error: m })
          }
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
