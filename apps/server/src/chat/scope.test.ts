// The run scope of the chat pipeline (Phase 8, W8.5; ADR-036 / ADR-038, ARCHITECTURE.md 6.13):
// - `createRunScope`: the journal, the rules (once per run) and the shared working folder, with fail-safe fallbacks;
// - end to end over `POST /api/chat` with the fake checkpoint and shell rule services and a stand-in `core-workspace`
//   shell (`mock:shell`): the tool and its policy see the run scope, an allowlisted command runs without a card, a
//   continuation after an approval keeps the assistant message id, a stored `allow` override on the shell is ignored,
//   and a chat without a project gets no scope.
import type { ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ChatDetail, HarnessUIMessage, ShellToolInput } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeCheckpointService } from '../testing/fake-checkpoints.ts'
import type { FakeProjectService } from '../testing/fake-projects.ts'
import type { FakeShellRuleService } from '../testing/fake-shell-rules.ts'
import type { WorkspaceRunScope } from '../workspace/run-scope.ts'
import process from 'node:process'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { chatDetailSchema, matchShellRules, shellToolInputSchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinPlugins } from '../builtin-plugins/index.ts'
import { MOCK_WORKSPACE_UNAVAILABLE } from '../builtin-plugins/mock/workspace.ts'
import { toolPrefs } from '../db/schema.ts'
import { createMemoryLogger } from '../logger.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeCheckpointService } from '../testing/fake-checkpoints.ts'
import { createFakeProjectService } from '../testing/fake-projects.ts'
import { createFakeShellRuleService } from '../testing/fake-shell-rules.ts'
import { runScopeOf } from '../workspace/run-scope.ts'
import { createRunScope } from './scope.ts'
import { answerApprovals, chatBody, postChat, readSse, runnerOf, streamedText, testChatId, userMessage } from './testing.ts'

const shellCwd = vi.hoisted(() => ({ initialShellCwd: vi.fn((_history: readonly unknown[]): string => '.') }))

vi.mock('../workspace/shell-cwd.ts', async importOriginal => ({ ...(await importOriginal<object>()), initialShellCwd: shellCwd.initialShellCwd }))

const PROJECT_ID = 'prj_0123456789abcdef'
const MESSAGE_ID = 'msg_a000000000000001'
const SHELL_OFFERED = process.platform !== 'win32'

describe('createRunScope', () => {
  beforeEach(() => {
    shellCwd.initialShellCwd.mockReset()
    shellCwd.initialShellCwd.mockReturnValue('.')
  })

  it('is null for a run without a workspace (no journal, no rules read, no folder derived)', async () => {
    const checkpoints = createFakeCheckpointService()
    const shellRules = createFakeShellRuleService()
    const scope = await createRunScope({ checkpoints, shellRules }, { chatId: 'chat', messageId: MESSAGE_ID, workspace: null, history: [], logger: createMemoryLogger().logger })
    expect(scope).toBeNull()
    expect(checkpoints.journals).toEqual([])
    expect(shellRules.forRunCalls).toEqual([])
    expect(shellCwd.initialShellCwd).not.toHaveBeenCalled()
  })

  it('opens the journal of the run, reads the rules once and seeds the working folder from the history', async () => {
    const checkpoints = createFakeCheckpointService()
    const shellRules = createFakeShellRuleService()
    await shellRules.create({ projectId: null, prefix: 'git status' })
    await shellRules.create({ projectId: PROJECT_ID, prefix: 'ls' })
    await shellRules.create({ projectId: 'prj_fedcba9876543210', prefix: 'make' })
    shellCwd.initialShellCwd.mockReturnValue('packages/web')
    const history: HarnessUIMessage[] = [userMessage('hi')]
    const scope = await createRunScope({ checkpoints, shellRules }, { chatId: 'chat', messageId: MESSAGE_ID, workspace: { projectId: PROJECT_ID }, history, logger: createMemoryLogger().logger })
    expect(scope).toMatchObject({ chatId: 'chat', messageId: MESSAGE_ID, projectId: PROJECT_ID, shellCwd: { current: 'packages/web' } })
    expect(scope?.shellRules).toEqual({ projectId: PROJECT_ID, prefixes: ['git status', 'ls'] })
    expect(scope?.journal?.scope).toEqual({ chatId: 'chat', messageId: MESSAGE_ID, projectId: PROJECT_ID })
    expect(checkpoints.journals).toEqual([{ chatId: 'chat', messageId: MESSAGE_ID, projectId: PROJECT_ID }])
    expect(shellRules.forRunCalls).toEqual([PROJECT_ID])
    expect(shellCwd.initialShellCwd).toHaveBeenCalledWith(history)
  })

  it('never stops the run: no journal, no rules (every command asks) and the project folder on failures', async () => {
    const checkpoints = createFakeCheckpointService({ journal: () => {
      throw new Error('store closed')
    } })
    const shellRules = { ...createFakeShellRuleService(), forRun: async () => {
      throw new Error('database is locked')
    } }
    shellCwd.initialShellCwd.mockImplementation(() => {
      throw new Error('bad history')
    })
    const memory = createMemoryLogger()
    const scope = await createRunScope({ checkpoints, shellRules }, { chatId: 'chat', messageId: MESSAGE_ID, workspace: { projectId: PROJECT_ID }, history: [], logger: memory.logger })
    expect(scope).toEqual({ chatId: 'chat', messageId: MESSAGE_ID, projectId: PROJECT_ID, journal: null, shellRules: { projectId: PROJECT_ID, prefixes: [] }, shellCwd: { current: '.' } })
    expect(Object.isFrozen(scope?.shellRules)).toBe(true)
    expect(memory.records.map(record => [record.level, record.msg])).toEqual([
      ['warn', 'cannot open the checkpoint journal; the run writes without recording'],
      ['warn', 'cannot read the shell rules; every shell command asks'],
      ['warn', 'cannot derive the shell working folder; the run starts in the project folder'],
    ])
  })
})

// ---------- end to end ----------

interface Seen {
  command: string
  scope: WorkspaceRunScope | null
}

/** What the stand-in shell's policy function and `execute` saw, in order. */
const policies: Seen[] = []
const executions: Seen[] = []

/**
 * A stand-in of the core `shell` (real name, schema, access): its policy matches the run's rules like `shellPolicy`
 * (`safe` when the whole command matches, else `ask`); `execute` runs nothing and answers `ran <command>`.
 */
const standInShell: ToolDefinition<ShellToolInput> = {
  name: 'shell',
  description: 'Runs a command (test stand-in).',
  inputSchema: shellToolInputSchema,
  workspace: 'execute',
  policy: (input: ShellToolInput, c: ToolCallContext) => {
    const scope = runScopeOf(c)
    policies.push({ command: input.command, scope })
    return matchShellRules(input.command, scope?.shellRules.prefixes ?? []).allowed ? 'safe' : 'ask'
  },
  execute: async (input: ShellToolInput, c: ToolCallContext) => {
    executions.push({ command: input.command, scope: runScopeOf(c) })
    return { exitCode: 0, stdout: `ran ${input.command}`, stderr: '' }
  },
}

let nextChat = 7600

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

async function detailOf(t: TestApp, chatId: string): Promise<ChatDetail> {
  const response = await t.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

/** The tool call id of the (only) shell part of a stored assistant message. */
function shellCallId(message: HarnessUIMessage | undefined): string | undefined {
  const part = message?.parts.find(item => item.type === 'tool-shell') as { toolCallId?: string } | undefined
  return part?.toolCallId
}

describe.skipIf(!SHELL_OFFERED)('the run scope in chat runs (mock:shell, stand-in shell, fake services)', () => {
  let t: TestApp
  let projects: FakeProjectService
  let checkpoints: FakeCheckpointService
  let rules: FakeShellRuleService

  beforeAll(async () => {
    const builtins = getBuiltinPlugins({ mockProvider: true }).map(builtin => (builtin.id === 'core-workspace'
      ? { ...builtin, module: definePlugin({ setup(ctx) {
          ctx.tools.register(standInShell as ToolDefinition)
        } }) }
      : builtin))
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, builtins, checkpoints: 'fake', shellRules: 'fake', factories: { projects: createFakeProjectService } })
    projects = t.deps.projects as FakeProjectService
    checkpoints = t.deps.checkpoints as FakeCheckpointService
    rules = t.deps.shellRules as FakeShellRuleService
  })

  beforeEach(() => {
    policies.length = 0
    executions.length = 0
    checkpoints.journals.length = 0
    checkpoints.records.length = 0
    rules.forRunCalls.length = 0
    shellCwd.initialShellCwd.mockReset()
    shellCwd.initialShellCwd.mockReturnValue('.')
  })

  afterAll(async () => {
    await t.close()
  })

  it('a first run: the policy and the tool see the run scope; an allowlisted command runs without a card', async () => {
    const project = await projects.add({ name: 'Scope' })
    await rules.create({ projectId: project.id, prefix: 'ls' })
    shellCwd.initialShellCwd.mockReturnValue('src')
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'ls -la', { modelRef: 'mock:shell', toolMode: 'ask', projectId: project.id })))
    expect(chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
    expect(streamedText(chunks)).toBe('Shell done: ran ls -la')

    const assistant = (await detailOf(t, chatId)).messages[1]!
    const toolCallId = shellCallId(assistant)!
    const expected = { chatId, messageId: assistant.id, projectId: project.id, toolCallId }
    expect(policies).toHaveLength(1)
    expect(executions).toHaveLength(1)
    expect(policies[0]?.scope).toMatchObject({ ...expected, shellRules: { projectId: project.id, prefixes: ['ls'] }, shellCwd: { current: 'src' } })
    expect(executions[0]?.scope).toMatchObject(expected)
    // One journal, one rule read, one working folder object per run.
    expect(executions[0]?.scope?.shellCwd).toBe(policies[0]?.scope?.shellCwd)
    expect(executions[0]?.scope?.journal).toBe(policies[0]?.scope?.journal)
    expect(checkpoints.journals).toEqual([{ chatId, messageId: assistant.id, projectId: project.id }])
    expect(rules.forRunCalls).toEqual([project.id])
    expect(checkpoints.records).toEqual([{ kind: 'shell', scope: { chatId, messageId: assistant.id, projectId: project.id }, toolCallId, command: 'ls -la' }])
    // The folder is derived from the run's history (the new user message last).
    const history = shellCwd.initialShellCwd.mock.calls[0]?.[0] as HarnessUIMessage[]
    expect(history.at(-1)?.role).toBe('user')
    await runnerOf(t).idle()
  })

  it('a continuation after an approval keeps the assistant message id', async () => {
    const project = await projects.add({ name: 'Continue' })
    const chatId = newChatId()
    const first = await readSse(await postChat(t, chatBody(chatId, 'rm build.log', { modelRef: 'mock:shell', toolMode: 'ask', projectId: project.id })))
    expect(first.chunks.filter(chunk => chunk.type === 'tool-approval-request')).toHaveLength(1)
    expect(executions).toEqual([])
    expect(checkpoints.records).toEqual([])
    const pending = (await detailOf(t, chatId)).messages[1]!

    const { chunks } = await readSse(await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:shell', toolMode: 'ask' }), message: answerApprovals(pending, true) }))
    expect(streamedText(chunks)).toBe('Shell done: ran rm build.log')
    const done = (await detailOf(t, chatId)).messages
    expect(done).toHaveLength(2)
    expect(done[1]?.id).toBe(pending.id)
    const toolCallId = shellCallId(done[1])!
    expect(executions).toHaveLength(1)
    expect(executions[0]?.scope).toMatchObject({ chatId, messageId: pending.id, projectId: project.id, toolCallId })
    const scope = { chatId, messageId: pending.id, projectId: project.id }
    expect(checkpoints.journals).toEqual([scope, scope])
    expect(rules.forRunCalls).toEqual([project.id, project.id])
    expect(checkpoints.records).toEqual([{ kind: 'shell', scope, toolCallId, command: 'rm build.log' }])
    // The continuation's history ends with the continued message.
    const history = shellCwd.initialShellCwd.mock.calls[1]?.[0] as HarnessUIMessage[]
    expect(history.at(-1)?.id).toBe(pending.id)
    await runnerOf(t).idle()
  })

  it('ignores a stored allow override on the shell: a command without a rule still asks', async () => {
    const project = await projects.add({ name: 'Override' })
    await t.db.insert(toolPrefs).values({ toolName: 'shell', enabled: true, override: 'allow' })
    try {
      const chatId = newChatId()
      const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'rm -rf dist', { modelRef: 'mock:shell', toolMode: 'ask', projectId: project.id })))
      expect(chunks.filter(chunk => chunk.type === 'tool-approval-request')).toHaveLength(1)
      expect(executions).toEqual([])
      await runnerOf(t).idle()
    }
    finally {
      await t.db.delete(toolPrefs).where(eq(toolPrefs.toolName, 'shell'))
    }
  })

  it('a chat without a project gets no scope: no journal, no rules read, no folder derived', async () => {
    const { chunks } = await readSse(await postChat(t, chatBody(newChatId(), 'ls', { modelRef: 'mock:shell', toolMode: 'auto' })))
    expect(streamedText(chunks)).toBe(MOCK_WORKSPACE_UNAVAILABLE)
    expect(checkpoints.journals).toEqual([])
    expect(rules.forRunCalls).toEqual([])
    expect(shellCwd.initialShellCwd).not.toHaveBeenCalled()
    await runnerOf(t).idle()
  })
})
