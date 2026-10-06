// The outcome, the result and the record of one event (W11.1-T3): every outcome of `hookRecordOutcomeSchema` the
// service writes, the silent success, the caps and the schema of the record.
import type { HookEvent, HookOutcome } from '@harness-forge/shared'
import type { RanHook } from './record.ts'
import { hookDataSchema, LIMITS, readHookOutput } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { eventResult, recordEntry, singleOutcome } from './record.ts'

const ID = 'hev_AAAAAAAAAAAAAAAA'

function ran(event: HookEvent, stdout: string, fields: { exitCode?: number | null, stderr?: string, timedOut?: boolean, source?: RanHook['source'] } = {}): RanHook {
  const exitCode = fields.exitCode === undefined ? 0 : fields.exitCode
  const outcome: HookOutcome = readHookOutput(event, { exitCode, timedOut: fields.timedOut ?? false, stdout, stdoutTruncated: false, stderr: fields.stderr ?? '' })
  return { source: fields.source ?? 'personal', label: 'sh hook.sh', exitCode, timedOut: fields.timedOut ?? false, durationMs: 12, outcome, error: outcome.error }
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function pre(decision: string, extra: Record<string, unknown> = {}): string {
  return json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: `${decision} reason`, ...extra } })
}

const TOOL = { callId: 'call-1', name: 'shell' }

describe('hook event results and records', () => {
  it('preToolUse outcomes: denied > asked > allowed > rewritten; stopped; the updated input', () => {
    const outcome = (...hooks: RanHook[]) => eventResult({ event: 'PreToolUse', ran: hooks, id: ID, createdAt: 1, tool: TOOL })
    expect(outcome(ran('PreToolUse', pre('allow')), ran('PreToolUse', pre('ask')), ran('PreToolUse', pre('deny'))).result).toMatchObject({ decision: 'deny', block: true, reason: 'deny reason', record: { outcome: 'denied', reason: 'deny reason', toolCallId: 'call-1', toolName: 'shell' } })
    expect(outcome(ran('PreToolUse', pre('allow')), ran('PreToolUse', pre('ask'))).result.record?.outcome).toBe('asked')
    const allowed = outcome(ran('PreToolUse', pre('allow', { updatedInput: { command: 'ls -la' } }))).result
    expect(allowed).toMatchObject({ decision: 'allow', updatedInput: { command: 'ls -la' }, record: { outcome: 'allowed', updatedInput: { command: 'ls -la' } } })
    const rewritten = outcome(ran('PreToolUse', json({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'echo rewritten' } } }))).result
    expect(rewritten).toMatchObject({ decision: null, updatedInput: { command: 'echo rewritten' }, record: { outcome: 'rewritten' } })
    // A deny drops every rewrite.
    const denied = outcome(ran('PreToolUse', json({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'x' } } })), ran('PreToolUse', '', { exitCode: 2, stderr: 'nope' })).result
    expect(denied.updatedInput).toBeUndefined()
    expect(denied.record).toMatchObject({ outcome: 'denied', reason: 'nope' })
    expect(denied.record?.updatedInput).toBeUndefined()
    expect(outcome(ran('PreToolUse', json({ continue: false, stopReason: 'Enough.' }))).result).toMatchObject({ continue: false, stopReason: 'Enough.', record: { outcome: 'stopped', reason: 'Enough.' } })
  })

  it('the other outcomes: continued, blocked, context, error, a system message; a silent success has no record', () => {
    const result = (event: HookEvent, ...hooks: RanHook[]) => eventResult({ event, ran: hooks, id: ID, createdAt: 1, tool: null }).result
    expect(result('Stop', ran('Stop', json({ decision: 'block', reason: 'Run the tests.' })))).toMatchObject({ block: true, record: { outcome: 'continued', reason: 'Run the tests.' } })
    // `continue: false` wins over a block (no follow-up turn).
    expect(result('Stop', ran('Stop', json({ decision: 'block', reason: 'x', continue: false })))).toMatchObject({ block: true, continue: false, record: { outcome: 'stopped' } })
    expect(result('SubagentStop', ran('SubagentStop', '', { exitCode: 2, stderr: 'Again.' }))).toMatchObject({ block: true, record: { outcome: 'blocked', reason: 'Again.' } })
    expect(result('UserPromptSubmit', ran('UserPromptSubmit', 'Today is Monday.'))).toMatchObject({ context: 'Today is Monday.', record: { outcome: 'context', context: 'Today is Monday.' } })
    expect(result('PostToolUse', ran('PostToolUse', '', { exitCode: 1, stderr: 'secret stderr' }))).toMatchObject({ block: false, record: { outcome: 'error', hooks: [{ exitCode: 1, error: 'The hook failed with exit code 1.' }] } })
    expect(result('Notification', ran('Notification', '', { exitCode: null, timedOut: true }))).toMatchObject({ record: { outcome: 'error', hooks: [{ timedOut: true, exitCode: null }] } })
    expect(result('PreCompact', ran('PreCompact', json({ systemMessage: 'Compacting now.' })))).toMatchObject({ record: { outcome: 'context', hooks: [{ systemMessage: 'Compacting now.' }] } })
    expect(result('Stop', ran('Stop', ''))).toEqual({ ran: true, decision: null, reason: null, context: null, block: false, continue: true, stopReason: null, record: null })
    expect(result('Stop')).toMatchObject({ ran: false, record: null })
    expect(JSON.stringify(result('PostToolUse', ran('PostToolUse', '', { exitCode: 1, stderr: 'secret stderr' })))).not.toContain('secret stderr')
  })

  it('records validate against the shared schema and respect the caps', () => {
    const many = Array.from({ length: LIMITS.hooksPerEventMax + 3 }, (_, index) => ran('PostToolUse', json({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `context ${index} ${'x'.repeat(1000)}` } })))
    const { result } = eventResult({ event: 'PostToolUse', ran: many, id: ID, createdAt: 5, tool: TOOL })
    const record = result.record
    expect(hookDataSchema.safeParse(record).success).toBe(true)
    expect(record?.hooks).toHaveLength(LIMITS.hooksPerEventMax)
    expect(record?.context?.length).toBeLessThanOrEqual(LIMITS.hookContextMaxChars)
    expect(record).toMatchObject({ id: ID, event: 'PostToolUse', createdAt: 5, toolCallId: 'call-1', toolName: 'shell' })
    // Code hooks of several plugins share one outcome: it joins the combination once.
    const code: RanHook = { source: 'plugin', label: 'a: run.stop', pluginId: 'a', exitCode: null, timedOut: false, durationMs: 1, outcome: readHookOutput('Stop', { exitCode: 0, timedOut: false, stdout: json({ decision: 'block', reason: 'R' }), stdoutTruncated: false, stderr: '' }), error: null }
    const twice = eventResult({ event: 'Stop', ran: [code, { ...code, label: 'b: run.stop', pluginId: 'b', shared: true }], id: ID, createdAt: 1 })
    expect(twice.result.reason).toBe('R')
    expect(twice.result.record?.hooks.map(hook => hook.pluginId)).toEqual(['a', 'b'])
    expect(recordEntry({ ...code, label: 'l'.repeat(500), error: 'e'.repeat(5000) })).toMatchObject({ label: 'l'.repeat(LIMITS.hookLabelMaxChars), error: 'e'.repeat(LIMITS.hookSystemMessageMaxChars) })
    expect(singleOutcome('Stop', code)).toBe('continued')
    expect(singleOutcome('Stop', ran('Stop', ''))).toBeNull()
  })
})
