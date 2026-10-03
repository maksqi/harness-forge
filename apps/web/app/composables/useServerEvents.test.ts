import type { ServerEvent } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProjectsStore } from '~/stores/projects'
import { useProvidersStore } from '~/stores/providers'
import { useShellRulesStore } from '~/stores/shell-rules'
import { useUiStore } from '~/stores/ui'
import { useWorkspaceStore } from '~/stores/workspace'
import { chatId, chatSummary, logEntry, pluginSummary, projectId, projectSummary, providerSummary, workspaceChangedData } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { dispatchServerEvent, KEY_ROTATED_MESSAGE, parseServerEvent, refetchLoadedStores, useServerEvents } from './useServerEvents'

const mock = vi.hoisted(() => ({ api: null as unknown, toast: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('vue-sonner', () => ({ toast: Object.assign((...args: unknown[]) => mock.toast(...args), { error: vi.fn(), success: vi.fn() }) }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  vi.useFakeTimers()
  mock.toast.mockReset()
  api = createMockApi()
  mock.api = api
  stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('parseServerEvent', () => {
  it('accepts valid events and rejects anything else', () => {
    const event = createServerEvent('catalog.changed', { providerId: null }, 1)
    expect(parseServerEvent(JSON.stringify(event))).toEqual(event)
    expect(parseServerEvent('not json')).toBeNull()
    expect(parseServerEvent(JSON.stringify({ type: 'chat.updated', data: {}, at: 1 }))).toBeNull()
    expect(parseServerEvent(JSON.stringify({ type: 'unknown.event', data: {}, at: 1 }))).toBeNull()
  })
})

describe('dispatchServerEvent', () => {
  it('routes chat and run events to the chats store', async () => {
    api.chats.list.mockResolvedValue({ items: [], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()
    dispatchServerEvent(createServerEvent('chat.created', chatSummary({ id: chatId(1) }), 1))
    dispatchServerEvent(createServerEvent('run.started', { chatId: chatId(1), messageId: 'msg_aaaaaaaaaaaaaaaa', modelRef: 'mock:echo' }, 2))
    expect(chats.byId(chatId(1))).toBeDefined()
    expect(chats.statusOf(chatId(1))).toBe('running')
    dispatchServerEvent(createServerEvent('run.finished', { chatId: chatId(1), messageId: 'msg_aaaaaaaaaaaaaaaa', outcome: 'completed', awaitingApproval: true }, 3))
    expect(chats.statusOf(chatId(1))).toBe('approval')
  })

  it('patches providers and refetches loaded models on provider.changed', async () => {
    api.providers.list.mockResolvedValue({ items: [providerSummary()] })
    api.models.list.mockResolvedValue({ items: [] })
    const providers = useProvidersStore()
    const models = useModelsStore()
    await Promise.all([providers.fetchAll(), models.fetchAll()])
    dispatchServerEvent(createServerEvent('provider.changed', { id: 'anthropic', provider: providerSummary({ status: 'error' }) }, 1))
    expect(providers.byId('anthropic')?.status).toBe('error')
    await vi.advanceTimersByTimeAsync(500)
    expect(api.models.list).toHaveBeenCalledTimes(2)
  })

  it('refetches models on catalog.changed', async () => {
    api.models.list.mockResolvedValue({ items: [] })
    await useModelsStore().fetchAll()
    dispatchServerEvent(createServerEvent('catalog.changed', { providerId: 'anthropic' }, 1))
    await vi.advanceTimersByTimeAsync(500)
    expect(api.models.list).toHaveBeenCalledTimes(2)
  })

  it('updates plugins and refetches providers and models on plugin.changed', async () => {
    api.plugins.list.mockResolvedValue({ items: [pluginSummary()] })
    api.providers.list.mockResolvedValue({ items: [] })
    api.models.list.mockResolvedValue({ items: [] })
    const plugins = usePluginsStore()
    await Promise.all([plugins.fetchAll(), useProvidersStore().fetchAll(), useModelsStore().fetchAll()])
    dispatchServerEvent(createServerEvent('plugin.changed', { id: 'dice-roller', plugin: pluginSummary({ state: 'error' }) }, 1))
    expect(plugins.byId('dice-roller')?.state).toBe('error')
    await vi.advanceTimersByTimeAsync(500)
    expect(api.providers.list).toHaveBeenCalledTimes(2)
    expect(api.models.list).toHaveBeenCalledTimes(2)
  })

  it('appends plugin.log entries to fetched logs', async () => {
    api.plugins.logs.mockResolvedValue({ items: [] })
    const plugins = usePluginsStore()
    await plugins.fetchLogs('dice-roller')
    dispatchServerEvent(createServerEvent('plugin.log', { pluginId: 'dice-roller', entry: logEntry(1) }, 1))
    expect(plugins.logs['dice-roller']).toHaveLength(1)
  })

  it('routes project.changed to the projects and chats stores', () => {
    const projects = useProjectsStore()
    const chats = useChatsStore()
    const projectEvents = vi.spyOn(projects, 'applyEvent')
    const chatEvents = vi.spyOn(chats, 'applyEvent')
    const changed = createServerEvent('project.changed', { id: projectId(1), project: projectSummary({ id: projectId(1) }) }, 1)
    dispatchServerEvent(changed)
    const deleted = createServerEvent('project.changed', { id: projectId(1), project: null }, 2)
    dispatchServerEvent(deleted)
    expect(projectEvents.mock.calls).toEqual([[changed], [deleted]])
    expect(chatEvents.mock.calls).toEqual([[changed], [deleted]])
  })

  it('routes the Phase 8 events to the workspace and shell rules stores', () => {
    const workspace = useWorkspaceStore()
    const shellRules = useShellRulesStore()
    const chats = useChatsStore()
    const workspaceEvents = vi.spyOn(workspace, 'applyEvent')
    const ruleEvents = vi.spyOn(shellRules, 'applyEvent')
    const chatEvents = vi.spyOn(chats, 'applyEvent').mockImplementation(() => {})
    const changed = createServerEvent('workspace.changed', workspaceChangedData(), 1)
    const finished = createServerEvent('run.finished', { chatId: chatId(1), messageId: 'msg_asst000000000001', outcome: 'completed', awaitingApproval: false }, 2)
    const deletedChat = createServerEvent('chat.deleted', { id: chatId(1) }, 3)
    const deletedProject = createServerEvent('project.changed', { id: projectId(1), project: null }, 4)
    const started = createServerEvent('run.started', { chatId: chatId(1), messageId: 'msg_asst000000000001', modelRef: 'mock:echo' }, 5)
    for (const event of [changed, finished, deletedChat, deletedProject, started])
      dispatchServerEvent(event)
    expect(workspaceEvents.mock.calls).toEqual([[changed], [finished], [deletedChat], [deletedProject]])
    expect(ruleEvents.mock.calls).toEqual([[deletedProject]])
    expect(chatEvents.mock.calls).toEqual([[finished], [deletedChat], [deletedProject], [started]])
  })

  it('reloads the loaded chat list and shows a toast on key.rotated', async () => {
    api.chats.list.mockResolvedValue({ items: [chatSummary({ id: chatId(1) })], nextCursor: null })
    const chats = useChatsStore()
    const seen: string[] = []
    const scope = effectScope()
    scope.run(() => useServerEvents().on('key.rotated', event => seen.push(...event.data.chatIds)))

    // Nothing loaded yet: no list request, the toast still shows.
    dispatchServerEvent(createServerEvent('key.rotated', { keyVersion: 2, rotatedAt: 1, chatIds: [] }, 1))
    expect(api.chats.list).not.toHaveBeenCalled()
    expect(mock.toast).toHaveBeenCalledWith(KEY_ROTATED_MESSAGE)
    expect(KEY_ROTATED_MESSAGE).toBe('The encryption key was rotated.')

    await chats.fetchPage()
    dispatchServerEvent(createServerEvent('key.rotated', { keyVersion: 3, rotatedAt: 2, chatIds: [chatId(1)] }, 2))
    await vi.advanceTimersByTimeAsync(0)
    expect(api.chats.list).toHaveBeenCalledTimes(2)
    expect(api.chats.list).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.not.objectContaining({ cursor: expect.anything() }) }))
    expect(mock.toast).toHaveBeenCalledTimes(2)
    // The chat sessions it lists subscribe themselves (useChatSession reloads their path).
    expect(seen).toEqual([chatId(1)])
    scope.stop()
  })

  it('a failed list reload after key.rotated is not an unhandled error', async () => {
    api.chats.list.mockResolvedValueOnce({ items: [], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()
    api.chats.list.mockRejectedValueOnce(new Error('offline'))
    dispatchServerEvent(createServerEvent('key.rotated', { keyVersion: 2, rotatedAt: 1, chatIds: [] }, 1))
    await vi.advanceTimersByTimeAsync(0)
    expect(api.chats.list).toHaveBeenCalledTimes(2)
  })

  it('leaves the open chat when it is deleted elsewhere', () => {
    const navigate = vi.fn()
    useUiStore().setActiveChat(chatId(1))
    dispatchServerEvent(createServerEvent('chat.deleted', { id: chatId(2) }, 1), { navigate })
    expect(navigate).not.toHaveBeenCalled()
    dispatchServerEvent(createServerEvent('chat.deleted', { id: chatId(1) }, 2), { navigate })
    expect(navigate).toHaveBeenCalledWith('/')
  })

  it('notifies subscribers after the stores and keeps going when one handler throws', () => {
    const seen: string[] = []
    const scope = effectScope()
    const events = useServerEvents()
    scope.run(() => {
      events.on('run.finished', (event) => {
        seen.push(`finished:${event.data.outcome}`)
        expect(useChatsStore().statusOf(event.data.chatId)).toBe('unread')
      })
      events.on('*', () => {
        throw new Error('broken subscriber')
      })
      events.on('*', (event: ServerEvent) => seen.push(`any:${event.type}`))
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    dispatchServerEvent(createServerEvent('run.finished', { chatId: chatId(4), messageId: 'msg_aaaaaaaaaaaaaaaa', outcome: 'failed', awaitingApproval: false }, 1))
    expect(seen).toEqual(['finished:failed', 'any:run.finished'])
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()

    scope.stop()
    dispatchServerEvent(createServerEvent('catalog.changed', { providerId: null }, 2))
    expect(seen).toHaveLength(2)
  })
})

describe('refetchLoadedStores', () => {
  it('reloads auth and settings, and only the other stores that were loaded', async () => {
    api.providers.list.mockResolvedValue({ items: [] })
    api.chats.list.mockResolvedValue({ items: [], nextCursor: null })
    await useProvidersStore().fetchAll()
    await useChatsStore().fetchPage()
    await refetchLoadedStores()
    expect(api.auth.status).toHaveBeenCalledTimes(1)
    expect(api.settings.get).toHaveBeenCalledTimes(1)
    expect(api.providers.list).toHaveBeenCalledTimes(2)
    expect(api.chats.list).toHaveBeenCalledTimes(2)
    expect(api.models.list).not.toHaveBeenCalled()
    expect(api.plugins.list).not.toHaveBeenCalled()
    expect(api.projects.list).not.toHaveBeenCalled()
  })

  it('reloads the projects once they were loaded', async () => {
    api.projects.list.mockResolvedValue({ items: [projectSummary()] })
    await useProjectsStore().fetchAll()
    await refetchLoadedStores()
    expect(api.projects.list).toHaveBeenCalledTimes(2)
  })

  it('refreshes the loaded workspace entries and the shell rules once they were loaded (Phase 8)', async () => {
    const workspace = useWorkspaceStore()
    const shellRules = useShellRulesStore()
    const refresh = vi.spyOn(workspace, 'refreshLoaded')
    const fetchRules = vi.spyOn(shellRules, 'fetchAll')
    await refetchLoadedStores()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchRules).not.toHaveBeenCalled()
    shellRules.loaded = true
    await refetchLoadedStores()
    expect(fetchRules).toHaveBeenCalledTimes(1)
  })
})
