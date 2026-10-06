// The project MCP store (docs/UI.md 7.33, 11.8; W11.9-T1): the servers and variables of a project, single flight,
// per-project versions, saving variables (values only in the request), reconnect, the events (`project-mcp.changed`
// replaces the servers, `project-trust.changed` refetches a loaded project), the 404 drop and the reconnect refresh.
import type { ProjectMcpList } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { flushPromises } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectId, projectMcpList, projectMcpServer } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useProjectMcpStore } from './project-mcp'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const P1 = projectId(1)
function connected(): ProjectMcpList {
  return projectMcpList({
    items: [projectMcpServer({ state: 'connected', tools: ['mcp__memory__get'], missingVariables: [] })],
    variables: [{ name: 'MCP_TOKEN', set: true, hint: null, usedBy: ['memory'] }],
  })
}

describe('project-mcp store', () => {
  it('starts empty', () => {
    const store = useProjectMcpStore()
    expect(store.byProject).toEqual({})
    expect(store.loadedAt).toEqual({})
    expect(store.servers(P1)).toEqual([])
    expect(store.variables(P1)).toEqual([])
    expect(store.byId(P1, 'memory')).toBeNull()
  })

  it('fetches, saves variables, reconnects and applies the server events', async () => {
    const store = useProjectMcpStore()
    api.projectMcp.list.mockResolvedValueOnce(projectMcpList())
    await store.fetch(P1)
    expect(store.byId(P1, 'memory')?.state).toBe('needs-variables')
    expect(store.variables(P1).map(variable => variable.name)).toEqual(['MCP_TOKEN'])

    const saved = projectMcpList({ items: [projectMcpServer({ state: 'idle', missingVariables: [] })], variables: [{ name: 'MCP_TOKEN', set: true, hint: null, usedBy: ['memory'] }] })
    api.projectMcp.setVariables.mockResolvedValueOnce(saved)
    await store.saveVariables(P1, { MCP_TOKEN: 'secret' })
    expect(api.projectMcp.setVariables).toHaveBeenCalledWith({ params: { id: P1 }, body: { values: { MCP_TOKEN: 'secret' } } })
    expect(store.byId(P1, 'memory')?.state).toBe('idle')
    // The value never reaches the cache: only whether one is stored.
    expect(JSON.stringify(store.byProject)).not.toContain('secret')

    api.projectMcp.reconnect.mockResolvedValueOnce(projectMcpServer({ state: 'connecting', missingVariables: [] }))
    await store.reconnect(P1, 'memory')
    expect(api.projectMcp.reconnect).toHaveBeenCalledWith({ params: { id: P1, serverId: 'memory' } })
    expect(store.byId(P1, 'memory')?.state).toBe('connecting')

    store.applyEvent(createServerEvent('project-mcp.changed', { projectId: P1, servers: [projectMcpServer({ state: 'connected', tools: ['mcp__memory__get'], missingVariables: [] })] }, 1))
    expect(store.servers(P1).map(server => server.state)).toEqual(['connected'])
    expect(store.variables(P1)).toEqual(saved.variables)
    store.applyEvent(createServerEvent('project.changed', { id: P1, project: null }, 2))
    expect(store.servers(P1)).toEqual([])
  })

  it('ignores project-mcp.changed for a project it never loaded', () => {
    const store = useProjectMcpStore()
    store.applyEvent(createServerEvent('project-mcp.changed', { projectId: P1, servers: [projectMcpServer()] }, 1))
    expect(store.byProject).toEqual({})
    expect(api.projectMcp.list).not.toHaveBeenCalled()
  })

  it('shares one request between concurrent fetches and reuses a fresh list within maxAgeMs', async () => {
    const store = useProjectMcpStore()
    const answer = deferred<ProjectMcpList>()
    api.projectMcp.list.mockReturnValueOnce(answer.promise)
    const first = store.fetch(P1)
    const second = store.fetch(P1)
    answer.resolve(projectMcpList())
    await Promise.all([first, second])
    expect(api.projectMcp.list).toHaveBeenCalledTimes(1)
    await store.fetch(P1, { maxAgeMs: 60_000 })
    expect(api.projectMcp.list).toHaveBeenCalledTimes(1)
  })

  it('refetches a loaded project on project-trust.changed (an approval changes the server states)', async () => {
    const store = useProjectMcpStore()
    store.applyEvent(createServerEvent('project-trust.changed', { projectId: P1, pending: 0 }, 1))
    expect(api.projectMcp.list).not.toHaveBeenCalled()
    api.projectMcp.list.mockResolvedValueOnce(projectMcpList())
    await store.fetch(P1)
    api.projectMcp.list.mockResolvedValueOnce(connected())
    store.applyEvent(createServerEvent('project-trust.changed', { projectId: P1, pending: 0 }, 2))
    await flushPromises()
    expect(api.projectMcp.list).toHaveBeenCalledTimes(2)
    expect(store.byId(P1, 'memory')?.state).toBe('connected')
    // A failed refetch stays quiet and keeps the list.
    api.projectMcp.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom.' }))
    store.applyEvent(createServerEvent('project-trust.changed', { projectId: P1, pending: 0 }, 3))
    await flushPromises()
    expect(store.byId(P1, 'memory')?.state).toBe('connected')
  })

  it('never caches an answer that project-mcp.changed overtook, and asks again', async () => {
    const store = useProjectMcpStore()
    api.projectMcp.list.mockResolvedValueOnce(projectMcpList())
    await store.fetch(P1)
    const old = deferred<ProjectMcpList>()
    api.projectMcp.list.mockReturnValueOnce(old.promise)
    const loading = store.fetch(P1)
    api.projectMcp.list.mockResolvedValueOnce(connected())
    store.applyEvent(createServerEvent('project-mcp.changed', { projectId: P1, servers: [projectMcpServer({ state: 'connecting', missingVariables: [] })] }, 1))
    expect(store.byId(P1, 'memory')?.state).toBe('connecting')
    old.resolve(projectMcpList())
    await loading
    await flushPromises()
    expect(api.projectMcp.list).toHaveBeenCalledTimes(3)
    expect(store.byId(P1, 'memory')?.state).toBe('connected')
  })

  it('drops a project the server no longer knows (404) and refreshes the loaded ones after a reconnect', async () => {
    const store = useProjectMcpStore()
    api.projectMcp.list.mockResolvedValueOnce(projectMcpList()).mockResolvedValueOnce(projectMcpList())
    await store.fetch(P1)
    await store.fetch(projectId(2))
    api.projectMcp.list.mockResolvedValueOnce(connected()).mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    await store.refreshLoaded()
    expect(api.projectMcp.list).toHaveBeenCalledTimes(4)
    expect(Object.keys(store.byProject)).toHaveLength(1)
  })

  it('throws the 403 login of saveVariables for the caller\'s fresh auth and keeps the list', async () => {
    const store = useProjectMcpStore()
    api.projectMcp.list.mockResolvedValueOnce(projectMcpList())
    await store.fetch(P1)
    api.projectMcp.setVariables.mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Confirm your password.', action: 'login' }))
    await expect(store.saveVariables(P1, { MCP_TOKEN: null })).rejects.toMatchObject({ code: 'forbidden', action: 'login' })
    expect(store.byId(P1, 'memory')?.state).toBe('needs-variables')
  })
})
