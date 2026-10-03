// `denyOpenApprovals` (C16-T6): open requests and unprocessed responses are denied with the reason (a response that
// already denied keeps its own reason); finished calls and other parts are untouched; the input is never mutated.
import type { HarnessUIMessagePart } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { KEY_ROTATION_DENIAL_REASON } from '../keys/types.ts'
import { denyOpenApprovals, isOpenApproval } from './approvals.ts'

const REASON = KEY_ROTATION_DENIAL_REASON

function toolPart(state: string, extra: Record<string, unknown> = {}): HarnessUIMessagePart {
  return { type: 'tool-current_time', toolCallId: `call_${state}`, state, input: {}, ...extra } as unknown as HarnessUIMessagePart
}

describe('denyOpenApprovals', () => {
  it('denies open requests and unprocessed responses with the reason and counts them', () => {
    const requested = toolPart('approval-requested', { approval: { id: 'apr_1' } })
    const approved = toolPart('approval-responded', { approval: { id: 'apr_2', approved: true } })
    const dynamic = { type: 'dynamic-tool', toolName: 'mcp__x__y', toolCallId: 'call_d', state: 'approval-requested', input: {}, approval: { id: 'apr_3' } } as unknown as HarnessUIMessagePart
    const { parts, denied } = denyOpenApprovals([requested, approved, dynamic], REASON)
    expect(denied).toBe(3)
    expect(parts).toEqual([
      { ...requested, state: 'output-denied', approval: { id: 'apr_1', approved: false, reason: REASON } },
      { ...approved, state: 'output-denied', approval: { id: 'apr_2', approved: false, reason: REASON } },
      { ...dynamic, state: 'output-denied', approval: { id: 'apr_3', approved: false, reason: REASON } },
    ])
  })

  it('keeps the reason of a response that already denied the call', () => {
    const deniedByUser = toolPart('approval-responded', { approval: { id: 'apr_1', approved: false, reason: 'Not now.' } })
    const deniedWithoutReason = toolPart('approval-responded', { approval: { id: 'apr_2', approved: false } })
    const { parts, denied } = denyOpenApprovals([deniedByUser, deniedWithoutReason], REASON)
    expect(denied).toBe(2)
    expect(parts[0]).toMatchObject({ state: 'output-denied', approval: { approved: false, reason: 'Not now.' } })
    expect(parts[1]).toMatchObject({ state: 'output-denied', approval: { approved: false, reason: REASON } })
  })

  it('leaves finished calls and other parts untouched (same objects) and returns the input when nothing is open', () => {
    const text = { type: 'text', text: 'hi', state: 'done' } as HarnessUIMessagePart
    const finished = [
      toolPart('output-available', { output: { now: 'x' } }),
      toolPart('output-error', { errorText: 'boom' }),
      toolPart('output-denied', { approval: { id: 'apr_9', approved: false, reason: 'No.' } }),
      toolPart('input-available'),
    ]
    const input = [text, ...finished]
    const result = denyOpenApprovals(input, REASON)
    expect(result.denied).toBe(0)
    expect(result.parts).toBe(input)

    const mixed = [text, toolPart('approval-requested', { approval: { id: 'apr_1' } }), ...finished]
    const next = denyOpenApprovals(mixed, REASON)
    expect(next.denied).toBe(1)
    expect(next.parts).not.toBe(mixed)
    expect(next.parts[0]).toBe(text)
    for (const [index, part] of finished.entries())
      expect(next.parts[index + 2]).toBe(part)
  })

  it('never mutates the input parts', () => {
    const requested = toolPart('approval-requested', { approval: { id: 'apr_1' } })
    const snapshot = structuredClone(requested)
    denyOpenApprovals([requested], REASON)
    expect(requested).toEqual(snapshot)
  })

  it('isOpenApproval matches only tool parts waiting for an approval or its processing', () => {
    expect(isOpenApproval(toolPart('approval-requested'))).toBe(true)
    expect(isOpenApproval(toolPart('approval-responded'))).toBe(true)
    expect(isOpenApproval(toolPart('output-available'))).toBe(false)
    expect(isOpenApproval({ type: 'text', text: 'approval-requested' } as HarnessUIMessagePart)).toBe(false)
  })
})
