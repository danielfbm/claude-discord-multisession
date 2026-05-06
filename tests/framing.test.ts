import { test, expect, describe } from 'bun:test'
import { Readable, PassThrough } from 'stream'
import { readFrames, writeFrame } from '../src/framing'

describe('framing', () => {
  test('readFrames splits on newlines', async () => {
    const src = Readable.from([Buffer.from('{"a":1}\n{"b":2}\n')])
    const out: unknown[] = []
    for await (const f of readFrames(src)) out.push(f)
    expect(out).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('readFrames handles fragmented chunks', async () => {
    const src = Readable.from([Buffer.from('{"a":'), Buffer.from('1}\n'), Buffer.from('{"b":2}\n')])
    const out: unknown[] = []
    for await (const f of readFrames(src)) out.push(f)
    expect(out).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('readFrames rejects messages over the size limit', async () => {
    const big = Buffer.from('"' + 'x'.repeat(2_000_000) + '"\n')
    const src = Readable.from([big])
    const out: unknown[] = []
    let threw = false
    try {
      for await (const f of readFrames(src, { maxBytes: 1024 })) out.push(f)
    } catch (e) {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test('writeFrame writes one line of JSON', async () => {
    const sink = new PassThrough()
    let captured = ''
    sink.on('data', d => { captured += d.toString('utf8') })
    writeFrame(sink, { hello: 'world' })
    await new Promise(r => setImmediate(r))
    expect(captured).toBe('{"hello":"world"}\n')
  })
})
