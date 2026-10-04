// Custom agent types end to end in-process (W10.3, ADR-045, PROVIDERS.md 8 "Customization mocks") over `POST /api/chat`
// with `mock:agents` as the chat model, the real `core-agent` and `core-workspace` tools, the real checkpoint journal, a
// fake project service with real temp folders and the fake customization service holding the project's agents:
// - the "Agent types" block lists the builtins first, then the catalog's agents by name;
// - a persona body and a `tools` list reach the child (the report names the persona and only the allowed tools that
//   run without approval in the mode); `escalate` (`shell`, `write_file`) gets neither in Ask; in Accept edits its write
//   is journaled under the reply with a `<parent>/<child>` call id; no approval request anywhere;
// - `general-purpose` runs `general`; an unknown type fails with the available types; a declared model runs the child;
// - a detached child (`runDetachedChild`) writes a journal row and a usage row under the launching message.
import type { ChatDetail, CustomizationEntry, HarnessUIMessage, TaskOutput } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeCustomizationService } from '../../testing/fake-customizations.ts'
import type { FakeProjectService } from '../../testing/fake-projects.ts'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { chatDetailSchema, taskOutputSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MOCK_AGENT_CONTENT, MOCK_AGENT_FILE } from '../../builtin-plugins/mock/agents.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { catalogEntryKey, fakeCatalogEntry } from '../../testing/fake-customizations.ts'
import { createFakeProjectService } from '../../testing/fake-projects.ts'
import { createRunScope } from '../scope.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from '../testing.ts'
import { createDetachedSession } from './host.ts'
import { runDetachedChild } from './index.ts'

let nextChat = 10300

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

async function detailOf(t: TestApp, chatId: string): Promise<ChatDetail> {
  const response = await t.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

function taskOutputsOf(message: HarnessUIMessage | undefined): TaskOutput[] {
  return (message?.parts ?? [])
    .filter(part => part.type === 'tool-task')
    .map(part => (part as unknown as { output: TaskOutput }).output)
}

async function usageRows(t: TestApp, chatId: string): Promise<string[]> {
  const result = await t.database.client.execute({ sql: 'SELECT purpose, model_id, message_id FROM usage WHERE chat_id = ? ORDER BY id', args: [chatId] })
  return result.rows.map(row => `${String(row.purpose)}:${String(row.model_id)}:${String(row.message_id)}`)
}

/** One project agent: its catalog entry and its file content. */
function agent(name: string, frontmatter: string[], body: string, tools?: string[]): { entry: CustomizationEntry, content: string } {
  const description = `The ${name} agent.`
  const entry = fakeCatalogEntry('agent', name, { description, ...(tools === undefined ? {} : { tools }) })
  const content = ['---', `name: ${name}`, `description: ${description}`, ...frontmatter, '---', body].join('\n')
  return { entry, content }
}

describe('custom agents through POST /api/chat (mock:agents)', () => {
  let t: TestApp
  let projects: FakeProjectService
  let customizations: FakeCustomizationService
  let projectId: string
  let projectPath: string

  async function turn(text: string, toolMode: 'ask' | 'edits' = 'ask'): Promise<{ chatId: string, chunks: UIMessageChunk[], reply: HarnessUIMessage }> {
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, text, { modelRef: 'mock:agents', toolMode, projectId })))
    await runnerOf(t).idle()
    const detail = await detailOf(t, chatId)
    expect(detail.pendingApproval).toBe(false)
    expect(chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
    return { chatId, chunks, reply: detail.messages.at(-1)! }
  }

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, customizations: 'fake', factories: { projects: createFakeProjectService } })
    projects = t.deps.projects as FakeProjectService
    customizations = t.deps.customizations as FakeCustomizationService
    const project = await projects.add({ name: 'Demo', files: { 'README.md': 'Demo project.\n' } })
    projectId = project.id
    projectPath = project.path
    const agents = [
      agent('reviewer', ['tools: Read, LS, Write'], 'PERSONA: strict reviewer\nReview the change.', ['read_file', 'list_directory', 'write_file']),
      agent('escalate', ['tools: [shell, write_file]'], 'PERSONA: escalate', ['shell', 'write_file']),
      agent('echoer', ['model: mock:echo'], 'Echo the task.'),
      agent('fallback', ['model: nowhere:missing'], 'PERSONA: fallback'),
    ]
    customizations.entries.set(projectId, agents.map(entry => entry.entry))
    for (const { entry, content } of agents)
      customizations.bodies.set(catalogEntryKey(entry), content)
  })

  beforeEach(async () => {
    await t.deps.settings.update({ subagentModelRef: null, subagentMaxSteps: 30 })
    await rm(join(projectPath, MOCK_AGENT_FILE), { force: true })
  })

  afterAll(async () => {
    await t.close()
  })

  it('lists the agent types after the task hint: the builtins first, then by name', async () => {
    const { chunks } = await turn('agents?')
    expect(streamedText(chunks)).toBe('Agent types: explore, general, echoer, escalate, fallback, reviewer')
  })

  it('ask: the persona and only the allowed tools that run without approval; the snapshot of the definition', async () => {
    const { chatId, chunks, reply } = await turn('agent reviewer')
    expect(streamedText(chunks)).toBe('Agent report: Report: persona=strict reviewer | tools: list_directory, read_file | model=agents')
    const [output] = taskOutputsOf(reply)
    expect(taskOutputSchema.safeParse(output).success).toBe(true)
    expect(output).toMatchObject({
      status: 'completed',
      type: 'reviewer',
      modelRef: 'mock:agents',
      agent: { source: 'project', description: 'The reviewer agent.', path: '.harness/agents/reviewer.md' },
    })
    expect(JSON.stringify(reply.parts)).not.toContain('approval-requested')
    expect((await usageRows(t, chatId)).filter(row => row.startsWith('subagent:'))).toEqual([`subagent:agents:${reply.id}`])
    // The body never reaches the log.
    expect(JSON.stringify(t.logs.records)).not.toContain('PERSONA: strict reviewer')
  })

  it('ask: escalate (shell, write_file) gets neither and writes nothing', async () => {
    const { chunks } = await turn('agent escalate write')
    expect(streamedText(chunks)).toBe('Agent report: Report: persona=escalate | tools: none | model=agents')
    await expect(readFile(join(projectPath, MOCK_AGENT_FILE), 'utf8')).rejects.toThrow()
  })

  it('accept edits: escalate writes; the change is journaled under the reply with a <parent>/<child> call id', async () => {
    const { chatId, chunks, reply } = await turn('agent escalate write', 'edits')
    expect(streamedText(chunks)).toBe('Agent report: Report: persona=escalate | tools: shell, write_file | model=agents')
    expect(await readFile(join(projectPath, MOCK_AGENT_FILE), 'utf8')).toBe(MOCK_AGENT_CONTENT)
    const [output] = taskOutputsOf(reply)
    expect(output?.steps.map(step => `${step.toolName}:${step.state}`)).toEqual(['write_file:done'])
    const rows = await t.database.client.execute({ sql: 'SELECT message_id, tool_call_id, path FROM workspace_changes WHERE chat_id = ?', args: [chatId] })
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.message_id).toBe(reply.id)
    expect(String(rows.rows[0]!.tool_call_id)).toMatch(/^mock_call_\d+(?:_\d+)?\/mock_call_\d+(?:_\d+)?$/)
    expect(rows.rows[0]!.path).toBe(MOCK_AGENT_FILE)
  })

  it('general-purpose runs general; an unknown type fails listing the available types', async () => {
    const alias = await turn('agent General-Purpose')
    expect(streamedText(alias.chunks)).toMatch(/^Agent report: Report: persona=none \| tools: .*list_directory.* \| model=agents$/)
    expect(taskOutputsOf(alias.reply)[0]).toMatchObject({ status: 'completed', type: 'general', agent: { source: 'builtin' } })

    const unknown = await turn('agent nope')
    expect(streamedText(unknown.chunks)).toBe('Agent report: Sub-agent failed: Unknown agent type nope. Available: explore, general, echoer, escalate, fallback, reviewer; partial report: (none)')
    expect(taskOutputsOf(unknown.reply)[0]).toMatchObject({ status: 'failed', type: 'nope', steps: [] })
  })

  it('a declared model runs the child; one that cannot be resolved falls back to the default (with a warning)', async () => {
    const echoer = await turn('agent echoer')
    expect(taskOutputsOf(echoer.reply)[0]).toMatchObject({ status: 'completed', type: 'echoer', modelRef: 'mock:echo' })
    expect((await usageRows(t, echoer.chatId)).filter(row => row.startsWith('subagent:'))).toEqual([`subagent:echo:${echoer.reply.id}`])

    await t.deps.settings.update({ subagentModelRef: 'mock:echo' })
    const fallback = await turn('agent fallback')
    expect(taskOutputsOf(fallback.reply)[0]).toMatchObject({ status: 'completed', type: 'fallback', modelRef: 'mock:echo' })
    expect(t.logs.records).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'the agent\'s model cannot be resolved; the default model runs the sub-agent' }))
  })

  it('a detached child writes its journal row and its usage row under the launching message', async () => {
    const launching = await turn('hello')
    expect(streamedText(launching.chunks)).toBe('Agents mock: hello')
    const { chatId, reply } = launching
    const opened = await t.deps.projects.openWorkspace(projectId)
    expect(opened.ok).toBe(true)
    const workspace = opened.ok ? opened.workspace : null
    const scope = await createRunScope(t.deps, { chatId, messageId: reply.id, workspace, history: [], logger: t.logs.logger })
    const costs: number[] = []
    const session = createDetachedSession({
      deps: t.deps,
      chatId,
      messageId: reply.id,
      settings: await t.deps.settings.get(),
      chatInstructions: undefined,
      reasoningEffort: 'auto',
      signal: new AbortController().signal,
      logger: t.logs.logger,
      onExtraCost: usd => costs.push(usd),
    })
    const outputs: TaskOutput[] = []
    for await (const output of runDetachedChild({
      session,
      model: await t.deps.providers.resolveModel('mock:agents'),
      toolMode: 'edits',
      workspace,
      scope,
      catalog: await t.deps.customizations.catalog(projectId),
      task: { type: 'escalate', description: 'Run escalate', prompt: 'Run the escalate agent and write agent.txt.', background: true },
      toolCallId: 'call_bg',
    }))
      outputs.push(output)

    expect(outputs.at(-1)).toMatchObject({ status: 'completed', type: 'escalate', report: 'Report: persona=escalate | tools: shell, write_file | model=agents' })
    expect(await readFile(join(projectPath, MOCK_AGENT_FILE), 'utf8')).toBe(MOCK_AGENT_CONTENT)
    const rows = await t.database.client.execute({ sql: 'SELECT message_id, tool_call_id, path FROM workspace_changes WHERE chat_id = ?', args: [chatId] })
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.message_id).toBe(reply.id)
    expect(String(rows.rows[0]!.tool_call_id)).toMatch(/^call_bg\/mock_call_\d+(?:_\d+)?$/)
    expect((await usageRows(t, chatId)).filter(row => row.startsWith('subagent:'))).toEqual([`subagent:agents:${reply.id}`])
    // The detached child never adds an approval to the chat.
    expect((await detailOf(t, chatId)).pendingApproval).toBe(false)
  })
})
