// Projects store (docs/UI.md 7.20, 9.10, 11; docs/API.md projects; ADR-031): the projects of the server (named folders
// that chats can belong to), the folder browser of the Add project dialog and `project.changed` events.
// Signature frozen from Gate P7-0b (C15); the implementation (optimistic rename, rollback, events) is W7.9's.
// Skeleton (C15, P7-0b): the actions call the API and keep the list as the server returns it; no optimistic updates
// and no event handling yet.
import type { ProjectBrowse, ProjectCreate, ProjectSummary, ProjectUpdate, ServerEvent } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { withHarnessErrors } from '~/utils/errors'

export const useProjectsStore = defineStore('projects', () => {
  const api = useApi()

  // ---------- state ----------

  const items = ref<ProjectSummary[]>([])
  /** The list arrived once. */
  const loaded = ref(false)
  const loading = ref(false)

  // ---------- getters ----------

  const index = computed(() => new Map(items.value.map(project => [project.id, project])))
  /** `byId(id)`: the loaded project, or undefined. */
  const byId = computed(() => (id: string): ProjectSummary | undefined => index.value.get(id))
  /** The projects sorted by name. */
  const sorted = computed<ProjectSummary[]>(() =>
    [...items.value].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1)))

  // ---------- actions ----------

  /** `GET /projects`. Throws `HarnessError`. */
  async function fetchAll(): Promise<void> {
    loading.value = true
    try {
      const list = await withHarnessErrors(api.projects.list())
      items.value = list.items
      loaded.value = true
    }
    finally {
      loading.value = false
    }
  }

  /** `POST /projects` (a fresh-auth route: the caller wraps it in `useFreshAuth().run`). */
  function create(input: ProjectCreate): Promise<ProjectSummary> {
    return withHarnessErrors(api.projects.create({ body: input }))
  }

  /** `PATCH /projects/:id` (W7.9: optimistic, rolled back on error). */
  function update(id: string, patch: ProjectUpdate): Promise<ProjectSummary> {
    return withHarnessErrors(api.projects.update({ params: { id }, body: patch }))
  }

  /** `DELETE /projects/:id`; `409 run-active` is thrown (the caller shows the toast). */
  function remove(id: string): Promise<void> {
    return withHarnessErrors(api.projects.remove({ params: { id } }))
  }

  /** `GET /projects/browse?path=`: the roots without a path, else the subfolders of `path`. */
  function browse(path?: string | null, opts: { signal?: AbortSignal } = {}): Promise<ProjectBrowse> {
    return withHarnessErrors(api.projects.browse({
      query: path ? { path } : {},
      signal: opts.signal,
    }))
  }

  /** `project.changed`: upsert, or remove for `project: null` (W7.9). */
  function applyEvent(_event: ServerEvent): void {}

  return {
    items,
    loaded,
    loading,
    byId,
    sorted,
    fetchAll,
    create,
    update,
    remove,
    browse,
    applyEvent,
  }
})
