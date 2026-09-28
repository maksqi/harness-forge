// Server events (docs/API.md 7, docs/UI.md 11): parsing, dispatch into the stores, the reconnect refetch, and a
// small subscription API for components that react to single events (e.g. W2.2 refetches a chat on
// `run.finished` unless its own session streamed it). The connection itself lives in plugins/events.client.ts.
import type { ServerEvent, ServerEventOf, ServerEventType } from '@harness-forge/shared'
import type { Ref } from 'vue'
import type { EventStreamStatus } from '~/utils/event-stream'
import { serverEventSchema } from '@harness-forge/shared'
import { getCurrentScope, onScopeDispose, readonly, ref } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { useUiStore } from '~/stores/ui'

type AnyHandler = (event: ServerEvent) => void

const status = ref<EventStreamStatus>('idle')
const handlers = new Map<ServerEventType | '*', Set<AnyHandler>>()

export interface ServerEvents {
  /** Connection state of `GET /api/events`. */
  status: Readonly<Ref<EventStreamStatus>>
  /**
   * Calls `handler` for every event of `type` (or every event with '*') after the stores applied it. Returns the
   * unsubscribe function, also called automatically when the current scope ends.
   */
  on: <T extends ServerEventType>(type: T | '*', handler: (event: ServerEventOf<T>) => void) => () => void
}

export interface DispatchOptions {
  /** Navigation for `chat.deleted` of the open chat (default: none). */
  navigate?: (path: string) => unknown
}

function subscribe<T extends ServerEventType>(type: T | '*', handler: (event: ServerEventOf<T>) => void): () => void {
  const set = handlers.get(type) ?? new Set<AnyHandler>()
  handlers.set(type, set)
  const listener = handler as AnyHandler
  set.add(listener)
  const unsubscribe = () => {
    set.delete(listener)
  }
  if (getCurrentScope())
    onScopeDispose(unsubscribe)
  return unsubscribe
}

/** Subscriptions and connection state of the server event stream. */
export function useServerEvents(): ServerEvents {
  return { status: readonly(status), on: subscribe }
}

/** Updates the connection state (called by plugins/events.client.ts). */
export function setServerEventsStatus(next: EventStreamStatus): void {
  status.value = next
}

/** Parses one SSE `data` payload; null when it is not a valid `ServerEvent`. */
export function parseServerEvent(data: string): ServerEvent | null {
  try {
    const parsed = serverEventSchema.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  }
  catch {
    return null
  }
}

/** A failing handler never stops the others (the error is still reported: it is a bug). */
function safely(run: () => void) {
  try {
    run()
  }
  catch (error) {
    console.error('[events] handler failed', error)
  }
}

/**
 * Applies one event (docs/UI.md 11): `chat.*` / `run.*` -> chats; `provider.changed` -> providers (+ models
 * refetch); `catalog.changed` -> models; `plugin.changed` -> plugins (+ providers and models refetch); `plugin.log`
 * -> plugins. Then leaves `/chat/<id>` when the open chat was deleted, and notifies `useServerEvents().on()`
 * subscribers.
 */
export function dispatchServerEvent(event: ServerEvent, options: DispatchOptions = {}): void {
  switch (event.type) {
    case 'chat.created':
    case 'chat.updated':
    case 'chat.deleted':
    case 'run.started':
    case 'run.finished':
      safely(() => useChatsStore().applyEvent(event))
      break
    case 'provider.changed':
      safely(() => useProvidersStore().applyEvent(event))
      safely(() => useModelsStore().applyEvent(event))
      break
    case 'catalog.changed':
      safely(() => useModelsStore().applyEvent(event))
      break
    case 'plugin.changed':
      safely(() => usePluginsStore().applyEvent(event))
      safely(() => useProvidersStore().applyEvent(event))
      safely(() => useModelsStore().applyEvent(event))
      break
    case 'plugin.log':
      safely(() => usePluginsStore().applyEvent(event))
      break
  }
  if (event.type === 'chat.deleted' && options.navigate && useUiStore().activeChatId === event.data.id)
    safely(() => void options.navigate?.('/'))
  for (const key of [event.type, '*'] as const) {
    for (const handler of [...(handlers.get(key) ?? [])])
      safely(() => handler(event))
  }
}

/**
 * Refetches every loaded store after the event stream reconnects (missed events are not replayed): auth status,
 * settings, and the providers / models / plugins / chats data that was loaded before.
 */
export async function refetchLoadedStores(): Promise<void> {
  const auth = useAuthStore()
  const settings = useSettingsStore()
  const providers = useProvidersStore()
  const models = useModelsStore()
  const plugins = usePluginsStore()
  const chats = useChatsStore()
  const tasks: Array<Promise<unknown>> = [auth.fetchStatus(), settings.fetch(), plugins.refreshLoaded()]
  if (providers.loaded)
    tasks.push(providers.fetchAll())
  if (models.loaded)
    tasks.push(models.fetchAll())
  if (chats.loaded)
    tasks.push(chats.fetchPage({ reset: true }))
  await Promise.allSettled(tasks)
}
