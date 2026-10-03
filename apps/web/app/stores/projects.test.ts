// Projects store (docs/UI.md 11; W7.9-T1): list, create, optimistic update with rollback, remove, browse and the
// `project.changed` events.
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useProjectsStore } from './projects'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

const website = projectSummary({ id: projectId(1), name: 'website' })
const api2 = projectSummary({ id: projectId(2), name: 'API', path: '/srv/workspaces/api', chatCount: 3 })
const notes = projectSummary({ id: projectId(3), name: 'Notes', path: '/srv/workspaces/notes', available: false, issue: 'The folder does not exist.' })

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

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
  it('loads the projects, sorts them by name (case-insensitive) and finds them by id', async () => {
    api.projects.list.mockResolvedValueOnce({ items: [website, api2, notes] })
    const projects = useProjectsStore()
    expect(projects.loaded).toBe(false)
    const loading = projects.fetchAll()
    expect(projects.loading).toBe(true)
    await loading
    expect(projects.loading).toBe(false)
    expect(projects.loaded).toBe(true)
    expect(projects.sorted.map(project => project.name)).toEqual(['API', 'Notes', 'website'])
    expect(projects.byId(projectId(3))).toEqual(notes)
    expect(projects.byId(projectId(9))).toBeUndefined()
  })

  it('keeps the newest answer when two loads overlap, and stays unloaded after a failure', async () => {
    const projects = useProjectsStore()
    let resolveSlow: (value: unknown) => void = () => {}
    api.projects.list
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveSlow = resolve
      }))
      .mockResolvedValueOnce({ items: [website] })
    const slow = projects.fetchAll()
    await projects.fetchAll()
    resolveSlow({ items: [website, api2] })
    await slow
    expect(projects.items).toEqual([website])

    disposePinia(pinia)
    pinia = createPinia()
    setActivePinia(pinia)
    const fresh = useProjectsStore()
    api.projects.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom.' }))
    await expect(fresh.fetchAll()).rejects.toMatchObject({ code: 'internal_error' })
    expect(fresh.loaded).toBe(false)
    expect(fresh.loading).toBe(false)
  })
})

describe('projects store: changes', () => {
  it('creates a project and adds it to the list', async () => {
    const projects = useProjectsStore()
    projects.items = [website]
    api.projects.create.mockResolvedValueOnce(api2)
    const created = await projects.create({ name: 'API', path: '/srv/workspaces', newFolder: 'api' })
    expect(api.projects.create).toHaveBeenCalledWith({ body: { name: 'API', path: '/srv/workspaces', newFolder: 'api' } })
    expect(created).toEqual(api2)
    expect(projects.sorted.map(project => project.id)).toEqual([projectId(2), projectId(1)])

    api.projects.create.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A project for this folder already exists.', details: { reason: 'exists' } }))
    await expect(projects.create({ name: 'Again', path: '/srv/workspaces/api' })).rejects.toMatchObject({ code: 'conflict' })
    expect(projects.items).toHaveLength(2)
  })

  it('renames optimistically and rolls back when the request fails', async () => {
    const projects = useProjectsStore()
    projects.items = [website, api2]
    let reject: (error: unknown) => void = () => {}
    api.projects.update.mockReturnValueOnce(new Promise((_resolve, fail) => {
      reject = fail
    }))
    const renaming = projects.update(projectId(1), { name: '  Site  ' })
    expect(projects.byId(projectId(1))?.name).toBe('Site')
    expect(api.projects.update).toHaveBeenCalledWith({ params: { id: projectId(1) }, body: { name: '  Site  ' } })
    reject(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    await expect(renaming).rejects.toMatchObject({ code: 'not_found' })
    expect(projects.byId(projectId(1))?.name).toBe('website')

    api.projects.update.mockResolvedValueOnce({ ...website, instructions: 'Use pnpm.', updatedAt: 2 })
    const saved = await projects.update(projectId(1), { instructions: 'Use pnpm.' })
    expect(saved.instructions).toBe('Use pnpm.')
    expect(projects.byId(projectId(1))).toEqual({ ...website, instructions: 'Use pnpm.', updatedAt: 2 })
  })

  it('removes a project once the server deleted it; an unknown project counts as deleted', async () => {
    const projects = useProjectsStore()
    projects.items = [website, api2]
    api.projects.remove.mockResolvedValueOnce(undefined)
    await projects.remove(projectId(1))
    expect(api.projects.remove).toHaveBeenCalledWith({ params: { id: projectId(1) } })
    expect(projects.items).toEqual([api2])

    api.projects.remove.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A response is running.', details: { reason: 'run-active', chatId: 'c' } }))
    await expect(projects.remove(projectId(2))).rejects.toMatchObject({ code: 'conflict' })
    expect(projects.items).toEqual([api2])

    api.projects.remove.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    await projects.remove(projectId(2))
    expect(projects.items).toEqual([])
  })

  it('browses the roots without a path and a folder with one, passing the abort signal', async () => {
    const projects = useProjectsStore()
    const answer = { path: null, parent: null, roots: [{ path: '/srv/workspaces', available: true }], entries: [], truncated: false }
    api.projects.browse.mockResolvedValue(answer)
    const controller = new AbortController()
    expect(await projects.browse(null, { signal: controller.signal })).toEqual(answer)
    expect(api.projects.browse).toHaveBeenLastCalledWith({ query: {}, signal: controller.signal })
    await projects.browse('/srv/workspaces')
    expect(api.projects.browse).toHaveBeenLastCalledWith({ query: { path: '/srv/workspaces' }, signal: undefined })

    api.projects.browse.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'Choose a folder inside the workspace folders.' }))
    await expect(projects.browse('/etc')).rejects.toBeInstanceOf(HarnessError)
  })
})

describe('projects store: events', () => {
  it('upserts a changed project and removes a deleted one', () => {
    const projects = useProjectsStore()
    projects.items = [website]
    projects.applyEvent(createServerEvent('project.changed', { id: projectId(2), project: api2 }))
    expect(projects.sorted.map(project => project.id)).toEqual([projectId(2), projectId(1)])
    projects.applyEvent(createServerEvent('project.changed', { id: projectId(1), project: { ...website, name: 'Site' } }))
    expect(projects.byId(projectId(1))?.name).toBe('Site')
    projects.applyEvent(createServerEvent('project.changed', { id: projectId(2), project: null }))
    expect(projects.items.map(project => project.id)).toEqual([projectId(1)])
    // Deleting an unknown project and other events change nothing.
    projects.applyEvent(createServerEvent('project.changed', { id: projectId(9), project: null }))
    projects.applyEvent(createServerEvent('chat.deleted', { id: '0199a0b0-0000-7000-8000-000000000001' }))
    expect(projects.items).toHaveLength(1)
  })
})
