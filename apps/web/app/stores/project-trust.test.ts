import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectId, projectSummary, projectTrustList, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useProjectTrustStore } from './project-trust'

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

describe('project-trust store (P11-0b shape)', () => {
  it('starts empty: unknown pending counts are null', () => {
    const store = useProjectTrustStore()
    expect(store.byProject).toEqual({})
    expect(store.loadedAt).toEqual({})
    expect(store.pendingByEvent).toEqual({})
    expect(store.trust(projectId(1))).toBeNull()
    expect(store.pending(projectId(1))).toBeNull()
    expect(store.pending(null)).toBeNull()
  })

  it('counts the pending items of a list, else the latest event', async () => {
    const store = useProjectTrustStore()
    store.applyEvent(createServerEvent('project-trust.changed', { projectId: projectId(1), pending: 4 }, 1))
    expect(store.pending(projectId(1))).toBe(4)
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList())
    await store.fetch(projectId(1))
    expect(api.projectTrust.list).toHaveBeenCalledWith({ params: { id: projectId(1) } })
    expect(store.pending(projectId(1))).toBe(2)
    store.applyEvent(createServerEvent('project.changed', { id: projectId(1), project: null }, 2))
    expect(store.trust(projectId(1))).toBeNull()
    expect(store.pending(projectId(1))).toBeNull()
    store.applyEvent(createServerEvent('project.changed', { id: projectId(2), project: projectSummary({ id: projectId(2) }) }, 3))
  })

  it('approves, refetches on a stale conflict and throws, and revokes', async () => {
    const store = useProjectTrustStore()
    const approved = projectTrustList({ items: projectTrustList().items.map(item => ({ ...item, state: 'approved' as const })) })
    api.projectTrust.approve.mockResolvedValueOnce(approved)
    await expect(store.approve(projectId(1), [{ kind: 'hook', sha256: trustSha(1) }])).resolves.toEqual(approved)
    expect(api.projectTrust.approve).toHaveBeenCalledWith({ params: { id: projectId(1) }, body: { items: [{ kind: 'hook', sha256: trustSha(1) }] } })
    expect(store.pending(projectId(1))).toBe(0)
    api.projectTrust.approve.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Changed.', details: { reason: 'stale' } }))
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList())
    await expect(store.approve(projectId(1), [{ kind: 'mcp', sha256: trustSha(3) }])).rejects.toMatchObject({ code: 'conflict' })
    expect(api.projectTrust.list).toHaveBeenCalledTimes(1)
    expect(store.pending(projectId(1))).toBe(2)
    api.projectTrust.revoke.mockResolvedValueOnce(projectTrustList({ items: [] }))
    await store.revoke(projectId(1), trustSha(4))
    expect(api.projectTrust.revoke).toHaveBeenCalledWith({ params: { id: projectId(1), sha256: trustSha(4) } })
    expect(store.trust(projectId(1))?.items).toEqual([])
  })
})
