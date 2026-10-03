// Projects store (docs/UI.md 7.20, 9.10, 11; docs/API.md projects; ADR-031): the projects of the server (named folders
// that chats can belong to), the folder browser of the Add project dialog and `project.changed` events.
// Signature frozen from Gate P7-0b (C15); implementation W7.9: `create` adds the new project to the list, `update` applies
// at once and rolls back when the request fails, `remove` drops the row once the server deleted it (an unknown project
// counts as deleted), `applyEvent` upserts or removes, and a slower `fetchAll` never overwrites a newer one.
import type { ProjectBrowse, ProjectCreate, ProjectSummary, ProjectUpdate, ServerEvent } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, withHarnessErrors } from '~/utils/errors'

/** Sort order of projects: by name (case and accent insensitive), then by id. */
function compareProjects(a: ProjectSummary, b: ProjectSummary): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

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
  const sorted = computed<ProjectSummary[]>(() => [...items.value].sort(compareProjects))

  // ---------- helpers ----------

  let fetchSeq = 0

  function upsert(project: ProjectSummary): void {
    items.value = index.value.has(project.id)
      ? items.value.map(item => (item.id === project.id ? project : item))
      : [...items.value, project]
  }

  function drop(id: string): void {
    if (index.value.has(id))
      items.value = items.value.filter(item => item.id !== id)
  }

  // ---------- actions ----------

  /** `GET /projects`. Throws `HarnessError`; the answer of an older call never replaces a newer one. */
  async function fetchAll(): Promise<void> {
    const seq = ++fetchSeq
    loading.value = true
    try {
      const list = await withHarnessErrors(api.projects.list())
      if (seq !== fetchSeq)
        return
      items.value = list.items
      loaded.value = true
    }
    finally {
      if (seq === fetchSeq)
        loading.value = false
    }
  }

  /** `POST /projects` (a fresh-auth route: the caller wraps it in `useFreshAuth().run`); the project joins the list. */
  async function create(input: ProjectCreate): Promise<ProjectSummary> {
    const project = await withHarnessErrors(api.projects.create({ body: input }))
    upsert(project)
    return project
  }

  /** `PATCH /projects/:id`: applied at once, rolled back when the request fails. Throws `HarnessError`. */
  async function update(id: string, patch: ProjectUpdate): Promise<ProjectSummary> {
    const previous = index.value.get(id)
    if (previous) {
      const optimistic: ProjectSummary = { ...previous }
      if (patch.name !== undefined)
        optimistic.name = patch.name.trim()
      if (patch.instructions !== undefined)
        optimistic.instructions = patch.instructions === '' ? null : patch.instructions
      upsert(optimistic)
    }
    try {
      const project = await withHarnessErrors(api.projects.update({ params: { id }, body: patch }))
      upsert(project)
      return project
    }
    catch (error) {
      if (previous && index.value.has(id))
        upsert(previous)
      throw error
    }
  }

  /**
   * `DELETE /projects/:id`; the row goes away once the server answered (an unknown project counts as deleted).
   * `409 run-active` is thrown (the caller shows the toast).
   */
  async function remove(id: string): Promise<void> {
    try {
      await withHarnessErrors(api.projects.remove({ params: { id } }))
    }
    catch (error) {
      if (!hasErrorCode(error, 'not_found'))
        throw error
    }
    drop(id)
  }

  /** `GET /projects/browse?path=`: the roots without a path, else the subfolders of `path`. */
  function browse(path?: string | null, opts: { signal?: AbortSignal } = {}): Promise<ProjectBrowse> {
    return withHarnessErrors(api.projects.browse({
      query: path ? { path } : {},
      signal: opts.signal,
    }))
  }

  /** `project.changed`: upsert, or remove for `project: null`. */
  function applyEvent(event: ServerEvent): void {
    if (event.type !== 'project.changed')
      return
    const { id, project } = event.data
    if (project === null)
      drop(id)
    else
      upsert(project)
  }

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
