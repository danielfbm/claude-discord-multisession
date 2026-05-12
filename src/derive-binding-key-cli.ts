#!/usr/bin/env bun
// Thin CLI wrapper around deriveSessionId() so scripts/derive-binding-key.sh
// can stay in sync with src/session-id.ts automatically. Reading the rewrite
// env (CLAUDE_DISCORD_CWD_REWRITE) and realpath resolution happen inside
// deriveSessionId — this file deliberately does no extra logic so there is
// nothing to drift.
import { deriveSessionId } from './session-id'

const cwd = process.argv[2] ?? process.cwd()
process.stdout.write(deriveSessionId(cwd) + '\n')
