import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import { basename } from 'path'

/**
 * Env var that lets users normalize machine-specific cwd prefixes so the
 * same project produces the same session_id across machines. Format:
 *
 *     CLAUDE_DISCORD_CWD_REWRITE="<from1>=<to1>,<from2>=<to2>"
 *
 * Each rule is a *literal prefix* match applied at a directory boundary
 * (the realpath must equal `from` or start with `from + '/'`). Rules are
 * tried longest-prefix-first; the first match wins. Unset / empty value
 * means "no rewrite" and the hash is computed from realpath(cwd) verbatim,
 * matching the v1 behavior.
 */
export const CWD_REWRITE_ENV = 'CLAUDE_DISCORD_CWD_REWRITE'

export type RewriteRule = { from: string; to: string }

/**
 * Parse the rewrite-rule spec. Tolerant of empty/undefined input (returns
 * []). Malformed segments (missing `=`, blank `from`) are skipped silently
 * — we'd rather degrade to legacy hashing than crash the shim, since this
 * env is set by the user and a typo should not break Discord routing.
 *
 * Rules are returned sorted by `from.length` desc so the caller can apply
 * longest-prefix-wins by iterating in order.
 */
export function parseCwdRewriteRules(spec: string | undefined | null): RewriteRule[] {
  if (!spec) return []
  const out: RewriteRule[] = []
  for (const raw of spec.split(',')) {
    const seg = raw.trim()
    if (!seg) continue
    const eq = seg.indexOf('=')
    if (eq <= 0) continue
    const from = stripTrailingSlash(seg.slice(0, eq).trim())
    const to = stripTrailingSlash(seg.slice(eq + 1).trim())
    // Reject empty `from` and bare `/` — they're either malformed or a
    // footgun (a rule rooted at `/` only matches `/` itself given the
    // boundary check below, so it would never do anything useful).
    if (!from || from === '/') continue
    out.push({ from, to })
  }
  // Longest prefix wins. Stable sort would also tie-break by insertion
  // order, which is what we want for human predictability.
  out.sort((a, b) => b.from.length - a.from.length)
  return out
}

function stripTrailingSlash(p: string): string {
  // Normalize "/a/b/" → "/a/b" so the boundary check below doesn't need to
  // care whether the user wrote the trailing slash.
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1)
  return p
}

/**
 * Apply rewrite rules to a realpath. Match is at the directory boundary
 * only: `from` matches when path === from or path starts with `from + '/'`.
 * No partial / mid-component substitution — that would silently rewrite
 * paths the user did not intend.
 *
 * Boundary join: for the descendant branch the suffix always starts with
 * '/'. When `to` is exactly '/' (rewrite-to-root) the naive concatenation
 * `to + suffix` produces a leading '//' that hashes to a different value
 * than the real `/suffix` path on machines that don't rewrite — breaking
 * the cross-machine reuse invariant the rewrite is meant to provide. We
 * special-case `to === '/'` so '/mnt/ssd=/' applied to '/mnt/ssd/proj'
 * returns '/proj' instead of '//proj'. Exact-match still returns `to`
 * verbatim ('/'), which is the intended canonical form.
 */
export function applyCwdRewrite(realpath: string, rules: RewriteRule[]): string {
  for (const r of rules) {
    if (realpath === r.from) return r.to
    if (realpath.startsWith(r.from + '/')) {
      const suffix = realpath.slice(r.from.length) // starts with '/'
      return r.to === '/' ? suffix : r.to + suffix
    }
  }
  return realpath
}

function sha12(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/**
 * Stable identifier for "this Claude Code session in this cwd."
 * v1: SHA-1 of realpath(cwd), first 12 hex chars. Implies one CC per cwd.
 * v2: when CLAUDE_DISCORD_CWD_REWRITE is set, the realpath is normalized
 * first so the same logical project hashes the same across machines.
 */
export function deriveSessionId(cwd: string): string {
  return deriveSessionIdInfo(cwd).sessionId
}

export type SessionIdInfo = {
  /** The current 12-hex key — what to register / look up under. */
  sessionId: string
  /** The path that was sha1'd. Equals realpath when no rewrite applied. */
  canonicalCwd: string
  /** sha1(realpath) — the pre-rewrite key, for migrating legacy entries. */
  legacySessionId: string
  /** True iff rewrite rules changed the path. When false, canonicalCwd
   *  == realpath and legacySessionId == sessionId, so the shim should
   *  omit the migration hints from the register frame to keep the wire
   *  shape clean. */
  rewriteApplied: boolean
}

/**
 * Full breakdown of how the session_id was derived. Used by the shim to
 * include legacy_session_id + canonical_cwd in the register frame so the
 * daemon can migrate pre-rewrite bindings to the new key on first use.
 *
 * `env` is injectable for testability. Production callers pass process.env.
 */
export function deriveSessionIdInfo(cwd: string, env: NodeJS.ProcessEnv = process.env): SessionIdInfo {
  let real: string
  try { real = realpathSync(cwd) } catch { real = cwd }
  const rules = parseCwdRewriteRules(env[CWD_REWRITE_ENV])
  const canonical = applyCwdRewrite(real, rules)
  const legacy = sha12(real)
  const id = canonical === real ? legacy : sha12(canonical)
  return {
    sessionId: id,
    canonicalCwd: canonical,
    legacySessionId: legacy,
    rewriteApplied: canonical !== real,
  }
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
