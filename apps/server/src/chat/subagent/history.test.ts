// Sub-agent outputs in the model history (W9.5-T6): stored `tool-task` outputs keep only `{ status, report, error? }`.
import type { HarnessUIMessage, HarnessUIMessagePart, TaskOutput } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { taskModelText } from '../../builtin-plugins/core-agent/index.ts'
import { buildModelHistory } from '../model-history.ts'
import { reduceAgentOutputs, reduceTaskOutput, TASK_PART_TYPE } from './history.ts'

const FULL: TaskOutput = {
  status: 'completed',
  type: 'explore',
  description: 'List the files',
  modelRef: 'mock:subagent',
  steps: [{ toolCallId: 'mock_call_1', toolName: 'list_directory', summary: '.', state: 'done', resultPreview: 'secret-looking preview' }],
  stepsOmitted: 3,
  report: 'Found 3 files.',
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  costUsd: 0.001,
  startedAt: 1,
  finishedAt: 2,
}

function taskPart(output: unknown, state = 'output-available', toolCallId = 'call_1'): HarnessUIMessagePart {
  return { type: TASK_PART_TYPE, toolCallId, state, input: { description: 'List the files', prompt: 'List.', type: 'explore' }, output } as unknown as HarnessUIMessagePart
}

function assistant(parts: HarnessUIMessagePart[], id = 'msg_a000000000000001'): HarnessUIMessage {
  return { id, role: 'assistant', parts }
}

const user: HarnessUIMessage = { id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'Explore.' }] }

describe('reduceTaskOutput', () => {
  it('keeps status, report and error of a TaskOutput-like value; null for anything else', () => {
    expect(reduceTaskOutput(FULL)).toEqual({ status: 'completed', report: 'Found 3 files.' })
    expect(reduceTaskOutput({ ...FULL, status: 'failed', error: 'Boom.' })).toEqual({ status: 'failed', report: 'Found 3 files.', error: 'Boom.' })
    expect(reduceTaskOutput({ status: 'completed', report: 'Already reduced.' })).toEqual({ status: 'completed', report: 'Already reduced.' })
    expect(reduceTaskOutput({ truncated: true, originalBytes: 99, preview: '{' })).toBeNull()
    expect(reduceTaskOutput({ status: 1, report: 'x' })).toBeNull()
    expect(reduceTaskOutput('text')).toBeNull()
    expect(reduceTaskOutput(null)).toBeNull()
    // Phase 10: a background launch keeps its task id (the model text names it); the agent snapshot is dropped.
    const launch = { ...FULL, status: 'background', report: '', taskId: 'bgt_0123456789abcdef', agent: { source: 'project', description: 'Reviews.', path: '.harness/agents/r.md' } }
    expect(reduceTaskOutput(launch)).toEqual({ status: 'background', report: '', taskId: 'bgt_0123456789abcdef' })
    expect(reduceTaskOutput({ ...FULL, taskId: 7 })).toEqual({ status: 'completed', report: 'Found 3 files.' })
    expect(reduceTaskOutput([FULL])).toBeNull()
  })
})

describe('reduceAgentOutputs', () => {
  it('reduces stored task outputs and keeps everything else (the same objects when nothing changes)', () => {
    const other = { type: 'tool-read_file', toolCallId: 'call_2', state: 'output-available', input: {}, output: { status: 'x', report: 'y', steps: [] } } as unknown as HarnessUIMessagePart
    const message = assistant([{ type: 'text', text: 'Delegating.' }, taskPart(FULL), other, taskPart(undefined, 'output-error', 'call_3')])
    const plain = assistant([{ type: 'text', text: 'x' }], 'msg_a000000000000002')
    const reduced = reduceAgentOutputs([user, message, plain])
    expect(reduced[0]).toBe(user)
    expect(reduced[2]).toBe(plain)
    const parts = reduced[1]!.parts as unknown as Record<string, unknown>[]
    expect(parts[0]).toBe(message.parts[0])
    expect(parts[1]).toEqual({ ...(message.parts[1] as object), output: { status: 'completed', report: 'Found 3 files.' } })
    expect(parts[2]).toBe(message.parts[2])
    expect(parts[3]).toBe(message.parts[3])
    // The stored message is never changed.
    expect((message.parts[1] as unknown as { output: TaskOutput }).output.steps).toHaveLength(1)
  })

  it('returns the same message when its task outputs cannot be reduced', () => {
    const marker = assistant([taskPart({ truncated: true, originalBytes: 70_000, preview: '{"status"' })])
    expect(reduceAgentOutputs([marker])[0]).toBe(marker)
    const userWithTaskLikePart = { ...user, parts: [taskPart(FULL)] } as HarnessUIMessage
    expect(reduceAgentOutputs([userWithTaskLikePart])[0]).toBe(userWithTaskLikePart)
  })

  it('runs inside buildModelHistory: the model never receives the steps; the model text reads the reduced output', () => {
    const history = buildModelHistory([user, assistant([taskPart({ ...FULL, status: 'limit', report: 'Partial.', error: 'Step limit.' })])])
    const part = history[1]!.parts[0] as unknown as { output: Parameters<typeof taskModelText>[0] }
    expect(part.output).toEqual({ status: 'limit', report: 'Partial.', error: 'Step limit.' })
    expect(JSON.stringify(history)).not.toContain('secret-looking preview')
    expect(taskModelText(part.output)).toBe('Partial.')
  })
})
