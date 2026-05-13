#!/usr/bin/env bun
/**
 * Discord channel for Claude Code — multi-session edition.
 *
 * Two modes:
 *   - default (no args): run as a per-session shim. Connects to (or
 *     lazy-spawns) the daemon over the Unix socket, and translates
 *     between MCP-stdio and the daemon's framed protocol.
 *   - --daemon: run as the long-lived daemon. Holds the single Discord
 *     gateway connection and routes messages between Discord and any
 *     connected shims.
 *
 * Modifications from anthropics/claude-plugins-official@48aa4351:
 *   - Split into per-session shim + long-lived daemon.
 *   - Daemon supports multiple shim connections over a UDS.
 *   - Shim auto-spawns the daemon if not running.
 *   - Threads bound to sessions; permission requests post in-thread.
 */

if (process.argv.includes('--daemon')) {
  const { runDaemon } = await import('./src/daemon-entry')
  await runDaemon()
} else if (process.argv.includes('--ask-hook')) {
  const { runAskHook } = await import('./src/ask-hook')
  await runAskHook()
} else {
  const { runShim } = await import('./src/shim')
  await runShim()
}
