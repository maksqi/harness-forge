// Project trust store (Phase 11, ADR-049; docs/UI.md 7.33, 11.8; docs/API.md 4.32, 5.32): the executable items of each
// project folder (hooks, `.mcp.json` servers, command files with `!` lines) and their approvals, as `GET
// /projects/:id/trust` lists them, plus the pending count of the latest `project-trust.changed` per project (the trust
// chip before a list was fetched). The only reader of the trust routes: ProjectTrustDialog, ProjectTrustChip, Settings ->
// Projects and the Customize Hooks tab read it. Approvals need fresh auth: `approve` throws the 403 `login` for the
// component's `useFreshAuth().run(task, { required: true })` ("Approving project commands needs your password.").
// Signature frozen from Gate P11-0b (C39); implementation W11.9 (single flight, per-project versions, the refetch of a
// loaded list on an event). P11-0b: plain requests; `applyEvent` records the pending count and drops deleted projects.
import type { ProjectTrustList, ServerEvent, TrustApproval } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, toHarnessError, withHarnessErrors } from '~/utils/errors'

export interface FetchProjectTrustOptions {
  /** A cached list younger than this is returned as is; omitted = always fetch. */
  maxAgeMs?: number
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record))
    return record
  const { [key]: _removed, ...rest } = record
  return rest
}

export const useProjectTrustStore = defineStore('project-trust', () => {
  const api = useApi()

  // ---------- state ----------

  /** The trust list of each project (`GET /projects/:id/trust`). */
  const byProject = ref<Record<string, ProjectTrustList>>({})
  /** When each list was cached. */
  const loadedAt = ref<Record<string, number>>({})
  /** The `pending` of the latest `project-trust.changed` per project (the chip count before a fetch). */
  const pendingByEvent = ref<Record<string, number>>({})

  // ---------- getters ----------

  /** `trust(projectId)`: the cached list, or null before its first fetch. */
  const trust = computed(() => (projectId: string): ProjectTrustList | null => byProject.value[projectId] ?? null)
  /**
   * `pending(projectId)`: the pending items of the cached list, else the count of the latest `project-trust.changed`,
   * else null (unknown); null without a project.
   */
  const pending = computed(() => (projectId: string | null): number | null => {
    if (!projectId)
      return null
    const list = byProject.value[projectId]
    if (list)
      return list.items.filter(item => item.state === 'pending').length
    return pendingByEvent.value[projectId] ?? null
  })

  // ---------- helpers ----------

  function store(projectId: string, list: ProjectTrustList): void {
    byProject.value = { ...byProject.value, [projectId]: list }
    loadedAt.value = { ...loadedAt.value, [projectId]: Date.now() }
  }

  function forget(projectId: string): void {
    byProject.value = omit(byProject.value, projectId)
    loadedAt.value = omit(loadedAt.value, projectId)
    pendingByEvent.value = omit(pendingByEvent.value, projectId)
  }

  // ---------- actions ----------

  /** `GET /projects/:id/trust` (a fresh scan of the folder). Throws `HarnessError` (404 for an unknown project). */
  async function fetch(projectId: string, opts: FetchProjectTrustOptions = {}): Promise<ProjectTrustList> {
    const cached = byProject.value[projectId]
    const at = loadedAt.value[projectId]
    if (cached && opts.maxAgeMs !== undefined && at !== undefined && Date.now() - at < opts.maxAgeMs)
      return cached
    const list = await withHarnessErrors(api.projectTrust.list({ params: { id: projectId } }))
    store(projectId, list)
    return list
  }

  /**
   * `POST /projects/:id/trust { items }` (fresh auth: the 403 `login` is thrown). A 409 `stale` (an item changed while it
   * was reviewed) refetches the list, then throws. Returns the list after the approval.
   */
  async function approve(projectId: string, items: readonly TrustApproval[]): Promise<ProjectTrustList> {
    try {
      const list = await withHarnessErrors(api.projectTrust.approve({ params: { id: projectId }, body: { items: [...items] } }))
      store(projectId, list)
      return list
    }
    catch (error) {
      const details = toHarnessError(error).details as { reason?: unknown } | undefined
      if (hasErrorCode(error, 'conflict') && details?.reason === 'stale')
        await fetch(projectId).catch(() => {})
      throw error
    }
  }

  /** `DELETE /projects/:id/trust/:sha256` (idempotent, no fresh auth). Throws `HarnessError`. */
  async function revoke(projectId: string, sha256: string): Promise<void> {
    const list = await withHarnessErrors(api.projectTrust.revoke({ params: { id: projectId, sha256 } }))
    store(projectId, list)
  }

  /**
   * `project-trust.changed`: records the pending count (W11.9 also refetches a loaded list); `project.changed` with
   * `project: null`: drops the project.
   */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'project-trust.changed')
      pendingByEvent.value = { ...pendingByEvent.value, [event.data.projectId]: event.data.pending }
    else if (event.type === 'project.changed' && event.data.project === null)
      forget(event.data.id)
  }

  /** Refetches every loaded list (after the event stream reconnects: missed events are not replayed). */
  async function refreshLoaded(): Promise<void> {
    await Promise.allSettled(Object.keys(byProject.value).map(projectId => fetch(projectId)))
  }

  return {
    byProject,
    loadedAt,
    pendingByEvent,
    trust,
    pending,
    fetch,
    approve,
    revoke,
    applyEvent,
    refreshLoaded,
  }
})
