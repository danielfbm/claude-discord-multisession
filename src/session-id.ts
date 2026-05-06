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
 * Discord thread name derived from cwd basename + short session id.
 * Discord caps thread names at 100 chars; we cap basename at 80 to leave
 * room for the suffix.
 */
export function deriveThreadName(cwd: string, sessionId: string): string {
  const raw = basename(cwd) || 'claude'
  const trimmed = raw.length > 80 ? raw.slice(0, 80) : raw
  return `${trimmed}-${sessionId.slice(0, 6)}`
}
