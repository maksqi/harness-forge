import type { HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import {
  classifyRequest,
  FAILED_TOOL_TEXT,
  finalizeParts,
  firstText,
  hasPendingApproval,
  mergeApprovalDecisions,
  plainText,
  STOPPED_TOOL_TEXT,
  supersedeApprovals,
  SUPERSEDED_REASON,
} from './history.ts'

function tool(state: string, extra: Record<string, unknown> = {}): HarnessUIMessagePart {
  return { type: 'tool-demo', toolCallId: `call_${state}`, state, input: { a: 1 }, ...extra } as unknown as HarnessUIMessagePart
}

function assistant(parts: HarnessUIMessagePart[], id = 'msg_a000000000000001'): HarnessUIMessage {
  return { id, role: 'assistant', parts }
}

const user: HarnessUIMessage = { id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'hello' }] }

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  }
  catch (error) {
    return error instanceof HarnessError ? error.code : 'other'
  }
  return undefined
}

describe('classifyRequest', () => {
  it('recognizes new, regenerate and continuation requests (ADR-023)', () => {
    expect(classifyRequest({ trigger: 'submit-message', message: user })).toBe('new')
    expect(classifyRequest({ trigger: 'submit-message', message: user, parentId: null })).toBe('new')
    expect(classifyRequest({ trigger: 'submit-message', message: user, parentId: 'msg_a000000000000001' })).toBe('new')
    expect(classifyRequest({ trigger: 'regenerate-message', message: user })).toBe('regenerate')
    expect(classifyRequest({ trigger: 'regenerate-message', message: user, messageId: 'msg_x000000000000001' })).toBe('regenerate')
    expect(classifyRequest({ trigger: 'submit-message', message: assistant([]) })).toBe('continuation')
    expect(classifyRequest({ trigger: 'submit-message', message: assistant([]), messageId: 'msg_a000000000000001' })).toBe('continuation')
  })

  it('rejects messageId on a user message: in-place edits were removed', () => {
    expect(codeOf(() => classifyRequest({ trigger: 'submit-message', message: user, messageId: user.id }))).toBe('validation_error')
    expect(codeOf(() => classifyRequest({ trigger: 'submit-message', message: user, messageId: 'msg_other00000000001', parentId: null }))).toBe('validation_error')
  })

  it('rejects parentId on a regenerate or an approval continuation', () => {
    expect(codeOf(() => classifyRequest({ trigger: 'regenerate-message', message: user, parentId: null }))).toBe('validation_error')
    expect(codeOf(() => classifyRequest({ trigger: 'regenerate-message', message: user, parentId: 'msg_u000000000000001' }))).toBe('validation_error')
    expect(codeOf(() => classifyRequest({ trigger: 'submit-message', message: assistant([]), parentId: 'msg_u000000000000001' }))).toBe('validation_error')
    expect(codeOf(() => classifyRequest({ trigger: 'submit-message', message: assistant([]), parentId: null }))).toBe('validation_error')
  })

  it('rejects other inconsistent requests with validation_error', () => {
    expect(codeOf(() => classifyRequest({ trigger: 'submit-message', message: { ...user, role: 'system' } }))).toBe('validation_error')
    expect(codeOf(() => classifyRequest({ trigger: 'submit-message', message: assistant([]), messageId: 'msg_other00000000001' }))).toBe('validation_error')
  })

  it('names the offending field in the issue path', () => {
    try {
      classifyRequest({ trigger: 'regenerate-message', message: user, parentId: null })
    }
    catch (error) {
      expect((error as HarnessError).toJSON().error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['parentId'] }] } })
    }
    try {
      classifyRequest({ trigger: 'submit-message', message: user, messageId: user.id })
    }
    catch (error) {
      expect((error as HarnessError).toJSON().error).toMatchObject({ details: { issues: [{ path: ['messageId'] }] } })
    }
    expect.assertions(2)
  })
})

describe('approvals', () => {
  it('detects a pending approval on an assistant message', () => {
    expect(hasPendingApproval(assistant([tool('approval-requested', { approval: { id: 'ap1' } })]))).toBe(true)
    expect(hasPendingApproval(assistant([tool('output-available', { output: 1 })]))).toBe(false)
    expect(hasPendingApproval(user)).toBe(false)
    expect(hasPendingApproval(undefined)).toBe(false)
  })

  it('supersedes requested and unprocessed responded approvals, returning only changed messages', () => {
    const pending = assistant([
      { type: 'text', text: 'let me check' },
      tool('approval-requested', { approval: { id: 'ap1', signature: 'sig' } }),
      tool('approval-responded', { approval: { id: 'ap2', approved: true } }),
      tool('output-available', { output: 1, approval: { id: 'ap3', approved: true } }),
    ])
    const done = assistant([tool('output-available', { output: 2 })], 'msg_a000000000000002')
    const result = supersedeApprovals([user, pending, done])
    expect(result.count).toBe(2)
    expect(result.changed.map(message => message.id)).toEqual([pending.id])
    const parts = result.messages[1]!.parts as unknown as Record<string, unknown>[]
    expect(parts[1]).toMatchObject({ state: 'output-denied', approval: { id: 'ap1', signature: 'sig', approved: false, reason: SUPERSEDED_REASON } })
    expect(parts[2]).toMatchObject({ state: 'output-denied', approval: { id: 'ap2', approved: false, reason: SUPERSEDED_REASON } })
    expect(parts[3]).toMatchObject({ state: 'output-available' })
    expect(result.messages[2]).toBe(done)
  })

  it('merges only the approval decisions of the client copy, by approval id', () => {
    const stored = assistant([
      { type: 'step-start' },
      tool('approval-requested', { toolCallId: 'call_1', input: { a: 1 }, approval: { id: 'ap1', signature: 'server-signature' } }),
      tool('approval-requested', { toolCallId: 'call_2', input: { b: 2 }, approval: { id: 'ap2' } }),
    ])
    const incoming = assistant([
      { type: 'text', text: 'injected by the client' },
      tool('approval-responded', { toolCallId: 'call_1', input: { a: 'tampered' }, approval: { id: 'ap1', approved: true, signature: 'forged' } }),
      tool('approval-responded', { toolCallId: 'call_2', approval: { id: 'ap2', approved: false, reason: `  ${'r'.repeat(2500)}  ` } }),
      tool('approval-responded', { approval: { id: 'unknown', approved: true } }),
    ])
    const { message, merged } = mergeApprovalDecisions(stored, incoming)
    expect(merged).toBe(2)
    expect(message.parts).toHaveLength(3)
    const parts = message.parts as unknown as Record<string, unknown>[]
    expect(parts[1]).toEqual({ type: 'tool-demo', toolCallId: 'call_1', state: 'approval-responded', input: { a: 1 }, approval: { id: 'ap1', signature: 'server-signature', approved: true } })
    expect(parts[2]).toMatchObject({ state: 'approval-responded', input: { b: 2 }, approval: { id: 'ap2', approved: false } })
    // Phase 9: plan feedback travels as the reason, capped at LIMITS.approvalReasonMaxChars (2000).
    expect((parts[2]!.approval as { reason: string }).reason).toHaveLength(LIMITS.approvalReasonMaxChars)
    expect(LIMITS.approvalReasonMaxChars).toBe(2000)
    expect(mergeApprovalDecisions(stored, stored).merged).toBe(0)
  })
})

describe('finalizeParts', () => {
  it('marks streaming text done and turns unfinished tool calls into errors', () => {
    const parts: HarnessUIMessagePart[] = [
      { type: 'reasoning', text: 'hmm', state: 'streaming' },
      { type: 'text', text: 'partial', state: 'streaming' },
      tool('input-streaming', { input: undefined }),
      tool('input-available'),
      tool('output-available', { output: 1 }),
    ]
    const aborted = finalizeParts(parts, 'aborted') as unknown as Record<string, unknown>[]
    expect(aborted[0]).toMatchObject({ state: 'done' })
    expect(aborted[1]).toMatchObject({ state: 'done', text: 'partial' })
    expect(aborted[2]).toMatchObject({ state: 'output-error', errorText: 'The run was stopped before the tool finished.' })
    expect(aborted[3]).toMatchObject({ state: 'output-error', input: { a: 1 } })
    expect(aborted[4]).toBe(parts[4])
    expect((finalizeParts(parts, 'failed') as unknown as Record<string, unknown>[])[3]).toMatchObject({ errorText: 'The run ended before the tool finished.' })
  })

  it('turns a part still holding a preliminary output (a running sub-agent) into an error (Phase 9)', () => {
    const running = { type: 'tool-task', toolCallId: 'call_task', state: 'output-available', preliminary: true, input: { description: 'x' }, output: { status: 'running', steps: [{ toolName: 'read_file' }] } } as unknown as HarnessUIMessagePart
    const done = { type: 'tool-task', toolCallId: 'call_done', state: 'output-available', input: {}, output: { status: 'completed', report: 'ok' } } as unknown as HarnessUIMessagePart
    const settledFalse = { ...done, preliminary: false } as unknown as HarnessUIMessagePart
    const aborted = finalizeParts([running, done, settledFalse], 'aborted') as unknown as Record<string, unknown>[]
    expect(aborted[0]).toEqual({ type: 'tool-task', toolCallId: 'call_task', state: 'output-error', input: { description: 'x' }, errorText: STOPPED_TOOL_TEXT })
    expect(aborted[1]).toBe(done)
    expect(aborted[2]).toBe(settledFalse)
    expect((finalizeParts([running], 'failed')[0] as unknown as Record<string, unknown>).errorText).toBe(FAILED_TOOL_TEXT)
    expect((finalizeParts([running], 'completed')[0] as unknown as Record<string, unknown>).state).toBe('output-error')
  })
})

describe('text helpers', () => {
  it('reads the first text part and the plain text', () => {
    const message: HarnessUIMessage = { id: 'msg_u000000000000002', role: 'user', parts: [{ type: 'file', mediaType: 'image/png', url: '/api/files/file_0000000000000001' }, { type: 'text', text: '/cmd a' }, { type: 'text', text: 'b' }] }
    expect(firstText(message)).toBe('/cmd a')
    expect(plainText(message)).toBe('/cmd a b')
    expect(firstText(assistant([]))).toBe('')
  })
})
