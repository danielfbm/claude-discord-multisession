import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import { basename } from 'path'

/**
 * Stable identifier for "this Claude Code session in this cwd."
 * v1: SHA-1 of realpath(cwd), first 12 hex chars. Implies one CC per cwd.
 */
export function deriveSessionId(cwd: string): string {
  let real: string
  try { real = realpathSync(cwd) } catch { real = cwd }
  return createHash('sha1').update(real).digest('hex').slice(0, 12)
}

/**
 * Discord thread name. Priority:
 *   1. DISCORD_THREAD_NAME env (passed through register.thread_name)
 *   2. cwd basename (if unique enough for your workflow)
 *   3. fallback: basename + short id (the v1 default, kept as a safety net
 *      when callers explicitly want collision-resistant naming)
 *
 * Discord caps thread names at 100 chars; we cap at 90 to leave headroom.
 */
export function deriveThreadName(cwd: string, sessionId: string, override?: string): string {
  if (override) {
    // Whitelist: word chars, whitespace, `.`, `-`, and `/` (commonly used as a
    // namespace separator, e.g. "claude/foo"). Discord threads accept `/`.
    const safe = override.replace(/[^\w\s./-]/g, '').trim().slice(0, 90)
    if (safe) return safe
  }
  const raw = basename(cwd) || 'claude'
  return raw.length > 90 ? raw.slice(0, 90) : raw
}
