// W12.6-T3 (ADR-058) end to end in-process over `POST /api/chat` with `mock:agents` as the chat model, the real
// `core-agent` and `core-workspace` tools, a fake project service with a real temp folder and the fake customization
// service holding the project's agents and skills: `disallowedTools: Bash` removes `shell` from a child that lists it in
// `tools`, a preloaded skill's text reaches the child's instructions (its persona line wins over an agent body without
// one), `maxTurns: 1` ends the child at its first step (the finalize nudge: no tool), and `model: sonnet` runs on the
// model the setting `modelAliases` names (an unmapped name falls back to the default child model with a warning).
import type { ChatDetail, CustomizationEntry, HarnessUIMessage, TaskOutput } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeCustomizationService } from '../../testing/fake-customizations.ts'
import type { FakeProjectService } from '../../testing/fake-projects.ts'
import { chatDetailSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { catalogEntryKey, fakeCatalogEntry } from '../../testing/fake-customizations.ts'
import { createFakeProjectService } from '../../testing/fake-projects.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from '../testing.ts'
import { subagentStepLimitText } from './index.ts'

let nextChat = 0x10A00

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

function taskOutputsOf(message: HarnessUIMessage | undefined): TaskOutput[] {
  return (message?.parts ?? [])
    .filter(part => part.type === 'tool-task')
    .map(part => (part as unknown as { output: TaskOutput }).output)
}

/** One project definition: its catalog entry and its file content. */
function definition(kind: 'agent' | 'skill', name: string, frontmatter: string[], body: string): { entry: CustomizationEntry, content: string } {
  const description = `The ${name} ${kind}.`
  const entry = fakeCatalogEntry(kind, name, { description })
  const content = ['---', `name: ${name}`, `description: ${description}`, ...frontmatter, '---', body].join('\n')
  return { entry, content }
}

describe('agent keys through POST /api/chat (mock:agents, W12.6-T3)', () => {
  let t: TestApp
  let projectId: string

  async function turn(text: string, toolMode: 'ask' | 'edits' = 'edits'): Promise<{ chatId: string, text: string, reply: HarnessUIMessage }> {
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, text, { modelRef: 'mock:agents', toolMode, projectId })))
    await runnerOf(t).idle()
    const response = await t.request(`/api/chats/${chatId}`)
    const detail: ChatDetail = chatDetailSchema.parse(await response.json())
    expect(detail.pendingApproval).toBe(false)
    return { chatId, text: streamedText(chunks), reply: detail.messages.at(-1)! }
  }

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, customizations: 'fake', factories: { projects: createFakeProjectService } })
    const projects = t.deps.projects as FakeProjectService
    const customizations = t.deps.customizations as FakeCustomizationService
    const project = await projects.add({ name: 'Keys', files: { 'README.md': 'Keys project.\n' } })
    projectId = project.id
    const items = [
      definition('agent', 'keyed', ['tools: [Bash, Write, LS, Read]', 'disallowedTools: Bash', 'skills: [house-style]'], 'Work on the task.'),
      definition('agent', 'short', ['maxTurns: 1'], 'PERSONA: short'),
      definition('agent', 'aliased', ['model: sonnet'], 'PERSONA: aliased'),
      definition('skill', 'house-style', [], 'PERSONA: from the preloaded skill\nKeep every answer short.'),
    ]
    customizations.entries.set(projectId, items.map(item => item.entry))
    for (const { entry, content } of items)
      customizations.bodies.set(catalogEntryKey(entry), content)
  })

  beforeEach(async () => {
    await t.deps.settings.update({ subagentModelRef: null, subagentMaxSteps: 30, modelAliases: { sonnet: null, opus: null, haiku: null, fable: null } })
  })

  afterAll(async () => {
    await t.close()
  })

  it('disallowedTools removes shell; the preloaded skill reaches the child\'s instructions', async () => {
    const { text, reply } = await turn('agent keyed')
    expect(text).toBe('Agent report: Report: persona=from the preloaded skill | tools: list_directory, read_file, write_file | model=agents')
    expect(taskOutputsOf(reply).at(-1)).toMatchObject({ status: 'completed', type: 'keyed' })
    // The skill body never reaches the log.
    expect(JSON.stringify(t.logs.records)).not.toContain('Keep every answer short.')
  })

  it('maxTurns: 1 ends the child at its first step without tools', async () => {
    const { text, reply } = await turn('agent short')
    expect(text).toBe('Agent report: Report: persona=short | tools: none | model=agents')
    const output = taskOutputsOf(reply).at(-1)
    expect(output).toMatchObject({ status: 'limit', type: 'short', error: subagentStepLimitText(1) })
    expect(output?.steps).toEqual([])
  })

  it('model: sonnet runs on the model of the setting modelAliases; unmapped, the default model with a warning', async () => {
    await t.deps.settings.update({ modelAliases: { sonnet: 'mock:echo', opus: null, haiku: null, fable: null } })
    const mapped = await turn('agent aliased')
    expect(taskOutputsOf(mapped.reply).at(-1)).toMatchObject({ status: 'completed', type: 'aliased', modelRef: 'mock:echo' })

    await t.deps.settings.update({ modelAliases: { sonnet: null, opus: null, haiku: null, fable: null } })
    const fallback = await turn('agent aliased')
    expect(taskOutputsOf(fallback.reply).at(-1)).toMatchObject({ status: 'completed', type: 'aliased', modelRef: 'mock:agents' })
    expect(t.logs.records).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'the agent\'s Claude model name has no model; the default model runs the sub-agent' }))
  })
})
