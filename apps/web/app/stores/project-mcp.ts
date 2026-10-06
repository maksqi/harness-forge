// Project MCP store (Phase 11, ADR-050; docs/UI.md 7.33, 11.8; docs/API.md 4.32, 5.33): the servers of each project's
// `.mcp.json` with their state and tools, and the project's variables (only whether a value is stored), as `GET
// /projects/:id/mcp` lists them; `project-mcp.changed` replaces the servers. The only reader of the project MCP routes:
// ProjectMcpDialog and the tool rows of project servers (their names) read it. Saving variables needs fresh auth:
// `saveVariables` throws the 403 `login` for the component's `useFreshAuth().run(task, { required: true })` ("Saving the
// variables of this project's MCP servers needs your password.").
// Signature frozen from Gate P11-0b (C39); implementation W11.9 (single flight, per-project versions, the refetch of a
// loaded project on `project-trust.changed`). P11-0b: plain requests; `applyEvent` replaces the servers of a loaded
// project and drops deleted projects.
import type { ProjectMcpList, ProjectMcpServer, ServerEvent } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { withHarnessErrors } from '~/utils/errors'

export interface FetchProjectMcpOptions {
  /** A cached list younger than this is returned as is; omitted = always fetch. */
  maxAgeMs?: number
}

const NO_SERVERS: readonly ProjectMcpServer[] = Object.freeze([])
const NO_VARIABLES: ProjectMcpList['variables'] = Object.freeze([]) as unknown as ProjectMcpList['variables']

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record))
    return record
  const { [key]: _removed, ...rest } = record
  return rest
}

export const useProjectMcpStore = defineStore('project-mcp', () => {
  const api = useApi()

  // ---------- state ----------

  /** The `.mcp.json` servers and variables of each project (`GET /projects/:id/mcp`). */
  const byProject = ref<Record<string, ProjectMcpList>>({})
  /** When each list was cached. */
  const loadedAt = ref<Record<string, number>>({})

  // ---------- getters ----------

  /** `servers(projectId)`: the project's servers; [] until loaded. */
  const servers = computed(() => (projectId: string): readonly ProjectMcpServer[] => byProject.value[projectId]?.items ?? NO_SERVERS)
  /** `byId(projectId, serverId)`: one server, or null. */
  const byId = computed(() => (projectId: string, serverId: string): ProjectMcpServer | null =>
    byProject.value[projectId]?.items.find(server => server.id === serverId) ?? null)
  /** `variables(projectId)`: the project's variables; [] until loaded. */
  const variables = computed(() => (projectId: string): ProjectMcpList['variables'] => byProject.value[projectId]?.variables ?? NO_VARIABLES)

  // ---------- helpers ----------

  function store(projectId: string, list: ProjectMcpList): void {
    byProject.value = { ...byProject.value, [projectId]: list }
    loadedAt.value = { ...loadedAt.value, [projectId]: Date.now() }
  }

  // ---------- actions ----------

  /** `GET /projects/:id/mcp`. Throws `HarnessError` (404 for an unknown project). */
  async function fetch(projectId: string, opts: FetchProjectMcpOptions = {}): Promise<ProjectMcpList> {
    const cached = byProject.value[projectId]
    const at = loadedAt.value[projectId]
    if (cached && opts.maxAgeMs !== undefined && at !== undefined && Date.now() - at < opts.maxAgeMs)
      return cached
    const list = await withHarnessErrors(api.projectMcp.list({ params: { id: projectId } }))
    store(projectId, list)
    return list
  }

  /**
   * `PUT /projects/:id/mcp/variables { values }` (fresh auth: the 403 `login` is thrown): a value sets a variable, null
   * clears it. Returns the list after the change. Throws `HarnessError`.
   */
  async function saveVariables(projectId: string, values: Readonly<Record<string, string | null>>): Promise<ProjectMcpList> {
    const list = await withHarnessErrors(api.projectMcp.setVariables({ params: { id: projectId }, body: { values: { ...values } } }))
    store(projectId, list)
    return list
  }

  /** `POST /projects/:id/mcp/:serverId/reconnect`: the server's new state replaces its row. Throws `HarnessError`. */
  async function reconnect(projectId: string, serverId: string): Promise<void> {
    const server = await withHarnessErrors(api.projectMcp.reconnect({ params: { id: projectId, serverId } }))
    const list = byProject.value[projectId]
    if (list)
      store(projectId, { ...list, items: list.items.map(item => (item.id === server.id ? server : item)) })
  }

  /**
   * `project-mcp.changed`: replaces the servers of a loaded project (W11.9 also refetches a loaded project on
   * `project-trust.changed`); `project.changed` with `project: null`: drops the project.
   */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'project-mcp.changed') {
      const list = byProject.value[event.data.projectId]
      if (list)
        byProject.value = { ...byProject.value, [event.data.projectId]: { ...list, items: event.data.servers } }
    }
    else if (event.type === 'project.changed' && event.data.project === null) {
      byProject.value = omit(byProject.value, event.data.id)
      loadedAt.value = omit(loadedAt.value, event.data.id)
    }
  }

  /** Refetches every loaded project (after the event stream reconnects: missed events are not replayed). */
  async function refreshLoaded(): Promise<void> {
    await Promise.allSettled(Object.keys(byProject.value).map(projectId => fetch(projectId)))
  }

  return {
    byProject,
    loadedAt,
    servers,
    byId,
    variables,
    fetch,
    saveVariables,
    reconnect,
    applyEvent,
    refreshLoaded,
  }
})
