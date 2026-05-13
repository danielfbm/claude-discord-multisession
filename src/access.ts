import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { dirname } from 'path'

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  /** Channel under which auto-thread-creation spawns threads. */
  parentChannelId?: string
  /**
   * When false, the shim's MCP `instructions` blob omits the
   * 👀 / ✅ / ❌ read-receipt paragraphs. Treated as `true` when
   * absent, preserving the historical default. Read once at shim
   * startup — not hot-reloadable, since `instructions` is published
   * during MCP server construction.
   */
  reactionGuidance?: boolean
  /**
   * Opt-in to the PreToolUse hook that intercepts the model's built-in
   * AskUserQuestion and renders the question over Discord. Default false.
   * The hook denies the tool call and supplies the user's answer as the
   * deny reason — that's the only short-circuit the hook contract exposes,
   * so transcripts of intercepted calls show as denied-with-prose-answer.
   * When false, the hook prints `{}` and Claude Code's built-in UI runs.
   */
  askUserQuestionHook?: boolean
}

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

export function loadAccess(file: string): Access {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      parentChannelId: parsed.parentChannelId,
      reactionGuidance: parsed.reactionGuidance,
      askUserQuestionHook: parsed.askUserQuestionHook,
    }
  } catch {
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
    return defaultAccess()
  }
}

export function saveAccess(file: string, a: Access): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}
