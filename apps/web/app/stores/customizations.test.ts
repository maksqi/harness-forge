import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_MARKDOWN, agentCustomization, commandSummary, customizationEntry, customizationId, customizationList, pluginSummary, projectDefinitionFile, projectDefinitionWriteResult, projectId, trustSha } from '~/utils/testing/fixtures'
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('customizations store: ordering (W10.8)', () => {
  it('never lets an answer older than the last event or a newer fetch win', async () => {
    const store = useCustomizationsStore()
    const old = customizationList({ builtAt: 1 })
    const fresh = customizationList({ builtAt: 2 })
    const first = deferred<typeof old>()
    api.customizations.list.mockReturnValueOnce(first.promise)
    const pendingFirst = store.fetchCatalog(projectId(1))
    // A customization.changed arrives while the first fetch runs: the scope was just used, so it is refetched.
    api.customizations.list.mockResolvedValueOnce(fresh)
    store.applyEvent(createServerEvent('customization.changed', { kind: 'agent', projectId: projectId(1) }, 1))
    await vi.waitFor(() => expect(store.catalog(projectId(1))?.builtAt).toBe(2))
    first.resolve(old)
    // The caller still gets its answer; the cache keeps the newer one.
    expect((await pendingFirst).builtAt).toBe(1)
    expect(store.catalog(projectId(1))?.builtAt).toBe(2)
    expect(api.customizations.list).toHaveBeenCalledTimes(2)

    // A refresh started after a plain fetch wins even when the plain fetch answers last.
    const plain = deferred<typeof old>()
    const refreshed = deferred<typeof old>()
    api.customizations.list.mockReturnValueOnce(plain.promise).mockReturnValueOnce(refreshed.promise)
    const a = store.fetchCatalog(null)
    const b = store.fetchCatalog(null, { refresh: true })
    refreshed.resolve(customizationList({ project: null, builtAt: 4 }))
    await b
    plain.resolve(customizationList({ project: null, builtAt: 3 }))
    await a
    expect(store.catalog(null)?.builtAt).toBe(4)
  })

  it('refetches at once only the lists used in the last minute; the others wait for their next use', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const store = useCustomizationsStore()
    api.customizations.list.mockResolvedValue(customizationList())
    api.commands.list.mockResolvedValue({ items: [commandSummary()] })
    await store.fetchCatalog(projectId(1))
    await store.fetchCommands(projectId(1))
    vi.setSystemTime(Date.now() + 61_000)
    await store.fetchCommands(null)
    store.applyEvent(createServerEvent('plugin.changed', { id: 'core-commands', plugin: pluginSummary() }, 1))
    await vi.waitFor(() => expect(api.commands.list).toHaveBeenCalledTimes(3))
    expect(api.commands.list).toHaveBeenLastCalledWith({ query: {} })
    expect(api.customizations.list).toHaveBeenCalledTimes(1)
    expect(store.stale[`catalog:${projectId(1)}`]).toBe(true)
    expect(store.stale[`commands:${projectId(1)}`]).toBe(true)
    // The next use refetches a stale list even when it is young enough.
    await store.fetchCatalog(projectId(1), { maxAgeMs: 10 * 60_000 })
    expect(api.customizations.list).toHaveBeenCalledTimes(2)
    expect(store.stale[`catalog:${projectId(1)}`]).toBeUndefined()
    // Event refetches do not count as a use: a second event a minute later leaves the list alone.
    vi.setSystemTime(Date.now() + 61_000)
    store.applyEvent(createServerEvent('customization.changed', {}, 2))
    await Promise.resolve()
    expect(api.customizations.list).toHaveBeenCalledTimes(2)
  })
})

describe('customizations store: optimistic toggle and errors (W10.8)', () => {
  const mine = customizationEntry({ name: 'mine', source: 'user', id: customizationId(1), path: undefined })

  it('shows a turned-off definition at once in every cached scope and keeps it on success', async () => {
    const store = useCustomizationsStore()
    api.customizations.list.mockResolvedValueOnce(customizationList({ items: [mine], project: null }))
    api.customizations.list.mockResolvedValueOnce(customizationList({ items: [mine, customizationEntry()] }))
    await store.fetchCatalog(null)
    await store.fetchCatalog(projectId(1))
    const request = deferred<ReturnType<typeof agentCustomization>>()
    api.customizations.update.mockReturnValueOnce(request.promise)
    const done = store.update(customizationId(1), { enabled: false })
    expect(store.personal('agent')[0]).toMatchObject({ enabled: false, state: 'off' })
    expect(store.entriesOf(projectId(1), 'agent').find(entry => entry.name === 'mine')).toMatchObject({ enabled: false, state: 'off' })
    request.resolve({ ...agentCustomization(), enabled: false })
    expect((await done).enabled).toBe(false)
    expect(store.personal('agent')[0]?.state).toBe('off')
    expect(store.stale['catalog:']).toBe(true)
  })

  it('keeps the optimistic state when a fetch answers while the update runs', async () => {
    const store = useCustomizationsStore()
    api.customizations.list.mockResolvedValue(customizationList({ items: [mine], project: null }))
    await store.fetchCatalog(null)
    const request = deferred<ReturnType<typeof agentCustomization>>()
    api.customizations.update.mockReturnValueOnce(request.promise)
    const done = store.update(customizationId(1), { enabled: false })
    // The server has not applied the change yet: the refetch still says "on".
    await store.fetchCatalog(null)
    expect(store.personal('agent')[0]).toMatchObject({ enabled: false, state: 'off' })
    request.resolve({ ...agentCustomization(), enabled: false })
    await done
    expect(store.personal('agent')[0]).toMatchObject({ enabled: false, state: 'off' })
  })

  it('rolls the optimistic state back on a failure and throws the HarnessError', async () => {
    const store = useCustomizationsStore()
    api.customizations.list.mockResolvedValueOnce(customizationList({ items: [{ ...mine, enabled: false, state: 'off' }], project: null }))
    await store.fetchCatalog(null)
    api.customizations.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    const done = store.update(customizationId(1), { enabled: true })
    expect(store.personal('agent')[0]).toMatchObject({ enabled: true, state: 'active' })
    await expect(done).rejects.toMatchObject({ code: 'internal_error', message: 'Boom' })
    expect(store.personal('agent')[0]).toMatchObject({ enabled: false, state: 'off' })
  })

  it('keeps 409 exists and 400 diagnostics as typed errors for the editor', async () => {
    const store = useCustomizationsStore()
    api.customizations.create.mockRejectedValueOnce({ error: { code: 'conflict', message: 'A personal agent named "reviewer" already exists.', details: { reason: 'exists' } } })
    const conflict = await store.create({ kind: 'agent', content: AGENT_MARKDOWN }).catch((error: unknown) => error)
    expect(conflict).toBeInstanceOf(HarnessError)
    expect(conflict).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    const diagnostics = [{ level: 'error', code: 'missing-field', message: 'Line 1: Add a description.', line: 1 }]
    api.customizations.update.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'The definition has errors.', details: { issues: [], diagnostics } }))
    const invalid = await store.update(customizationId(1), { content: '---\nname: x\n---\n' }).catch((error: unknown) => error)
    expect(invalid).toMatchObject({ code: 'validation_error', details: { diagnostics } })
  })
})

describe('customizations store: project definition files (Phase 12, C46)', () => {
  it('maps a project entry to its editable file and nothing else', () => {
    const store = useCustomizationsStore()
    const project = customizationEntry({ name: 'reviewer', source: 'project', path: '.claude/agents/reviewer.md' })
    expect(store.projectSource(projectId(1), project)).toEqual({ path: '.claude/agents/reviewer.md', kind: 'agent', name: 'reviewer', create: false })
    expect(store.projectSource(null, project)).toBeNull()
    expect(store.projectSource(projectId(1), customizationEntry({ source: 'user', id: customizationId(1), path: undefined }))).toBeNull()
    expect(store.projectSource(projectId(1), customizationEntry({ source: 'project', path: 'notes/reviewer.md' }))).toBeNull()
  })

  it('reads, saves and deletes a project file and marks the project scope stale', async () => {
    const store = useCustomizationsStore()
    api.customizations.list.mockResolvedValue(customizationList())
    await store.fetchCatalog(projectId(1))
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile())
    const file = await store.readProjectFile(projectId(1), '.claude/agents/reviewer.md')
    expect(file.sha256).toBe(trustSha(1))
    expect(api.projectDefinitions.read).toHaveBeenCalledWith({ params: { id: projectId(1) }, query: { path: '.claude/agents/reviewer.md' } })

    api.projectDefinitions.write.mockResolvedValueOnce(projectDefinitionWriteResult({ path: '.claude/agents/reviewer.md', trust: { pending: 0 } }))
    const body = { path: '.claude/agents/reviewer.md', expectedSha256: trustSha(1), content: '---\nname: reviewer\ndescription: x\n---\nBody\n' }
    const saved = await store.saveProjectFile(projectId(1), body)
    expect(saved.trust.pending).toBe(0)
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({ params: { id: projectId(1) }, body })
    expect(store.stale[`catalog:${customizationScopeKey(projectId(1))}`]).toBe(true)

    api.projectDefinitions.remove.mockResolvedValueOnce(undefined)
    await store.removeProjectFile(projectId(1), '.claude/agents/reviewer.md', trustSha(2))
    expect(api.projectDefinitions.remove).toHaveBeenCalledWith({ params: { id: projectId(1) }, query: { path: '.claude/agents/reviewer.md', expectedSha256: trustSha(2) } })
  })
})
