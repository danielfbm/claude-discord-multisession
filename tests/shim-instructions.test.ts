import { test, expect, describe } from 'bun:test'
import { buildInstructions } from '../src/shim'

describe('buildInstructions', () => {
  const onText = buildInstructions(true)
  const offText = buildInstructions(false)

  test('on-variant contains both reaction paragraphs', () => {
    expect(onText).toContain('Read-receipt reactions:')
    expect(onText).toContain('react again on the same message_id')
    expect(onText).toContain('👀')
    expect(onText).toContain('✅')
    expect(onText).toContain('❌')
  })

  test('off-variant drops both reaction paragraphs', () => {
    expect(offText).not.toContain('Read-receipt reactions:')
    expect(offText).not.toContain('react again on the same message_id')
    expect(offText).not.toContain('👀')
    expect(offText).not.toContain('✅')
    expect(offText).not.toContain('❌')
  })

  test('invariant content present in both', () => {
    for (const txt of [onText, offText]) {
      expect(txt).toContain('The sender reads Discord')
      expect(txt).toContain('fetch_messages pulls real Discord history')
      expect(txt).toContain('Access is managed by the /discord:access skill')
    }
  })

  test('off-variant is strictly shorter than on-variant', () => {
    expect(offText.length).toBeLessThan(onText.length)
  })

  test('joined string has no leading/trailing blanks and no triple newlines', () => {
    for (const txt of [onText, offText]) {
      expect(txt.startsWith('\n')).toBe(false)
      expect(txt.endsWith('\n')).toBe(false)
      expect(txt).not.toContain('\n\n\n')
    }
  })
})
