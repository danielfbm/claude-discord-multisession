/**
 * Resolve the Discord channel state directory.
 *
 * Priority (highest first):
 *   1. DISCORD_STATE_DIR — explicit per-instance override.
 *   2. CLAUDE_CONFIG_DIR — when Claude Code's config dir is relocated
 *      (devcontainers, shared volumes), keep channel state alongside it.
 *   3. ~/.claude/channels/discord — default.
 */
import { homedir } from 'os'
import { join } from 'path'

export function getStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DISCORD_STATE_DIR) return env.DISCORD_STATE_DIR
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, 'channels', 'discord')
  return join(homedir(), '.claude', 'channels', 'discord')
}
