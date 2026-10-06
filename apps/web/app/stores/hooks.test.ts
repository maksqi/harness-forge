import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeHookEntry, hookEntry, hookId, hookList, personalHook, projectId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { hookScopeKey, useHooksStore } from './hooks'

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
})

describe('hooks store (P11-0b shape)', () => {
  it('starts empty', () => {
    const store = useHooksStore()
    expect(store.lists).toEqual({})
    expect(store.loadedAt).toEqual({})
    expect(store.stale).toEqual({})
    expect(store.list(null)).toBeNull()
    expect(store.list(projectId(1))).toBeNull()
    expect(store.personal).toEqual([])
    expect(hookScopeKey(null)).toBe('')
    expect(hookScopeKey(projectId(1))).toBe(projectId(1))
  })

  it('fetches a scope, keeps the personal entries of the global one and reuses a young list', async () => {
    const store = useHooksStore()
    const global = hookList({ items: [hookEntry(), codeHookEntry()], project: undefined })
    api.hooks.list.mockResolvedValueOnce(global)
    await store.fetch(null)
    expect(api.hooks.list).toHaveBeenCalledWith({ query: {} })
    expect(store.list(null)).toEqual(global)
    expect(store.personal).toEqual([hookEntry()])
    await store.fetch(null, { maxAgeMs: 60_000 })
    expect(api.hooks.list).toHaveBeenCalledTimes(1)
    api.hooks.list.mockResolvedValueOnce(hookList())
    await store.fetch(projectId(1))
    expect(api.hooks.list).toHaveBeenLastCalledWith({ query: { projectId: projectId(1) } })
    expect(store.list(projectId(1))?.project?.pending).toBe(1)
  })

  it('drops a deleted project\'s scope on a 404 and throws', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValueOnce(hookList())
    await store.fetch(projectId(1))
    api.hooks.list.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    await expect(store.fetch(projectId(1))).rejects.toMatchObject({ code: 'not_found' })
    expect(store.list(projectId(1))).toBeNull()
  })

  it('marks every scope stale after a mutation or an event and throws the fresh-auth 403', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(hookList())
    await store.fetch(null)
    api.hooks.create.mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Log in again.', action: 'login' }))
    await expect(store.create({ event: 'Stop', command: 'sh check.sh' })).rejects.toMatchObject({ code: 'forbidden' })
    api.hooks.update.mockResolvedValueOnce(personalHook({ enabled: false }))
    await expect(store.update(hookId(1), { enabled: false })).resolves.toMatchObject({ enabled: false })
    expect(store.stale['']).toBe(true)
    await store.fetch(null)
    expect(store.stale['']).toBeUndefined()
    store.applyEvent(createServerEvent('hooks.changed', { projectId: null }, 1))
    expect(store.stale['']).toBe(true)
    api.hooks.remove.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Gone' }))
    await expect(store.remove(hookId(1))).resolves.toBeUndefined()
  })

  it('refetches the loaded scopes after a reconnect', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(hookList())
    await store.fetch(null)
    await store.fetch(projectId(1))
    api.hooks.list.mockClear()
    await store.refreshLoaded()
    expect(api.hooks.list).toHaveBeenCalledTimes(2)
  })
})
