/**
 * Daemon entrypoint: loads env, instantiates discord.js Client + RealDiscordOps,
 * starts the UDS server, and bridges Discord events into the daemon's
 * deliverInbound / permissionDecision.
 *
 * Kept separate from src/daemon.ts so unit tests can import startDaemon()
 * without pulling in discord.js.
 */
import {
  Client, GatewayIntentBits, Partials, ChannelType,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  type Message, type Interaction,
} from 'discord.js'
import { readFileSync, chmodSync, readdirSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { startDaemon } from './daemon'
import { RealDiscordOps } from './discord-ops-real'
import { loadAccess } from './access'
import { getStateDir } from './state-dir'

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export async function runDaemon(): Promise<void> {
  const stateDir = getStateDir()
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const envFile = join(stateDir, '.env')
  try {
    chmodSync(envFile, 0o600)
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
  const TOKEN = process.env.DISCORD_BOT_TOKEN
  if (!TOKEN) {
    process.stderr.write(
      `discord daemon: DISCORD_BOT_TOKEN required\n  set in ${envFile}\n  format: DISCORD_BOT_TOKEN=MTIz...\n`,
    )
    process.exit(1)
  }

  process.on('unhandledRejection', err => {
    process.stderr.write(`discord daemon: unhandled rejection: ${err}\n`)
  })
  process.on('uncaughtException', err => {
    process.stderr.write(`discord daemon: uncaught exception: ${err}\n`)
  })

  const client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  })

  const accessFile = join(stateDir, 'access.json')
  const ops = new RealDiscordOps(client, () => loadAccess(accessFile), stateDir)

  // Promise that resolves on the FIRST gateway 'ready' event. The daemon
  // register handler awaits this before any channel-fetching call, which
  // prevents the "channel not found" race when a shim connects during the
  // ~1-3s login + READY window.
  const readyPromise = new Promise<void>(resolve => {
    client.once('ready', () => resolve())
  })

  const handle = await startDaemon({
    stateDir, ops, idleExitMs: 60_000,
    waitReady: () => readyPromise,
    onShutdown: async () => {
      try { await client.destroy() } catch {}
      process.exit(0)
    },
  })

  const dmChannelUsers = new Map<string, string>()

  client.on('messageCreate', async (msg: Message) => {
    if (msg.author.bot) return
    try {
      const isDM = msg.channel.type === ChannelType.DM
      let parentId: string | undefined
      if ('isThread' in msg.channel && msg.channel.isThread()) {
        parentId = msg.channel.parentId ?? undefined
      }

      let isReplyToBot = false
      const refId = msg.reference?.messageId
      if (refId && ops.recentSentIds.has(refId)) isReplyToBot = true
      else if (refId) {
        try {
          const r = await msg.fetchReference()
          if (r.author.id === client.user?.id) isReplyToBot = true
        } catch {}
      }

      // Permission-reply text intercept (only for allow-listed senders).
      const access = loadAccess(accessFile)
      if (access.allowFrom.includes(msg.author.id)) {
        const m = PERMISSION_REPLY_RE.exec(msg.content)
        if (m) {
          handle.permissionDecision(m[2]!.toLowerCase(), m[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny')
          void msg.react(m[1]!.toLowerCase().startsWith('y') ? '✅' : '❌').catch(() => {})
          return
        }
      }

      if (isDM) dmChannelUsers.set(msg.channelId, msg.author.id)

      // Typing indicator
      if ('sendTyping' in msg.channel) {
        void (msg.channel as any).sendTyping().catch(() => {})
      }
      if (access.ackReaction) {
        void msg.react(access.ackReaction).catch(() => {})
      }

      handle.deliverInbound({
        chat_id: msg.channelId,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: msg.createdAt.toISOString(),
        content: msg.content || (msg.attachments.size > 0 ? '(attachment)' : ''),
        isDM,
        parentChannelId: parentId,
        hasBotMention: !!(client.user && msg.mentions.has(client.user)),
        isReplyToBot,
        attachments: [...msg.attachments.values()].map(a => ({
          name: (a.name ?? a.id).replace(/[\[\]\r\n;]/g, '_'),
          type: a.contentType ?? 'unknown',
          bytes: a.size,
        })),
      })
    } catch (err) {
      process.stderr.write(`discord daemon: messageCreate handler failed: ${err}\n`)
    }
  })

  client.on('interactionCreate', async (interaction: Interaction) => {
    // Ask flow (buttons, string-select, modal submit).
    if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())
        && interaction.customId.startsWith('ask:')) {
      try { await ops.handleAskInteraction(interaction as any) }
      catch (err) { process.stderr.write(`handleAskInteraction failed: ${err}\n`) }
      return
    }
    if (!interaction.isButton()) return
    const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(interaction.customId)
    if (!m) return
    const access = loadAccess(accessFile)
    if (!access.allowFrom.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
      return
    }
    const [, behavior, request_id] = m

    if (behavior === 'more') {
      const details = handle.pendingPermissions.get(request_id)
      if (!details) {
        await interaction.reply({ content: 'Details no longer available.', ephemeral: true }).catch(() => {})
        return
      }
      let prettyInput: string
      try { prettyInput = JSON.stringify(JSON.parse(details.input_preview), null, 2) }
      catch { prettyInput = details.input_preview }
      const expanded =
        `🔐 Permission: ${details.tool_name}\n\n` +
        `tool_name: ${details.tool_name}\n` +
        `description: ${details.description}\n` +
        `input_preview:\n${prettyInput}`
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`perm:allow:${request_id}`).setLabel('Allow').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`perm:deny:${request_id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
      )
      await interaction.update({ content: expanded, components: [row] }).catch(() => {})
      return
    }

    handle.permissionDecision(request_id, behavior as 'allow' | 'deny')
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await interaction.update({
      content: `${interaction.message.content}\n\n${label}`,
      components: [],
    }).catch(() => {})
  })

  // Approval polling: the /discord:access skill writes approved/<senderId>
  // with the DM channel ID; we send "Paired!" on Discord and remove the file.
  const APPROVED_DIR = join(stateDir, 'approved')
  setInterval(() => {
    let files: string[]
    try { files = readdirSync(APPROVED_DIR) } catch { return }
    for (const senderId of files) {
      const path = join(APPROVED_DIR, senderId)
      let dmChannelId: string
      try { dmChannelId = readFileSync(path, 'utf8').trim() } catch { rmSync(path, { force: true }); continue }
      if (!dmChannelId) { rmSync(path, { force: true }); continue }
      void (async () => {
        try {
          const ch: any = await client.channels.fetch(dmChannelId)
          if ('send' in ch) await ch.send('Paired! Say hi to Claude.')
        } catch (err) {
          process.stderr.write(`discord daemon: failed to send approval confirm: ${err}\n`)
        }
        rmSync(path, { force: true })
      })()
    }
  }, 5000).unref()

  client.once('ready', c => {
    process.stderr.write(`discord daemon: gateway connected as ${c.user.tag}\n`)
  })
  client.on('error', err => {
    process.stderr.write(`discord daemon: client error: ${err}\n`)
  })

  client.login(TOKEN).catch(err => {
    process.stderr.write(`discord daemon: login failed: ${err}\n`)
    process.exit(1)
  })

  // handle.shutdown invokes onShutdown, which destroys the client and exits.
  const shutdown = () => { void handle.shutdown() }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
}
