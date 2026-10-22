// `prepareRun` and the Phase 14 seams (C52-T3): `PreparedRun.webSearch` (body > chat > global), a new chat saving the
// body's mode, and the command resolution getting the chat's project (`CommandContext.projectId`) and the MCP managers
// (`CommandServices.mcp` / `projectMcp` through `deps`); an MCP prompt name that resolves to nothing stays plain text.
import type { ChatRequestBody } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeProjectService } from '../testing/fake-projects.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeProjectService } from '../testing/fake-projects.ts'
import { resolveCommand } from './commands.ts'
import { commitHistory, prepareRun } from './prepare.ts'
import { createRunRegistry } from './runs.ts'
import { chatBody, testChatId } from './testing.ts'

vi.mock('./commands.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./commands.ts')>()
  return { ...actual, resolveCommand: vi.fn(actual.resolveCommand) }
})

describe('prepareRun: the Phase 14 seams (C52-T3)', () => {
  let t: TestApp
  let projectId: string
  let nextChat = 14_500

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, factories: { projects: createFakeProjectService } })
    projectId = (await (t.deps.projects as FakeProjectService).add({ name: 'Demo' })).id
  })

  beforeEach(() => {
    vi.mocked(resolveCommand).mockClear()
  })

  afterAll(async () => {
    await t.close()
  })

  async function prepare(body: ChatRequestBody) {
    const run = createRunRegistry().acquire(body.chatId, body.modelRef)
    const prepared = await prepareRun(t.deps, run, body, createSilentLogger())
    await commitHistory(t.deps, body.chatId, prepared.writes)
    return prepared
  }

  function newChatId(): string {
    nextChat += 1
    return testChatId(nextChat)
  }

  it('the command resolution gets the chat\'s project and the MCP managers; an unknown MCP prompt stays plain text', async () => {
    const chatId = newChatId()
    const prepared = await prepare(chatBody(chatId, '/mcp__srv__greet Ada', { projectId }))
    expect(prepared.command).toBeNull()
    expect(prepared.userMessage?.metadata?.command).toBeUndefined()
    const [services, text, context] = vi.mocked(resolveCommand).mock.calls[0]!
    expect(text).toBe('/mcp__srv__greet Ada')
    expect(context.projectId).toBe(projectId)
    expect(services).toMatchObject({ mcp: t.deps.mcp, projectMcp: t.deps.projectMcp })
    const plain = await prepare(chatBody(newChatId(), 'hello'))
    expect(plain.command).toBeNull()
    expect(vi.mocked(resolveCommand).mock.calls.at(-1)?.[2].projectId).toBeNull()
  })

  it('the turn mode (PreparedRun.webSearch): body > chat > global; a new chat saves the mode of the body, an existing one keeps its own', async () => {
    const chatId = newChatId()
    expect((await prepare(chatBody(chatId, 'one', { webSearch: 'auto' }))).webSearch).toBe('auto')
    expect((await t.deps.chats.find(chatId))?.settings.webSearch).toBe('auto')
    expect((await prepare(chatBody(chatId, 'two'))).webSearch).toBe('auto')
    expect((await prepare(chatBody(chatId, 'three', { webSearch: 'off' }))).webSearch).toBe('off')
    expect((await t.deps.chats.find(chatId))?.settings.webSearch).toBe('auto')
    const other = newChatId()
    expect((await prepare(chatBody(other, 'one'))).webSearch).toBe('off')
    expect((await t.deps.chats.find(other))?.settings.webSearch).toBeUndefined()
    await t.deps.settings.update({ webSearchDefault: 'auto' })
    try {
      expect((await prepare(chatBody(other, 'two'))).webSearch).toBe('auto')
    }
    finally {
      await t.deps.settings.update({ webSearchDefault: 'off' })
    }
  })
})
