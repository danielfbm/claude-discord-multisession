import { test, expect, describe } from 'bun:test'
import { validateToolArgs } from '../src/daemon'

// These tests cover the synchronous validator. Live runTool dispatch is
// already covered by daemon-shim.integration.test.ts; here we lock the
// per-field error semantics so a future refactor cannot silently regress
// the LLM-facing hints that make self-correction possible.
describe('validateToolArgs', () => {
  const replySpecs = [
    { name: 'chat_id', type: 'string' as const, required: true },
    { name: 'text', type: 'string' as const, required: true },
    { name: 'reply_to', type: 'string' as const, required: false },
    { name: 'files', type: 'array' as const, required: false },
  ]
  const replySynonyms = { content: 'text', message: 'text', message_id: 'reply_to' }

  test('accepts a well-formed reply payload', () => {
    const r = validateToolArgs('reply', { chat_id: 'c', text: 'hi' }, replySpecs, replySynonyms)
    expect(r.ok).toBe(true)
  })

  test('accepts optional fields when correctly typed', () => {
    const r = validateToolArgs('reply',
      { chat_id: 'c', text: 'hi', reply_to: 'm123', files: ['/a.png'] },
      replySpecs, replySynonyms)
    expect(r.ok).toBe(true)
  })

  test('flags missing required text', () => {
    const r = validateToolArgs('reply', { chat_id: 'c' }, replySpecs, replySynonyms)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("requires field 'text'")
    expect(r.error).toContain('got keys [chat_id]')
  })

  test('rejects synonym for required field (text vs content)', () => {
    // Exact scenario that produced the May-13 "undefined" Discord messages.
    // The synonym pre-check fires before the required-missing loop, so the
    // error names the wrong field directly rather than the missing one.
    const r = validateToolArgs('reply',
      { chat_id: 'c', content: 'hi', message_id: 'm' },
      replySpecs, replySynonyms)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("received unknown field 'content'")
    expect(r.error).toContain("did you mean 'text'?")
  })

  test('rejects synonym for OPTIONAL field — reply_to typed as message_id', () => {
    // Regression: optional canonical fields must NOT shield wrong-named
    // siblings. Pre-fix, this call passed validation and ops.reply ran
    // without a quote target, silently losing the LLM's intent. Post-fix
    // it's a hard rejection with a self-correct hint.
    const r = validateToolArgs('reply',
      { chat_id: 'c', text: 'hi', message_id: 'm' },
      replySpecs, replySynonyms)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("received unknown field 'message_id'")
    expect(r.error).toContain("did you mean 'reply_to'?")
  })

  test('synonym pre-check fires even when required field is also missing', () => {
    // Earlier behavior reported `requires field 'text'` here. Post-fix
    // we surface the wrong-name first because that's the actionable
    // signal: once renamed, text is supplied as part of the same fix.
    const r = validateToolArgs('reply',
      { chat_id: 'c', message_id: 'm' /* no text */ },
      replySpecs, replySynonyms)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("received unknown field 'message_id'")
    expect(r.error).toContain("did you mean 'reply_to'?")
  })

  test('synonym co-existence: when both canonical and wrong key are present, canonical wins', () => {
    // Survivable misuse — `text` is provided correctly; the extra
    // `content` is ignored. We don't reject this because no intent is
    // lost and being strict here would mask LLM payloads that include
    // both keys defensively.
    const r = validateToolArgs('reply',
      { chat_id: 'c', text: 'hello', content: 'should be ignored' },
      replySpecs, replySynonyms)
    expect(r.ok).toBe(true)
  })

  test('rejects wrong type for required string', () => {
    const r = validateToolArgs('reply',
      { chat_id: 'c', text: 123 as unknown as string },
      replySpecs, replySynonyms)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("'text' to be string, got number")
  })

  test('rejects wrong type for optional field when present', () => {
    const r = validateToolArgs('reply',
      { chat_id: 'c', text: 'hi', files: 'not-an-array' as unknown as string[] },
      replySpecs, replySynonyms)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("'files' to be array, got string")
  })

  test('react: hints when emoji was sent as text (the inverse leak)', () => {
    const reactSpecs = [
      { name: 'chat_id', type: 'string' as const, required: true },
      { name: 'message_id', type: 'string' as const, required: true },
      { name: 'emoji', type: 'string' as const, required: true },
    ]
    const r = validateToolArgs('react',
      { chat_id: 'c', message_id: 'm', text: '👀' },
      reactSpecs, { text: 'emoji', content: 'emoji', reply_to: 'message_id' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("received unknown field 'text'")
    expect(r.error).toContain("did you mean 'emoji'?")
  })

  test('hint omitted when no synonym was actually sent', () => {
    const r = validateToolArgs('reply', { chat_id: 'c' }, replySpecs, replySynonyms)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).not.toContain('did you mean')
  })

  // Alias resolution + string[] element-type checks. These lock the
  // semantics added when fetch_messages was migrated to validateToolArgs
  // and `files` switched from 'array' to 'string[]'.
  describe('aliases', () => {
    const fetchSpecs = [
      { name: 'channel', type: 'string' as const, required: true, aliases: ['chat_id'] as const },
      { name: 'limit', type: 'number' as const, required: false },
    ] as const

    test('legacy alias resolves and is normalized onto canonical key', () => {
      // chat_id is the legacy name; after validation v.args.channel
      // should expose the value as if the caller had typed `channel`.
      const r = validateToolArgs('fetch_messages', { chat_id: 'C-123' }, fetchSpecs)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.args.channel).toBe('C-123')
    })

    test('canonical wins when both canonical and alias are present', () => {
      // Same coexistence policy as synonyms: the right name takes precedence.
      const r = validateToolArgs('fetch_messages', { channel: 'A', chat_id: 'B' }, fetchSpecs)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.args.channel).toBe('A')
    })

    test('alias normalization does not mutate the caller args object', () => {
      // Regression guard: a sloppy implementation could write back onto
      // the input. We shallow-clone on first alias hit so the caller's
      // object is untouched.
      const input = { chat_id: 'C-1' }
      const r = validateToolArgs('fetch_messages', input, fetchSpecs)
      expect(r.ok).toBe(true)
      expect((input as Record<string, unknown>).channel).toBeUndefined()
      expect(input.chat_id).toBe('C-1')
    })

    test('missing both canonical and alias still reports required error', () => {
      const r = validateToolArgs('fetch_messages', { limit: 5 }, fetchSpecs)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toContain("requires field 'channel'")
    })
  })

  describe("string[] element-type", () => {
    const replyTypedSpecs = [
      { name: 'chat_id', type: 'string' as const, required: true },
      { name: 'text', type: 'string' as const, required: true },
      { name: 'files', type: 'string[]' as const, required: false },
    ] as const

    test('accepts a homogeneous string array', () => {
      const r = validateToolArgs('reply',
        { chat_id: 'c', text: 'hi', files: ['/a.png', '/b.png'] },
        replyTypedSpecs)
      expect(r.ok).toBe(true)
    })

    test('accepts empty array', () => {
      const r = validateToolArgs('reply',
        { chat_id: 'c', text: 'hi', files: [] },
        replyTypedSpecs)
      expect(r.ok).toBe(true)
    })

    test('rejects array with non-string element', () => {
      const r = validateToolArgs('reply',
        { chat_id: 'c', text: 'hi', files: ['/a.png', 123] as unknown as string[] },
        replyTypedSpecs)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toContain("'files' to be string[]")
      expect(r.error).toContain('mixed/non-string')
    })

    test('rejects non-array value for string[] field', () => {
      const r = validateToolArgs('reply',
        { chat_id: 'c', text: 'hi', files: 'not-an-array' as unknown as string[] },
        replyTypedSpecs)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toContain("'files' to be string[], got string")
    })
  })
})
