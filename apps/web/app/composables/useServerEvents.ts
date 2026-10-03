// Server events (docs/API.md 7, docs/UI.md 11): parsing, dispatch into the stores, the reconnect refetch, and a
// small subscription API for components that react to single events (e.g. W2.2 refetches a chat on
// `run.finished` unless its own session streamed it). The connection itself lives in plugins/events.client.ts.
// Phase 7: `project.changed` updates the projects and chats stores (ADR-031); `key.rotated` (ADR-034) reloads the chat
// list and shows a toast, and every chat session it lists reloads its own path (useChatSession). The server closes
// every event stream right after `key.rotated`, so the client reconnects (or lands on /login when signed out).
// Phase 8 (ADR-036 - ADR-038): `workspace.changed`, `run.finished`, `chat.deleted` and `project.changed` also go to the
// workspace store (the changes panel; it refetches the loaded entries, debounced 300 ms per chat, and drops the entries
// of deleted chats and of a deleted project's chats, so it sees `project.changed` before the chats store detaches
// them); `project.changed` to the shell rules store (a deleted project drops its rules); a reconnect refreshes the loaded
// workspace entries and the loaded shell rules.
import type { ServerEvent, ServerEventOf, ServerEventType } from '@harness-forge/shared'
import type { Ref } from 'vue'
import type { EventStreamStatus } from '~/utils/event-stream'
import { serverEventSchema } from '@harness-forge/shared'
import { getCurrentScope, onScopeDispose, readonly, ref } from 'vue'
import { toast } from 'vue-sonner'
import { useAuthStore } from '~/stores/auth'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProjectsStore } from '~/stores/projects'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { useShellRulesStore } from '~/stores/shell-rules'
import { useUiStore } from '~/stores/ui'
import { useWorkspaceStore } from '~/stores/workspace'

type AnyHandler = (event: ServerEvent) => void

/** The toast after a master-key rotation (docs/UI.md 11, 15). */
export const KEY_ROTATED_MESSAGE = 'The encryption key was rotated.'

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

/** `key.rotated`: the chat list reloads (rows of stopped runs and expired approvals change) and a toast says why. */
function applyKeyRotated(): void {
  const chats = useChatsStore()
  if (chats.loaded)
    chats.fetchPage({ reset: true }).catch(() => {})
  toast(KEY_ROTATED_MESSAGE)
}

/**
 * Applies one event (docs/UI.md 11): `chat.*` / `run.*` -> chats; `provider.changed` -> providers (+ models
 * refetch); `catalog.changed` -> models; `plugin.changed` -> plugins (+ providers and models refetch); `plugin.log`
 * -> plugins; `project.changed` -> projects + chats + workspace + shell rules; `workspace.changed` -> workspace (and
 * `run.finished` / `chat.deleted` -> workspace too); `key.rotated` -> the chat list reloads, toast. Then leaves
 * `/chat/<id>` when the open chat was deleted, and notifies `useServerEvents().on()` subscribers (the chat sessions
 * listed by `key.rotated` reload their path there).
 */
export function dispatchServerEvent(event: ServerEvent, options: DispatchOptions = {}): void {
  switch (event.type) {
    case 'chat.created':
    case 'chat.updated':
    case 'run.started':
      safely(() => useChatsStore().applyEvent(event))
      break
    case 'chat.deleted':
    case 'run.finished':
      safely(() => useChatsStore().applyEvent(event))
      safely(() => useWorkspaceStore().applyEvent(event))
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
    case 'project.changed':
      safely(() => useProjectsStore().applyEvent(event))
      // Before the chats store detaches a deleted project's chats: the workspace store finds them by their project.
      safely(() => useWorkspaceStore().applyEvent(event))
      safely(() => useChatsStore().applyEvent(event))
      safely(() => useShellRulesStore().applyEvent(event))
      break
    case 'workspace.changed':
      safely(() => useWorkspaceStore().applyEvent(event))
      break
    case 'key.rotated':
      safely(applyKeyRotated)
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
 * settings, and the providers / models / plugins / chats / projects / shell rules data that was loaded before, plus the
 * loaded entries of the changes panel (`workspace.refreshLoaded()`).
 */
export async function refetchLoadedStores(): Promise<void> {
  const auth = useAuthStore()
  const settings = useSettingsStore()
  const providers = useProvidersStore()
  const models = useModelsStore()
  const plugins = usePluginsStore()
  const chats = useChatsStore()
  const projects = useProjectsStore()
  const shellRules = useShellRulesStore()
  const workspace = useWorkspaceStore()
  const tasks: Array<Promise<unknown>> = [auth.fetchStatus(), settings.fetch(), plugins.refreshLoaded(), workspace.refreshLoaded()]
  if (providers.loaded)
    tasks.push(providers.fetchAll())
  if (models.loaded)
    tasks.push(models.fetchAll())
  if (chats.loaded)
    tasks.push(chats.fetchPage({ reset: true }))
  if (projects.loaded)
    tasks.push(projects.fetchAll())
  if (shellRules.loaded)
    tasks.push(shellRules.fetchAll())
  await Promise.allSettled(tasks)
}
