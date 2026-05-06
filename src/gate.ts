import { randomBytes } from 'crypto'
import type { Access } from './access'

export type GateInput = {
  senderId: string
  isDM: boolean
  /** Channel ID where the message arrived. For threads, this is the thread ID. */
  channelId: string
  /** Parent channel ID if `channelId` is a thread, else undefined. */
  parentChannelId?: string
  content: string
  /** True if Discord's structured @bot mention is present. */
  hasBotMention: boolean
  /** True if this is a reply to one of the bot's recent messages. */
  isReplyToBot: boolean
}

export type GateResult =
  | { action: 'deliver' }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

const PAIRING_CAP = 3
const PAIRING_TTL_MS = 60 * 60 * 1000
const REPLY_CAP = 2

export function gate(input: GateInput, access: Access): GateResult {
  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  if (input.isDM) return gateDM(input, access)

  // Threads inherit their parent channel's group policy.
  const lookupKey = input.parentChannelId ?? input.channelId
  const policy = access.groups[lookupKey]
  if (!policy) return { action: 'drop' }
  const groupAllow = policy.allowFrom ?? []
  const requireMention = policy.requireMention ?? true
  if (groupAllow.length > 0 && !groupAllow.includes(input.senderId)) {
    return { action: 'drop' }
  }
  if (requireMention && !mentioned(input, access.mentionPatterns)) {
    return { action: 'drop' }
  }
  return { action: 'deliver' }
}

function gateDM(input: GateInput, access: Access): GateResult {
  if (access.allowFrom.includes(input.senderId)) return { action: 'deliver' }
  if (access.dmPolicy === 'allowlist') return { action: 'drop' }

  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === input.senderId) {
      if ((p.replies ?? 1) >= REPLY_CAP) return { action: 'drop' }
      p.replies = (p.replies ?? 1) + 1
      return { action: 'pair', code, isResend: true }
    }
  }
  if (Object.keys(access.pending).length >= PAIRING_CAP) return { action: 'drop' }

  const code = randomBytes(3).toString('hex')
  const now = Date.now()
  access.pending[code] = {
    senderId: input.senderId,
    chatId: input.channelId,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    replies: 1,
  }
  return { action: 'pair', code, isResend: false }
}

function mentioned(input: GateInput, patterns?: string[]): boolean {
  if (input.hasBotMention) return true
  if (input.isReplyToBot) return true
  for (const pat of patterns ?? []) {
    try { if (new RegExp(pat, 'i').test(input.content)) return true } catch {}
  }
  return false
}
