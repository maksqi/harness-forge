// Pure rules of MCP questions in the transcript (Phase 14, ADR-060; docs/UI.md 7.35, 11.10, 15): the countdown, the result
// lines, the records of a final output, the pending request of a tool part (C54) and W14.9's card helpers.
import type { ToolPartLike } from '../chat-format'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { elicitationId, mcpElicitation, mcpElicitationRecord, mcpToolProgress } from '~/utils/testing/fixtures'
import {
  countdownText,
  createAnnouncedElicitations,
  elicitationAnnouncement,
  elicitationAnswer,
  elicitationCautionText,
  elicitationControl,
  elicitationFieldHint,
  elicitationFieldLabel,
  elicitationFieldsText,
  elicitationFocusTarget,
  elicitationInputType,
  elicitationIssuesOf,
  elicitationJumpLabel,
  elicitationJumpText,
  elicitationMinuteAnnouncement,
  elicitationRecordsOf,
  elicitationResultAction,
  elicitationResultText,
  elicitationSensitiveText,
  isLongElicitationMessage,
  pendingElicitationOf,
} from './elicitation'

/** An element with attributes and children (no markup strings). */
function element(tag: string, attributes: Record<string, string> = {}, children: Element[] = []): HTMLElement {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes))
    node.setAttribute(key, value)
  node.append(...children)
  return node
}

describe('countdown and result lines', () => {
  it('counts whole seconds down to 0:00', () => {
    expect(countdownText(462_000)).toBe('7:42 left')
    expect(countdownText(59_001)).toBe('1:00 left')
    expect(countdownText(500)).toBe('0:01 left')
    expect(countdownText(-5)).toBe('0:00 left')
    expect(countdownText(Number.NaN)).toBe('0:00 left')
  })

  it('words each ending (docs/UI.md 15)', () => {
    expect(elicitationResultText({ action: 'accept', reason: 'user' }, 'Linear')).toBe('You answered Linear\'s request.')
    expect(elicitationResultText({ action: 'decline', reason: 'user' }, 'Linear')).toBe('You declined Linear\'s request.')
    expect(elicitationResultText({ action: 'cancel', reason: 'user' }, 'Linear')).toBe('You dismissed Linear\'s request.')
    expect(elicitationResultText({ action: 'cancel', reason: 'timeout' }, 'Linear')).toBe('Linear\'s request expired.')
    expect(elicitationResultText({ action: 'cancel', reason: 'stopped' }, 'Linear')).toBe('Stopped before you answered.')
    expect(elicitationResultText({ action: 'decline', reason: 'not-interactive' }, 'Linear')).toBe('Declined automatically: sub-agents can\'t ask you.')
    expect(elicitationResultText({ action: 'decline', reason: 'ambiguous' }, 'Linear')).toBe('Declined automatically: more than one chat was using Linear.')
    expect(elicitationResultText({ action: 'decline', reason: 'unsupported' }, 'Linear')).toBe('Declined automatically: harness-forge can\'t show this form.')
    expect(elicitationResultAction(mcpElicitationRecord({ action: 'cancel', reason: 'timeout' }))).toBe('timeout')
    expect(elicitationResultAction(mcpElicitationRecord({ action: 'decline' }))).toBe('decline')
    expect(elicitationFieldsText(['email', 'count'])).toBe('Asked for: email, count')
    expect(elicitationFieldsText([])).toBeNull()
  })

  it('reads the records of a final output and drops invalid ones (never values)', () => {
    const record = mcpElicitationRecord()
    expect(elicitationRecordsOf({ content: [], elicitations: [record, { id: 'nope' }] })).toEqual([record])
    // A shared output cut at the share limit keeps its records (W14.6).
    expect(elicitationRecordsOf({ truncated: true, preview: '…', elicitations: [record] })).toEqual([record])
    expect(elicitationRecordsOf('text')).toEqual([])
    expect(elicitationRecordsOf({ elicitations: 'x' })).toEqual([])
  })

  it('finds the pending request of a running MCP call only', () => {
    const request = mcpElicitation()
    const waiting = { type: 'tool-mcp__fixture__ask', toolCallId: 'c', state: 'output-available', input: {}, output: mcpToolProgress(request), preliminary: true } as ToolPartLike
    expect(pendingElicitationOf(waiting)).toEqual(request)
    expect(pendingElicitationOf({ ...waiting, preliminary: false } as ToolPartLike)).toBeNull()
    expect(pendingElicitationOf({ ...waiting, output: mcpToolProgress(null) } as ToolPartLike)).toBeNull()
    expect(pendingElicitationOf({ ...waiting, type: 'tool-read_file' } as ToolPartLike)).toBeNull()
  })
})

describe('card helpers (W14.9)', () => {
  it('picks the control, input type, label and hint of a field', () => {
    expect(elicitationControl({ type: 'string' })).toBe('input')
    expect(elicitationControl({ type: 'integer' })).toBe('number')
    expect(elicitationControl({ type: 'number' })).toBe('number')
    expect(elicitationControl({ type: 'boolean' })).toBe('checkbox')
    const option = { value: 'a', label: 'A' }
    expect(elicitationControl({ type: 'enum', options: [option, option, option, option] })).toBe('radios')
    expect(elicitationControl({ type: 'enum', options: [option, option, option, option, option] })).toBe('select')
    expect(elicitationControl({ type: 'multi-enum', options: [option] })).toBe('checkboxes')
    expect(elicitationInputType({ format: 'email' })).toBe('email')
    expect(elicitationInputType({ format: 'uri' })).toBe('url')
    expect(elicitationInputType({ format: 'date' })).toBe('date')
    expect(elicitationInputType({ format: 'date-time' })).toBe('datetime-local')
    expect(elicitationInputType({})).toBe('text')
    expect(elicitationFieldLabel({ name: 'team', title: 'Team' })).toBe('Team')
    expect(elicitationFieldLabel({ name: 'team', title: null })).toBe('team')
    expect(elicitationFieldHint({ type: 'integer', minimum: 1, maximum: 4 })).toBe('Whole number, 1 to 4')
    expect(elicitationFieldHint({ type: 'number', minimum: 0, maximum: 1.5 })).toBe('Number, 0 to 1.5')
    expect(elicitationFieldHint({ type: 'number', minimum: 0 })).toBeNull()
    expect(elicitationFieldHint({ type: 'multi-enum', minItems: 1, maxItems: 3 })).toBe('Choose 1 to 3')
    expect(elicitationFieldHint({ type: 'string' })).toBeNull()
  })

  it('builds the answer with the server\'s rules', () => {
    const form = mcpElicitation().form
    expect(elicitationAnswer(form, { email: ' ada@example.com ', count: '4', notify: false, priority: 'high' }))
      .toEqual({ ok: true, content: { email: 'ada@example.com', count: 4, notify: false, priority: 'high' } })
    const invalid = elicitationAnswer(form, { email: 'nope', count: '42', priority: '' })
    expect(invalid.ok).toBe(false)
    expect(invalid.ok ? [] : invalid.issues.map(issue => [issue.field, issue.code])).toEqual([
      ['email', 'format'],
      ['count', 'too-large'],
      ['priority', 'required'],
    ])
  })

  it('words the card, the pill and the announcements', () => {
    expect(elicitationCautionText('Linear')).toBe('Share only what you would give Linear. Never enter passwords here.')
    expect(elicitationSensitiveText('Linear')).toBe('Linear asks for something that looks like a secret. Answer only if you trust Linear.')
    expect(elicitationAnnouncement('Linear')).toBe('Linear needs your input')
    expect(elicitationMinuteAnnouncement('Linear')).toBe('Linear\'s request expires in 1 minute')
    expect(elicitationJumpText('Linear')).toBe('Linear needs your input · Show')
    expect(elicitationJumpLabel('Linear')).toBe('Linear needs your input, show the request')
    expect(isLongElicitationMessage('Short')).toBe(false)
    expect(isLongElicitationMessage('1\n2\n3\n4\n5\n6\n7')).toBe(true)
    expect(isLongElicitationMessage('x'.repeat(500))).toBe(true)
  })

  it('finds the focus target of a card: the first field\'s control, else Submit', () => {
    const first = element('input', { id: 'first' }) as HTMLInputElement
    const card = element('section', {}, [
      element('div', { 'data-testid': testIds.elicitationField }, [
        element('input', { type: 'hidden' }),
        element('button', { role: 'radio', tabindex: '-1' }),
        first,
      ]),
      element('div', { 'data-testid': testIds.elicitationField }, [element('input', { id: 'second' })]),
      element('button', { 'data-testid': testIds.elicitationSubmit, 'id': 'submit' }),
    ])
    expect(elicitationFocusTarget(card)?.id).toBe('first')
    first.disabled = true
    expect(elicitationFocusTarget(card)?.id).toBe('submit')
    card.querySelectorAll(`[data-testid="${testIds.elicitationField}"]`).forEach(item => item.remove())
    expect(elicitationFocusTarget(card)?.id).toBe('submit')
  })

  it('remembers what a tab announced (bounded)', () => {
    const announced = createAnnouncedElicitations(2)
    expect(announced.add(elicitationId(1))).toBe(true)
    expect(announced.add(elicitationId(1))).toBe(false)
    expect(announced.add(`${elicitationId(1)}:minute`)).toBe(true)
    expect(announced.add(elicitationId(2))).toBe(true)
    // The oldest key is forgotten beyond the bound.
    expect(announced.add(elicitationId(1))).toBe(true)
    announced.clear()
    expect(announced.add(elicitationId(2))).toBe(true)
  })
})

describe('elicitationIssuesOf (W14.9)', () => {
  it('reads both issue shapes and drops entries without a message', () => {
    expect(elicitationIssuesOf([
      { field: 'email', code: 'format', message: 'Enter an email address.' },
      { path: ['content', 'count'], code: 'too-large', message: 'At most 10.' },
      { path: ['content'], code: 'type', message: 'The answer must be an object of field values.' },
      { path: ['content', 'x'] },
      null,
      'nope',
    ])).toEqual([
      { field: 'email', code: 'format', message: 'Enter an email address.' },
      { field: 'count', code: 'too-large', message: 'At most 10.' },
      { field: '', code: 'type', message: 'The answer must be an object of field values.' },
    ])
  })
})
