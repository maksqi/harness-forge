import type { HarnessUIMessage } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { hookCarrier, hookData, hookPart, hookRecordId, taskResultPart, userMessage } from '~/utils/testing/fixtures'
import { hookAnnouncement, hookDataOf, hookOutcomeText, hookSourceText, isHookCarrierMessage, toolHooksOf } from './hook-notes'

describe('hookDataOf', () => {
  it('returns the data of a valid data-hook part', () => {
    const data = hookData()
    expect(hookDataOf(hookPart())).toEqual(data)
  })

  it('returns null for other parts, invalid data and malformed values', () => {
    expect(hookDataOf({ type: 'text', text: 'hi' })).toBeNull()
    expect(hookDataOf({ type: 'data-hook', data: { id: 'nope', event: 'PreToolUse' } })).toBeNull()
    expect(hookDataOf({ type: 'data-hook', data: { ...hookData(), outcome: 'feedback' } })).toBeNull()
    expect(hookDataOf({ type: 'data-hook', data: { ...hookData(), event: 'BeforeTool' } })).toBeNull()
    expect(hookDataOf(null)).toBeNull()
    expect(hookDataOf('data-hook')).toBeNull()
    expect(hookDataOf([hookPart()])).toBeNull()
  })
})

describe('toolHooksOf', () => {
  it('groups the tool-linked records by tool call id, in part order', () => {
    const pre = hookData({ id: hookRecordId(1), event: 'PreToolUse', outcome: 'allowed', toolCallId: 'call_a' })
    const post = hookData({ id: hookRecordId(2), event: 'PostToolUse', outcome: 'context', toolCallId: 'call_a', context: 'Formatted.' })
    const other = hookData({ id: hookRecordId(3), event: 'PreToolUse', outcome: 'denied', toolCallId: 'call_b' })
    const stop = hookData({ id: hookRecordId(4), event: 'Stop', outcome: 'stopped', toolCallId: undefined, toolName: undefined })
    const parts = [
      { type: 'text', text: 'Working' },
      { type: 'data-hook', id: pre.id, data: pre },
      { type: 'data-hook', id: stop.id, data: stop },
      { type: 'data-hook', id: other.id, data: other },
      { type: 'data-hook', id: 'bad', data: { id: 'bad' } },
      { type: 'data-hook', id: post.id, data: post },
    ]
    const grouped = toolHooksOf(parts)
    expect([...grouped.keys()]).toEqual(['call_a', 'call_b'])
    expect(grouped.get('call_a')).toEqual([pre, post])
    expect(grouped.get('call_b')).toEqual([other])
  })

  it('returns an empty map without records or for malformed input', () => {
    expect(toolHooksOf([{ type: 'text', text: 'x' }]).size).toBe(0)
    expect(toolHooksOf([null, 3, 'data-hook']).size).toBe(0)
    expect(toolHooksOf(undefined as unknown as unknown[]).size).toBe(0)
  })
})

describe('isHookCarrierMessage', () => {
  it('is true for a user message holding only valid data-hook parts', () => {
    expect(isHookCarrierMessage(hookCarrier('msg_carrier'))).toBe(true)
    const two = hookCarrier('msg_carrier_2', [hookData({ id: hookRecordId(1) }), hookData({ id: hookRecordId(2), event: 'Stop', outcome: 'continued', toolCallId: undefined })])
    expect(isHookCarrierMessage(two)).toBe(true)
  })

  it('is false for ordinary, mixed, empty, assistant and invalid messages', () => {
    expect(isHookCarrierMessage(userMessage('msg_u', 'hello'))).toBe(false)
    const mixed: HarnessUIMessage = { ...userMessage('msg_m', 'hello'), parts: [{ type: 'text', text: 'hello' }, hookPart()] }
    expect(isHookCarrierMessage(mixed)).toBe(false)
    expect(isHookCarrierMessage({ ...userMessage('msg_e', ''), parts: [] })).toBe(false)
    expect(isHookCarrierMessage({ ...hookCarrier('msg_a'), role: 'assistant' })).toBe(false)
    const invalid: HarnessUIMessage = { ...hookCarrier('msg_i'), parts: [{ type: 'data-hook', id: 'x', data: { id: 'x' } } as never] }
    expect(isHookCarrierMessage(invalid)).toBe(false)
    const taskCarrier: HarnessUIMessage = { ...userMessage('msg_t', ''), parts: [taskResultPart()] }
    expect(isHookCarrierMessage(taskCarrier)).toBe(false)
  })
})

describe('the P11-0b placeholders', () => {
  it('type-check and answer plain values', () => {
    const data = hookData()
    expect(hookOutcomeText(data)).toContain('PreToolUse')
    expect(hookSourceText(data.hooks[0]!, null)).toBe('Project hook')
    expect(hookSourceText({ source: 'plugin', label: 'hook-pack: prompt.submit', pluginId: 'hook-pack', exitCode: null, durationMs: 1 }, 'Hook pack')).toBe('From Hook pack')
    expect(hookAnnouncement(data, 'write_file')).toBeNull()
  })
})
