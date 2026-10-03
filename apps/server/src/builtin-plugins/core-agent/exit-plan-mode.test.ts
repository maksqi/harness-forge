// `exit_plan_mode` (Phase 9, W9.3-T3; ADR-041): `execute` reports the continuation's mode from the run's agent scope
// (`edits` or `ask`), the model reads the frozen text; no scope or another mode is a tool error. The rejection path
// (Keep planning: a denied approval whose reason is the feedback) runs through the SDK and is covered end to end in
// `chat/modes.test.ts`.
import type { ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ExitPlanModeOutput, ToolMode } from '@harness-forge/shared'
import type { AgentRunScope } from '../../chat/agent-scope.ts'
import { exitPlanModeInputSchema, exitPlanModeOutputSchema, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { bindAgentScope } from '../../chat/agent-scope.ts'
import { EXIT_PLAN_MODE_TIMEOUT_MS } from './common.ts'
import {
  createExitPlanModeTool,
  EXIT_PLAN_MODE_MODE_ERROR,
  EXIT_PLAN_MODE_NO_RUN_ERROR,
  EXIT_PLAN_MODE_TOOL_NAME,
  exitPlanModeOutput,
} from './exit-plan-mode.ts'

function context(): ToolCallContext {
  return { chatId: '0199a8f0-0000-7000-8000-000000000001', modelRef: 'mock:plan', toolCallId: 'mock_call_3', messages: [], signal: new AbortController().signal }
}

function scope(toolMode: ToolMode): AgentRunScope {
  return {
    chatId: '0199a8f0-0000-7000-8000-000000000001',
    messageId: 'msg_a000000000000001',
    toolMode,
    runSubagent: () => {
      throw new Error('not used')
    },
    todos: () => null,
  }
}

/** A context bound to an agent scope of `toolMode` (what `wrapToolExecute` does for every call of a run). */
function scoped(toolMode: ToolMode): ToolCallContext {
  const c = context()
  bindAgentScope(c, scope(toolMode))
  return c
}

const PLAN = { plan: '# Plan\n1. Create notes.txt.' }

async function run(tool: ToolDefinition, c: ToolCallContext): Promise<unknown> {
  return Promise.resolve(tool.execute(PLAN, c))
}

describe('exit_plan_mode execute', () => {
  const tool = createExitPlanModeTool() as unknown as ToolDefinition

  it.each(['edits', 'ask'] as const)('returns { approved: true, mode: %s } from the run\'s agent scope', async (mode) => {
    const output = await run(tool, scoped(mode))
    expect(output).toEqual({ approved: true, mode })
    expect(exitPlanModeOutputSchema.parse(output)).toEqual(output)
  })

  it('fails without an agent scope (outside a chat run, or inside a sub-agent)', async () => {
    await expect(run(tool, context())).rejects.toThrow(EXIT_PLAN_MODE_NO_RUN_ERROR)
    expect(() => exitPlanModeOutput(null)).toThrow(EXIT_PLAN_MODE_NO_RUN_ERROR)
  })

  it.each(['plan', 'off', 'auto'] as const)('fails in mode %s: it never reports a mode the run is not in', async (mode) => {
    await expect(run(tool, scoped(mode))).rejects.toThrow(EXIT_PLAN_MODE_MODE_ERROR)
  })

  it('the model reads the frozen text with the mode label', async () => {
    const text = async (mode: ExitPlanModeOutput['mode']) => tool.toModelOutput!(await run(tool, scoped(mode)), { toolCallId: 'mock_call_3', input: PLAN })
    expect(await text('edits')).toEqual({ type: 'text', value: 'The user approved the plan. Mode is now Accept edits. Implement it now; track progress with todo_write.' })
    expect(await text('ask')).toEqual({ type: 'text', value: 'The user approved the plan. Mode is now Ask. Implement it now; track progress with todo_write.' })
  })

  it('keeps the frozen definition: policy always, no workspace access, 60 s, plan up to the shared limit', () => {
    expect(tool.name).toBe(EXIT_PLAN_MODE_TOOL_NAME)
    expect(tool.policy).toBe('always')
    expect(tool.workspace).toBeUndefined()
    expect(tool.timeoutMs).toBe(EXIT_PLAN_MODE_TIMEOUT_MS)
    expect(tool.inputSchema).toBe(exitPlanModeInputSchema)
    const schema = exitPlanModeInputSchema
    expect(schema.safeParse({ plan: 'x'.repeat(LIMITS.planMaxChars) }).success).toBe(true)
    expect(schema.safeParse({ plan: 'x'.repeat(LIMITS.planMaxChars + 1) }).success).toBe(false)
    expect(schema.safeParse({ plan: '' }).success).toBe(false)
  })
})
