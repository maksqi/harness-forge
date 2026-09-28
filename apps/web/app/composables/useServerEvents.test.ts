import type { ServerEvent } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProvidersStore } from '~/stores/providers'
import { useUiStore } from '~/stores/ui'
import { chatId, chatSummary, logEntry, pluginSummary, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { dispatchServerEvent, parseServerEvent, refetchLoadedStores, useServerEvents } from './useServerEvents'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  vi.useFakeTimers()
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
  })
})
