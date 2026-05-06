import { z } from 'zod'

export const RegisterMsg = z.object({
  type: z.literal('register'),
  id: z.number(),
  session_id: z.string().min(1),
  mode: z.enum(['dm', 'thread']),
  cwd: z.string(),
  thread_id: z.string().optional(),
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
  ]),
  message: z.string(),
})

export const ToolCallMsg = z.object({
  type: z.literal('tool_call'),
  id: z.number(),
  name: z.enum(['reply', 'react', 'edit_message', 'fetch_messages', 'download_attachment']),
  args: z.record(z.string(), z.unknown()),
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
  RegisterMsg, ToolCallMsg, PermissionRequestMsg, UnregisterMsg, PingMsg,
])
const DaemonUnion = z.union([
  RegisterAckMsg, RegisterErrMsg, ToolResultMsg, PermissionDecisionMsg, InboundMsg, PongMsg,
])

export type ShimMsg = z.infer<typeof ShimUnion>
export type DaemonMsg = z.infer<typeof DaemonUnion>

export function parseShimMsg(raw: unknown): ShimMsg {
  return ShimUnion.parse(raw)
}
export function parseDaemonMsg(raw: unknown): DaemonMsg {
  return DaemonUnion.parse(raw)
}
