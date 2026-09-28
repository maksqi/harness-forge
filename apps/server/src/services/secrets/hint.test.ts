import { describe, expect, it } from 'vitest'
import { HINT_MIN_LENGTH, HINT_PREFIX_MIN_LENGTH, secretHint } from './hint.ts'

describe('secretHint (masking table)', () => {
  it.each([
    ['empty', '', null],
    ['very short', 'abc', null],
    ['11 characters', 'abcdefg9fQ2', null],
    ['12 characters: last 4 only', 'abcdefgh9fQ2', '…9fQ2'],
    ['23 characters: last 4 only', 'sk-abcdefghijklmnop9fQ2', '…9fQ2'],
    ['24 characters: prefix + last 4', 'sk-abcdefghijklmnopq9fQ2', 'sk-…9fQ2'],
    ['OpenAI project key', 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z0123456789abcdef9fQ2', 'sk-…9fQ2'],
    ['Anthropic key', `sk-ant-api03-${'x'.repeat(80)}-9fQ2AA`, 'sk-…Q2AA'],
    ['Google key', 'AIzaSyD-0123456789abcdefghijklmnopqrs', 'AIz…pqrs'],
    ['Groq key', `gsk_${'A'.repeat(48)}9fQ2`, 'gsk…9fQ2'],
    ['Mistral key (no prefix)', 'abcdefghijklmnopqrstuvwxyz0123459fQ2', 'abc…9fQ2'],
  ])('%s', (_label, value, expected) => {
    expect(secretHint(value)).toBe(expected)
  })

  it('counts code points, never splitting a surrogate pair', () => {
    const value = `${'🔑'.repeat(30)}`
    expect(secretHint(value)).toBe('🔑🔑🔑…🔑🔑🔑🔑')
    expect(secretHint('🔑'.repeat(HINT_MIN_LENGTH - 1))).toBeNull()
  })

  it('reveals at most 7 characters, and at most a third of values shorter than 24', () => {
    for (let length = 0; length <= 80; length++) {
      const value = Array.from({ length }, (_, index) => String.fromCharCode(65 + (index % 26))).join('')
      const hint = secretHint(value)
      if (length < HINT_MIN_LENGTH) {
        expect(hint).toBeNull()
        continue
      }
      const revealed = Array.from(hint ?? '').length - 1
      expect(revealed).toBeLessThanOrEqual(length < HINT_PREFIX_MIN_LENGTH ? Math.floor(length / 3) : 7)
      expect(hint).not.toBe(value)
    }
  })
})
