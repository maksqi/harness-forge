// The tool set of a sub-agent (P9-0b stub, C26-T5): no tools and a denying approval function until W9.5.
import type { RunSession } from '../pipeline.ts'
import { describe, expect, it } from 'vitest'
import { childTools, SUBAGENT_APPROVAL_DENIED_TEXT } from './tools.ts'

describe('childTools (stub until W9.5)', () => {
  it('offers no tool and never asks', async () => {
    const tools = await childTools({
      session: {} as RunSession,
      type: 'explore',
      toolMode: 'ask',
      model: {} as never,
      workspace: null,
      scope: null,
      parentCallId: 'call_1',
      signal: new AbortController().signal,
    })
    expect(tools.tools).toEqual({})
    expect([...tools.byName.keys()]).toEqual([])
    expect(await tools.toolApproval({ toolCall: { toolName: 'shell', toolCallId: 'call_1/a', input: {} }, messages: [] }))
      .toEqual({ type: 'denied', reason: SUBAGENT_APPROVAL_DENIED_TEXT })
  })
})
