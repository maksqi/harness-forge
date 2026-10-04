// `exit_plan_mode` (Phase 9, W9.3-T3; ADR-041): `execute` reports the continuation's mode from the run's agent scope
// (`edits` or `ask`), the model reads the frozen text; no scope or another mode is a tool error. The rejection path
// (Keep planning: a denied approval whose reason is the feedback) runs through the SDK and is covered end to end in
// `chat/modes.test.ts`. Phase 10 (W10.5-T4, ADR-047): an approved call saves the plan through `scope.savePlan` and the
// output carries `planPath` / `planError` (a failed save never fails the approval); end to end with `mock:plan` in a
// project chat: the plan file, its journal row (tool `exit_plan_mode`), the changes list, rewind and undo; no file when
// `planFiles` is off, for a denied plan or in a chat without a project.
import type { ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ChatDetail, ExitPlanModeOutput, HarnessUIMessage, ProjectSummary, ToolMode } from '@harness-forge/shared'
import type { AgentRunScope, SavedPlan } from '../../chat/agent-scope.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeProjectService } from '../../testing/fake-projects.ts'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chatDetailSchema, exitPlanModeInputSchema, exitPlanModeOutputSchema, LIMITS } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bindAgentScope } from '../../chat/agent-scope.ts'
import { PLAN_FILE_FAILED_ERROR } from '../../chat/plan-file.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from '../../chat/testing.ts'
import { workspaceChanges } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeProjectService } from '../../testing/fake-projects.ts'
import { MOCK_PLAN_NOTES_FILE, MOCK_PLAN_TEXT } from '../mock/plan-mode.ts'
import { EXIT_PLAN_MODE_TIMEOUT_MS } from './common.ts'
import {
  createExitPlanModeTool,
  EXIT_PLAN_MODE_MODE_ERROR,
  EXIT_PLAN_MODE_NO_RUN_ERROR,
  EXIT_PLAN_MODE_TOOL_NAME,
  exitPlanModeModelText,
  exitPlanModeOutput,
  withSavedPlan,
} from './exit-plan-mode.ts'

function context(): ToolCallContext {
  return { chatId: '0199a8f0-0000-7000-8000-000000000001', modelRef: 'mock:plan', toolCallId: 'mock_call_3', messages: [], signal: new AbortController().signal }
}

function scope(toolMode: ToolMode, savePlan: AgentRunScope['savePlan'] = async () => ({})): AgentRunScope {
  return {
    chatId: '0199a8f0-0000-7000-8000-000000000001',
    messageId: 'msg_a000000000000001',
    toolMode,
    runSubagent: () => {
      throw new Error('not used')
    },
    todos: () => null,
    loadSkill: async () => {
      throw new Error('not used')
    },
    savePlan,
  }
}

/** A context bound to an agent scope of `toolMode` (what `wrapToolExecute` does for every call of a run). */
function scoped(toolMode: ToolMode, savePlan?: AgentRunScope['savePlan']): ToolCallContext {
  const c = context()
  bindAgentScope(c, scope(toolMode, savePlan))
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

describe('exit_plan_mode execute: the plan file (Phase 10)', () => {
  const tool = createExitPlanModeTool() as unknown as ToolDefinition

  it('saves the plan through the scope and adds planPath; the model reads the path', async () => {
    const calls: Array<{ plan: string, c: ToolCallContext }> = []
    const c = scoped('edits', async (plan, callContext) => {
      calls.push({ plan, c: callContext })
      return { planPath: '.harness/plans/2026-10-04-plan.md' }
    })
    const output = await run(tool, c)
    expect(output).toEqual({ approved: true, mode: 'edits', planPath: '.harness/plans/2026-10-04-plan.md' })
    expect(calls).toEqual([{ plan: PLAN.plan, c }])
    expect(await tool.toModelOutput!(output, { toolCallId: 'mock_call_3', input: PLAN })).toEqual({
      type: 'text',
      value: 'The user approved the plan. Mode is now Accept edits. Implement it now; track progress with todo_write.\nThe plan was saved to .harness/plans/2026-10-04-plan.md.',
    })
  })

  it('a failed save is planError and never fails the approval (a rejection too)', async () => {
    const failed = await run(tool, scoped('ask', async () => ({ planError: 'The plan folder ".harness/plans" is or goes through a symbolic link.' })))
    expect(failed).toEqual({ approved: true, mode: 'ask', planError: 'The plan folder ".harness/plans" is or goes through a symbolic link.' })
    expect(exitPlanModeModelText(failed as ExitPlanModeOutput)).toBe('The user approved the plan. Mode is now Ask. Implement it now; track progress with todo_write.\nThe plan file could not be saved: The plan folder ".harness/plans" is or goes through a symbolic link.')
    const rejected = await run(tool, scoped('edits', async () => {
      throw new Error('disk on fire')
    }))
    expect(rejected).toEqual({ approved: true, mode: 'edits', planError: PLAN_FILE_FAILED_ERROR })
    expect(exitPlanModeOutputSchema.parse(rejected)).toEqual(rejected)
  })

  it('no save in another mode or without a scope (the mode check comes first)', async () => {
    let saves = 0
    const savePlan = async (): Promise<SavedPlan> => {
      saves += 1
      return { planPath: 'x.md' }
    }
    await expect(run(tool, scoped('plan', savePlan))).rejects.toThrow(EXIT_PLAN_MODE_MODE_ERROR)
    await expect(run(tool, scoped('auto', savePlan))).rejects.toThrow(EXIT_PLAN_MODE_MODE_ERROR)
    expect(saves).toBe(0)
  })

  it('withSavedPlan keeps the output schema: a bad path or an empty error adds nothing, a long error is cut', () => {
    const base: ExitPlanModeOutput = { approved: true, mode: 'edits' }
    expect(withSavedPlan(base, {})).toEqual(base)
    expect(withSavedPlan(base, null)).toEqual(base)
    expect(withSavedPlan(base, { planPath: '' })).toEqual(base)
    expect(withSavedPlan(base, { planPath: 'p'.repeat(LIMITS.workspacePathMaxChars + 1) })).toEqual(base)
    expect(withSavedPlan(base, { planError: '  ' })).toEqual(base)
    expect(withSavedPlan(base, { planPath: 'a.md', planError: 'ignored' })).toEqual({ ...base, planPath: 'a.md' })
    const long = withSavedPlan(base, { planError: 'e'.repeat(2000) })
    expect(long.planError).toHaveLength(500)
    expect(exitPlanModeOutputSchema.safeParse(long).success).toBe(true)
  })
})

// ---------- end to end: mock:plan in a project chat ----------

const PLAN_PATH = /^\.harness\/plans\/\d{4}-\d{2}-\d{2}-plan(?:-\d+)?\.md$/

async function detailOf(t: TestApp, chatId: string): Promise<ChatDetail> {
  const response = await t.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

/** The client's answer to every pending approval of `message` (`addToolApprovalResponse`). */
function decide(message: HarnessUIMessage, approved: boolean, reason?: string): HarnessUIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const value = part as unknown as Record<string, unknown>
      if (value.state !== 'approval-requested')
        return part
      const approval = { ...(value.approval as object), approved, ...(reason === undefined ? {} : { reason }) }
      return { ...value, state: 'approval-responded', approval } as unknown as typeof part
    }),
  }
}

/** Plans with `mock:plan` and answers the card (`edits` when approved, `plan` with feedback otherwise). */
async function planAndDecide(t: TestApp, chatId: string, approved: boolean, projectId?: string): Promise<ChatDetail> {
  await readSse(await postChat(t, chatBody(chatId, 'make a plan', { modelRef: 'mock:plan', toolMode: 'plan', ...(projectId === undefined ? {} : { projectId }) })))
  const leaf = (await detailOf(t, chatId)).messages.at(-1)!
  const toolMode = approved ? 'edits' : 'plan'
  const answer = await readSse(await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:plan', toolMode }), message: decide(leaf, approved, approved ? undefined : 'Use a table') }))
  expect(streamedText(answer.chunks)).toContain(approved ? 'Plan done in mode edits.' : 'Revising: Use a table')
  await runnerOf(t).idle()
  return detailOf(t, chatId)
}

/** The outputs of the chat's `exit_plan_mode` calls. */
function planOutputs(detail: ChatDetail): unknown[] {
  return detail.messages.flatMap(message => message.parts)
    .filter(part => part.type === 'tool-exit_plan_mode' && (part as { state?: string }).state === 'output-available')
    .map(part => (part as { output?: unknown }).output)
}

let nextChat = 10_500

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

// Each plan flow runs the mock's steps (a few seconds per approved plan): a generous timeout per test.
describe('mock:plan with plan files (PROVIDERS.md 8)', { timeout: 30_000 }, () => {
  let t: TestApp
  let project: ProjectSummary

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, factories: { projects: createFakeProjectService } })
  })

  beforeEach(async () => {
    project = await (t.deps.projects as FakeProjectService).add({ name: 'Plan files' })
    await t.deps.settings.update({ planFiles: false, planDirectory: '.harness/plans' })
  })

  afterAll(async () => {
    await t.close()
  })

  it('planFiles on: approve in Accept edits -> the plan file, a journal row, the changes list; rewind removes it, undo restores it', async () => {
    await t.deps.settings.update({ planFiles: true })
    const chatId = newChatId()
    const detail = await planAndDecide(t, chatId, true, project.id)
    const [output, ...others] = planOutputs(detail) as ExitPlanModeOutput[]
    expect(others).toEqual([])
    expect(output).toMatchObject({ approved: true, mode: 'edits' })
    expect(output!.planPath).toMatch(PLAN_PATH)
    expect(output!.planError).toBeUndefined()
    const planPath = output!.planPath!
    const absolute = join(project.path, planPath)
    expect(await readFile(absolute, 'utf8')).toBe(`${MOCK_PLAN_TEXT}\n`)

    const rows = await t.db.select().from(workspaceChanges).where(eq(workspaceChanges.chatId, chatId)).orderBy(workspaceChanges.id)
    expect(rows.map(row => [row.tool, row.path])).toEqual([['exit_plan_mode', planPath], ['write_file', MOCK_PLAN_NOTES_FILE]])
    const changes = await t.deps.checkpoints.listChanges(chatId)
    expect(changes.files.map(file => file.path).sort()).toEqual([planPath, MOCK_PLAN_NOTES_FILE].sort())

    const userMessage = detail.messages.find(message => message.role === 'user')!
    const rewound = await t.deps.checkpoints.rewind(chatId, { messageId: userMessage.id, conflicts: 'skip' })
    expect(rewound.deleted.sort()).toEqual([planPath, MOCK_PLAN_NOTES_FILE].sort())
    expect(existsSync(absolute)).toBe(false)
    const undone = await t.deps.checkpoints.undo(chatId, { batchId: rewound.batchId!, conflicts: 'skip' })
    expect(undone.restored).toContain(planPath)
    expect(await readFile(absolute, 'utf8')).toBe(`${MOCK_PLAN_TEXT}\n`)
  })

  it('a second approved plan of the same day gets the next name (-2)', async () => {
    await t.deps.settings.update({ planFiles: true })
    const first = planOutputs(await planAndDecide(t, newChatId(), true, project.id)) as ExitPlanModeOutput[]
    const second = planOutputs(await planAndDecide(t, newChatId(), true, project.id)) as ExitPlanModeOutput[]
    const planPath = first[0]!.planPath!
    expect(second[0]!.planPath).toBe(planPath.replace(/\.md$/, '-2.md'))
    expect(await readFile(join(project.path, second[0]!.planPath!), 'utf8')).toBe(`${MOCK_PLAN_TEXT}\n`)
  })

  it('planFiles off (the default): no file, no planPath', async () => {
    const detail = await planAndDecide(t, newChatId(), true, project.id)
    expect(planOutputs(detail)).toEqual([{ approved: true, mode: 'edits' }])
    expect(existsSync(join(project.path, '.harness'))).toBe(false)
  })

  it('a denied plan writes nothing', async () => {
    await t.deps.settings.update({ planFiles: true })
    const detail = await planAndDecide(t, newChatId(), false, project.id)
    expect(planOutputs(detail)).toEqual([])
    expect(existsSync(join(project.path, '.harness'))).toBe(false)
  })

  it('a chat without a project: approved, no file', async () => {
    await t.deps.settings.update({ planFiles: true })
    const detail = await planAndDecide(t, newChatId(), true)
    expect(planOutputs(detail)).toEqual([{ approved: true, mode: 'edits' }])
    expect(await readdir(project.path)).toEqual([])
  })
})
