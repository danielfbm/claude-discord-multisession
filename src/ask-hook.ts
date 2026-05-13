/**
 * PreToolUse hook for AskUserQuestion. Runs as a short-lived process invoked
 * by Claude Code when the model is about to call AskUserQuestion. Reads the
 * PreToolUse payload from stdin, asks the daemon to render the question over
 * Discord, blocks until the user answers, then prints a hook response that
 * denies the built-in tool call and supplies the user's answer in the deny
 * reason (the only short-circuit channel the hook contract exposes).
 *
 * If anything goes wrong (daemon not running, no session bound, parse fail),
 * prints `{}` so Claude Code falls back to the built-in UI without surfacing
 * a hook error to the user.
 */
import { createConnection, type Socket } from 'net'
import { existsSync } from 'fs'
import { join } from 'path'
import { readFrames, writeFrame } from './framing'
import { deriveSessionId } from './session-id'
import { getStateDir } from './state-dir'
import { loadAccess } from './access'

const FALLBACK = '{}\n'

function fallback(): void {
  process.stdout.write(FALLBACK)
}

async function readStdin(): Promise<string> {
  return new Promise(res => {
    let buf = ''
    process.stdin.on('data', c => { buf += c.toString('utf8') })
    process.stdin.on('end', () => res(buf))
  })
}

async function connect(sockPath: string): Promise<Socket | null> {
  if (!existsSync(sockPath)) return null
  return new Promise(res => {
    const s = createConnection(sockPath)
    s.once('connect', () => res(s))
    s.once('error', () => { try { s.destroy() } catch {}; res(null) })
  })
}

export async function runAskHook(): Promise<void> {
  let payload: any
  try { payload = JSON.parse(await readStdin()) } catch { fallback(); return }
  if (payload?.tool_name !== 'AskUserQuestion') { fallback(); return }

  // Feature gate: opt-in via access.json. If disabled, fall through so
  // Claude Code's built-in AskUserQuestion UI runs.
  const stateDir = getStateDir()
  const accessFile = join(stateDir, 'access.json')
  let enabled = false
  try { enabled = loadAccess(accessFile).askUserQuestionHook === true } catch {}
  if (!enabled) { fallback(); return }

  const rawQuestions = payload?.tool_input?.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) { fallback(); return }

  const questions = rawQuestions.map((q: any) => ({
    question: String(q?.question ?? ''),
    header: q?.header ? String(q.header) : undefined,
    multiSelect: !!q?.multiSelect,
    options: Array.isArray(q?.options)
      ? q.options.map((o: any) => ({
          label: String(o?.label ?? ''),
          description: o?.description ? String(o.description) : undefined,
        })).filter((o: any) => o.label)
      : [],
  })).filter((q: any) => q.question && q.options.length > 0)
  if (questions.length === 0) { fallback(); return }

  const sockPath = join(stateDir, 'daemon.sock')
  const sock = await connect(sockPath)
  if (!sock) { fallback(); return }

  const session_id = process.env.CLAUDE_SESSION_ID ?? deriveSessionId(payload?.cwd ?? process.cwd())
  writeFrame(sock, { type: 'hook_ask', id: 1, session_id, questions, timeout_ms: 600_000 })

  let result: any = null
  try {
    for await (const f of readFrames(sock)) { result = f; break }
  } catch {
    fallback(); try { sock.destroy() } catch {}; return
  }
  try { sock.end() } catch {}

  if (!result || result.type !== 'hook_ask_result' || !result.ok) {
    // Daemon couldn't route (no bound session, etc.) → fall back to built-in UI.
    fallback(); return
  }

  const lines: string[] = []
  for (let i = 0; i < questions.length; i++) {
    const a = result.answers?.[i]
    const note = result.notes?.[i]
    const ans = Array.isArray(a) ? a.join(', ') : (a ?? '')
    lines.push(`Q${i + 1}: ${questions[i].question}\nA: ${ans}${note ? ` (notes: ${note})` : ''}`)
  }
  const reason = `User answered via Discord:\n${lines.join('\n\n')}`
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n')
}
