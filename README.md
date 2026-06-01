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
this CC session to it. If you `/clear` or the shim respawns, the *same* CC
process reattaches to that thread (the identity is tied to the CC process,
not the conversation).

**4. Launch additional sessions** — from other directories, or even the
**same** directory. Each concurrent Claude Code process gets its own thread:
with `DISCORD_THREAD_ID=auto` the identity folds in the CC process id, so two
sessions in one project no longer collide. To pin a session to a specific
thread regardless of cwd, pass an explicit `DISCORD_THREAD_ID=<snowflake>`
(below) — two sessions sharing the same explicit thread id supersede each
other (newest wins).

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
# session_id is sha1(canonical_cwd or realpath(cwd))[:12]; see
# scripts/derive-binding-key.sh for the exact derivation, including
# CLAUDE_DISCORD_CWD_REWRITE handling.
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

Session identity is keyed on the **thread**, so one project can host several
concurrent sessions:

| Launch | `session_id` | Effect |
|--------|--------------|--------|
| `DISCORD_THREAD_ID=<snowflake>` | `sha1('thread:'+id)[:12]` | Identity = the thread. Same id in two sessions → newest supersedes; different ids in one cwd → independent sessions. |
| `DISCORD_THREAD_ID=auto` | `sha1('auto:'+realpath+' '+ppid)[:12]` | Per-CC-process thread. Stable across `/clear` (same CC process), distinct between concurrent CC instances. |
| `DISCORD_THREAD_ID=project` | `sha1(realpath\|canonical)[:12]` | One stable thread per directory. Persists across full CC restarts (unlike `auto`). Carries `CLAUDE_DISCORD_CWD_REWRITE` migration. Use when restart-stability matters more than concurrent-session isolation. |
| no thread env (DM) | `sha1(realpath\|canonical)[:12]` | Legacy cwd identity + `CLAUDE_DISCORD_CWD_REWRITE` migration. One DM session at a time. |
| `CLAUDE_SESSION_ID=<x>` | `<x>` verbatim | You own the key (overrides all of the above). |

A register for an already-live `session_id` **takes over**: the daemon drops
the stale connection and binds the newcomer. This is what lets a `/clear`
(which respawns the shim) reconnect cleanly instead of being rejected as
"already registered". A genuine *concurrent* race (two registers in flight at
once) still fails one fast, so no duplicate thread is created.

Permission prompts in a thread session post inside the bound thread (so the
human can answer in-context). The DM session keeps fanning prompts to all
DMs in `allowFrom`.

### Cross-machine cwd portability

By default the session_id is `sha1(realpath(cwd))[:12]`, so the same logical
project hashes differently on machines whose paths diverge — e.g. a project
checked out at `/mnt/external-ssd/work/foo` on the desktop and at
`/home/me/work/foo` on the laptop. That means the second machine would
create a brand-new Discord thread instead of reusing the existing one.

Set `CLAUDE_DISCORD_CWD_REWRITE` to make the hash stable. The shim applies
literal prefix rewrites at directory boundaries before hashing:

```sh
# Format: "<from1>=<to1>,<from2>=<to2>"
export CLAUDE_DISCORD_CWD_REWRITE="/mnt/external-ssd/work=$HOME/work"
```

With this set, both `/mnt/external-ssd/work/foo` and `$HOME/work/foo`
sha1 the same canonical path and reuse the same thread.

Notes:

- **Backward compatible.** When the env is unset, behavior is byte-identical
  to v1 — no rewrite is applied and no extra fields are written to
  `bindings.json`.
- **One-shot migration.** When the env first becomes active for a cwd that
  already had a binding, the daemon renames the existing entry from the
  pre-rewrite key to the new key on the next register, preserving
  `thread_id`, `created_at`, and the Discord thread itself. The old key
  disappears from `bindings.json`.
- **Self-contained verification.** Migrated entries gain a `canonical_cwd`
  field that records the exact string that was sha1'd. Any consumer can
  verify the key without needing the env var configured locally — useful
  for inspecting `bindings.json` on a machine that doesn't share the
  rewrite rules.
- **Don't hand-edit `canonical_cwd`.** Removing the field on a migrated
  entry causes the next register to treat it as pre-migration and run the
  migration logic again, which may not be what you want. To reset a
  binding, delete the whole entry instead of stripping the field.
- **Match semantics.** `from` only matches at a directory boundary (the
  realpath equals `from` exactly, or starts with `from + '/'`). No
  mid-component substitution — `/long/path` does not match `/long/path-x`.
- **Rewrite to `/` is special-cased.** When `to` is the root, descendants
  of `from` keep their suffix as-is so the canonical path stays valid —
  `/mnt/ssd=/` applied to `/mnt/ssd/foo` yields `/foo`, not `//foo`. The
  exact-match case still returns `/`.
- **Longest prefix wins** when multiple rules could match. Malformed
  segments (no `=`, blank `from`, bare `/`) are silently skipped — the
  shim degrades to legacy hashing rather than crashing on a typo.
- **`CLAUDE_SESSION_ID` overrides everything.** If the user pins the
  session_id explicitly, rewrite rules are not consulted and no migration
  hints are sent.

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
| `discord_ask` | Ask the Discord user one or more structured questions (1–4 per call). Each question renders as Discord buttons (≤5 options, single-select) or a string-select menu (multi-select or >5 options), plus an **Other…** button that opens a modal for free-text. Blocks until the user answers or the timeout elapses (default 10 min, override via `timeout_ms`). Authorization is enforced per click against `access.allowFrom`. Returns the chosen labels per question. |

### `AskUserQuestion` PreToolUse hook (opt-in)

The plugin ships a `PreToolUse` hook on `AskUserQuestion`
(`hooks/hooks.json` → `${CLAUDE_PLUGIN_ROOT}/server.ts --ask-hook`) that can
auto-route the model's built-in `AskUserQuestion` calls through the same
Discord UI as `discord_ask`. **Disabled by default**; flip it on in
`access.json`:

```json
{
  "askUserQuestionHook": true
}
```

When enabled and the user clicks, the hook denies the underlying tool call
and supplies the answer as the deny reason — that's the only short-circuit
channel the hook contract exposes today, so intercepted calls show in the
transcript as denied-with-prose-answer rather than as a clean tool result.
For best results, prefer calling `discord_ask` directly when possible. When
the flag is `false` (or the daemon isn't running or no session is bound),
the hook prints `{}` and Claude Code's built-in UI runs unchanged.

**Routing & authorization for both `discord_ask` and the hook:**

| Session mode | Where the question posts | Who can click |
| --- | --- | --- |
| Thread | The bound thread | `access.groups[parent].allowFrom`. **Empty = open**: anyone with thread access can answer (matches inbound message semantics in `gate.ts`). |
| DM | DM to `access.allowFrom[0]` (the first paired user) | `access.allowFrom` |

The first valid click wins; subsequent clicks see "That question was already answered."

Inbound messages trigger a typing indicator automatically — Discord shows
"botname is typing…" while the assistant works.

### Read-receipt reactions (default on)

The shim's MCP `instructions` ask the assistant to react with 👀 on the
inbound message before doing multi-step work, and with ✅ / ❌ when the
work finishes. This gives the user a passive "Claude saw it / Claude is
done" signal without spamming reply messages.

To opt out — for example to save the ~270 tokens per turn the extra two
react calls cost, or to reduce field-name confusion between `react` and
`reply` in long sessions — set `reactionGuidance` in `access.json`:

```jsonc
{
  // ...
  "reactionGuidance": false
}
```

Or use the skill:

```
/discord:access set reactionGuidance false
```

The MCP `instructions` blob is built once at shim startup, so this
takes effect on the next shim restart (Claude Code reconnects on the
next MCP handshake). When off, the two guidance paragraphs are dropped
from `instructions` and the assistant will not be prompted to add 👀 /
✅ / ❌ reactions. All other tools (including `react` itself) keep
working — only the guidance is conditional.

### Register mode (gating which sessions claim Discord)

By default any CC session that loads the plugin registers with the daemon
and starts consuming Discord traffic — handy when every shell launches CC
through a Discord-aware wrapper. When that isn't the case (for example a
host where most `claude` invocations are unrelated to Discord and only a
specific launcher should hook into it), set `registerMode` to require an
explicit marker:

```jsonc
{
  // ...
  // "always" (default, absent === "always"): every shim registers.
  // "marked-only": shim registers only when at least one of
  // DISCORD_THREAD_ID / DISCORD_THREAD_NAME is set in the env.
  "registerMode": "marked-only"
}
```

In `marked-only` mode, a session that boots without either env exits
cleanly (`exit 0`) and logs a single line to stderr:

```
discord shim: skipped register (registerMode=marked-only, no DISCORD_THREAD_ID / DISCORD_THREAD_NAME set)
```

Claude Code treats the MCP server as absent for that session — no error
banner, no tools exposed. To opt a launcher in, have it export either env
before `claude` runs (the same envs the thread / DM selection logic
already reads):

```sh
# Opt the session in. DISCORD_THREAD_ID=auto picks the lazy-create flow.
DISCORD_THREAD_ID=auto claude --dangerously-load-development-channels plugin:discord@danielfbm-discord
```

The value is read once at shim startup; flipping `registerMode` requires
the next CC launch (or `/mcp` reconnect) to take effect.

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
| Tool returns `isError`: `reply requires field 'text' (string); got keys [chat_id, content, message_id]. did you mean 'text' instead of 'content'?` | The assistant called a Discord tool with the wrong field names — usually `content`/`message_id` leaking in from `react`/`edit_message`. Prior to validation this silently sent the 9-byte string "undefined" to the channel. | No operator action needed — the assistant should retry with the correct field names. If it keeps failing, check the LLM's tool input in the session jsonl. |

If `daemon.log` is empty, the daemon never spawned — verify `bun` is on
`$PATH` and the cache install dir has a populated `node_modules/`.

### Tracing a `bindings.json` entry

Every register attempt now emits a single key=value line into `daemon.log`,
so any entry in `bindings.json` is traceable back to the shim that wrote it:

```sh
grep "register outcome=" ~/.claude/channels/discord/daemon.log
# discord daemon: register outcome=ok mode=thread session_id=... cwd=... thread_id=... reuse=false
# discord daemon: register outcome=err  ... code=thread_session_taken message="..."
# discord daemon: register outcome=migrate ... legacy_session_id=...
```

`reuse=true` means the daemon re-bound a previously-persisted entry instead
of creating a fresh Discord thread. If a binding shows up that you cannot
recall creating, grep the log for its `session_id` to see the original
register frame's `cwd` and timestamp.

## License

Apache-2.0. See [LICENSE](./LICENSE). Original work copyright Anthropic;
modifications copyright the contributors of this fork.
