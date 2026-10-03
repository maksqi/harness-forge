// stripAnsi skeleton (docs/UI.md 7.19, 11.4; C15, P7-0b): the frozen signature. W7.11 adds the escape handling and
// its tests.
import { describe, expect, it } from 'vitest'
import { stripAnsi } from './ansi'

describe('stripAnsi', () => {
  it('keeps text without escape sequences', () => {
    expect(stripAnsi('')).toBe('')
    expect(stripAnsi('PASS src/app.test.ts\n2 passed\n')).toBe('PASS src/app.test.ts\n2 passed\n')
  })
})
