// The Phase 11 seams of `prepareRun` and the C37 stubs (C37-T8): the hook carrier (`carrierParts`), the output style of
// a new chat (`ensureRunChat`), `PreparedRun.outputStyle` (`resolveRunOutputStyle` stub), the prompt hooks call site
// (`runPromptHooks` stub: queued records attached; a `hook-blocked` refusal removes the chat row this request created),
// the command expansion host, `startHookTurn` and `agentBlocks(…, { codingHints })`.
import type { ChatDetail, ChatRequestBody, HookData } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { AppDeps } from '../types.ts'
import type { PreparedRun, PrepareRunOptions } from './prepare.ts'
import { chatDetailSchema, HarnessError } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { fakeHookRecord } from '../testing/fake-hooks.ts'
import { hookBlockedError, isHookBlockedError, runPromptHooks } from './hooks-prompt.ts'
import { startHookTurn } from './index.ts'
import { DEFAULT_RUN_OUTPUT_STYLE, resolveRunOutputStyle } from './output-style.ts'
import { agentBlocks, TASK_HINT, TODO_HINT } from './params.ts'
import { carrierParts, commandExpansionHost, commitHistory, ensureRunChat, prepareRun } from './prepare.ts'
import { createRunRegistry } from './runs.ts'
import { chatBody, testChatId } from './testing.ts'

vi.mock('./hooks-prompt.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hooks-prompt.ts')>()
  return { ...actual, runPromptHooks: vi.fn(actual.runPromptHooks) }
})

let nextChat = 0xB000

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

describe('prepareRun: Phase 11 seams', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, projectTrust: 'fake' })
  })

  afterAll(async () => {
    await t.close()
  })

  async function prepare(body: ChatRequestBody, options?: PrepareRunOptions): Promise<PreparedRun> {
    const run = createRunRegistry().acquire(body.chatId, body.modelRef)
    return prepareRun(t.deps, run, body, createSilentLogger(), options)
  }

  async function chat(chatId: string): Promise<{ status: number, detail?: ChatDetail }> {
    const response = await t.request(`/api/chats/${chatId}`)
    return response.status === 200 ? { status: 200, detail: chatDetailSchema.parse(await response.json()) } : { status: response.status }
  }

  it('accepts a carrier of hook records (origin hook) and refuses mixed or other parts', async () => {
    const record = fakeHookRecord('Stop', 'continued', { reason: 'run the tests' })
    const chatId = newChatId()
    await commitHistory(t.deps, chatId, (await prepare(chatBody(chatId, 'first'))).writes)
    const carrier = { id: 'msg_c000000000000011', role: 'user' as const, parts: [{ type: 'data-hook' as const, data: record }] }
    const prepared = await prepare({ ...chatBody(chatId, 'x'), message: carrier }, { serverMessage: true, origin: 'hook' })
    expect(prepared.userMessage?.parts).toEqual([{ type: 'data-hook', data: record }])
    expect(prepared.command).toBeNull()
    const taskResult = { type: 'data-task-result', data: {} }
    expect(() => carrierParts([{ type: 'data-hook', data: record }, taskResult])).toThrow(HarnessError)
    expect(() => carrierParts([{ type: 'text', text: 'x' }])).toThrow('A server-started turn can only carry background task results or hook records (one kind).')
    expect(() => carrierParts([])).toThrow(HarnessError)
    expect(carrierParts([{ type: 'data-hook', id: 'h1', data: record }])).toEqual([{ type: 'data-hook', id: 'h1', data: record }])
  })

  it('saves the requested output style of a new chat only', async () => {
    const chatId = newChatId()
    const created = await ensureRunChat(t.deps, chatBody(chatId, 'hi', { outputStyle: 'learning' }))
    expect(created.created).toBe(true)
    expect(created.chat.settings.outputStyle).toBe('learning')
    expect((await chat(chatId)).detail?.settings.outputStyle).toBe('learning')
    const again = await ensureRunChat(t.deps, chatBody(chatId, 'hi', { outputStyle: 'explanatory' }))
    expect(again.created).toBe(false)
    expect(again.chat.settings.outputStyle).toBe('learning')
    const automatic = await ensureRunChat(t.deps, chatBody(newChatId(), 'hi', { outputStyle: null }))
    expect(automatic.chat.settings.outputStyle).toBeUndefined()
  })

  it('gives a chat run the default output style and a command reply none', async () => {
    const run = await prepare(chatBody(newChatId(), 'hi'))
    expect(run.outputStyle).toEqual(DEFAULT_RUN_OUTPUT_STYLE)
    expect(DEFAULT_RUN_OUTPUT_STYLE).toEqual({ name: 'default', label: 'Default', content: '', keepCodingInstructions: true })
    const compact = await prepare(chatBody(newChatId(), '/compact'))
    expect(compact.outputStyle).toBeNull()
  })

  it('calls the prompt hooks with the planned run and attaches their records to the new user message', async () => {
    const mocked = vi.mocked(runPromptHooks)
    mocked.mockClear()
    const record = fakeHookRecord('UserPromptSubmit', 'context', { context: 'Branch: main' })
    const chatId = newChatId()
    const prepared = await prepare(chatBody(chatId, 'hi'), { origin: 'queue', hookRecords: [record] })
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(mocked.mock.calls[0]![0]).toMatchObject({ origin: 'queue', serverMessage: false, precomputed: [record], prepared: { kind: 'new', userMessage: { id: prepared.userMessage!.id } } })
    expect(prepared.userMessage!.parts).toEqual([{ type: 'text', text: 'hi' }, { type: 'data-hook', data: record }])
    expect(prepared.history.at(-1)).toBe(prepared.userMessage)
    expect(prepared.writes.append?.message).toBe(prepared.userMessage)
    await commitHistory(t.deps, chatId, prepared.writes)
    expect((await chat(chatId)).detail?.messages.at(-1)?.parts).toEqual(prepared.userMessage!.parts)
    // Without records the message is unchanged.
    const plain = await prepare(chatBody(newChatId(), 'plain'))
    expect(plain.userMessage!.parts).toEqual([{ type: 'text', text: 'plain' }])
    expect(mocked.mock.calls.at(-1)![0]).toMatchObject({ origin: 'request', serverMessage: false })
  })

  it('a hook-blocked refusal removes the chat row this request created and keeps an existing chat', async () => {
    const mocked = vi.mocked(runPromptHooks)
    const record = fakeHookRecord('UserPromptSubmit', 'blocked', { reason: 'no secrets' })
    const fresh = newChatId()
    mocked.mockRejectedValueOnce(hookBlockedError(fresh, record))
    const error = await prepare(chatBody(fresh, 'my password is x')).catch((caught: unknown) => caught)
    expect(isHookBlockedError(error)).toBe(true)
    expect((error as HarnessError).toJSON().error).toMatchObject({ code: 'conflict', message: 'A hook blocked this message: no secrets', details: { reason: 'hook-blocked', chatId: fresh, hook: record } })
    expect((await chat(fresh)).status).toBe(404)

    const existing = newChatId()
    await commitHistory(t.deps, existing, (await prepare(chatBody(existing, 'first'))).writes)
    mocked.mockRejectedValueOnce(hookBlockedError(existing, record))
    await expect(prepare(chatBody(existing, 'second'))).rejects.toMatchObject({ code: 'conflict' })
    expect((await chat(existing)).detail?.messages).toHaveLength(1)
    // Any other failure keeps the chat row (the v1.6 behavior of a failed prepare).
    const other = newChatId()
    mocked.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'boom' }))
    await expect(prepare(chatBody(other, 'x'))).rejects.toMatchObject({ code: 'internal_error' })
    expect((await chat(other)).status).toBe(200)
  })
})

describe('the C37 stubs', () => {
  const signal = new AbortController().signal

  it('runPromptHooks answers the precomputed records; resolveRunOutputStyle answers default', async () => {
    const actual = await vi.importActual<typeof import('./hooks-prompt.ts')>('./hooks-prompt.ts')
    const record: HookData = fakeHookRecord('UserPromptSubmit', 'context', { context: 'x' })
    const input = { deps: {} as AppDeps, prepared: {} as PreparedRun, body: chatBody(testChatId(1), 'x'), origin: 'request' as const, serverMessage: false, signal, logger: createSilentLogger() }
    expect(await actual.runPromptHooks(input)).toEqual({ records: [] })
    expect(await actual.runPromptHooks({ ...input, precomputed: [record] })).toEqual({ records: [record] })
    const style = await resolveRunOutputStyle({ deps: {} as AppDeps, catalog: {} as PreparedRun['catalog'], chat: {} as PreparedRun['chat'], settings: {} as PreparedRun['settings'], history: [], modelRef: 'mock:echo', signal, logger: createSilentLogger() })
    expect(style).toEqual({ style: DEFAULT_RUN_OUTPUT_STYLE, notices: [] })
    const controller = new AbortController()
    controller.abort()
    await expect(actual.runPromptHooks({ ...input, signal: controller.signal })).rejects.toBeDefined()
  })

  it('hookBlockedError without a reason; startHookTurn starts nothing yet', () => {
    const record = fakeHookRecord('UserPromptSubmit', 'blocked')
    expect(hookBlockedError('c', record).message).toBe('A hook blocked this message.')
    expect(isHookBlockedError(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'run-active' } }))).toBe(false)
    const start = vi.fn(async () => new Response(null))
    expect(startHookTurn({ chatId: 'c', data: record, previous: { modelRef: 'mock:echo', reasoningEffort: 'auto', toolMode: 'ask' }, options: { logger: createSilentLogger(), requestId: 'r' }, events: { emit: () => {} }, start })).toBe(false)
    expect(start).not.toHaveBeenCalled()
  })

  it('commandExpansionHost opens the project folder once, on first use, and checks trust hashes', async () => {
    const opened: string[] = []
    const workspace = { projectId: 'prj_0123456789abcdef', name: 'P', root: '/srv/p', instructions: null, projectFile: null }
    const deps = {
      env: { workspaceShell: false },
      projects: { openWorkspace: async (id: string) => {
        opened.push(id)
        return { ok: true as const, workspace }
      } },
      projectTrust: { approved: async () => new Set(['a'.repeat(64)]) },
    } as unknown as Pick<AppDeps, 'env' | 'projects' | 'projectTrust'>
    const host = commandExpansionHost(deps, workspace.projectId)
    expect(host).toMatchObject({ projectId: workspace.projectId, shellEnabled: false })
    expect(opened).toEqual([])
    expect(await host.workspace()).toBe(workspace)
    expect(await host.workspace()).toBe(workspace)
    expect(opened).toEqual([workspace.projectId])
    expect(await host.trusted(workspace.projectId, 'a'.repeat(64))).toBe(true)
    expect(await host.trusted(workspace.projectId, 'b'.repeat(64))).toBe(false)
    expect(await commandExpansionHost(deps, null).workspace()).toBeNull()
  })

  it('agentBlocks leaves out the coding hints with codingHints false (plan block and listings stay)', () => {
    const tools = ['todo_write', 'task', 'exit_plan_mode']
    const listings = { agentTypes: [{ name: 'explore', description: 'Read only.' }] }
    const all = agentBlocks('plan', tools, listings)
    expect(all).toContain(TODO_HINT)
    expect(all).toContain(TASK_HINT)
    expect(agentBlocks('plan', tools, listings, { codingHints: true })).toEqual(all)
    const plain = agentBlocks('plan', tools, listings, { codingHints: false })
    expect(plain).toEqual(all.filter(block => block !== TODO_HINT && block !== TASK_HINT))
    expect(plain.length).toBe(2)
  })
})
