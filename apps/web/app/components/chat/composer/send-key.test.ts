import type { SendKey } from '@harness-forge/shared'
import type { EnterKeyEvent } from './send-key'
import { describe, expect, it } from 'vitest'
import { enterKeyAction, sendKeyCombo } from './send-key'

function key(overrides: Partial<EnterKeyEvent> = {}): EnterKeyEvent {
  return { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13, ...overrides }
}

describe('send key matrix', () => {
  const cases: Array<[string, Partial<EnterKeyEvent>, Record<SendKey, 'send' | 'newline' | null>]> = [
    ['Enter', {}, { 'enter': 'send', 'mod-enter': 'newline' }],
    ['Shift+Enter', { shiftKey: true }, { 'enter': 'newline', 'mod-enter': 'newline' }],
    ['Cmd+Enter', { metaKey: true }, { 'enter': 'send', 'mod-enter': 'send' }],
    ['Ctrl+Enter', { ctrlKey: true }, { 'enter': 'send', 'mod-enter': 'send' }],
    ['Shift+Cmd+Enter', { shiftKey: true, metaKey: true }, { 'enter': 'newline', 'mod-enter': 'newline' }],
    ['Alt+Enter', { altKey: true }, { 'enter': 'newline', 'mod-enter': 'newline' }],
    ['Enter during IME composition', { isComposing: true }, { 'enter': null, 'mod-enter': null }],
    ['Enter confirming an IME candidate (keyCode 229)', { keyCode: 229 }, { 'enter': null, 'mod-enter': null }],
    ['another key', { key: 'a' }, { 'enter': null, 'mod-enter': null }],
  ]

  for (const [label, event, expected] of cases) {
    for (const sendKey of ['enter', 'mod-enter'] as const) {
      it(`${label} with sendKey=${sendKey} -> ${expected[sendKey] ?? 'ignored'}`, () => {
        expect(enterKeyAction(key(event), sendKey)).toBe(expected[sendKey])
      })
    }
  }

  it('shows the send combo of the setting', () => {
    expect(sendKeyCombo('enter')).toBe('enter')
    expect(sendKeyCombo('mod-enter')).toBe('mod+enter')
  })
})
