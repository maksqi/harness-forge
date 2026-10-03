// Workspace store (docs/UI.md 7.21, 11.5): the entries of both views (loading, error, loadedAt; joined and forced
// fetches that never reject), the diff cache, revert and undo, the debounced refresh on server events, the reconnect
// refresh and the drops.
import type { ChatChanges } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  changeBatchId,
  chatChangeFile,
  chatChanges,
  chatId,
  chatSummary,
  fileDiff,
  gitStatus,
  projectId,
  projectSummary,
  restoreResult,
  workspaceChangedData,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useChatsStore } from './chats'
import { useUiStore } from './ui'
import { useWorkspaceStore, WORKSPACE_REFRESH_DEBOUNCE_MS } from './workspace'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  vi.useRealTimers()
})

/** A promise with its resolve / reject, for answers that arrive later. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('workspace store: shape', () => {
  it('starts empty and exposes the frozen members', () => {
    const workspace = useWorkspaceStore()
    expect(workspace.chat).toEqual({})
    expect(workspace.git).toEqual({})
    expect(workspace.chatChanges(chatId(1))).toBeNull()
    expect(workspace.gitStatus(chatId(1))).toBeNull()
    expect(workspace.changeCount(chatId(1))).toBe(0)
    for (const action of ['fetchChatChanges', 'fetchGit', 'fileDiff', 'revert', 'undo', 'applyEvent', 'refreshLoaded'] as const)
      expect(workspace[action]).toBeTypeOf('function')
  })

  it('reads loaded entries; the count leaves out files back to their original state', () => {
    const workspace = useWorkspaceStore()
    const changes = chatChanges({ files: [chatChangeFile(), chatChangeFile({ path: 'b.ts', status: 'unchanged' }), chatChangeFile({ path: 'c.ts', status: 'added' })] })
    workspace.chat[chatId(1)] = { data: changes, loading: false, error: null, loadedAt: 1 }
    workspace.git[chatId(1)] = { data: gitStatus(), loading: false, error: null, loadedAt: 1 }
    expect(workspace.chatChanges(chatId(1))).toEqual(changes)
    expect(workspace.gitStatus(chatId(1))).toEqual(gitStatus())
    expect(workspace.changeCount(chatId(1))).toBe(2)
  })
})

describe('workspace store: fetches', () => {
  it('loads This chat into its entry: loading, data, loadedAt; a failure stays in the entry and keeps the data', async () => {
    const workspace = useWorkspaceStore()
    const answer = deferred<ChatChanges>()
    api.changes.list.mockReturnValueOnce(answer.promise)
    const loading = workspace.fetchChatChanges(chatId(1))
    expect(api.changes.list).toHaveBeenCalledWith({ params: { id: chatId(1) }, signal: expect.any(AbortSignal) })
    expect(workspace.chat[chatId(1)]).toEqual({ data: null, loading: true, error: null, loadedAt: null })
    answer.resolve(chatChanges())
    await loading
    const entry = workspace.chat[chatId(1)]!
    expect(entry).toMatchObject({ data: chatChanges(), loading: false, error: null })
    expect(entry.loadedAt).toBeTypeOf('number')
    expect(workspace.changeCount(chatId(1))).toBe(1)

    api.changes.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom.' }))
    await expect(workspace.fetchChatChanges(chatId(1))).resolves.toBeUndefined()
    expect(workspace.chat[chatId(1)]).toMatchObject({ data: chatChanges(), loading: false, error: { code: 'internal_error', message: 'Boom.' } })
  })

  it('loads the Git view into its own entry, and clears an earlier error on success', async () => {
    const workspace = useWorkspaceStore()
    api.changes.git.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Chat not found.' }))
    await workspace.fetchGit(chatId(1))
    expect(workspace.git[chatId(1)]?.error?.code).toBe('not_found')
    api.changes.git.mockResolvedValueOnce(gitStatus())
    await workspace.fetchGit(chatId(1))
    expect(workspace.git[chatId(1)]).toMatchObject({ data: gitStatus(), error: null, loading: false })
    expect(workspace.gitStatus(chatId(1))).toEqual(gitStatus())
    expect(workspace.chat[chatId(1)]).toBeUndefined()
  })

  it('joins a running fetch; force aborts it and its late answer is ignored', async () => {
    const workspace = useWorkspaceStore()
    const first = deferred<ChatChanges>()
    const second = deferred<ChatChanges>()
    api.changes.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = workspace.fetchChatChanges(chatId(1))
    const b = workspace.fetchChatChanges(chatId(1))
    expect(api.changes.list).toHaveBeenCalledTimes(1)
    const forced = workspace.fetchChatChanges(chatId(1), { force: true })
    expect(api.changes.list).toHaveBeenCalledTimes(2)
    const firstSignal = api.changes.list.mock.calls[0]![0].signal as AbortSignal
    expect(firstSignal.aborted).toBe(true)

    second.resolve(chatChanges({ files: [chatChangeFile({ path: 'new.ts' })] }))
    await forced
    first.resolve(chatChanges({ files: [chatChangeFile({ path: 'old.ts' })] }))
    await Promise.all([a, b])
    expect(workspace.chatChanges(chatId(1))?.files.map(file => file.path)).toEqual(['new.ts'])
    expect(workspace.chat[chatId(1)]?.loading).toBe(false)
  })

  it('never rejects, even when the client throws at once', async () => {
    mock.api = {}
    setActivePinia(createPinia())
    const workspace = useWorkspaceStore()
    await expect(workspace.fetchChatChanges(chatId(1))).resolves.toBeUndefined()
    expect(workspace.chat[chatId(1)]).toMatchObject({ data: null, loading: false, error: { code: 'internal_error' } })
  })
})

describe('workspace store: diffs, revert and undo', () => {
  it('caches a diff per view until that view\'s next successful fetch', async () => {
    const workspace = useWorkspaceStore()
    const signal = new AbortController().signal
    api.changes.diff.mockResolvedValue(fileDiff())
    await expect(workspace.fileDiff(chatId(1), 'chat', 'src/index.ts', { signal })).resolves.toEqual(fileDiff())
    expect(api.changes.diff).toHaveBeenCalledWith({ params: { id: chatId(1) }, query: { source: 'chat', path: 'src/index.ts' }, signal })
    await workspace.fileDiff(chatId(1), 'chat', 'src/index.ts')
    expect(api.changes.diff).toHaveBeenCalledTimes(1)
    await workspace.fileDiff(chatId(1), 'git', 'src/index.ts')
    expect(api.changes.diff).toHaveBeenCalledTimes(2)

    // A failed refresh keeps the cache; a successful one drops the view's diffs only.
    api.changes.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom.' }))
    await workspace.fetchChatChanges(chatId(1))
    await workspace.fileDiff(chatId(1), 'chat', 'src/index.ts')
    expect(api.changes.diff).toHaveBeenCalledTimes(2)
    api.changes.list.mockResolvedValueOnce(chatChanges())
    await workspace.fetchChatChanges(chatId(1))
    await workspace.fileDiff(chatId(1), 'chat', 'src/index.ts')
    await workspace.fileDiff(chatId(1), 'git', 'src/index.ts')
    expect(api.changes.diff).toHaveBeenCalledTimes(3)
  })

  it('does not cache a diff that was loading while the view refreshed', async () => {
    const workspace = useWorkspaceStore()
    const answer = deferred<ReturnType<typeof fileDiff>>()
    api.changes.diff.mockReturnValueOnce(answer.promise).mockResolvedValue(fileDiff({ currentSha: 'e'.repeat(64) }))
    const loading = workspace.fileDiff(chatId(1), 'chat', 'src/index.ts')
    api.changes.list.mockResolvedValueOnce(chatChanges())
    await workspace.fetchChatChanges(chatId(1))
    answer.resolve(fileDiff())
    await expect(loading).resolves.toEqual(fileDiff())
    await expect(workspace.fileDiff(chatId(1), 'chat', 'src/index.ts')).resolves.toMatchObject({ currentSha: 'e'.repeat(64) })
    expect(api.changes.diff).toHaveBeenCalledTimes(2)
  })

  it('reverts and undoes through the changes routes and throws HarnessError', async () => {
    const workspace = useWorkspaceStore()
    api.changes.revert.mockResolvedValueOnce(restoreResult())
    api.changes.undo.mockResolvedValueOnce(restoreResult({ batchId: changeBatchId(2) }))
    await workspace.revert(chatId(1), { source: 'chat', path: 'src/index.ts', expectedSha: null })
    expect(api.changes.revert).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { source: 'chat', path: 'src/index.ts', expectedSha: null } })
    await expect(workspace.undo(chatId(1), changeBatchId(1))).resolves.toMatchObject({ batchId: changeBatchId(2) })
    expect(api.changes.undo).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { batchId: changeBatchId(1), conflicts: 'skip' } })

    api.changes.revert.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A response is running.', details: { reason: 'run-active' } }))
    await expect(workspace.revert(chatId(1), { source: 'chat', path: 'a.ts' })).rejects.toBeInstanceOf(HarnessError)
    api.changes.diff.mockRejectedValueOnce({ code: 'not_found', message: 'Not found.' })
    await expect(workspace.fileDiff(chatId(1), 'chat', 'a.ts')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('workspace store: refreshes', () => {
  /** Loads both views of chat `n` in project `p`. */
  async function load(workspace: ReturnType<typeof useWorkspaceStore>, n: number, p: number, views: Array<'chat' | 'git'> = ['chat', 'git']) {
    api.changes.list.mockResolvedValueOnce(chatChanges({ projectId: projectId(p) }))
    api.changes.git.mockResolvedValueOnce(gitStatus())
    if (views.includes('chat'))
      await workspace.fetchChatChanges(chatId(n))
    if (views.includes('git'))
      await workspace.fetchGit(chatId(n))
  }

  function calledChats(fn: MockApi['changes']['list']) {
    return fn.mock.calls.map(([options]) => (options as { params: { id: string } }).params.id)
  }

  it('workspace.changed refetches the loaded entries of its chat and project once, 300 ms after the last event', async () => {
    vi.useFakeTimers()
    const workspace = useWorkspaceStore()
    await load(workspace, 1, 1)
    await load(workspace, 2, 1)
    await load(workspace, 3, 2)
    await load(workspace, 4, 1, ['chat'])
    api.changes.list.mockClear()
    api.changes.git.mockClear()
    api.changes.list.mockResolvedValue(chatChanges())
    api.changes.git.mockResolvedValue(gitStatus())

    const event = createServerEvent('workspace.changed', workspaceChangedData({ chatId: chatId(1), projectId: projectId(1) }))
    workspace.applyEvent(event)
    await vi.advanceTimersByTimeAsync(200)
    workspace.applyEvent(event)
    await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_DEBOUNCE_MS - 1)
    expect(api.changes.list).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    // Chat 1: both views; chat 2 (same project, not open): Git only; chat 3: another project; chat 4: no Git entry.
    expect(calledChats(api.changes.list)).toEqual([chatId(1)])
    expect(calledChats(api.changes.git).sort()).toEqual([chatId(1), chatId(2)])
  })

  it('workspace.changed also refreshes the open chat of the project (changed outside this chat)', async () => {
    vi.useFakeTimers()
    const workspace = useWorkspaceStore()
    await load(workspace, 1, 1, ['chat'])
    await load(workspace, 2, 1, ['chat'])
    useUiStore().setActiveChat(chatId(2))
    api.changes.list.mockClear()
    api.changes.list.mockResolvedValue(chatChanges())
    workspace.applyEvent(createServerEvent('workspace.changed', workspaceChangedData({ chatId: chatId(1), projectId: projectId(1) })))
    await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_DEBOUNCE_MS)
    expect(calledChats(api.changes.list).sort()).toEqual([chatId(1), chatId(2)])
  })

  it('finds a chat\'s project in the chats store when only its Git view is loaded', async () => {
    vi.useFakeTimers()
    const workspace = useWorkspaceStore()
    await load(workspace, 5, 1, ['git'])
    useChatsStore().applyEvent(createServerEvent('chat.created', chatSummary({ id: chatId(5), projectId: projectId(1) })))
    api.changes.git.mockClear()
    api.changes.git.mockResolvedValue(gitStatus())
    workspace.applyEvent(createServerEvent('workspace.changed', workspaceChangedData({ chatId: null, projectId: projectId(1) })))
    await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_DEBOUNCE_MS)
    expect(calledChats(api.changes.git)).toEqual([chatId(5)])
  })

  it('run.finished refetches that chat\'s loaded entries; nothing for a chat that was never loaded', async () => {
    vi.useFakeTimers()
    const workspace = useWorkspaceStore()
    await load(workspace, 1, 1, ['chat'])
    api.changes.list.mockClear()
    api.changes.list.mockResolvedValue(chatChanges())
    const finished = (n: number) => createServerEvent('run.finished', { chatId: chatId(n), messageId: 'msg_asst000000000001', outcome: 'completed', awaitingApproval: false })
    workspace.applyEvent(finished(1))
    workspace.applyEvent(finished(9))
    await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_DEBOUNCE_MS)
    expect(calledChats(api.changes.list)).toEqual([chatId(1)])
    expect(api.changes.git).toHaveBeenCalledTimes(0)
  })

  it('chat.deleted drops the chat\'s entries and its pending refresh', async () => {
    vi.useFakeTimers()
    const workspace = useWorkspaceStore()
    await load(workspace, 1, 1)
    api.changes.list.mockClear()
    workspace.applyEvent(createServerEvent('workspace.changed', workspaceChangedData()))
    workspace.applyEvent(createServerEvent('chat.deleted', { id: chatId(1) }))
    expect(workspace.chat[chatId(1)]).toBeUndefined()
    expect(workspace.git[chatId(1)]).toBeUndefined()
    await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_DEBOUNCE_MS)
    expect(api.changes.list).not.toHaveBeenCalled()
  })

  it('a deleted project drops the entries of its chats; a changed project drops nothing', async () => {
    const workspace = useWorkspaceStore()
    await load(workspace, 1, 1)
    await load(workspace, 2, 2)
    workspace.applyEvent(createServerEvent('project.changed', { id: projectId(2), project: projectSummary({ id: projectId(2) }) }))
    expect(Object.keys(workspace.chat).sort()).toEqual([chatId(1), chatId(2)])
    workspace.applyEvent(createServerEvent('project.changed', { id: projectId(1), project: null }))
    expect(Object.keys(workspace.chat)).toEqual([chatId(2)])
    expect(Object.keys(workspace.git)).toEqual([chatId(2)])
  })

  it('refreshLoaded refetches every loaded entry, forced', async () => {
    const workspace = useWorkspaceStore()
    await load(workspace, 1, 1)
    await load(workspace, 2, 1, ['chat'])
    api.changes.list.mockClear()
    api.changes.git.mockClear()
    api.changes.list.mockResolvedValue(chatChanges())
    api.changes.git.mockResolvedValue(gitStatus())
    await workspace.refreshLoaded()
    expect(calledChats(api.changes.list).sort()).toEqual([chatId(1), chatId(2)])
    expect(calledChats(api.changes.git)).toEqual([chatId(1)])
  })
})
