import type { HarnessUIMessage } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { hookCarrier, hookData, hookPart, hookRecordId, taskResultPart, userMessage } from '~/utils/testing/fixtures'
import { hookAnnouncement, hookDataOf, hookDetailsKind, hookOutcomeText, hookPluginId, hookSourceText, isHookCarrierMessage, toolHooksOf } from './hook-notes'

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

describe('hookOutcomeText', () => {
  const tool = { toolCallId: 'call_1', toolName: 'write_file' }
  const message = { toolCallId: undefined, toolName: undefined }

  it('words every outcome of the record (docs/UI.md 7.31)', () => {
    expect(hookOutcomeText(hookData({ ...tool, event: 'PostToolUse', outcome: 'context', context: 'lint ok', reason: undefined }))).toBe('Hook added context · PostToolUse')
    expect(hookOutcomeText(hookData({ ...tool, outcome: 'denied', reason: 'Writes to dist/ are not allowed.' }))).toBe('Blocked by a PreToolUse hook: Writes to dist/ are not allowed.')
    expect(hookOutcomeText(hookData({ ...tool, outcome: 'asked', reason: 'Touches production.' }))).toBe('A hook asked you to confirm this call: Touches production.')
    expect(hookOutcomeText(hookData({ ...tool, outcome: 'allowed', reason: undefined }))).toBe('Allowed by a PreToolUse hook')
    expect(hookOutcomeText(hookData({ ...tool, outcome: 'allowed', reason: 'Safe folder.' }))).toBe('Allowed by a PreToolUse hook: Safe folder.')
    expect(hookOutcomeText(hookData({ ...tool, outcome: 'rewritten', reason: undefined, updatedInput: { path: 'b' } }))).toBe('Input changed by a PreToolUse hook')
    expect(hookOutcomeText(hookData({ ...tool, event: 'PostToolUse', outcome: 'blocked', reason: 'Lint errors in src/a.ts' }))).toBe('A PostToolUse hook told the agent: Lint errors in src/a.ts')
    expect(hookOutcomeText(hookData({ ...message, event: 'Stop', outcome: 'continued', reason: 'Run the tests.' }))).toBe('A Stop hook asked the agent to continue')
    expect(hookOutcomeText(hookData({ ...message, event: 'Stop', outcome: 'stopped', reason: 'Build is red.' }))).toBe('A hook stopped the agent: Build is red.')
  })

  it('leaves out a missing reason and puts a reason on one line', () => {
    expect(hookOutcomeText(hookData({ outcome: 'denied', reason: undefined }))).toBe('Blocked by a PreToolUse hook')
    expect(hookOutcomeText(hookData({ outcome: 'asked', reason: '' }))).toBe('A hook asked you to confirm this call')
    expect(hookOutcomeText(hookData({ ...message, event: 'Stop', outcome: 'stopped', reason: undefined }))).toBe('A hook stopped the agent')
    expect(hookOutcomeText(hookData({ outcome: 'denied', reason: '  No writes\n  to dist/.  ' }))).toBe('Blocked by a PreToolUse hook: No writes to dist/.')
  })

  it('takes a blocked record\'s feedback from the first line of its context when it has no reason', () => {
    const feedback = hookData({ event: 'PostToolUse', outcome: 'blocked', reason: undefined, context: '\n  nope  \nsecond line' })
    expect(hookOutcomeText(feedback)).toBe('A PostToolUse hook told the agent: nope')
    expect(hookOutcomeText(hookData({ event: 'PostToolUse', outcome: 'blocked', reason: undefined, context: undefined }))).toBe('A PostToolUse hook sent the agent feedback')
  })

  it('names how a failed hook failed: a timeout, an exit code, else "failed"', () => {
    const timedOut = hookData({ event: 'PostToolUse', outcome: 'error', reason: undefined, hooks: [
      { source: 'personal', label: 'pnpm lint', exitCode: 0, durationMs: 5 },
      { source: 'project', label: 'sleep 99', exitCode: null, timedOut: true, durationMs: 60_040, error: 'Timed out after 60s.' },
    ] })
    expect(hookOutcomeText(timedOut)).toBe('A PostToolUse hook timed out after 60s')
    const exited = hookData({ event: 'Stop', outcome: 'error', toolCallId: undefined, hooks: [{ source: 'personal', label: 'pnpm lint', exitCode: 1, durationMs: 300, error: 'Exit code 1.' }] })
    expect(hookOutcomeText(exited)).toBe('A Stop hook failed: exit 1')
    const invalid = hookData({ event: 'Stop', outcome: 'error', toolCallId: undefined, hooks: [{ source: 'plugin', pluginId: 'hook-pack', label: 'hook-pack: run.stop', exitCode: null, durationMs: 3, error: 'The hook threw.' }] })
    expect(hookOutcomeText(invalid)).toBe('A Stop hook failed')
    expect(hookOutcomeText(hookData({ outcome: 'error', hooks: [] }))).toBe('A PreToolUse hook failed')
  })
})

describe('hookSourceText', () => {
  it('names the source of one hook, a plugin by its name, else its id', () => {
    expect(hookSourceText({ source: 'personal', label: 'x', exitCode: 0, durationMs: 1 }, null)).toBe('Personal hook')
    expect(hookSourceText(hookData().hooks[0]!, null)).toBe('Project hook')
    const plugin = { source: 'plugin', label: 'hook-pack: prompt.submit', pluginId: 'hook-pack', exitCode: null, durationMs: 1 } as const
    expect(hookSourceText(plugin, 'Hook pack')).toBe('From Hook pack')
    expect(hookSourceText(plugin, null)).toBe('From hook-pack')
    expect(hookSourceText({ ...plugin, pluginId: undefined }, null)).toBe('From a plugin')
  })
})

describe('hookAnnouncement', () => {
  it('announces a hook denial by the tool and a continuation; nothing else', () => {
    expect(hookAnnouncement(hookData(), 'write_file "dist/a.js"')).toBe('A hook blocked write_file "dist/a.js"')
    expect(hookAnnouncement(hookData(), null)).toBe('A hook blocked write_file')
    expect(hookAnnouncement(hookData({ toolName: undefined }), ' ')).toBe('A hook blocked a tool call')
    expect(hookAnnouncement(hookData({ event: 'Stop', outcome: 'continued', toolCallId: undefined, toolName: undefined }), null)).toBe('A hook asked the agent to continue')
    for (const outcome of ['context', 'asked', 'allowed', 'rewritten', 'blocked', 'stopped', 'error'] as const)
      expect(hookAnnouncement(hookData({ outcome }), 'write_file')).toBeNull()
  })
})

describe('note helpers', () => {
  it('names what a note\'s toggle shows and the plugin of its first plugin hook', () => {
    expect(hookDetailsKind(hookData({ outcome: 'context', context: 'x' }))).toBe('context')
    expect(hookDetailsKind(hookData({ outcome: 'error' }))).toBe('output')
    expect(hookDetailsKind(hookData())).toBe('details')
    expect(hookPluginId(hookData())).toBeNull()
    expect(hookPluginId(hookData({ hooks: [
      { source: 'personal', label: 'x', exitCode: 0, durationMs: 1 },
      { source: 'plugin', pluginId: 'hook-pack', label: 'y', exitCode: 0, durationMs: 1 },
      { source: 'plugin', pluginId: 'other', label: 'z', exitCode: 0, durationMs: 1 },
    ] }))).toBe('hook-pack')
  })
})
