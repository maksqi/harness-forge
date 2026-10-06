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
// Phase 9 (ADR-042; C25 wires it, W9.9 owns it): `queue.changed` and `chat.deleted` go to the chat-queue store (the
// event's list replaces the chat's queue; a deleted chat's queue is dropped; a `failed` removal of a message this tab
// queued shows a toast), and a reconnect refetches the loaded queues (`chatQueue.refreshLoaded()`). `run.started` with
// `origin: 'queue'` reaches the live session of its chat through `on()` (after the chats store marked it running): the
// session reloads its path before it follows the reply when it does not show the queued message yet.
// Phase 10 (ADR-044 - ADR-046; C33 wires it, W10.10 owns it): `task.changed` and `chat.deleted` go to the
// background-tasks store (an upsert of the task in every tab; a deleted chat's list is dropped), `customization.changed`
// and `plugin.changed` to the customizations store (every cached catalog and command list is stale), and a reconnect
// refreshes the loaded lists of both stores. `run.started` with `origin: 'task'` (a turn the server started for finished
// background agents) reaches the chat's session through `on()`, like a queue-started turn.
// Phase 11 (ADR-048 - ADR-050; C39 wires it, W11.11 owns it): `hooks.changed` goes to the hooks store,
// `project-trust.changed` to the project-trust store (the pending count), the hooks store (project rows change state)
// and the project-mcp store (a loaded project is refetched), `project-mcp.changed` to the project-mcp store (the servers
// after the change); `plugin.changed` and `customization.changed` also to the hooks store (plugin hooks), and
// `project.changed` to the three stores (a deleted project is dropped); a reconnect refreshes the loaded lists of the
// three stores. `run.started` with `origin: 'hook'` (a turn the server started after a Stop hook blocked) reaches the
// chat's session through `on()`, like a task-started turn.
// Phase 12 (ADR-054; C46 wires it, complete from P12-0b, no P12-A owner): `marketplace.changed` goes to the marketplaces
// store (the summary is replaced or dropped), `plugin.changed` also to the marketplaces store (installed and update
// states), and a reconnect refreshes its loaded list and details (`marketplaces.refreshLoaded()`).
import type { ServerEvent, ServerEventOf, ServerEventType } from '@harness-forge/shared'
import type { Ref } from 'vue'
import type { EventStreamStatus } from '~/utils/event-stream'
import { serverEventSchema } from '@harness-forge/shared'
import { getCurrentScope, onScopeDispose, readonly, ref } from 'vue'
import { toast } from 'vue-sonner'
import { useAuthStore } from '~/stores/auth'
import { useBackgroundTasksStore } from '~/stores/background-tasks'
import { useChatQueueStore } from '~/stores/chat-queue'
import { useChatsStore } from '~/stores/chats'
import { useCustomizationsStore } from '~/stores/customizations'
import { useHooksStore } from '~/stores/hooks'
import { useMarketplacesStore } from '~/stores/marketplaces'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProjectMcpStore } from '~/stores/project-mcp'
import { useProjectTrustStore } from '~/stores/project-trust'
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
 * `run.finished` / `chat.deleted` -> workspace too); `key.rotated` -> the chat list reloads, toast; `queue.changed` /
 * `chat.deleted` -> chat queue (Phase 9); `task.changed` / `chat.deleted` -> background tasks, `customization.changed` /
 * `plugin.changed` -> customizations (Phase 10); `hooks.changed` -> hooks, `project-trust.changed` -> project trust + hooks +
 * project MCP, `project-mcp.changed` -> project MCP, `plugin.changed` / `customization.changed` / `project.changed` -> hooks
 * (and `project.changed` -> project trust + project MCP) (Phase 11); `marketplace.changed` / `plugin.changed` ->
 * marketplaces (Phase 12). Then leaves `/chat/<id>` when the open chat was deleted, and notifies
 * `useServerEvents().on()` subscribers (the chat sessions listed by `key.rotated` reload their path there).
 */
export function dispatchServerEvent(event: ServerEvent, options: DispatchOptions = {}): void {
  switch (event.type) {
    case 'chat.created':
    case 'chat.updated':
    case 'run.started':
      safely(() => useChatsStore().applyEvent(event))
      break
    case 'chat.deleted':
      safely(() => useChatsStore().applyEvent(event))
      safely(() => useWorkspaceStore().applyEvent(event))
      safely(() => useChatQueueStore().applyEvent(event))
      safely(() => useBackgroundTasksStore().applyEvent(event))
      break
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
      safely(() => useCustomizationsStore().applyEvent(event))
      safely(() => useHooksStore().applyEvent(event))
      safely(() => useMarketplacesStore().applyEvent(event))
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
      safely(() => useHooksStore().applyEvent(event))
      safely(() => useProjectTrustStore().applyEvent(event))
      safely(() => useProjectMcpStore().applyEvent(event))
      break
    case 'workspace.changed':
      safely(() => useWorkspaceStore().applyEvent(event))
      break
    case 'key.rotated':
      safely(applyKeyRotated)
      break
    case 'queue.changed':
      safely(() => useChatQueueStore().applyEvent(event))
      break
    case 'task.changed':
      safely(() => useBackgroundTasksStore().applyEvent(event))
      break
    case 'customization.changed':
      safely(() => useCustomizationsStore().applyEvent(event))
      safely(() => useHooksStore().applyEvent(event))
      break
    case 'hooks.changed':
      safely(() => useHooksStore().applyEvent(event))
      break
    case 'project-trust.changed':
      safely(() => useProjectTrustStore().applyEvent(event))
      safely(() => useHooksStore().applyEvent(event))
      safely(() => useProjectMcpStore().applyEvent(event))
      break
    case 'project-mcp.changed':
      safely(() => useProjectMcpStore().applyEvent(event))
      break
    case 'marketplace.changed':
      safely(() => useMarketplacesStore().applyEvent(event))
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
 * loaded entries of the changes panel (`workspace.refreshLoaded()`), the loaded chat queues
 * (`chatQueue.refreshLoaded()`, Phase 9), and the loaded background task lists and customization lists
 * (`backgroundTasks.refreshLoaded()`, `customizations.refreshLoaded()`, Phase 10), and the loaded hook listings, project
 * trust lists and project MCP lists (`hooks`, `projectTrust`, `projectMcp` `.refreshLoaded()`, Phase 11), and the
 * loaded marketplace list and details (`marketplaces.refreshLoaded()`, Phase 12).
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
  const chatQueue = useChatQueueStore()
  const backgroundTasks = useBackgroundTasksStore()
  const customizations = useCustomizationsStore()
  const hooks = useHooksStore()
  const projectTrust = useProjectTrustStore()
  const projectMcp = useProjectMcpStore()
  const marketplaces = useMarketplacesStore()
  const tasks: Array<Promise<unknown>> = [
    auth.fetchStatus(),
    settings.fetch(),
    plugins.refreshLoaded(),
    workspace.refreshLoaded(),
    chatQueue.refreshLoaded(),
    backgroundTasks.refreshLoaded(),
    customizations.refreshLoaded(),
    hooks.refreshLoaded(),
    projectTrust.refreshLoaded(),
    projectMcp.refreshLoaded(),
    marketplaces.refreshLoaded(),
  ]
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
