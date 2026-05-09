# Discord — multi-session edition

Connect a Discord bot to your Claude Code with an MCP server. One bot serves
N concurrent CC sessions on a single host, each bound to its own Discord
thread; DMs land in a designated DM session.

When the bot receives a message, the MCP server forwards it to Claude and
exposes tools to reply, react, edit, fetch history, and download attachments.

## Forked from

This is a fork of the official Discord plugin in
[`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord),
based on commit
[`48aa4351`](https://github.com/anthropics/claude-plugins-official/commit/48aa4351).
Apache-2.0; modified files carry change notices per the license.

What this fork adds on top of upstream:

- One bot serving multiple CC sessions, each bound to its own Discord thread.
- Long-lived **daemon** owning the single Discord gateway; lightweight
  per-session **shim** speaks MCP to CC and a UDS protocol to the daemon.
- `DISCORD_THREAD_ID=auto` to lazy-create a thread per session, or pass an
  existing thread snowflake to bind to one.
- `DISCORD_THREAD_NAME` to override the auto-generated thread name.
- Permission prompts post inside the bound thread instead of fanning across
  all DMs.

Single-host only by design; multi-machine is out of scope.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- A clone of this repo somewhere on disk (it's a private fork, installed via
  a local marketplace rather than `claude-plugins-official`).

```sh
git clone git@github.com:danielfbm/claude-discord-multisession.git
cd claude-discord-multisession
bun install
```

## Quick Setup

> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md)
> for groups, multi-user setups, and the `access.json` schema.

**1. Create a Discord application and bot.**

In the [Discord Developer Portal](https://discord.com/developers/applications)
click **New Application** → name it. Sidebar → **Bot**:

- Set a username.
- **Privileged Gateway Intents** → enable **Message Content Intent**
  (without this every inbound message has empty content).
- Scroll up → **Reset Token** → copy the ~70-char token (only shown once).
  This is your `DISCORD_BOT_TOKEN`. Note: it's not the Application ID, the
  Client Secret, or the Public Key.

**2. Invite the bot to a guild.**

Discord won't let you DM a bot unless you share a server with it.

OAuth2 → **URL Generator**. Scope: `bot`. Permissions:

- View Channels
- Send Messages
- Send Messages in Threads
- **Create Public Threads** *(needed for multi-session auto-threads)*
- Read Message History
- Attach Files
- Add Reactions

Or use the precomputed integer `309237746752` directly:

```
https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=309237746752
```

**3. Install the plugin from this local repo.**

Inside a CC session:

```
/plugin marketplace add /absolute/path/to/claude-discord-multisession
/plugin install discord@danielfbm-discord
```

**4. Save the bot token.**

```
/discord:configure MTIz...
```

Writes `DISCORD_BOT_TOKEN=...` to `~/.claude/channels/discord/.env`. You can
also write that file by hand, or `export DISCORD_BOT_TOKEN=...` — shell env
takes precedence over the file.

> **State directory resolution.** The plugin picks the channel state dir
> in this order: `$DISCORD_STATE_DIR`, then
> `$CLAUDE_CONFIG_DIR/channels/discord` (if `CLAUDE_CONFIG_DIR` is set —
> devcontainers, shared volumes), then `~/.claude/channels/discord`.
> If you've relocated Claude Code's config dir, the channel follows it
> automatically. Use `DISCORD_STATE_DIR` only when running multiple bots
> on one machine (different tokens, separate allowlists).

**5. Relaunch with the channel flag.**

This fork lives in a custom marketplace, so it isn't on Anthropic's
managed channel allowlist. Use the development flag:

```sh
claude --dangerously-load-development-channels plugin:discord@danielfbm-discord
```

The flag opts you into running an unapproved channel source. Standard
prompt-injection caveats apply — trust the bot/server you connect to.

**6. Pair.**

DM the bot. It replies with a pairing code. Inside CC:

```
/discord:access pair <code>
```

Your next DM reaches the assistant.

**7. Lock it down.**

```
/discord:access policy allowlist
```

Stops strangers from getting pairing replies. Pairing was for capturing IDs;
the allowlist holds them.

## Multi-session via threads

Run multiple CC sessions through one bot, each in its own Discord thread.

> **Configure `parentChannelId` (step 2) before launching with
> `DISCORD_THREAD_ID=auto`.** Without a parent set, the shim refuses to
> register in thread mode and Claude Code surfaces it as the generic
> *"Failed to reconnect to plugin:discord:discord"*. The real error is
> `register failed (parent_channel_unset)` in `<state-dir>/daemon.log`.
> If your shell rc exports `DISCORD_THREAD_ID=auto` globally, complete
> Quick Setup in DM mode first (open a shell without the var), set the
> parent, then re-enable. See [Troubleshooting](#troubleshooting).

**1. Pick a parent channel.** Get its snowflake (Developer Mode →
right-click → Copy Channel ID). The bot must be a member of the guild that
owns this channel and have `Create Public Threads` there.

**2. Set it as the parent.** Inside any CC session that has the plugin
loaded:

```
/discord:configure parent 1502124892781547632
```

This writes `parentChannelId` and adds the channel to `groups` so inbound
thread messages pass the access gate.

**3. Launch a thread session from any working directory:**

```sh
cd ~/some/project
DISCORD_THREAD_ID=auto \
  claude --dangerously-load-development-channels plugin:discord@danielfbm-discord
```

The bot creates a thread named `<cwd-basename>` (e.g. `project`) and binds
this CC session to it. Subsequent launches from the same cwd reuse the same
thread.

**4. Launch additional sessions from other directories** the same way. Each
cwd produces a distinct session_id, a distinct thread, and a distinct shim.

**5. DMs** continue to land in whichever session was launched *without*
`DISCORD_THREAD_ID` (the "DM session"). Only one DM session at a time.

### Custom thread names

Override the default basename naming with an env var:

```sh
DISCORD_THREAD_ID=auto DISCORD_THREAD_NAME='Sprint 42 refactor' \
  claude --dangerously-load-development-channels plugin:discord@danielfbm-discord
```

The name is sanitized to word/space/`.`/`-` characters, trimmed, and capped
at 90 chars. Applied only at thread *creation* time — for an already-bound
cwd, edit `bindings.json` (see "Resetting a binding") or rename the thread
in Discord directly.

### Binding to an existing thread

If you've already created a thread by hand and want CC to bind to it:

```sh
# Get the thread ID: right-click the thread → Copy Thread ID
DISCORD_THREAD_ID=1502195236900966400 \
  claude --dangerously-load-development-channels plugin:discord@danielfbm-discord
```

The thread's parent channel must be opted into `groups` (step 2 of
Multi-session) for inbound messages to pass the gate.

### Resetting a binding

To start fresh in a working directory — new thread for the same cwd —
remove the session entry from `bindings.json`:

```sh
# session_id is sha1(realpath(cwd)).slice(0, 12)
jq 'del(."<session_id>")' ~/.claude/channels/discord/bindings.json \
  > /tmp/b.json && mv /tmp/b.json ~/.claude/channels/discord/bindings.json
```

The next launch with `DISCORD_THREAD_ID=auto` creates a new thread. The old
one stays in Discord as an orphan; archive or delete it manually.

### How it works

A long-lived **daemon** owns the single Discord gateway connection. Each
session's MCP server (the **shim**) talks to the daemon over a Unix socket
at `~/.claude/channels/discord/daemon.sock`. The daemon is lazy-spawned by
the first shim and idle-exits 60 s after the last shim disconnects.

Session identity: `sha1(realpath(launch_cwd))[:12]`. One CC per cwd.

Permission prompts in a thread session post inside the bound thread (so the
human can answer in-context). The DM session keeps fanning prompts to all
DMs in `allowFrom`.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, guild channels, mention
detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are Discord **snowflakes** (numeric — enable Developer
Mode, right-click → Copy ID). Default DM policy is `pairing`. Guild channels
are opt-in per channel ID via `groups`.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a channel. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments — max 10 files, 25 MB each. Auto-chunks; files attach to the first chunk. Returns sent message ID(s). |
| `react` | Add an emoji reaction by message ID. Unicode emoji work directly; custom emoji need `<:name:id>` form. |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |
| `fetch_messages` | Pull recent history from a channel (oldest-first). Capped at 100 per call. Each line includes the message ID so the model can `reply_to` it; attachments marked `+Natt`. |
| `download_attachment` | Download all attachments from a specific message ID to `~/.claude/channels/discord/inbox/`. Returns file paths + metadata. |

Inbound messages trigger a typing indicator automatically — Discord shows
"botname is typing…" while the assistant works.

## Attachments

Not auto-downloaded. The `<channel>` notification lists each attachment's
name, type, and size; the assistant calls
`download_attachment(chat_id, message_id)` when it actually wants the file.
Downloads land in `~/.claude/channels/discord/inbox/`.

Same path for attachments on historical messages found via `fetch_messages`
(messages with attachments are marked `+Natt`).

## Troubleshooting

When the shim fails to start, Claude Code shows the generic *"Failed to
reconnect to plugin:discord:discord"*. The real cause lives in
`<state-dir>/daemon.log` and on the shim's stderr. `<state-dir>` resolves
to `$DISCORD_STATE_DIR`, then `$CLAUDE_CONFIG_DIR/channels/discord`, then
`~/.claude/channels/discord` (see step 4 of Quick Setup).

| Error | Cause | Fix |
| --- | --- | --- |
| `discord daemon: DISCORD_BOT_TOKEN required\n  set in <path>/.env` | `.env` is in a different dir than the daemon resolves to. | Check `$CLAUDE_CONFIG_DIR` / `$DISCORD_STATE_DIR`; place `.env` in the dir the daemon actually points at (the path printed in the error). |
| `discord shim: register failed (parent_channel_unset)` | Launched with `DISCORD_THREAD_ID=auto` but `parentChannelId` is unset. | `/discord:configure parent <channelId>` first, then relaunch. |
| `discord daemon: login failed: Error [TokenInvalid]` | Token is malformed or revoked. | Developer Portal → Bot → Reset Token, then `/discord:configure <new-token>`. |
| MCP disconnects after working briefly, no clear error | Multiple daemons racing for the socket (resolved in 0.0.6). | `/plugin update discord@danielfbm-discord`, kill stray `bun ... server.ts --daemon` processes, restart Claude Code. |

If `daemon.log` is empty, the daemon never spawned — verify `bun` is on
`$PATH` and the cache install dir has a populated `node_modules/`.

## License

Apache-2.0. See [LICENSE](./LICENSE). Original work copyright Anthropic;
modifications copyright the contributors of this fork.
