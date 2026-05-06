import type { Readable, Writable } from 'stream'

const DEFAULT_MAX_BYTES = 1024 * 1024 // 1 MiB

export async function* readFrames(
  src: Readable,
  opts: { maxBytes?: number } = {},
): AsyncGenerator<unknown> {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES
  let buf = ''
  for await (const chunk of src) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (buf.length > max) {
      throw new Error(`framing: message exceeds ${max} bytes`)
    }
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line) continue
      yield JSON.parse(line)
    }
  }
}

export function writeFrame(dst: Writable, msg: unknown): void {
  dst.write(JSON.stringify(msg) + '\n')
}
