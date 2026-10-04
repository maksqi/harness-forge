import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentCustomization, commandSummary, customizationEntry, customizationId, customizationList, pluginSummary, projectId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { customizationScopeKey, useCustomizationsStore } from './customizations'

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

describe('customizations store: shape', () => {
  it('starts empty: no catalog, no entries, no commands', () => {
    const store = useCustomizationsStore()
    expect(store.catalogs).toEqual({})
    expect(store.commands).toEqual({})
    expect(store.loadedAt).toEqual({})
    expect(store.stale).toEqual({})
    expect(store.catalog(null)).toBeNull()
    expect(store.personal('agent')).toEqual([])
    expect(store.entriesOf(projectId(1), 'agent')).toEqual([])
    expect(store.slashCommands(projectId(1))).toEqual([])
    expect(customizationScopeKey(null)).toBe('')
    expect(customizationScopeKey(projectId(1))).toBe(projectId(1))
  })
})

describe('customizations store: catalog', () => {
  it('fetches a scope\'s catalog, single-flight, and serves it while it is young enough', async () => {
    const list = customizationList()
    api.customizations.list.mockResolvedValue(list)
    const store = useCustomizationsStore()
    const [a, b] = await Promise.all([store.fetchCatalog(projectId(1), { refresh: true }), store.fetchCatalog(projectId(1), { refresh: true })])
    expect(a).toEqual(list)
    expect(b).toEqual(list)
    expect(api.customizations.list).toHaveBeenCalledTimes(1)
    expect(api.customizations.list).toHaveBeenCalledWith({ query: { projectId: projectId(1), refresh: '1' } })
    expect(store.catalog(projectId(1))).toEqual(list)
    expect(store.entriesOf(projectId(1), 'agent').map(entry => entry.name)).toEqual(['explore', 'general', 'reviewer'])
    await store.fetchCatalog(projectId(1), { maxAgeMs: 10_000 })
    expect(api.customizations.list).toHaveBeenCalledTimes(1)
    await store.fetchCatalog(projectId(1))
    expect(api.customizations.list).toHaveBeenCalledTimes(2)
  })

  it('lists the personal entries of the global catalog', async () => {
    const mine = customizationEntry({ name: 'mine', source: 'user', id: customizationId(1), path: undefined })
    api.customizations.list.mockResolvedValue(customizationList({ items: [...customizationList().items, mine], project: null }))
    const store = useCustomizationsStore()
    await store.fetchCatalog(null)
    expect(api.customizations.list).toHaveBeenCalledWith({ query: {} })
    expect(store.personal('agent')).toEqual([mine])
    expect(store.personal('command')).toEqual([])
  })
})

describe('customizations store: commands', () => {
  it('fetches the commands of a scope, caches them and caches [] for a deleted project', async () => {
    api.commands.list.mockResolvedValueOnce({ items: [commandSummary()] })
    const store = useCustomizationsStore()
    await store.fetchCommands(null, { maxAgeMs: 15_000 })
    expect(api.commands.list).toHaveBeenCalledWith({ query: {} })
    expect(store.slashCommands(null)).toEqual([commandSummary()])
    await store.fetchCommands(null, { maxAgeMs: 15_000 })
    expect(api.commands.list).toHaveBeenCalledTimes(1)

    api.commands.list.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    expect(await store.fetchCommands(projectId(2))).toEqual([])
    expect(store.slashCommands(projectId(2))).toEqual([])
    api.commands.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    await expect(store.fetchCommands(projectId(3))).rejects.toMatchObject({ code: 'internal_error' })
  })

  it('marks every list stale on customization.changed and plugin.changed and refetches the loaded command lists', async () => {
    api.commands.list.mockResolvedValue({ items: [commandSummary()] })
    const store = useCustomizationsStore()
    await store.fetchCommands(projectId(1), { maxAgeMs: 15_000 })
    store.applyEvent(createServerEvent('customization.changed', { kind: 'command', id: customizationId(1) }, 1))
    expect(store.stale[`commands:${projectId(1)}`]).toBe(true)
    await vi.waitFor(() => expect(api.commands.list).toHaveBeenCalledTimes(2))
    store.applyEvent(createServerEvent('plugin.changed', { id: 'core-commands', plugin: pluginSummary() }, 2))
    await vi.waitFor(() => expect(api.commands.list).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(store.stale[`commands:${projectId(1)}`]).toBeUndefined())
    store.applyEvent(createServerEvent('catalog.changed', { providerId: null }, 3))
    await store.refreshLoaded()
    expect(api.commands.list).toHaveBeenCalledTimes(4)
  })
})

describe('customizations store: personal definitions', () => {
  it('gets, creates, updates and removes through the routes, marking every scope stale', async () => {
    api.commands.list.mockResolvedValue({ items: [] })
    const store = useCustomizationsStore()
    await store.fetchCommands(null)
    const created = agentCustomization()
    api.customizations.get.mockResolvedValue(created)
    api.customizations.create.mockResolvedValue(created)
    api.customizations.update.mockResolvedValue({ ...created, enabled: false })
    expect(await store.get(customizationId(1))).toEqual(created)
    expect(await store.create({ kind: 'agent', content: created.content })).toEqual(created)
    expect(api.customizations.create).toHaveBeenCalledWith({ body: { kind: 'agent', content: created.content } })
    expect(store.stale['commands:']).toBe(true)
    expect((await store.update(customizationId(1), { enabled: false })).enabled).toBe(false)
    expect(api.customizations.update).toHaveBeenCalledWith({ params: { id: customizationId(1) }, body: { enabled: false } })
    api.customizations.remove.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Gone.' }))
    await expect(store.remove(customizationId(1))).resolves.toBeUndefined()
    api.customizations.create.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'You already have an agent named reviewer.', details: { reason: 'exists' } }))
    await expect(store.create({ kind: 'agent', content: created.content })).rejects.toBeInstanceOf(HarnessError)
  })

  it('reads the source of an entry: personal through get, the others through /customizations/source', async () => {
    const store = useCustomizationsStore()
    api.customizations.get.mockResolvedValue(agentCustomization())
    expect(await store.sourceOf(customizationEntry({ source: 'user', id: customizationId(1), path: undefined }), null)).toBe(agentCustomization().content)
    api.customizations.source.mockResolvedValue({ content: '# reviewer', path: '.harness/agents/reviewer.md' })
    expect(await store.sourceOf(customizationEntry(), projectId(1))).toBe('# reviewer')
    expect(api.customizations.source).toHaveBeenCalledWith({
      query: { projectId: projectId(1), kind: 'agent', name: 'reviewer', source: 'project', path: '.harness/agents/reviewer.md' },
    })
  })
})
