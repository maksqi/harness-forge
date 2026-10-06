// The project trust store (docs/UI.md 7.33, 11.8; W11.9-T1): the lists and pending counts, single flight, per-project
// versions (an answer an event or a mutation overtook is not cached), the event refetch of loaded lists, the stale
// approval (refetch, then throw), revoke, the 404 drop and the reconnect refresh.
import type { ProjectTrustList } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { flushPromises } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectId, projectSummary, projectTrustList, trustCommandItem, trustHookItem, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { isStaleTrustError, useProjectTrustStore } from './project-trust'

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

const P1 = projectId(1)
const allApproved = (): ProjectTrustList => projectTrustList({ items: projectTrustList().items.map(item => ({ ...item, state: 'approved' as const })) })

describe('project-trust store', () => {
  it('starts empty: unknown pending counts are null', () => {
    const store = useProjectTrustStore()
    expect(store.byProject).toEqual({})
    expect(store.loadedAt).toEqual({})
    expect(store.pendingByEvent).toEqual({})
    expect(store.trust(P1)).toBeNull()
    expect(store.pending(P1)).toBeNull()
    expect(store.pending(null)).toBeNull()
  })

  it('counts the pending items of a list, else the latest event', async () => {
    const store = useProjectTrustStore()
    store.applyEvent(createServerEvent('project-trust.changed', { projectId: P1, pending: 4 }, 1))
    expect(store.pending(P1)).toBe(4)
    // Nothing was loaded or loading: the event does not fetch.
    expect(api.projectTrust.list).not.toHaveBeenCalled()
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList())
    await store.fetch(P1)
    expect(api.projectTrust.list).toHaveBeenCalledWith({ params: { id: P1 } })
    expect(store.pending(P1)).toBe(2)
    expect(store.pendingByEvent).toEqual({})
    store.applyEvent(createServerEvent('project.changed', { id: P1, project: null }, 2))
    expect(store.trust(P1)).toBeNull()
    expect(store.pending(P1)).toBeNull()
    store.applyEvent(createServerEvent('project.changed', { id: projectId(2), project: projectSummary({ id: projectId(2) }) }, 3))
  })

  it('shares one request between concurrent fetches and reuses a fresh list within maxAgeMs', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    const store = useProjectTrustStore()
    const answer = deferred<ProjectTrustList>()
    api.projectTrust.list.mockReturnValueOnce(answer.promise)
    const first = store.fetch(P1)
    const second = store.fetch(P1, { maxAgeMs: 60_000 })
    answer.resolve(projectTrustList())
    await expect(first).resolves.toEqual(projectTrustList())
    await expect(second).resolves.toEqual(projectTrustList())
    expect(api.projectTrust.list).toHaveBeenCalledTimes(1)

    await store.fetch(P1, { maxAgeMs: 60_000 })
    expect(api.projectTrust.list).toHaveBeenCalledTimes(1)
    vi.setSystemTime(1_000_000 + 61_000)
    api.projectTrust.list.mockResolvedValueOnce(allApproved())
    await store.fetch(P1, { maxAgeMs: 60_000 })
    expect(api.projectTrust.list).toHaveBeenCalledTimes(2)
    expect(store.pending(P1)).toBe(0)
    // Without maxAgeMs every call asks the server (a fresh scan).
    api.projectTrust.list.mockResolvedValueOnce(allApproved())
    await store.fetch(P1)
    expect(api.projectTrust.list).toHaveBeenCalledTimes(3)
  })

  it('refetches a loaded list on project-trust.changed, and the event count wins until the answer', async () => {
    const store = useProjectTrustStore()
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList())
    await store.fetch(P1, { maxAgeMs: 60_000 })
    const refetch = deferred<ProjectTrustList>()
    api.projectTrust.list.mockReturnValueOnce(refetch.promise)
    store.applyEvent(createServerEvent('project-trust.changed', { projectId: P1, pending: 0 }, 1))
    expect(api.projectTrust.list).toHaveBeenCalledTimes(2)
    expect(store.pending(P1)).toBe(0)
    // A stale list is never served from the cache, whatever maxAgeMs says (the refetch in flight is shared).
    const shared = store.fetch(P1, { maxAgeMs: 60_000 })
    expect(api.projectTrust.list).toHaveBeenCalledTimes(2)
    refetch.resolve(allApproved())
    await shared
    expect(store.trust(P1)?.items.every(item => item.state === 'approved')).toBe(true)
    expect(store.pendingByEvent).toEqual({})
  })

  it('never caches an answer an event overtook, and fetches again', async () => {
    const store = useProjectTrustStore()
    const old = deferred<ProjectTrustList>()
    api.projectTrust.list.mockReturnValueOnce(old.promise)
    const first = store.fetch(P1)
    api.projectTrust.list.mockResolvedValueOnce(allApproved())
    store.applyEvent(createServerEvent('project-trust.changed', { projectId: P1, pending: 0 }, 1))
    expect(api.projectTrust.list).toHaveBeenCalledTimes(2)
    await flushPromises()
    expect(store.trust(P1)?.items.every(item => item.state === 'approved')).toBe(true)
    old.resolve(projectTrustList())
    // The overtaken answer still reaches its caller, but the cache keeps the newer list.
    await expect(first).resolves.toEqual(projectTrustList())
    expect(store.pending(P1)).toBe(0)
  })

  it('approves, refetches on a stale conflict and throws, and revokes', async () => {
    const store = useProjectTrustStore()
    api.projectTrust.approve.mockResolvedValueOnce(allApproved())
    await expect(store.approve(P1, [{ kind: 'hook', sha256: trustSha(1) }])).resolves.toEqual(allApproved())
    expect(api.projectTrust.approve).toHaveBeenCalledWith({ params: { id: P1 }, body: { items: [{ kind: 'hook', sha256: trustSha(1) }] } })
    expect(store.pending(P1)).toBe(0)
    const stale = new HarnessError({ code: 'conflict', message: 'Changed.', details: { reason: 'stale' } })
    api.projectTrust.approve.mockRejectedValueOnce(stale)
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList())
    await expect(store.approve(P1, [{ kind: 'mcp', sha256: trustSha(3) }])).rejects.toMatchObject({ code: 'conflict' })
    expect(api.projectTrust.list).toHaveBeenCalledTimes(1)
    expect(store.pending(P1)).toBe(2)
    api.projectTrust.revoke.mockResolvedValueOnce(projectTrustList({ items: [] }))
    await store.revoke(P1, trustSha(4))
    expect(api.projectTrust.revoke).toHaveBeenCalledWith({ params: { id: P1, sha256: trustSha(4) } })
    expect(store.trust(P1)?.items).toEqual([])
  })

  it('throws other approval failures without a refetch (a 403 login is for the caller\'s fresh auth)', async () => {
    const store = useProjectTrustStore()
    api.projectTrust.approve.mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Confirm your password.', action: 'login' }))
    await expect(store.approve(P1, [{ kind: 'hook', sha256: trustSha(1) }])).rejects.toMatchObject({ code: 'forbidden', action: 'login' })
    api.projectTrust.approve.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Busy.', details: { reason: 'other' } }))
    await expect(store.approve(P1, [{ kind: 'hook', sha256: trustSha(1) }])).rejects.toMatchObject({ code: 'conflict' })
    expect(api.projectTrust.list).not.toHaveBeenCalled()
  })

  it('a mutation overtakes a fetch in flight', async () => {
    const store = useProjectTrustStore()
    const old = deferred<ProjectTrustList>()
    api.projectTrust.list.mockReturnValueOnce(old.promise)
    const loading = store.fetch(P1)
    api.projectTrust.revoke.mockResolvedValueOnce(projectTrustList({ items: [trustHookItem(), trustCommandItem({ state: 'pending' })] }))
    await store.revoke(P1, trustSha(4))
    old.resolve(allApproved())
    await loading
    expect(store.pending(P1)).toBe(2)
  })

  it('drops a project the server no longer knows (404) and the deleted project of project.changed', async () => {
    const store = useProjectTrustStore()
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList())
    await store.fetch(P1)
    // The event's refetch answers 404: the project is gone.
    api.projectTrust.list.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    store.applyEvent(createServerEvent('project-trust.changed', { projectId: P1, pending: 1 }, 1))
    await flushPromises()
    expect(store.trust(P1)).toBeNull()
    expect(store.pending(P1)).toBeNull()
    api.projectTrust.list.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    await expect(store.fetch(P1)).rejects.toMatchObject({ code: 'not_found' })
    expect(store.trust(P1)).toBeNull()
    // Other failures keep the cached list.
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList())
    await store.fetch(P1)
    api.projectTrust.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom.' }))
    await expect(store.fetch(P1)).rejects.toMatchObject({ code: 'internal_error' })
    expect(store.trust(P1)).not.toBeNull()
  })

  it('refreshes every loaded list after a reconnect', async () => {
    const store = useProjectTrustStore()
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList()).mockResolvedValueOnce(projectTrustList())
    await store.fetch(P1)
    await store.fetch(projectId(2))
    api.projectTrust.list.mockResolvedValueOnce(allApproved()).mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom.' }))
    await store.refreshLoaded()
    expect(api.projectTrust.list).toHaveBeenCalledTimes(4)
    expect(api.projectTrust.list.mock.calls.slice(2).map(call => call[0].params.id).sort()).toEqual([P1, projectId(2)].sort())
  })

  it('recognizes the stale conflict', () => {
    expect(isStaleTrustError(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'stale' } }))).toBe(true)
    expect(isStaleTrustError(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'exists' } }))).toBe(false)
    expect(isStaleTrustError(new HarnessError({ code: 'not_found', message: 'x' }))).toBe(false)
    expect(isStaleTrustError(new Error('x'))).toBe(false)
  })
})
