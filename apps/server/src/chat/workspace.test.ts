// Projects and workspaces in the chat pipeline (Phase 7, W7.4; ADR-031 / ADR-032, ARCHITECTURE.md 6.13), end to end
// over `POST /api/chat` with the fake project service (real temp folders):
// - the workspace tools are offered only in a chat whose project folder opened (`execute` only with the shell switch on);
// - the instructions: global → workspace block → project file → project instructions → chat instructions;
// - a folder that cannot be opened gives the `workspace-unavailable` notice and no workspace tool;
// - chats with a project use `projectMaxSteps`;
// - `mock:workspace` in Accept edits mode: write and edit run without asking, the shell asks; every tool gets the frozen
//   `ToolCallContext.workspace`.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable, ToolCallContext, ToolDefinition, ToolWorkspace } from '@harness-forge/plugin-sdk'
import type { ChatDetail, EditFileToolInput, HarnessUIMessage, ProjectSummary, ShellToolInput, WriteFileToolInput } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeProjectService } from '../testing/fake-projects.ts'
import { readFile, rm } from 'node:fs/promises'
import process from 'node:process'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { chatDetailSchema, editFileToolInputSchema, shellToolInputSchema, writeFileToolInputSchema } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getBuiltinPlugins } from '../builtin-plugins/index.ts'
import { MOCK_WORKSPACE_CONTENT, MOCK_WORKSPACE_FILE, MOCK_WORKSPACE_UNAVAILABLE } from '../builtin-plugins/mock/workspace.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeProjectService } from '../testing/fake-projects.ts'
import { readWorkspaceFile, writeWorkspaceFile } from '../workspace/paths.ts'
import { osName } from './params.ts'
import { answerApprovals, chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from './testing.ts'

const WORKSPACE_TOOLS = ['read_file', 'list_directory', 'find_files', 'search_files', 'write_file', 'edit_file', 'shell']
const SHELL_OFFERED = process.platform !== 'win32'
let nextChat = 7000

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

function finishPart(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finishPart()]
}

/** A model whose answer is computed from the call options (calls are recorded). */
function scriptedModel(script: (options: LanguageModelV4CallOptions, call: number) => LanguageModelV4StreamPart[]): { model: LanguageModelV4, calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    provider: 'testkit',
    modelId: 'agent',
    doStream: async (options) => {
      calls.push(options)
      return { stream: convertArrayToReadableStream(script(options, calls.length)) }
    },
  })
  return { model, calls }
}

/** Names of the function tools of a model call. */
function toolNames(call: LanguageModelV4CallOptions | undefined): string[] {
  return (call?.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.name] : [])).sort()
}

/** The system prompt of a model call. */
function systemOf(call: LanguageModelV4CallOptions | undefined): string {
  const first = call?.prompt[0]
  return first?.role === 'system' ? first.content : ''
}

/** Registers the `testkit` provider (model `agent`, tools, from `scripted`) on an app. */
function registerTestkit(app: TestApp, scripted: Map<string, LanguageModelV4>): Disposable {
  return app.deps.registry.providers.register('mock', {
    id: 'testkit',
    name: 'Test kit',
    credentials: [],
    seedModels: [{ id: 'agent', name: 'Agent', contextWindow: 64_000, capabilities: { tools: true } }],
    createLanguageModel: (modelId) => {
      const model = scripted.get(modelId)
      if (model === undefined)
        throw new Error(`No scripted model "${modelId}".`)
      return model
    },
  })
}

async function detailOf(app: TestApp, chatId: string): Promise<ChatDetail> {
  const response = await app.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

async function patchChat(app: TestApp, chatId: string, body: unknown): Promise<void> {
  const response = await app.request(`/api/chats/${chatId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(response.status).toBe(200)
}

function toolParts(message: HarnessUIMessage | undefined): Record<string, unknown>[] {
  return (message?.parts ?? []).filter(part => part.type.startsWith('tool-')) as unknown as Record<string, unknown>[]
}

describe('workspace tools, instructions, notice and steps (real core-workspace definitions)', () => {
  let t: TestApp
  let projects: FakeProjectService
  let testkit: Disposable
  const scripted = new Map<string, LanguageModelV4>()

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, factories: { projects: createFakeProjectService } })
    projects = t.deps.projects as FakeProjectService
    testkit = registerTestkit(t, scripted)
  })

  beforeEach(() => {
    scripted.clear()
  })

  afterAll(async () => {
    testkit.dispose()
    await t.close()
  })

  it('a chat without a project is offered no workspace tool and gets no workspace block', async () => {
    const { model, calls } = scriptedModel(() => textParts('ok'))
    scripted.set('agent', model)
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'hi', { modelRef: 'testkit:agent' })))
    const sent = toolNames(calls[0])
    expect(sent.length).toBeGreaterThan(0)
    for (const name of WORKSPACE_TOOLS)
      expect(sent).not.toContain(name)
    expect(systemOf(calls[0])).not.toContain('Project "')
    expect(projects.opened).not.toContain(chatId)
    await runnerOf(t).idle()
  })

  it('a project chat gets the workspace tools and the instructions in order on every run', async () => {
    const project = await projects.add({ name: 'Demo', instructions: 'Project rules.', files: { 'AGENTS.md': 'Use pnpm.\n' } })
    await t.deps.settings.update({ instructions: 'Global rules.' })
    const { model, calls } = scriptedModel(() => textParts('ok'))
    scripted.set('agent', model)
    try {
      const chatId = newChatId()
      await readSse(await postChat(t, chatBody(chatId, 'first', { modelRef: 'testkit:agent', projectId: project.id })))
      expect((await detailOf(t, chatId)).projectId).toBe(project.id)
      await patchChat(t, chatId, { settings: { instructions: 'Chat rules.' } })
      await readSse(await postChat(t, chatBody(chatId, 'second', { modelRef: 'testkit:agent' })))
      // Each run opens the folder twice: its workspace and its customization catalog (Phase 10, W10.1; `run.finished`
      // drops the cached catalog, so the next run builds it again).
      expect(projects.opened.filter(id => id === project.id)).toHaveLength(4)

      const sent = toolNames(calls[1])
      for (const name of WORKSPACE_TOOLS.filter(name => name !== 'shell' || SHELL_OFFERED))
        expect(sent).toContain(name)
      const system = systemOf(calls[1])
      const block = `Project "Demo", folder ${project.path} (${osName()}).`
      const parts = ['Global rules.', block, 'Instructions from AGENTS.md in the project folder:\n\nUse pnpm.', 'Project rules.', 'Chat rules.']
      const positions = parts.map(part => system.indexOf(part))
      expect(positions.every(position => position >= 0)).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
      expect(system).toContain('- Read a file with read_file before you change it.')
      expect(system).toContain('- Prefer edit_file for changes to an existing file')
      expect(system.includes('- Each shell call runs in a new process')).toBe(SHELL_OFFERED)
      await runnerOf(t).idle()
    }
    finally {
      await t.deps.settings.update({ instructions: '' })
    }
  })

  it('a folder that cannot be opened gives the workspace-unavailable notice and no workspace tool', async () => {
    const project = await projects.add({ name: 'Gone' })
    const { model, calls } = scriptedModel(() => textParts('ok'))
    scripted.set('agent', model)
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'first', { modelRef: 'testkit:agent', projectId: project.id })))
    expect(toolNames(calls[0])).toContain('read_file')
    await rm(project.path, { recursive: true, force: true })

    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'second', { modelRef: 'testkit:agent' })))
    const message = `The project folder ${project.path} is not available: The folder no longer exists.`
    const notices = chunks.flatMap(chunk => (chunk.type === 'data-notice' ? [chunk.data] : []))
    expect(notices).toEqual([{ level: 'warning', code: 'workspace-unavailable', message }])
    expect(streamedText(chunks)).toBe('ok')
    const sent = toolNames(calls[1])
    for (const name of WORKSPACE_TOOLS)
      expect(sent).not.toContain(name)
    expect(systemOf(calls[1])).not.toContain('Project "Gone"')
    const reply = (await detailOf(t, chatId)).messages.at(-1)
    expect(reply?.parts.find(part => part.type === 'data-notice')).toEqual({ type: 'data-notice', data: { level: 'warning', code: 'workspace-unavailable', message } })
    await runnerOf(t).idle()
  })

  it('chats with a project use projectMaxSteps, the others maxSteps', async () => {
    const loop = t.deps.registry.tools.register('mock', {
      name: 'loop_tool',
      description: 'Returns ok.',
      inputSchema: z.object({}),
      policy: 'safe',
      execute: async () => ({ ok: true }),
    })
    const { model, calls } = scriptedModel((_options, call) => [
      { type: 'tool-call', toolCallId: `call_loop_${call}`, toolName: 'loop_tool', input: '{}' },
      finishPart('tool-calls'),
    ])
    scripted.set('agent', model)
    await t.deps.settings.update({ maxSteps: 1, projectMaxSteps: 3 })
    try {
      const project = await projects.add({ name: 'Steps' })
      await readSse(await postChat(t, chatBody(newChatId(), 'loop', { modelRef: 'testkit:agent', projectId: project.id })))
      expect(calls).toHaveLength(3)
      calls.length = 0
      await readSse(await postChat(t, chatBody(newChatId(), 'loop', { modelRef: 'testkit:agent' })))
      expect(calls).toHaveLength(1)
      await runnerOf(t).idle()
    }
    finally {
      loop.dispose()
      await t.deps.settings.update({ maxSteps: 20, projectMaxSteps: 100 })
    }
  })

  it('mock:workspace answers that no workspace tools are available in a chat without a project', async () => {
    const { chunks } = await readSse(await postChat(t, chatBody(newChatId(), 'go', { modelRef: 'mock:workspace', toolMode: 'edits' })))
    expect(streamedText(chunks)).toBe(MOCK_WORKSPACE_UNAVAILABLE)
    await runnerOf(t).idle()
  })
})

describe('the shell switched off (HF_WORKSPACE_SHELL=0)', () => {
  let t: TestApp
  let testkit: Disposable
  const scripted = new Map<string, LanguageModelV4>()

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, workspaceShell: false, factories: { projects: createFakeProjectService } })
    testkit = registerTestkit(t, scripted)
  })

  afterAll(async () => {
    testkit.dispose()
    await t.close()
  })

  it('offers the file tools without shell and leaves the shell rule out', async () => {
    const project = await (t.deps.projects as FakeProjectService).add({ name: 'No shell' })
    const { model, calls } = scriptedModel(() => textParts('ok'))
    scripted.set('agent', model)
    await readSse(await postChat(t, chatBody(newChatId(), 'hi', { modelRef: 'testkit:agent', projectId: project.id })))
    const sent = toolNames(calls[0])
    for (const name of WORKSPACE_TOOLS.filter(name => name !== 'shell'))
      expect(sent).toContain(name)
    expect(sent).not.toContain('shell')
    expect(systemOf(calls[0])).toContain('- Prefer edit_file')
    expect(systemOf(calls[0])).not.toContain('Each shell call')
    await runnerOf(t).idle()
  })
})

// ---------- Accept edits with mock:workspace ----------

/** Contexts the stand-in tools received, by tool name. */
const received = new Map<string, ToolCallContext[]>()

function record(name: string, c: ToolCallContext): ToolWorkspace {
  received.set(name, [...(received.get(name) ?? []), c])
  if (c.workspace === undefined)
    throw new Error('No workspace.')
  return c.workspace
}

/**
 * Stand-ins of the `core-workspace` file tools and shell with the real names, schemas, access levels and policies
 * (`write_file` asks for a hidden path), working through the frozen path guard. The shell runs nothing: it reads the
 * file named after `cat`.
 */
function standInTools(): ToolDefinition[] {
  const writeFile: ToolDefinition<WriteFileToolInput> = {
    name: 'write_file',
    description: 'Writes a file (test stand-in).',
    inputSchema: writeFileToolInputSchema,
    policy: input => (input.path.startsWith('.') ? 'always' : 'ask'),
    workspace: 'write',
    execute: async (input, c) => {
      const result = await writeWorkspaceFile(record('write_file', c).root, input.path, input.content)
      return { path: result.rel, created: result.created }
    },
  }
  const editFile: ToolDefinition<EditFileToolInput> = {
    name: 'edit_file',
    description: 'Edits a file (test stand-in).',
    inputSchema: editFileToolInputSchema,
    policy: 'ask',
    workspace: 'write',
    execute: async (input, c) => {
      const root = record('edit_file', c).root
      const text = (await readWorkspaceFile(root, input.path, { maxBytes: 65_536 })).bytes.toString('utf8')
      await writeWorkspaceFile(root, input.path, text.replace(input.old_string, input.new_string))
      return { path: input.path, replacements: 1 }
    },
  }
  const shell: ToolDefinition<ShellToolInput> = {
    name: 'shell',
    description: 'Runs a command (test stand-in).',
    inputSchema: shellToolInputSchema,
    policy: 'ask',
    workspace: 'execute',
    execute: async (input, c) => {
      const root = record('shell', c).root
      const file = input.command.replace(/^cat /, '')
      return { exitCode: 0, stdout: (await readWorkspaceFile(root, file, { maxBytes: 65_536 })).bytes.toString('utf8'), stderr: '' }
    },
  }
  return [writeFile, editFile, shell] as ToolDefinition[]
}

describe('accept edits with mock:workspace on a temp project', () => {
  let t: TestApp
  let project: ProjectSummary

  beforeAll(async () => {
    const builtins = getBuiltinPlugins({ mockProvider: true }).map(builtin => (builtin.id === 'core-workspace'
      ? { ...builtin, module: definePlugin({ setup(ctx) {
          for (const tool of standInTools())
            ctx.tools.register(tool)
        } }) }
      : builtin))
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, builtins, factories: { projects: createFakeProjectService } })
  })

  beforeEach(async () => {
    received.clear()
    project = await (t.deps.projects as FakeProjectService).add({ name: 'Edits' })
  })

  afterAll(async () => {
    await t.close()
  })

  it('runs write and edit without asking, asks for the shell, then finishes after the approval', async () => {
    const chatId = newChatId()
    const first = await readSse(await postChat(t, chatBody(chatId, 'go', { modelRef: 'mock:workspace', toolMode: 'edits', projectId: project.id })))
    expect(first.chunks.filter(chunk => chunk.type === 'tool-approval-request')).toHaveLength(SHELL_OFFERED ? 1 : 0)
    expect(await readFile(`${project.path}/${MOCK_WORKSPACE_FILE}`, 'utf8')).toBe(MOCK_WORKSPACE_CONTENT.replace('mock agent', 'workspace agent'))

    const pending = await detailOf(t, chatId)
    const assistant = pending.messages[1]!
    const parts = toolParts(assistant)
    expect(parts.map(part => [part.type, part.state])).toEqual([
      ['tool-write_file', 'output-available'],
      ['tool-edit_file', 'output-available'],
      ...(SHELL_OFFERED ? [['tool-shell', 'approval-requested']] : []),
    ])
    // Every tool of the run got the same frozen { projectId, name, root }.
    const workspace = received.get('write_file')?.[0]?.workspace
    expect(workspace).toEqual({ projectId: project.id, name: 'Edits', root: project.path })
    expect(Object.isFrozen(workspace)).toBe(true)
    expect(received.get('edit_file')?.[0]?.workspace).toBe(workspace)
    if (!SHELL_OFFERED)
      return

    expect(pending.pendingApproval).toBe(true)
    expect(received.has('shell')).toBe(false)
    const { chunks } = await readSse(await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:workspace', toolMode: 'edits' }), message: answerApprovals(assistant, true) }))
    expect(streamedText(chunks)).toBe('Workspace done: Hello from the workspace agent.')
    expect(received.get('shell')?.[0]?.workspace).toEqual({ projectId: project.id, name: 'Edits', root: project.path })
    const done = await detailOf(t, chatId)
    expect(done.pendingApproval).toBe(false)
    expect(toolParts(done.messages[1]).map(part => part.state)).toEqual(['output-available', 'output-available', 'output-available'])
    await runnerOf(t).idle()
  })

  it('asks for the first write in ask mode', async () => {
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'go', { modelRef: 'mock:workspace', toolMode: 'ask', projectId: project.id })))
    expect(chunks.filter(chunk => chunk.type === 'tool-approval-request')).toHaveLength(1)
    expect(toolParts((await detailOf(t, chatId)).messages[1]).map(part => [part.type, part.state])).toEqual([['tool-write_file', 'approval-requested']])
    expect(received.size).toBe(0)
    await runnerOf(t).idle()
  })

  it('runs everything in auto mode', async () => {
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'go', { modelRef: 'mock:workspace', toolMode: 'auto', projectId: project.id })))
    expect(chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
    expect(streamedText(chunks)).toBe(SHELL_OFFERED ? 'Workspace done: Hello from the workspace agent.' : 'Workspace done.')
    await runnerOf(t).idle()
  })
})
