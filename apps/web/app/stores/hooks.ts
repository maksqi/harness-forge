// Hooks store (Phase 11, ADR-048; docs/UI.md 9.13, 11.8; docs/API.md 4.31, 5.31): the hook listing per scope (`GET
// /hooks?projectId=`: personal, the project's when asked, and plugin hooks, with the kill switches and the project scan)
// and the personal hook mutations. The only reader of the hook routes: the Customize Hooks tab (HooksPanel, HookEditor,
// HookImportDialog) and the plugin detail page (`list(null)`) read it. Creating a hook and changing one (unless the
// change only turns it off) need fresh auth: `create` / `update` throw the 403 `login` for the component's
// `useFreshAuth().run(task, { required: true })` ("Saving a hook needs your password."). There is no `get(id)` (no `GET
// /hooks/:id`): the editor reads the personal entry of the list.
// Signature frozen from Gate P11-0b (C39); implementation W11.8 (single flight per scope, per-scope versions, an answer
// older than the last event never wins, `{ enabled: false }` optimistic with rollback, the refetch of the scopes used in
// the last minute on an event). P11-0b: plain requests; every mutation and event marks every scope stale.
import type { HookCreate, HookEntry, HookList, HookRunList, HookUpdate, PersonalHook, ServerEvent } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, withHarnessErrors } from '~/utils/errors'

export interface FetchHooksOptions {
  /** A cached list younger than this (and not stale) is returned as is; omitted = always fetch. */
  maxAgeMs?: number
}

const NO_ENTRIES: readonly HookEntry[] = Object.freeze([])

/** The cache key of a scope: the project id, '' for none. */
export function hookScopeKey(projectId: string | null): string {
  return projectId ?? ''
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record))
    return record
  const { [key]: _removed, ...rest } = record
  return rest
}

export const useHooksStore = defineStore('hooks', () => {
  const api = useApi()

  // ---------- state ----------

  /** The hook listing of each scope (key = projectId ?? ''). */
  const lists = ref<Record<string, HookList>>({})
  /** When each scope was cached. */
  const loadedAt = ref<Record<string, number>>({})
  /** Scopes an event or a mutation made stale (refetched on their next use). */
  const stale = ref<Record<string, true>>({})

  // ---------- getters ----------

  /** `list(projectId)`: the cached listing of the scope, or null before its first fetch. */
  const list = computed(() => (projectId: string | null): HookList | null => lists.value[hookScopeKey(projectId)] ?? null)
  /** The personal entries of the global listing (`list(null)`). */
  const personal = computed<readonly HookEntry[]>(() => lists.value['']?.items.filter(entry => entry.source === 'personal') ?? NO_ENTRIES)

  // ---------- helpers ----------

  function markAllStale(): void {
    const next: Record<string, true> = { ...stale.value }
    for (const scope of Object.keys(lists.value))
      next[scope] = true
    stale.value = next
  }

  // ---------- actions ----------

  /**
   * `GET /hooks?projectId=`: the listing of the scope. A cached list younger than `maxAgeMs` and not stale is returned as
   * is; a 404 (a deleted project) drops the scope and is thrown. Throws `HarnessError`.
   */
  async function fetch(projectId: string | null, opts: FetchHooksOptions = {}): Promise<HookList> {
    const scope = hookScopeKey(projectId)
    const cached = lists.value[scope]
    const at = loadedAt.value[scope]
    if (cached && !stale.value[scope] && opts.maxAgeMs !== undefined && at !== undefined && Date.now() - at < opts.maxAgeMs)
      return cached
    try {
      const listed = await withHarnessErrors(api.hooks.list({ query: projectId === null ? {} : { projectId } }))
      lists.value = { ...lists.value, [scope]: listed }
      loadedAt.value = { ...loadedAt.value, [scope]: Date.now() }
      stale.value = omit(stale.value, scope)
      return listed
    }
    catch (error) {
      if (projectId !== null && hasErrorCode(error, 'not_found')) {
        lists.value = omit(lists.value, scope)
        loadedAt.value = omit(loadedAt.value, scope)
        stale.value = omit(stale.value, scope)
      }
      throw error
    }
  }

  /** `GET /hooks/runs`: the in-memory run log of the server (newest first). Throws `HarnessError`. */
  async function runs(): Promise<HookRunList> {
    return withHarnessErrors(api.hooks.runs())
  }

  /** `POST /hooks` (fresh auth: the 403 `login` is thrown). Marks every scope stale. Throws `HarnessError`. */
  async function create(body: HookCreate): Promise<PersonalHook> {
    const created = await withHarnessErrors(api.hooks.create({ body }))
    markAllStale()
    return created
  }

  /**
   * `PATCH /hooks/:id` (fresh auth unless the patch is exactly `{ enabled: false }`). Marks every scope stale. Throws
   * `HarnessError`.
   */
  async function update(id: string, patch: HookUpdate): Promise<PersonalHook> {
    try {
      return await withHarnessErrors(api.hooks.update({ params: { id }, body: patch }))
    }
    finally {
      markAllStale()
    }
  }

  /** `DELETE /hooks/:id`; a 404 counts as removed. Marks every scope stale. Throws `HarnessError`. */
  async function remove(id: string): Promise<void> {
    try {
      await withHarnessErrors(api.hooks.remove({ params: { id } }))
    }
    catch (error) {
      if (!hasErrorCode(error, 'not_found'))
        throw error
    }
    finally {
      markAllStale()
    }
  }

  /**
   * `hooks.changed`, `project-trust.changed`, `plugin.changed`, `customization.changed`: every cached scope is stale
   * (W11.8 also refetches the scopes used in the last minute); `project.changed` with `project: null` drops the scope.
   */
  function applyEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'hooks.changed':
      case 'project-trust.changed':
      case 'plugin.changed':
      case 'customization.changed':
        markAllStale()
        break
      case 'project.changed':
        if (event.data.project === null) {
          lists.value = omit(lists.value, event.data.id)
          loadedAt.value = omit(loadedAt.value, event.data.id)
          stale.value = omit(stale.value, event.data.id)
        }
        break
    }
  }

  /** Refetches every loaded scope (after the event stream reconnects: missed events are not replayed). */
  async function refreshLoaded(): Promise<void> {
    await Promise.allSettled(Object.keys(lists.value).map(scope => fetch(scope === '' ? null : scope)))
  }

  return {
    lists,
    loadedAt,
    stale,
    list,
    personal,
    fetch,
    runs,
    create,
    update,
    remove,
    applyEvent,
    refreshLoaded,
  }
})
