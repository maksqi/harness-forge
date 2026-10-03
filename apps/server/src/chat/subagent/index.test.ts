// The sub-agent runner (P9-0b stub, C26-T5): one `failed` output until W9.5.
import type { TaskOutput } from '@harness-forge/shared'
import type { RunSession } from '../pipeline.ts'
import { taskOutputSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createSubagentRunner, SUBAGENTS_UNAVAILABLE_TEXT } from './index.ts'

describe('createSubagentRunner (stub until W9.5)', () => {
  it('yields one failed output', async () => {
    const session = { ctx: { now: () => 1234 } } as unknown as RunSession
    const runner = createSubagentRunner({ session, model: { modelRef: 'mock:subagent' } as never, toolMode: 'ask', workspace: null, scope: null })
    const outputs: TaskOutput[] = []
    for await (const output of runner.run({ description: 'List files', prompt: 'List the project files', type: 'explore' }, { toolCallId: 'call_1', signal: new AbortController().signal }))
      outputs.push(output)
    expect(outputs).toEqual([{
      status: 'failed',
      type: 'explore',
      description: 'List files',
      modelRef: 'mock:subagent',
      steps: [],
      stepsOmitted: 0,
      report: '',
      startedAt: 1234,
      finishedAt: 1234,
      error: SUBAGENTS_UNAVAILABLE_TEXT,
    }])
    expect(taskOutputSchema.safeParse(outputs[0]).success).toBe(true)
  })
})
