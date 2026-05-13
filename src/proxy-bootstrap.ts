/**
 * Side-effect module: prepares the daemon to talk to Discord through an
 * HTTP CONNECT proxy. server.ts awaits a dynamic import of this module
 * before it awaits the dynamic import of daemon-entry.ts. That ordering
 * matters because @discordjs/ws (transitive of discord.js) captures
 * globalThis.WebSocket exactly once at its module-evaluation time. Under
 * Bun, sibling static imports of an ESM bootstrap and a CJS module like
 * discord.js do NOT preserve declaration order — the CJS body runs
 * first, so we cannot rely on static-import order in daemon-entry.
 *
 * Discord traffic has three legs the daemon needs to cover:
 *   - REST (discord.com/api) — @discordjs/rest uses globalThis.fetch on
 *     Bun, and Bun's fetch already honors HTTPS_PROXY env vars. No work
 *     needed beyond what's set in the environment.
 *   - Gateway WebSocket (gateway.discord.gg) — @discordjs/ws captures
 *     globalThis.WebSocket at module load. We replace it with a subclass
 *     of the npm `ws` WebSocket that auto-injects `agent: proxyAgent`
 *     into the constructor options. (Plain `ws.WebSocket` ignores
 *     https.globalAgent — only the explicit `agent` option works.)
 *   - Anything undici-based — covered by setGlobalDispatcher.
 *
 * The proxy URL itself is resolved lazily: installHttpProxy() is called
 * from runDaemon() after the channel .env is sourced, so the channel
 * .env can carry the proxy setting in addition to the shell env. The
 * subclass reads wsProxyAgent at construction time, so as long as
 * installHttpProxy() runs before client.login(), the agent is in place.
 */
import { WebSocket as WsWebSocket, type ClientOptions } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { ProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici'
import type { Agent } from 'node:http'

let wsProxyAgent: Agent | undefined

class ProxyAwareWebSocket extends WsWebSocket {
  constructor(address: string | URL, protocols?: string | string[], options?: ClientOptions) {
    const merged: ClientOptions = wsProxyAgent
      ? { ...options, agent: options?.agent ?? wsProxyAgent }
      : (options ?? {})
    super(address, protocols, merged)
  }
}

// @discordjs/ws picks globalThis.WebSocket under Bun. We replace it
// unconditionally so the captured constructor is always our subclass —
// safe with no proxy (wsProxyAgent stays undefined, options pass through).
;(globalThis as any).WebSocket = ProxyAwareWebSocket

export function pickProxyUrl(): string | undefined {
  const order = [
    'DISCORD_PROXY',
    'HTTPS_PROXY', 'https_proxy',
    'HTTP_PROXY',  'http_proxy',
    'ALL_PROXY',   'all_proxy',
  ]
  for (const k of order) {
    const v = process.env[k]
    if (v && /^https?:\/\//i.test(v)) return v
  }
  return undefined
}

export function maskProxyUrl(u: string): string {
  try {
    const url = new URL(u)
    if (url.username || url.password) { url.username = '***'; url.password = '' }
    return url.toString()
  } catch { return u }
}

export function installHttpProxy(proxyUrl: string): Dispatcher {
  wsProxyAgent = new HttpsProxyAgent(proxyUrl) as unknown as Agent
  const restAgent = new ProxyAgent(proxyUrl)
  setGlobalDispatcher(restAgent)
  return restAgent
}
