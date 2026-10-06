// Project MCP store (Phase 11, ADR-050; docs/UI.md 7.33, 11.8; docs/API.md 4.32, 5.33): the servers of each project's
// `.mcp.json` with their state and tools, and the project's variables (only whether a value is stored), as `GET
// /projects/:id/mcp` lists them; `project-mcp.changed` replaces the servers. The only reader of the project MCP routes:
// ProjectMcpDialog, ProjectTrustDialog (the variables of MCP items) and the tool rows of project servers (their names)
// read it. Saving variables needs fresh auth: `saveVariables` throws the 403 `login` for the component's
// `useFreshAuth().run(task, { required: true })` ("Saving the variables of this project's MCP servers needs your
// password."). Values are never answered, cached or logged: only `{ name, set, hint, usedBy }`.
// Signature frozen from Gate P11-0b (C39); implementation W11.9:
// - single flight per project: concurrent `fetch` calls share one request;
// - per-project versions: every fetch start, event and mutation bumps the project's version, and a fetch answer is cached
//   only when nothing came after it (it still reaches its caller);
// - `project-mcp.changed` replaces the servers of a loaded project; `project-trust.changed` (an approval changes the
//   servers' states) refetches a loaded or loading project quietly;
// - a 404 (a deleted project) drops the project; `project.changed` with `project: null` drops it too.
import type { ProjectMcpList, ProjectMcpServer, ServerEvent } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, withHarnessErrors } from '~/utils/errors'

export interface FetchProjectMcpOptions {
  /** A cached list younger than this (and not stale) is returned as is; omitted = always fetch. */
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

  // Not state: bookkeeping of the requests.
  /** Per project: bumped by every fetch start, event and mutation (an answer is cached only when nothing came after it). */
  const versions = new Map<string, number>()
  /** Per project: the fetch in flight. */
  const inFlight = new Map<string, Promise<ProjectMcpList>>()
  /** Projects an event made stale (refetched on their next use, whatever `maxAgeMs` says). */
  const stale = new Set<string>()

  // ---------- getters ----------

  /** `servers(projectId)`: the project's servers; [] until loaded. */
  const servers = computed(() => (projectId: string): readonly ProjectMcpServer[] => byProject.value[projectId]?.items ?? NO_SERVERS)
  /** `byId(projectId, serverId)`: one server, or null. */
  const byId = computed(() => (projectId: string, serverId: string): ProjectMcpServer | null =>
    byProject.value[projectId]?.items.find(server => server.id === serverId) ?? null)
  /** `variables(projectId)`: the project's variables; [] until loaded. */
  const variables = computed(() => (projectId: string): ProjectMcpList['variables'] => byProject.value[projectId]?.variables ?? NO_VARIABLES)

  // ---------- helpers ----------

  function bump(projectId: string): number {
    const next = (versions.get(projectId) ?? 0) + 1
    versions.set(projectId, next)
    return next
  }

  function store(projectId: string, list: ProjectMcpList): void {
    byProject.value = { ...byProject.value, [projectId]: list }
    loadedAt.value = { ...loadedAt.value, [projectId]: Date.now() }
    stale.delete(projectId)
  }

  function forget(projectId: string): void {
    bump(projectId)
    inFlight.delete(projectId)
    stale.delete(projectId)
    byProject.value = omit(byProject.value, projectId)
    loadedAt.value = omit(loadedAt.value, projectId)
  }

  /** One request per project at a time; the answer is cached when no event or mutation overtook it. */
  function load(projectId: string): Promise<ProjectMcpList> {
    const current = inFlight.get(projectId)
    if (current)
      return current
    const version = bump(projectId)
    const request = (async () => {
      try {
        const list = await withHarnessErrors(api.projectMcp.list({ params: { id: projectId } }))
        if (versions.get(projectId) === version)
          store(projectId, list)
        return list
      }
      catch (error) {
        if (versions.get(projectId) === version && hasErrorCode(error, 'not_found'))
          forget(projectId)
        throw error
      }
    })().finally(() => {
      if (inFlight.get(projectId) === request)
        inFlight.delete(projectId)
    })
    inFlight.set(projectId, request)
    return request
  }

  /** Marks a project stale and refetches it quietly when it is loaded or loading. */
  function refetchTracked(projectId: string): void {
    const tracked = byProject.value[projectId] !== undefined || inFlight.has(projectId)
    stale.add(projectId)
    inFlight.delete(projectId)
    if (tracked)
      void load(projectId).catch(() => {})
  }

  // ---------- actions ----------

  /**
   * `GET /projects/:id/mcp` (single flight per project). A cached list younger than `maxAgeMs` and not stale is returned
   * as is. Throws `HarnessError` (404 for an unknown project, which is dropped).
   */
  async function fetch(projectId: string, opts: FetchProjectMcpOptions = {}): Promise<ProjectMcpList> {
    const cached = byProject.value[projectId]
    const at = loadedAt.value[projectId]
    if (cached && opts.maxAgeMs !== undefined && at !== undefined && !stale.has(projectId) && Date.now() - at < opts.maxAgeMs)
      return cached
    return load(projectId)
  }

  /**
   * `PUT /projects/:id/mcp/variables { values }` (fresh auth: the 403 `login` is thrown): a value sets a variable, null
   * clears it. Returns the list after the change. Throws `HarnessError`.
   */
  async function saveVariables(projectId: string, values: Readonly<Record<string, string | null>>): Promise<ProjectMcpList> {
    const list = await withHarnessErrors(api.projectMcp.setVariables({ params: { id: projectId }, body: { values: { ...values } } }))
    bump(projectId)
    inFlight.delete(projectId)
    store(projectId, list)
    return list
  }

  /** `POST /projects/:id/mcp/:serverId/reconnect`: the server's new state replaces its row. Throws `HarnessError`. */
  async function reconnect(projectId: string, serverId: string): Promise<void> {
    const server = await withHarnessErrors(api.projectMcp.reconnect({ params: { id: projectId, serverId } }))
    const list = byProject.value[projectId]
    if (list)
      byProject.value = { ...byProject.value, [projectId]: { ...list, items: list.items.map(item => (item.id === server.id ? server : item)) } }
  }

  /**
   * `project-mcp.changed`: replaces the servers of a loaded project (an older answer in flight is not cached);
   * `project-trust.changed`: refetches a loaded or loading project; `project.changed` with `project: null`: drops the
   * project.
   */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'project-mcp.changed') {
      const { projectId, servers: items } = event.data
      const list = byProject.value[projectId]
      if (!list)
        return
      bump(projectId)
      const retry = inFlight.has(projectId)
      inFlight.delete(projectId)
      byProject.value = { ...byProject.value, [projectId]: { ...list, items } }
      // A fetch in flight was overtaken (its variables may be newer than the cached ones): ask again.
      if (retry)
        void load(projectId).catch(() => {})
    }
    else if (event.type === 'project-trust.changed') {
      refetchTracked(event.data.projectId)
    }
    else if (event.type === 'project.changed' && event.data.project === null) {
      forget(event.data.id)
    }
  }

  /** Refetches every loaded project (after the event stream reconnects: missed events are not replayed). */
  async function refreshLoaded(): Promise<void> {
    await Promise.allSettled(Object.keys(byProject.value).map((projectId) => {
      stale.add(projectId)
      inFlight.delete(projectId)
      return load(projectId)
    }))
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
