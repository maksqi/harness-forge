// Hooks store (docs/UI.md 9.13, 11.8; W11.8-T1): per-scope caches with single flight and `maxAgeMs`, an answer that an
// event or a mutation overtook is never cached, events mark the affected scopes stale and refetch the recent ones,
// `{ enabled: false }` is optimistic with a rollback, and the fresh-auth 403 is thrown for the component.
import type { HookList } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeHookEntry, hookEntry, hookId, hookList, personalHook, projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { HOOKS_RECENT_MS, hookScopeKey, useHooksStore } from './hooks'

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
  vi.useRealTimers()
  disposePinia(pinia)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const globalList = hookList({ items: [hookEntry(), codeHookEntry()], project: undefined })

describe('hooks store', () => {
  it('starts empty', () => {
    const store = useHooksStore()
    expect(store.lists).toEqual({})
    expect(store.list(null)).toBeNull()
    expect(store.list(projectId(1))).toBeNull()
    expect(store.personal).toEqual([])
    expect(hookScopeKey(null)).toBe('')
    expect(hookScopeKey(projectId(1))).toBe(projectId(1))
  })

  it('fetches a scope, keeps the personal entries of the global one and reuses a young list', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValueOnce(globalList)
    await store.fetch(null)
    expect(api.hooks.list).toHaveBeenCalledWith({ query: {} })
    expect(store.list(null)).toEqual(globalList)
    expect(store.personal).toEqual([hookEntry()])
    await expect(store.fetch(null, { maxAgeMs: 60_000 })).resolves.toEqual(globalList)
    expect(api.hooks.list).toHaveBeenCalledTimes(1)
    api.hooks.list.mockResolvedValueOnce(hookList())
    await store.fetch(projectId(1))
    expect(api.hooks.list).toHaveBeenLastCalledWith({ query: { projectId: projectId(1) } })
    expect(store.list(projectId(1))?.project?.pending).toBe(1)
  })

  it('refetches a list older than maxAgeMs', async () => {
    vi.useFakeTimers()
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(globalList)
    await store.fetch(null)
    vi.advanceTimersByTime(20_000)
    await store.fetch(null, { maxAgeMs: 15_000 })
    expect(api.hooks.list).toHaveBeenCalledTimes(2)
  })

  it('runs one request per scope at a time', async () => {
    const store = useHooksStore()
    const answer = deferred<HookList>()
    api.hooks.list.mockReturnValueOnce(answer.promise)
    const first = store.fetch(null)
    const second = store.fetch(null)
    expect(api.hooks.list).toHaveBeenCalledTimes(1)
    answer.resolve(globalList)
    await expect(first).resolves.toEqual(globalList)
    await expect(second).resolves.toEqual(globalList)
  })

  it('never caches an answer that an event overtook, and refetches the scope used recently', async () => {
    const store = useHooksStore()
    const old = deferred<HookList>()
    api.hooks.list.mockReturnValueOnce(old.promise)
    const request = store.fetch(null)
    const fresh = hookList({ items: [hookEntry({ command: 'sh new.sh' })], project: undefined })
    api.hooks.list.mockResolvedValueOnce(fresh)
    store.applyEvent(createServerEvent('hooks.changed', { projectId: null }, 1))
    old.resolve(globalList)
    await expect(request).resolves.toEqual(globalList)
    await vi.waitFor(() => expect(store.list(null)).toEqual(fresh))
    expect(api.hooks.list).toHaveBeenCalledTimes(2)
  })

  it('marks only the affected scopes stale and refetches only the recently used ones', async () => {
    vi.useFakeTimers()
    const store = useHooksStore()
    api.hooks.list.mockImplementation(async ({ query }: { query: { projectId?: string } }) => (query.projectId ? hookList({ project: { ...hookList().project!, id: query.projectId } }) : globalList))
    await store.fetch(null)
    await store.fetch(projectId(1))
    await store.fetch(projectId(2))
    api.hooks.list.mockClear()

    store.applyEvent(createServerEvent('project-trust.changed', { projectId: projectId(1), pending: 0 }, 1))
    expect(store.stale).toEqual({ [projectId(1)]: true })
    await vi.waitFor(() => expect(api.hooks.list).toHaveBeenCalledWith({ query: { projectId: projectId(1) } }))
    expect(api.hooks.list).toHaveBeenCalledTimes(1)

    // A scope not used for a minute is only marked stale.
    vi.advanceTimersByTime(HOOKS_RECENT_MS + 1)
    api.hooks.list.mockClear()
    store.applyEvent(createServerEvent('plugin.changed', { id: 'hook-pack', plugin: null }, 2))
    expect(Object.keys(store.stale).sort()).toEqual(['', projectId(1), projectId(2)].sort())
    expect(api.hooks.list).not.toHaveBeenCalled()
    await store.fetch(null)
    expect(store.stale['']).toBeUndefined()

    store.applyEvent(createServerEvent('customization.changed', { projectId: projectId(2) }, 3))
    expect(store.stale[projectId(2)]).toBe(true)
    store.applyEvent(createServerEvent('customization.changed', {}, 4))
    expect(store.stale['']).toBeUndefined()
  })

  it('drops a deleted project\'s scope on a 404 and on project.changed', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValueOnce(hookList())
    await store.fetch(projectId(1))
    api.hooks.list.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    await expect(store.fetch(projectId(1))).rejects.toMatchObject({ code: 'not_found' })
    expect(store.list(projectId(1))).toBeNull()

    api.hooks.list.mockResolvedValueOnce(hookList())
    await store.fetch(projectId(1))
    store.applyEvent(createServerEvent('project.changed', { id: projectId(1), project: null }, 1))
    expect(store.list(projectId(1))).toBeNull()
    expect(projectSummary().id).toBe(projectId(1))
  })

  it('throws the fresh-auth 403 of create and marks every scope stale after a mutation', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(hookList())
    await store.fetch(null)
    await store.fetch(projectId(1))
    api.hooks.create.mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Log in again.', action: 'login' }))
    await expect(store.create({ event: 'Stop', command: 'sh check.sh' })).rejects.toMatchObject({ code: 'forbidden', action: 'login' })
    expect(store.stale).toEqual({})
    api.hooks.create.mockResolvedValueOnce(personalHook({ id: hookId(2) }))
    await store.create({ event: 'Stop', command: 'sh check.sh' })
    expect(store.stale).toEqual({ '': true, [projectId(1)]: true })
    api.hooks.remove.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Gone' }))
    await expect(store.remove(hookId(1))).resolves.toBeUndefined()
    api.hooks.remove.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await expect(store.remove(hookId(1))).rejects.toMatchObject({ code: 'internal_error' })
  })

  it('turns a hook off at once in every scope and rolls back a failure', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(hookList())
    await store.fetch(null)
    await store.fetch(projectId(1))
    const answer = deferred<unknown>()
    api.hooks.update.mockReturnValueOnce(answer.promise)
    const request = store.update(hookId(1), { enabled: false })
    expect(store.list(null)?.items[0]?.state).toBe('off')
    expect(store.list(projectId(1))?.items[0]?.state).toBe('off')
    expect(store.personal[0]?.state).toBe('off')
    answer.reject(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await expect(request).rejects.toMatchObject({ code: 'internal_error' })
    expect(store.list(null)?.items[0]?.state).toBe('active')

    // A success keeps the off state until the refetch answers.
    api.hooks.update.mockResolvedValueOnce(personalHook({ enabled: false }))
    await store.update(hookId(1), { enabled: false })
    expect(store.list(projectId(1))?.items[0]?.state).toBe('off')
    expect(api.hooks.update).toHaveBeenLastCalledWith({ params: { id: hookId(1) }, body: { enabled: false } })
  })

  it('does not change the shown state of a fresh-auth update before the server answers', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(hookList({ items: [hookEntry({ state: 'off' })] }))
    await store.fetch(null)
    api.hooks.update.mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Log in again.', action: 'login' }))
    const request = store.update(hookId(1), { enabled: true })
    expect(store.list(null)?.items[0]?.state).toBe('off')
    await expect(request).rejects.toMatchObject({ action: 'login' })
  })

  it('refetches the loaded scopes after a reconnect and reads the run log', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(hookList())
    await store.fetch(null)
    await store.fetch(projectId(1))
    api.hooks.list.mockClear()
    await store.refreshLoaded()
    expect(api.hooks.list).toHaveBeenCalledTimes(2)
    api.hooks.runs.mockResolvedValueOnce({ items: [] })
    await expect(store.runs()).resolves.toEqual({ items: [] })
  })
})
