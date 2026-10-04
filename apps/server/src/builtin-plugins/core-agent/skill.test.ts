// The `skill` tool of `core-agent` (W10.5-T2; ADR-045, ARCHITECTURE.md 6.25): `execute` delegates to the run's agent
// scope (`loadSkill(name, c.signal)`), a call without a scope (a sub-agent, a context outside a run) is a tool error;
// the model reads the content, the base folder line and the supporting files. Reading a supporting file under
// `.harness/` is a `safe` read (no approval in `ask`), writing there still always asks. End to end: `mock:agents` loads a
// project skill (`skill pdf`) and a scripted model reads its `ref.md` in `ask` without an approval card.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable, ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ChatDetail, ProjectSummary, SkillOutput } from '@harness-forge/shared'
import type { AgentRunScope } from '../../chat/agent-scope.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeCustomizationService } from '../../testing/fake-customizations.ts'
import type { FakeProjectService } from '../../testing/fake-projects.ts'
import { chatDetailSchema, HarnessError, skillInputSchema, skillOutputSchema } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindAgentScope } from '../../chat/agent-scope.ts'
import { resolveApproval } from '../../chat/approval.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from '../../chat/testing.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { catalogEntryKey, fakeCatalogEntry } from '../../testing/fake-customizations.ts'
import { createFakeProjectService } from '../../testing/fake-projects.ts'
import { readFilePolicy, writeFilePolicy } from '../core-workspace/policies.ts'
import { MOCK_SKILLS_UNAVAILABLE } from '../mock/agents.ts'
import { SKILL_TIMEOUT_MS } from './common.ts'
import { createSkillTool, SKILL_TOOL_NAME, skillModelText, SKILLS_NOT_AVAILABLE_ERROR } from './skill.ts'

const CHAT = '0199a8f0-0000-7000-8000-000000000001'

function context(signal = new AbortController().signal): ToolCallContext {
  return { chatId: CHAT, modelRef: 'mock:agents', toolCallId: 'call_skill_1', messages: [], signal }
}

function scope(loadSkill: AgentRunScope['loadSkill']): AgentRunScope {
  return {
    chatId: CHAT,
    messageId: 'msg_a000000000000001',
    toolMode: 'ask',
    runSubagent: () => {
      throw new Error('not used')
    },
    todos: () => null,
    loadSkill,
    savePlan: async () => ({}),
  }
}

const PDF: SkillOutput = {
  name: 'pdf',
  description: 'Work with PDF files.',
  source: 'project',
  content: '# PDF\nRead ref.md first.',
  truncated: false,
  baseDir: '.harness/skills/pdf',
  files: ['ref.md'],
}

describe('skill execute', () => {
  const tool = createSkillTool() as unknown as ToolDefinition

  it('keeps the frozen definition: safe, no workspace access, 60 s', () => {
    expect(tool.name).toBe(SKILL_TOOL_NAME)
    expect(tool.policy).toBe('safe')
    expect(tool.workspace).toBeUndefined()
    expect(tool.timeoutMs).toBe(SKILL_TIMEOUT_MS)
    expect(tool.inputSchema).toBe(skillInputSchema)
  })

  it('without an agent scope (a sub-agent, outside a run) is a tool error', async () => {
    await expect(Promise.resolve(tool.execute({ name: 'pdf' }, context()))).rejects.toThrow(SKILLS_NOT_AVAILABLE_ERROR)
  })

  it('delegates to the scope with the name and the call signal', async () => {
    const calls: Array<{ name: string, signal: AbortSignal }> = []
    const controller = new AbortController()
    const c = context(controller.signal)
    bindAgentScope(c, scope(async (name, signal) => {
      calls.push({ name, signal })
      return PDF
    }))
    const output = await Promise.resolve(tool.execute({ name: 'pdf' }, c))
    expect(output).toEqual(PDF)
    expect(calls).toEqual([{ name: 'pdf', signal: controller.signal }])
    expect(await tool.toModelOutput!(output, { toolCallId: 'call_skill_1', input: { name: 'pdf' } })).toEqual({
      type: 'text',
      value: '# PDF\nRead ref.md first.\n\nBase folder: .harness/skills/pdf — read supporting files with read_file\nSupporting files: .harness/skills/pdf/ref.md',
    })
  })

  it('an unknown skill is the loader\'s error (it lists the available skills)', async () => {
    const c = context()
    bindAgentScope(c, scope(async () => {
      throw new HarnessError({ code: 'not_found', message: 'Unknown skill "docx". Available skills: pdf.' })
    }))
    await expect(Promise.resolve(tool.execute({ name: 'docx' }, c))).rejects.toThrow('Unknown skill "docx". Available skills: pdf.')
  })
})

describe('supporting files: read safe, write always', () => {
  const workspace = { projectId: 'prj_SKILLPOLICYAAAAA', name: 'Skills', root: '/nonexistent-hf-project' }

  it('read_file of .harness/skills/pdf/ref.md needs no approval in ask; a write always asks, also in edits', async () => {
    const read = await readFilePolicy({ path: '.harness/skills/pdf/ref.md' }, { workspace })
    expect(read).toBe('safe')
    expect(resolveApproval({ override: null, hookDecision: undefined, toolMode: 'ask', policy: read, workspace: 'read' }).outcome).toBe('not-applicable')
    const write = await writeFilePolicy({ path: '.harness/skills/pdf/SKILL.md' }, { workspace })
    expect(write).toBe('always')
    for (const toolMode of ['ask', 'edits', 'auto'] as const)
      expect(resolveApproval({ override: null, hookDecision: undefined, toolMode, policy: write, workspace: 'write' }).outcome, toolMode).toBe('user-approval')
    expect(await writeFilePolicy({ path: '.claude/skills/pdf/SKILL.md' }, { workspace })).toBe('always')
  })
})

// ---------- end to end ----------

const SKILL_BODY = '# PDF\nFill the form with the fields listed in ref.md, then check the totals twice.'

function finish(reason: 'stop' | 'tool-calls'): LanguageModelV4StreamPart {
  return { type: 'finish', finishReason: { unified: reason, raw: reason }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
}

/** Calls `read_file` on the skill's `ref.md` once, then answers "done". */
function readingModel(calls: LanguageModelV4CallOptions[]): LanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options)
      const parts: LanguageModelV4StreamPart[] = calls.length === 1
        ? [{ type: 'tool-call', toolCallId: 'call_read_1', toolName: 'read_file', input: JSON.stringify({ path: '.harness/skills/pdf/ref.md' }) }, finish('tool-calls')]
        : [{ type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'done' }, { type: 'text-end', id: 't1' }, finish('stop')]
      return { stream: convertArrayToReadableStream(parts) }
    },
  })
}

function toolPart(detail: ChatDetail, type: string): Record<string, unknown> | undefined {
  return detail.messages.flatMap(message => message.parts).find(part => part.type === type) as Record<string, unknown> | undefined
}

describe('skills in a project chat (mock:agents, PROVIDERS.md 8)', { timeout: 30_000 }, () => {
  let t: TestApp
  let project: ProjectSummary
  let provider: Disposable
  const calls: LanguageModelV4CallOptions[] = []

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, customizations: 'fake', factories: { projects: createFakeProjectService } })
    project = await (t.deps.projects as FakeProjectService).add({
      name: 'Skills',
      files: {
        '.harness/skills/pdf/SKILL.md': `---\nname: pdf\ndescription: Fill PDF forms.\n---\n${SKILL_BODY}\n`,
        '.harness/skills/pdf/ref.md': 'Fields: name, total.\n',
      },
    })
    const fake = t.deps.customizations as FakeCustomizationService
    const entry = fakeCatalogEntry('skill', 'pdf', { description: 'Fill PDF forms.' })
    fake.entries.set(project.id, [entry])
    fake.bodies.set(catalogEntryKey(entry), `---\nname: pdf\ndescription: Fill PDF forms.\n---\n${SKILL_BODY}\n`)
    provider = t.deps.registry.providers.register('mock', {
      id: 'skillkit',
      name: 'Skill kit',
      credentials: [],
      seedModels: [{ id: 'reader', name: 'Reader', contextWindow: 32_000, capabilities: { tools: true } }],
      createLanguageModel: () => readingModel(calls),
    })
  })

  afterAll(async () => {
    provider.dispose()
    await t.close()
  })

  async function detailOf(chatId: string): Promise<ChatDetail> {
    return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
  }

  it('skill pdf -> the body, baseDir and files: [\'ref.md\']', async () => {
    const chatId = testChatId(10_601)
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'skill pdf', { modelRef: 'mock:agents', toolMode: 'ask', projectId: project.id })))
    await runnerOf(t).idle()
    expect(streamedText(chunks)).toContain(`Skill loaded: ${SKILL_BODY.slice(0, 80)}`)
    expect(chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
    const part = toolPart(await detailOf(chatId), 'tool-skill')
    expect(part?.state).toBe('output-available')
    expect(skillOutputSchema.parse(part?.output)).toEqual({
      name: 'pdf',
      description: 'Fill PDF forms.',
      source: 'project',
      content: SKILL_BODY,
      truncated: false,
      baseDir: '.harness/skills/pdf',
      files: ['ref.md'],
    })
  })

  it('an unknown skill is an error result that lists the available ones', async () => {
    const chatId = testChatId(10_602)
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'skill docx', { modelRef: 'mock:agents', toolMode: 'ask', projectId: project.id })))
    await runnerOf(t).idle()
    expect(streamedText(chunks)).toContain('Unknown skill "docx". Available skills: pdf.')
    expect(toolPart(await detailOf(chatId), 'tool-skill')?.state).toBe('output-error')
  })

  it('a chat without skills is not offered the tool', async () => {
    const other = await (t.deps.projects as FakeProjectService).add({ name: 'No skills' })
    const { chunks } = await readSse(await postChat(t, chatBody(testChatId(10_603), 'skill pdf', { modelRef: 'mock:agents', toolMode: 'ask', projectId: other.id })))
    await runnerOf(t).idle()
    expect(streamedText(chunks)).toContain(MOCK_SKILLS_UNAVAILABLE)
  })

  it('reading the skill\'s ref.md with read_file runs without approval in ask', async () => {
    const chatId = testChatId(10_604)
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'read the reference', { modelRef: 'skillkit:reader', toolMode: 'ask', projectId: project.id })))
    await runnerOf(t).idle()
    expect(chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
    const part = toolPart(await detailOf(chatId), 'tool-read_file')
    expect(part?.state).toBe('output-available')
    expect(JSON.stringify(part?.output)).toContain('Fields: name, total.')
    // The project's catalog has a skill, so the tool is offered next to read_file.
    expect((calls[0]?.tools ?? []).map(entry => entry.name)).toEqual(expect.arrayContaining(['read_file', 'skill']))
    expect(skillModelText(PDF).startsWith(PDF.content)).toBe(true)
  })
})
