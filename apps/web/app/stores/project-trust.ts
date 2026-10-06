// Project trust store (Phase 11, ADR-049; docs/UI.md 7.33, 11.8; docs/API.md 4.32, 5.32): the executable items of each
// project folder (hooks, `.mcp.json` servers, command files with `!` lines) and their approvals, as `GET
// /projects/:id/trust` lists them, plus the pending count of the latest `project-trust.changed` per project (the trust
// chip before a list was fetched). The only reader of the trust routes: ProjectTrustDialog, ProjectTrustChip, Settings ->
// Projects and the Customize Hooks tab read it. Approvals need fresh auth: `approve` throws the 403 `login` for the
// component's `useFreshAuth().run(task, { required: true })` ("Approving project commands needs your password.").
// Signature frozen from Gate P11-0b (C39); implementation W11.9:
// - single flight per project: concurrent `fetch` calls share one request;
// - per-project versions: every fetch start, event and mutation bumps the project's version, and a fetch answer is cached
//   only when nothing came after it (it still reaches its caller);
// - `project-trust.changed` records the event's pending count (newer than the cached list until the next answer replaces
//   it), marks the project stale and refetches it when it is loaded or loading;
// - a 404 (a deleted project) drops the project; `project.changed` with `project: null` drops it too.
import type { ProjectTrustList, ServerEvent, TrustApproval } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, toHarnessError, withHarnessErrors } from '~/utils/errors'

export interface FetchProjectTrustOptions {
  /** A cached list younger than this (and not stale) is returned as is; omitted = always fetch. */
  maxAgeMs?: number
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record))
    return record
  const { [key]: _removed, ...rest } = record
  return rest
}

/** A 409 conflict with `details.reason === 'stale'`: an item changed while it was reviewed. */
export function isStaleTrustError(error: unknown): boolean {
  if (!hasErrorCode(error, 'conflict'))
    return false
  const details = toHarnessError(error).details as { reason?: unknown } | undefined
  return details?.reason === 'stale'
}

export const useProjectTrustStore = defineStore('project-trust', () => {
  const api = useApi()

  // ---------- state ----------

  /** The trust list of each project (`GET /projects/:id/trust`). */
  const byProject = ref<Record<string, ProjectTrustList>>({})
  /** When each list was cached. */
  const loadedAt = ref<Record<string, number>>({})
  /**
   * The `pending` of the latest `project-trust.changed` per project that no list answered yet (the chip count before a
   * fetch, and between an event and its refetch).
   */
  const pendingByEvent = ref<Record<string, number>>({})

  // Not state: bookkeeping of the requests.
  /** Per project: bumped by every fetch start, event and mutation (an answer is cached only when nothing came after it). */
  const versions = new Map<string, number>()
  /** Per project: the fetch in flight. */
  const inFlight = new Map<string, Promise<ProjectTrustList>>()
  /** Projects an event made stale (refetched on their next use, whatever `maxAgeMs` says). */
  const stale = new Set<string>()

  // ---------- getters ----------

  /** `trust(projectId)`: the cached list, or null before its first fetch. */
  const trust = computed(() => (projectId: string): ProjectTrustList | null => byProject.value[projectId] ?? null)
  /**
   * `pending(projectId)`: the pending items of the cached list, else the count of the latest `project-trust.changed`,
   * else null (unknown); null without a project. An event newer than the cached list wins until the refetch answers.
   */
  const pending = computed(() => (projectId: string | null): number | null => {
    if (!projectId)
      return null
    const byEvent = pendingByEvent.value[projectId]
    if (byEvent !== undefined)
      return byEvent
    const list = byProject.value[projectId]
    if (list)
      return list.items.filter(item => item.state === 'pending').length
    return null
  })

  // ---------- helpers ----------

  function bump(projectId: string): number {
    const next = (versions.get(projectId) ?? 0) + 1
    versions.set(projectId, next)
    return next
  }

  function store(projectId: string, list: ProjectTrustList): void {
    byProject.value = { ...byProject.value, [projectId]: list }
    loadedAt.value = { ...loadedAt.value, [projectId]: Date.now() }
    pendingByEvent.value = omit(pendingByEvent.value, projectId)
    stale.delete(projectId)
  }

  function forget(projectId: string): void {
    bump(projectId)
    inFlight.delete(projectId)
    stale.delete(projectId)
    byProject.value = omit(byProject.value, projectId)
    loadedAt.value = omit(loadedAt.value, projectId)
    pendingByEvent.value = omit(pendingByEvent.value, projectId)
  }

  /** One request per project at a time; the answer is cached when no event or mutation overtook it. */
  function load(projectId: string): Promise<ProjectTrustList> {
    const current = inFlight.get(projectId)
    if (current)
      return current
    const version = bump(projectId)
    const request = (async () => {
      try {
        const list = await withHarnessErrors(api.projectTrust.list({ params: { id: projectId } }))
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

  /** A new answer that replaces the cache (approve, revoke): overtakes the fetch in flight. */
  function apply(projectId: string, list: ProjectTrustList): void {
    bump(projectId)
    inFlight.delete(projectId)
    store(projectId, list)
  }

  // ---------- actions ----------

  /**
   * `GET /projects/:id/trust` (a fresh scan of the folder; single flight per project). A cached list younger than
   * `maxAgeMs` and not stale is returned as is. Throws `HarnessError` (404 for an unknown project, which is dropped).
   */
  async function fetch(projectId: string, opts: FetchProjectTrustOptions = {}): Promise<ProjectTrustList> {
    const cached = byProject.value[projectId]
    const at = loadedAt.value[projectId]
    if (cached && opts.maxAgeMs !== undefined && at !== undefined && !stale.has(projectId) && Date.now() - at < opts.maxAgeMs)
      return cached
    return load(projectId)
  }

  /**
   * `POST /projects/:id/trust { items }` (fresh auth: the 403 `login` is thrown). A 409 `stale` (an item changed while it
   * was reviewed) refetches the list, then throws. Returns the list after the approval.
   */
  async function approve(projectId: string, items: readonly TrustApproval[]): Promise<ProjectTrustList> {
    try {
      const list = await withHarnessErrors(api.projectTrust.approve({ params: { id: projectId }, body: { items: [...items] } }))
      apply(projectId, list)
      return list
    }
    catch (error) {
      if (isStaleTrustError(error)) {
        stale.add(projectId)
        inFlight.delete(projectId)
        await load(projectId).catch(() => {})
      }
      throw error
    }
  }

  /** `DELETE /projects/:id/trust/:sha256` (idempotent, no fresh auth). Throws `HarnessError`. */
  async function revoke(projectId: string, sha256: string): Promise<void> {
    const list = await withHarnessErrors(api.projectTrust.revoke({ params: { id: projectId, sha256 } }))
    apply(projectId, list)
  }

  /**
   * `project-trust.changed`: records the pending count, marks the project stale and refetches it when it is loaded or
   * loading (quietly: a failed refetch keeps the cached list); `project.changed` with `project: null`: drops the project.
   */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'project-trust.changed') {
      const { projectId, pending: count } = event.data
      pendingByEvent.value = { ...pendingByEvent.value, [projectId]: count }
      const tracked = byProject.value[projectId] !== undefined || inFlight.has(projectId)
      bump(projectId)
      inFlight.delete(projectId)
      stale.add(projectId)
      if (tracked)
        void load(projectId).catch(() => {})
    }
    else if (event.type === 'project.changed' && event.data.project === null) {
      forget(event.data.id)
    }
  }

  /** Refetches every loaded list (after the event stream reconnects: missed events are not replayed). */
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
