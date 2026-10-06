import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent } from '@harness-forge/shared'
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

describe('project-mcp store (P11-0b shape)', () => {
  it('starts empty', () => {
    const store = useProjectMcpStore()
    expect(store.byProject).toEqual({})
    expect(store.loadedAt).toEqual({})
    expect(store.servers(projectId(1))).toEqual([])
    expect(store.variables(projectId(1))).toEqual([])
    expect(store.byId(projectId(1), 'memory')).toBeNull()
  })

  it('fetches, saves variables, reconnects and applies the server events', async () => {
    const store = useProjectMcpStore()
    api.projectMcp.list.mockResolvedValueOnce(projectMcpList())
    await store.fetch(projectId(1))
    expect(store.byId(projectId(1), 'memory')?.state).toBe('needs-variables')
    expect(store.variables(projectId(1)).map(variable => variable.name)).toEqual(['MCP_TOKEN'])

    const saved = projectMcpList({ items: [projectMcpServer({ state: 'idle', missingVariables: [] })], variables: [{ name: 'MCP_TOKEN', set: true, hint: null, usedBy: ['memory'] }] })
    api.projectMcp.setVariables.mockResolvedValueOnce(saved)
    await store.saveVariables(projectId(1), { MCP_TOKEN: 'secret' })
    expect(api.projectMcp.setVariables).toHaveBeenCalledWith({ params: { id: projectId(1) }, body: { values: { MCP_TOKEN: 'secret' } } })
    expect(store.byId(projectId(1), 'memory')?.state).toBe('idle')

    api.projectMcp.reconnect.mockResolvedValueOnce(projectMcpServer({ state: 'connecting', missingVariables: [] }))
    await store.reconnect(projectId(1), 'memory')
    expect(store.byId(projectId(1), 'memory')?.state).toBe('connecting')

    store.applyEvent(createServerEvent('project-mcp.changed', { projectId: projectId(1), servers: [projectMcpServer({ state: 'connected', tools: ['mcp__memory__get'], missingVariables: [] })] }, 1))
    expect(store.servers(projectId(1)).map(server => server.state)).toEqual(['connected'])
    store.applyEvent(createServerEvent('project.changed', { id: projectId(1), project: null }, 2))
    expect(store.servers(projectId(1))).toEqual([])
  })
})
