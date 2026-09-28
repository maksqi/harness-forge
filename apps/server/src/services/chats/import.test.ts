import type { HarnessUIMessage } from '@harness-forge/shared'
import { HarnessError, MESSAGE_ID_PATTERN } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { assignMessageIds, IMPORT_DENIAL_REASON, validateImportedMessages } from './import.ts'

const META = { modelRef: 'mock:echo', startedAt: 1 }

function user(id: string, text: string): HarnessUIMessage {
  return { id, role: 'user', metadata: META, parts: [{ type: 'text', text }] }
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

describe('validateImportedMessages', () => {
  it('accepts valid messages (metadata optional) and keeps them in order', async () => {
    const messages: HarnessUIMessage[] = [
      user('msg_aaaaaaaaaaaaaaaa', 'hello'),
      { id: 'msg_bbbbbbbbbbbbbbbb', role: 'assistant', parts: [{ type: 'text', text: 'hi', state: 'done' }] },
    ]
    await expect(validateImportedMessages(messages)).resolves.toEqual(messages)
    await expect(validateImportedMessages([])).resolves.toEqual([])
  })

  it('finalizes streaming parts and denies pending approvals', async () => {
    const assistant = {
      id: 'msg_bbbbbbbbbbbbbbbb',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'partial', state: 'streaming' },
        { type: 'reasoning', text: 'thinking', state: 'streaming' },
        { type: 'tool-web_fetch', toolCallId: 'c1', state: 'approval-requested', input: { url: 'u' }, approval: { id: 'a1' } },
        { type: 'dynamic-tool', toolName: 'mcp__x__y', toolCallId: 'c2', state: 'approval-responded', input: {}, approval: { id: 'a2', approved: true } },
        { type: 'tool-web_fetch', toolCallId: 'c3', state: 'approval-responded', input: {}, approval: { id: 'a3', approved: false, reason: 'no thanks' } },
        { type: 'tool-web_fetch', toolCallId: 'c4', state: 'output-available', input: {}, output: 'ok' },
      ],
    } as unknown as HarnessUIMessage
    const [result] = await validateImportedMessages([assistant])
    const parts = result!.parts as unknown as Record<string, unknown>[]
    expect(parts[0]).toMatchObject({ type: 'text', state: 'done' })
    expect(parts[1]).toMatchObject({ type: 'reasoning', state: 'done' })
    expect(parts[2]).toMatchObject({ state: 'output-denied', approval: { id: 'a1', approved: false, reason: IMPORT_DENIAL_REASON } })
    expect(parts[3]).toMatchObject({ state: 'output-denied', approval: { id: 'a2', approved: false, reason: IMPORT_DENIAL_REASON } })
    expect(parts[4]).toMatchObject({ state: 'output-denied', approval: { id: 'a3', approved: false, reason: 'no thanks' } })
    expect(parts[5]).toMatchObject({ state: 'output-available', output: 'ok' })
  })

  it('rejects invalid metadata with the issue path under messages, without echoing the value', async () => {
    const bad = { ...user('msg_aaaaaaaaaaaaaaaa', 'secret text'), metadata: { modelRef: 'no-colon', startedAt: 1 } } as HarnessUIMessage
    const error = await rejection(validateImportedMessages([user('msg_cccccccccccccccc', 'ok'), bad]))
    expect(error.code).toBe('validation_error')
    const { issues } = error.details as { issues: { path: unknown[] }[] }
    expect(issues[0]!.path.slice(0, 3)).toEqual(['messages', 1, 'metadata'])
    expect(JSON.stringify(error.toJSON())).not.toContain('secret text')
  })

  it('rejects unknown data parts and malformed parts', async () => {
    const unknownData = { id: 'msg_aaaaaaaaaaaaaaaa', role: 'assistant', parts: [{ type: 'data-custom', data: {} }] } as unknown as HarnessUIMessage
    expect((await rejection(validateImportedMessages([unknownData]))).code).toBe('validation_error')
    const badNotice = { id: 'msg_aaaaaaaaaaaaaaaa', role: 'assistant', parts: [{ type: 'data-notice', data: { level: 'loud' } }] } as unknown as HarnessUIMessage
    expect((await rejection(validateImportedMessages([badNotice]))).code).toBe('validation_error')
    const emptyUser = { id: 'msg_aaaaaaaaaaaaaaaa', role: 'user', parts: [] } as unknown as HarnessUIMessage
    const error = await rejection(validateImportedMessages([emptyUser]))
    expect((error.details as { issues: { path: unknown[] }[] }).issues[0]!.path[0]).toBe('messages')
  })
})

describe('assignMessageIds', () => {
  it('keeps valid unused ids and replaces invalid, repeated and taken ones', () => {
    const list = [
      user('msg_aaaaaaaaaaaaaaaa', 'keep'),
      user('not-a-message-id', 'invalid'),
      user('msg_aaaaaaaaaaaaaaaa', 'repeated'),
      user('msg_takentakentaken1', 'taken'),
    ]
    const result = assignMessageIds(list, new Set(['msg_takentakentaken1']))
    expect(result[0]).toBe(list[0])
    expect(result.map(message => message.id).every(id => MESSAGE_ID_PATTERN.test(id))).toBe(true)
    expect(new Set(result.map(message => message.id)).size).toBe(4)
    expect(result[3]!.id).not.toBe('msg_takentakentaken1')
    expect(result.map(message => (message.parts[0] as { text: string }).text)).toEqual(['keep', 'invalid', 'repeated', 'taken'])
  })
})
