import {
  Client, ChannelType, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  type Attachment, type ButtonInteraction, type StringSelectMenuInteraction,
  type ModalSubmitInteraction, type Message, type DMChannel,
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
  type AskRoute,
  type AskResult,
  type AskAnswer,
} from './discord-ops'
import type { AskQuestion } from './protocol'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_CHUNK_LIMIT = 2000

type PendingAsk = {
  request_id: string
  questions: AskQuestion[]
  allowFrom: string[]
  answers: AskAnswer[]
  currentIdx: number
  selectValues: Map<number, string[]>  // qIdx → in-progress multi-select values
  postedMessages: Message[]
  route: AskRoute
  resolve: (r: AskResult) => void
  timer: NodeJS.Timeout
}

export class RealDiscordOps implements DiscordOps {
  recentSentIds = new Set<string>()
  private RECENT_CAP = 200
  private pendingAsks = new Map<string, PendingAsk>()

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

  ask(route: AskRoute, request_id: string, questions: AskQuestion[], opts: { allowFrom: string[]; timeoutMs: number }): Promise<AskResult> {
    return new Promise<AskResult>(resolve => {
      const timer = setTimeout(() => this.finishAsk(request_id, { cancelled: true, reason: 'timeout' }), opts.timeoutMs)
      const pending: PendingAsk = {
        request_id, questions, allowFrom: opts.allowFrom, answers: [], currentIdx: 0,
        selectValues: new Map(), postedMessages: [], route, resolve, timer,
      }
      this.pendingAsks.set(request_id, pending)
      void this.postCurrentQuestion(pending).catch(err => {
        this.finishAsk(request_id, { cancelled: true, reason: `post failed: ${err instanceof Error ? err.message : String(err)}` })
      })
    })
  }

  private finishAsk(request_id: string, result: AskResult): void {
    const p = this.pendingAsks.get(request_id)
    if (!p) return
    clearTimeout(p.timer)
    this.pendingAsks.delete(request_id)
    p.resolve(result)
  }

  private async postCurrentQuestion(pending: PendingAsk): Promise<void> {
    const q = pending.questions[pending.currentIdx]
    if (!q) {
      this.finishAsk(pending.request_id, { answers: pending.answers })
      return
    }

    const header = q.header ? `**[${q.header}]** ` : ''
    const prefix = pending.questions.length > 1 ? `*Question ${pending.currentIdx + 1} of ${pending.questions.length}*\n` : ''
    const optsBody = q.options.map((o, i) => o.description ? `${i + 1}. **${o.label}** — ${o.description}` : `${i + 1}. **${o.label}**`).join('\n')
    const content = `${prefix}${header}${q.question}\n\n${optsBody}`

    const rows = this.buildAskRows(pending.request_id, pending.currentIdx, q)

    if (pending.route.kind === 'thread') {
      const ch = await this.fetchTextChannel(pending.route.chat_id)
      const msg = await ch.send({ content, components: rows })
      this.noteSent(msg.id)
      pending.postedMessages.push(msg)
    } else {
      const userId = pending.route.user_ids[0]
      if (!userId) throw new Error('discord_ask DM route has no allowFrom user')
      const u = await this.client.users.fetch(userId)
      const msg = await u.send({ content, components: rows })
      this.noteSent(msg.id)
      pending.postedMessages.push(msg)
    }
  }

  private buildAskRows(request_id: string, qIdx: number, q: AskQuestion): ActionRowBuilder<any>[] {
    const useSelect = q.multiSelect || q.options.length > 5
    if (!useSelect) {
      // Single-select buttons + Other.
      const buttons = q.options.map((o, i) =>
        new ButtonBuilder()
          .setCustomId(`ask:btn:${request_id}:${qIdx}:${i}`)
          .setLabel(o.label.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
      )
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`ask:other:${request_id}:${qIdx}`)
          .setLabel('Other…')
          .setStyle(ButtonStyle.Secondary)
      )
      // Discord allows 5 buttons per row; split if needed.
      const rows: ActionRowBuilder<ButtonBuilder>[] = []
      for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)))
      }
      return rows
    }

    // String-select menu (multi-select or >5 options).
    const select = new StringSelectMenuBuilder()
      .setCustomId(`ask:sel:${request_id}:${qIdx}`)
      .setPlaceholder(q.multiSelect ? 'Pick one or more…' : 'Pick one…')
      .setMinValues(q.multiSelect ? 1 : 1)
      .setMaxValues(q.multiSelect ? Math.min(q.options.length, 25) : 1)
      .addOptions(q.options.slice(0, 25).map((o, i) => ({
        label: o.label.slice(0, 100),
        value: String(i),
        description: o.description ? o.description.slice(0, 100) : undefined,
      })))

    const rows: ActionRowBuilder<any>[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)]
    if (q.multiSelect) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ask:sub:${request_id}:${qIdx}`).setLabel('Submit').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`ask:other:${request_id}:${qIdx}`).setLabel('Other…').setStyle(ButtonStyle.Secondary),
      ))
    } else {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ask:other:${request_id}:${qIdx}`).setLabel('Other…').setStyle(ButtonStyle.Secondary),
      ))
    }
    return rows
  }

  /**
   * Called from the daemon's interactionCreate handler for any customId
   * starting with `ask:`. Returns true if handled.
   */
  async handleAskInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
    const cid = interaction.customId
    if (!cid.startsWith('ask:')) return false
    const parts = cid.split(':')
    const kind = parts[1]
    const request_id = parts[2]
    const qIdx = parseInt(parts[3] ?? '-1', 10)
    const pending = this.pendingAsks.get(request_id)
    if (!pending) {
      try { await (interaction as any).reply({ content: 'This question is no longer pending.', ephemeral: true }) } catch {}
      return true
    }
    // Empty allowFrom = no per-user restriction (thread mode with an open
    // group policy). Anyone who can see the thread can answer.
    if (pending.allowFrom.length > 0 && !pending.allowFrom.includes(interaction.user.id)) {
      try { await (interaction as any).reply({ content: 'Not authorized.', ephemeral: true }) } catch {}
      return true
    }
    if (qIdx !== pending.currentIdx) {
      try { await (interaction as any).reply({ content: 'That question was already answered.', ephemeral: true }) } catch {}
      return true
    }
    const q = pending.questions[qIdx]
    if (!q) return true

    if (kind === 'btn' && interaction.isButton()) {
      const optIdx = parseInt(parts[4] ?? '-1', 10)
      const opt = q.options[optIdx]
      if (!opt) return true
      pending.answers.push({ selection: opt.label })
      await interaction.update({ content: `${interaction.message.content}\n\n✅ **${opt.label}**`, components: [] }).catch(() => {})
      await this.advance(pending)
      return true
    }

    if (kind === 'sel' && interaction.isStringSelectMenu()) {
      const values = interaction.values.map(v => q.options[parseInt(v, 10)]?.label).filter((v): v is string => typeof v === 'string')
      if (q.multiSelect) {
        // Multi-select: remember choice; wait for Submit.
        pending.selectValues.set(qIdx, values)
        await interaction.deferUpdate().catch(() => {})
        return true
      }
      // Single-value select: finalize immediately.
      pending.answers.push({ selection: values[0] ?? '' })
      await interaction.update({ content: `${interaction.message.content}\n\n✅ **${values[0] ?? ''}**`, components: [] }).catch(() => {})
      await this.advance(pending)
      return true
    }

    if (kind === 'sub' && interaction.isButton()) {
      const values = pending.selectValues.get(qIdx) ?? []
      if (values.length === 0) {
        try { await interaction.reply({ content: 'Pick at least one option first.', ephemeral: true }) } catch {}
        return true
      }
      pending.answers.push({ selection: values })
      await interaction.update({ content: `${interaction.message.content}\n\n✅ **${values.join(', ')}**`, components: [] }).catch(() => {})
      await this.advance(pending)
      return true
    }

    if (kind === 'other' && interaction.isButton()) {
      const modal = new ModalBuilder()
        .setCustomId(`ask:mod:${request_id}:${qIdx}`)
        .setTitle(this.truncate(q.question, 45))
      const input = new TextInputBuilder()
        .setCustomId('text')
        .setLabel('Your answer')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
      await interaction.showModal(modal).catch(() => {})
      return true
    }

    if (kind === 'mod' && interaction.isModalSubmit()) {
      const text = interaction.fields.getTextInputValue('text')
      pending.answers.push({ selection: 'Other', notes: text })
      // Modal submit doesn't have a message to update; reply ephemerally,
      // and edit the original question message to mark it answered.
      const orig = pending.postedMessages[qIdx]
      if (orig) {
        await orig.edit({ content: `${orig.content}\n\n✅ **Other**: ${this.truncate(text, 200)}`, components: [] }).catch(() => {})
      }
      await interaction.reply({ content: 'Recorded.', ephemeral: true }).catch(() => {})
      await this.advance(pending)
      return true
    }

    return false
  }

  private async advance(pending: PendingAsk): Promise<void> {
    pending.currentIdx += 1
    if (pending.currentIdx >= pending.questions.length) {
      this.finishAsk(pending.request_id, { answers: pending.answers })
      return
    }
    await this.postCurrentQuestion(pending).catch(err => {
      this.finishAsk(pending.request_id, { cancelled: true, reason: `post failed: ${err instanceof Error ? err.message : String(err)}` })
    })
  }

  private truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }
}
