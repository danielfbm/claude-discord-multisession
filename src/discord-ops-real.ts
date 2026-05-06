import {
  Client, ChannelType, ButtonBuilder, ButtonStyle, ActionRowBuilder, type Attachment,
} from 'discord.js'
import { writeFileSync, mkdirSync, statSync, realpathSync } from 'fs'
import { join, sep } from 'path'
import { chunk } from './chunk'
import { type Access } from './access'
import {
  type DiscordOps,
  type ReplyOpts,
  type FetchedMessage,
  type DownloadedAttachment,
  type ThreadInfo,
} from './discord-ops'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_CHUNK_LIMIT = 2000

export class RealDiscordOps implements DiscordOps {
  recentSentIds = new Set<string>()
  private RECENT_CAP = 200

  constructor(
    private client: Client,
    private getAccess: () => Access,
    private stateDir: string,
  ) {}

  private noteSent(id: string) {
    this.recentSentIds.add(id)
    if (this.recentSentIds.size > this.RECENT_CAP) {
      const first = this.recentSentIds.values().next().value
      if (first) this.recentSentIds.delete(first)
    }
  }

  private async fetchTextChannel(id: string) {
    const ch = await this.client.channels.fetch(id)
    if (!ch || !ch.isTextBased()) throw new Error(`channel ${id} not found or not text-based`)
    return ch as any
  }

  private assertSendable(f: string): void {
    let real: string, stateReal: string
    try {
      real = realpathSync(f)
      stateReal = realpathSync(this.stateDir)
    } catch { return }
    const inbox = join(stateReal, 'inbox')
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`)
    }
  }

  async reply(chat_id: string, text: string, opts: ReplyOpts = {}): Promise<string[]> {
    const ch = await this.fetchTextChannel(chat_id)
    if (!('send' in ch)) throw new Error('channel not sendable')
    const files = opts.files ?? []
    for (const f of files) {
      this.assertSendable(f)
      const st = statSync(f)
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
      }
    }
    if (files.length > 10) throw new Error('Discord allows max 10 attachments per message')

    const access = this.getAccess()
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
    const mode = access.chunkMode ?? 'length'
    const replyMode = access.replyToMode ?? 'first'
    const chunks = chunk(text, limit, mode)
    const ids: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const shouldReplyTo = opts.reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
      const sent = await ch.send({
        content: chunks[i],
        ...(i === 0 && files.length > 0 ? { files } : {}),
        ...(shouldReplyTo ? { reply: { messageReference: opts.reply_to, failIfNotExists: false } } : {}),
      })
      this.noteSent(sent.id)
      ids.push(sent.id)
    }
    return ids
  }

  async react(chat_id: string, message_id: string, emoji: string): Promise<void> {
    const ch = await this.fetchTextChannel(chat_id)
    const msg = await ch.messages.fetch(message_id)
    await msg.react(emoji)
  }

  async edit(chat_id: string, message_id: string, text: string): Promise<string> {
    const ch = await this.fetchTextChannel(chat_id)
    const msg = await ch.messages.fetch(message_id)
    const edited = await msg.edit(text)
    return edited.id
  }

  async fetch(chat_id: string, limit: number): Promise<FetchedMessage[]> {
    const ch = await this.fetchTextChannel(chat_id)
    const msgs = await ch.messages.fetch({ limit: Math.min(limit, 100) })
    const me = this.client.user?.id
    const arr = [...msgs.values()].reverse()
    return arr.map((m: any) => ({
      id: m.id,
      ts: m.createdAt.toISOString(),
      author_id: m.author.id,
      author_name: m.author.id === me ? 'me' : m.author.username,
      content: m.content,
      attachment_count: m.attachments.size,
    }))
  }

  async downloadAttachments(chat_id: string, message_id: string, dir: string): Promise<DownloadedAttachment[]> {
    mkdirSync(dir, { recursive: true })
    const ch = await this.fetchTextChannel(chat_id)
    const msg = await ch.messages.fetch(message_id)
    const out: DownloadedAttachment[] = []
    for (const att of msg.attachments.values() as IterableIterator<Attachment>) {
      if (att.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`)
      }
      const res = await fetch(att.url)
      const buf = Buffer.from(await res.arrayBuffer())
      const name = att.name ?? att.id
      const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const path = join(dir, `${Date.now()}-${att.id}.${ext}`)
      writeFileSync(path, buf)
      out.push({
        path,
        name: name.replace(/[\[\]\r\n;]/g, '_'),
        type: att.contentType ?? 'unknown',
        bytes: att.size,
      })
    }
    return out
  }

  async createThread(parent_channel_id: string, name: string): Promise<ThreadInfo> {
    const parent = await this.fetchTextChannel(parent_channel_id)
    if (!('threads' in parent)) {
      throw new Error(`channel ${parent_channel_id} cannot host threads`)
    }
    const t = await parent.threads.create({ name, autoArchiveDuration: 1440 })
    const url = parent.guildId ? `https://discord.com/channels/${parent.guildId}/${t.id}` : undefined
    return { thread_id: t.id, thread_name: t.name, thread_url: url }
  }

  async verifyThreadParent(thread_id: string): Promise<string | null> {
    try {
      const ch: any = await this.client.channels.fetch(thread_id)
      if (!ch || !ch.isThread()) return null
      return ch.parentId ?? null
    } catch {
      return null
    }
  }

  async postPermissionPrompt(chat_id: string, request_id: string, tool_name: string): Promise<void> {
    const ch = await this.fetchTextChannel(chat_id)
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:more:${request_id}`).setLabel('See more').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`perm:allow:${request_id}`).setLabel('Allow').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${request_id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
    )
    await ch.send({ content: `🔐 Permission: ${tool_name}`, components: [row] })
  }

  async postPermissionPromptDM(allowFrom: string[], request_id: string, tool_name: string): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:more:${request_id}`).setLabel('See more').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`perm:allow:${request_id}`).setLabel('Allow').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${request_id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
    )
    for (const userId of allowFrom) {
      try {
        const u = await this.client.users.fetch(userId)
        await u.send({ content: `🔐 Permission: ${tool_name}`, components: [row] })
      } catch (e) {
        process.stderr.write(`postPermissionPromptDM ${userId}: ${e}\n`)
      }
    }
  }
}
