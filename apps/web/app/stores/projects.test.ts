// Projects store skeleton (docs/UI.md 11; C15, P7-0b): the frozen shape (state, getters, actions) and the API calls
// behind the actions. W7.9 adds the optimistic update, the rollback and the event handling.
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useProjectsStore } from './projects'

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

const website = projectSummary({ id: projectId(1), name: 'website' })
const api2 = projectSummary({ id: projectId(2), name: 'API server', path: '/srv/workspaces/api' })
const zeta = projectSummary({ id: projectId(3), name: 'Zeta', path: '/srv/workspaces/zeta' })

describe('projects store: shape', () => {
  it('starts empty and exposes the frozen members', () => {
    const projects = useProjectsStore()
    expect(projects.items).toEqual([])
    expect(projects.loaded).toBe(false)
    expect(projects.loading).toBe(false)
    expect(projects.sorted).toEqual([])
    expect(projects.byId(projectId(1))).toBeUndefined()
    for (const action of ['fetchAll', 'create', 'update', 'remove', 'browse', 'applyEvent'] as const)
      expect(typeof projects[action]).toBe('function')
  })
})

describe('projects store: list', () => {
  it('loads the projects (GET /projects), looks them up by id and sorts them by name', async () => {
    api.projects.list.mockResolvedValueOnce({ items: [zeta, website, api2] })
    const projects = useProjectsStore()
    const request = projects.fetchAll()
    expect(projects.loading).toBe(true)
    await request
    expect(api.projects.list).toHaveBeenCalledTimes(1)
    expect(projects.loading).toBe(false)
    expect(projects.loaded).toBe(true)
    expect(projects.items).toEqual([zeta, website, api2])
    expect(projects.byId(projectId(2))).toEqual(api2)
    expect(projects.sorted.map(project => project.name)).toEqual(['API server', 'website', 'Zeta'])
  })

  it('throws a HarnessError when the list fails and stays unloaded', async () => {
    const projects = useProjectsStore()
    await expect(projects.fetchAll()).rejects.toBeInstanceOf(HarnessError)
    expect(projects.loaded).toBe(false)
    expect(projects.loading).toBe(false)
  })
})

describe('projects store: actions', () => {
  it('creates, updates and removes through the API', async () => {
    const projects = useProjectsStore()
    api.projects.create.mockResolvedValueOnce(website)
    await expect(projects.create({ name: 'website', path: '/srv/workspaces', newFolder: 'website' })).resolves.toEqual(website)
    expect(api.projects.create).toHaveBeenCalledWith({ body: { name: 'website', path: '/srv/workspaces', newFolder: 'website' } })

    const renamed = { ...website, name: 'Site' }
    api.projects.update.mockResolvedValueOnce(renamed)
    await expect(projects.update(website.id, { name: 'Site' })).resolves.toEqual(renamed)
    expect(api.projects.update).toHaveBeenCalledWith({ params: { id: website.id }, body: { name: 'Site' } })

    api.projects.remove.mockResolvedValueOnce(undefined)
    await expect(projects.remove(website.id)).resolves.toBeUndefined()
    expect(api.projects.remove).toHaveBeenCalledWith({ params: { id: website.id } })
  })

  it('browses the roots without a path and a folder with one, passing the abort signal', async () => {
    const projects = useProjectsStore()
    const roots = { path: null, parent: null, roots: [{ path: '/srv/workspaces', available: true }], entries: [], truncated: false }
    api.projects.browse.mockResolvedValue(roots)
    const controller = new AbortController()
    await expect(projects.browse()).resolves.toEqual(roots)
    expect(api.projects.browse).toHaveBeenLastCalledWith({ query: {}, signal: undefined })
    await projects.browse(null)
    expect(api.projects.browse).toHaveBeenLastCalledWith({ query: {}, signal: undefined })
    await projects.browse('/srv/workspaces', { signal: controller.signal })
    expect(api.projects.browse).toHaveBeenLastCalledWith({ query: { path: '/srv/workspaces' }, signal: controller.signal })
  })

  it('surfaces the server errors (the skeleton server answers 501)', async () => {
    const projects = useProjectsStore()
    api.projects.remove.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Busy.', details: { reason: 'run-active' } }))
    await expect(projects.remove(website.id)).rejects.toMatchObject({ code: 'conflict' })
    await expect(projects.browse('/srv')).rejects.toMatchObject({ code: 'not_implemented' })
  })

  it('accepts server events', () => {
    const projects = useProjectsStore()
    expect(() => projects.applyEvent({ type: 'project.changed', data: { id: website.id, project: website }, at: 1_759_000_000_000 })).not.toThrow()
  })
})
