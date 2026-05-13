import { z } from 'zod'

export const RegisterMsg = z.object({
  type: z.literal('register'),
  id: z.number(),
  session_id: z.string().min(1),
  mode: z.enum(['dm', 'thread']),
  cwd: z.string(),
  thread_id: z.string().optional(),
  thread_name: z.string().optional(),
  /**
   * Pre-rewrite key (sha1 of realpath only). Present iff the shim
   * applied CLAUDE_DISCORD_CWD_REWRITE and the resulting session_id
   * differs from the legacy hash. The daemon uses this to migrate a
   * pre-rewrite binding to the new key on first re-register, so users
   * keep their thread across the rule change.
   */
  legacy_session_id: z.string().optional(),
  /**
   * The rewritten path that the new session_id was sha1'd from. Stored
   * verbatim on the binding so the key can be re-verified later without
   * needing the env var configured (or even the path to exist locally).
   */
  canonical_cwd: z.string().optional(),
}).superRefine((v, ctx) => {
  if (v.mode === 'thread' && !v.thread_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'thread_id required when mode=thread' })
  }
})

export const RegisterAckMsg = z.object({
  type: z.literal('register_ack'),
  id: z.number(),
  session_id: z.string(),
  thread_id: z.string().nullable(),
  thread_name: z.string().optional(),
  thread_url: z.string().optional(),
})

export const RegisterErrMsg = z.object({
  type: z.literal('register_err'),
  id: z.number(),
  code: z.enum([
    'dm_session_taken',
    'thread_session_taken',
    'parent_channel_unset',
    'thread_not_allowed',
    'discord_unavailable',
    // Emitted when persisting the new binding to bindings.json fails after
    // a successful Discord createThread / verifyThreadParent. Distinct from
    // discord_unavailable so the shim and operators can tell a disk problem
    // apart from a Discord API problem.
    'bindings_save_failed',
    // Emitted when reading bindings.json fails (e.g. corrupt JSON, EACCES).
    // Returned per-register-request so a bad file does not bring down the
    // whole daemon message loop for every other shim.
    'bindings_load_failed',
    // Emitted when the legacy→canonical key migration fails (a rare path:
    // disk write error inside migrateBindingKey). Kept distinct from
    // bindings_save_failed so log greps can tell the two write paths apart
    // during incident response.
    'bindings_migrate_failed',
  ]),
  message: z.string(),
})

export const ToolCallMsg = z.object({
  type: z.literal('tool_call'),
  id: z.number(),
  name: z.enum(['reply', 'react', 'edit_message', 'fetch_messages', 'download_attachment', 'discord_ask']),
  args: z.record(z.string(), z.unknown()),
})

export const AskQuestionSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(z.object({
    label: z.string().min(1),
    description: z.string().optional(),
  })).min(1).max(20),
  multiSelect: z.boolean().optional(),
})
export type AskQuestion = z.infer<typeof AskQuestionSchema>

export const HookAskMsg = z.object({
  type: z.literal('hook_ask'),
  id: z.number(),
  session_id: z.string(),
  questions: z.array(AskQuestionSchema).min(1).max(4),
  timeout_ms: z.number().optional(),
})

export const HookAskResultMsg = z.object({
  type: z.literal('hook_ask_result'),
  id: z.number(),
  ok: z.boolean(),
  answers: z.array(z.union([z.string(), z.array(z.string())])).optional(),
  notes: z.array(z.string().optional()).optional(),
  error: z.string().optional(),
})

export const ToolResultMsg = z.object({
  type: z.literal('tool_result'),
  id: z.number(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
})

export const PermissionRequestMsg = z.object({
  type: z.literal('permission_request'),
  id: z.number(),
  request_id: z.string(),
  tool_name: z.string(),
  description: z.string(),
  input_preview: z.string(),
})

export const PermissionDecisionMsg = z.object({
  type: z.literal('permission_decision'),
  request_id: z.string(),
  behavior: z.enum(['allow', 'deny']),
})

export const InboundMsg = z.object({
  type: z.literal('inbound'),
  chat_id: z.string(),
  message_id: z.string(),
  user: z.string(),
  user_id: z.string(),
  ts: z.string(),
  content: z.string(),
  attachment_count: z.number().optional(),
  attachments: z.string().optional(),
})

export const UnregisterMsg = z.object({ type: z.literal('unregister'), id: z.number() })
export const PingMsg = z.object({ type: z.literal('ping'), id: z.number() })
export const PongMsg = z.object({ type: z.literal('pong'), id: z.number() })

const ShimUnion = z.union([
  RegisterMsg, ToolCallMsg, PermissionRequestMsg, UnregisterMsg, PingMsg, HookAskMsg,
])
const DaemonUnion = z.union([
  RegisterAckMsg, RegisterErrMsg, ToolResultMsg, PermissionDecisionMsg, InboundMsg, PongMsg, HookAskResultMsg,
])

export type ShimMsg = z.infer<typeof ShimUnion>
export type DaemonMsg = z.infer<typeof DaemonUnion>

export function parseShimMsg(raw: unknown): ShimMsg {
  return ShimUnion.parse(raw)
}
export function parseDaemonMsg(raw: unknown): DaemonMsg {
  return DaemonUnion.parse(raw)
}
