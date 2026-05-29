#!/usr/bin/env bun
// Thin CLI wrapper around deriveShimIdentity() so scripts/derive-binding-key.sh
// stays in sync with how the shim computes session_id. It mirrors the shim's
// inputs exactly — DISCORD_THREAD_ID, CLAUDE_SESSION_ID, the CWD_REWRITE env,
// and process.ppid for the auto token — so there is nothing to drift.
//
// Usage: derive-binding-key [cwd]
//   DISCORD_THREAD_ID=<snowflake>  → key = sha1('thread:'+id)
//   DISCORD_THREAD_ID=auto         → key = sha1('auto:'+realpath+' '+ppid)
//                                     (ppid only matters for a LIVE session;
//                                      for resetting a binding the persisted
//                                      key is what you want — see README)
//   unset (DM)                     → legacy sha1(realpath|canonical)
import { deriveShimIdentity } from './session-id'

const cwd = process.argv[2] ?? process.cwd()
const id = deriveShimIdentity({
  cwd,
  threadEnv: process.env.DISCORD_THREAD_ID,
  override: process.env.CLAUDE_SESSION_ID,
  ccToken: String(process.ppid),
})
process.stdout.write(id.sessionId + '\n')
