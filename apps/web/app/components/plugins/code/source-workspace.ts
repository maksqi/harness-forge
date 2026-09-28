// Editor workspace of one plugin (docs/UI.md 8.10, docs/API.md 5.18): the file listing, the open files with their
// buffers (content, last saved content, etag), saving with `baseEtag` (409 `stale` when the file changed elsewhere),
// Build & reload (dirty files are saved first), new / rename / delete, and the last build diagnostics.
//
// Workspaces are cached per plugin for the lifetime of the page, so switching the detail tabs (which unmounts the Source
// tab) or another plugin never loses unsaved edits; `beforeunload` warns while any buffer is dirty. Requests that need
// fresh auth go through the runner of the mounted Source tab (`attach()`), which prompts for the password.
import type { ApiClient, BuildDiagnostic, BuildResult, PluginFileEntry } from '@harness-forge/shared'
import type { ComputedRef, Ref } from 'vue'
import { computed, reactive, ref } from 'vue'
import { toHarnessError } from '~/utils/errors'
import { sha256Hex } from './source-files'

export interface OpenFile {
  path: string
  /** Current buffer. */
  content: string
  /** Content of the last load or save. */
  savedContent: string
  /** Etag of `savedContent` on the server (null until loaded). */
  etag: string | null
  status: 'loading' | 'ready' | 'error'
  error: string | null
}

/** Runs a request that may need fresh auth (the password prompt of the mounted Source tab). */
export type RequestRunner = <T>(task: () => Promise<T>) => Promise<T>

export type WorkspaceBusy = 'saving' | 'building' | null

export interface SourceWorkspace {
  readonly pluginId: string
  entries: Ref<PluginFileEntry[]>
  treeLoaded: Ref<boolean>
  treeError: Ref<string | null>
  /** Open files (editor tabs), in tab order. */
  files: OpenFile[]
  activePath: Ref<string | null>
  active: ComputedRef<OpenFile | null>
  /** Paths of open files with unsaved changes. */
  dirtyPaths: ComputedRef<string[]>
  busy: Ref<WorkspaceBusy>
  savedAt: Ref<number | null>
  lastBuild: Ref<BuildResult | null>
  /** Diagnostics of the last build (cleared by a successful one). */
  diagnostics: Ref<BuildDiagnostic[]>
  isDirty: (path: string) => boolean
  /** Sets the runner of requests that may need fresh auth; returns a function that restores the plain runner. */
  attach: (runner: RequestRunner) => () => void
  loadTree: () => Promise<void>
  /** Opens (or activates) a file tab; the content loads in the background. */
  open: (path: string) => Promise<void>
  close: (path: string) => void
  update: (path: string, content: string) => void
  /** Saves one file (`409 conflict` + `stale` when it changed on the server). */
  save: (path: string) => Promise<void>
  /** Saves every dirty file, one after the other; throws on the first failure. */
  saveAll: () => Promise<void>
  /** Writes the buffer without `baseEtag` (after a stale conflict). */
  overwrite: (path: string) => Promise<void>
  /** Loads the file again from the server, dropping the buffer. */
  reload: (path: string) => Promise<void>
  /** Saves dirty files, then `POST /plugins/:id/build` with reload. */
  build: () => Promise<BuildResult>
  createFile: (path: string, content?: string) => Promise<void>
  renameFile: (from: string, to: string) => Promise<void>
  deleteFile: (path: string) => Promise<void>
  /** Drops every unsaved change. */
  discardAll: () => void
}

const plainRunner: RequestRunner = task => task()

export function createSourceWorkspace(pluginId: string, api: ApiClient): SourceWorkspace {
  const entries = ref<PluginFileEntry[]>([])
  const treeLoaded = ref(false)
  const treeError = ref<string | null>(null)
  const files = reactive<OpenFile[]>([])
  const activePath = ref<string | null>(null)
  const busy = ref<WorkspaceBusy>(null)
  const savedAt = ref<number | null>(null)
  const lastBuild = ref<BuildResult | null>(null)
  const diagnostics = ref<BuildDiagnostic[]>([])
  let runner: RequestRunner = plainRunner

  const find = (path: string): OpenFile | undefined => files.find(file => file.path === path)
  const isDirty = (path: string): boolean => {
    const file = find(path)
    return file !== undefined && file.status === 'ready' && file.content !== file.savedContent
  }
  const active = computed(() => (activePath.value === null ? null : find(activePath.value) ?? null))
  const dirtyPaths = computed(() => files.filter(file => file.status === 'ready' && file.content !== file.savedContent).map(file => file.path))

  async function etagOf(path: string, content: string): Promise<string> {
    return await sha256Hex(content) ?? (await api.pluginFiles.read({ params: { id: pluginId, path } })).etag
  }

  async function loadTree(): Promise<void> {
    try {
      const { items } = await api.pluginFiles.list({ params: { id: pluginId } })
      entries.value = items
      treeError.value = null
    }
    catch (error) {
      treeError.value = toHarnessError(error).message
      throw error
    }
    finally {
      treeLoaded.value = true
    }
  }

  async function load(path: string): Promise<void> {
    const file = find(path)
    if (!file)
      return
    file.status = 'loading'
    file.error = null
    try {
      const content = await api.pluginFiles.read({ params: { id: pluginId, path } })
      const current = find(path)
      if (!current)
        return
      current.content = content.content
      current.savedContent = content.content
      current.etag = content.etag
      current.status = 'ready'
    }
    catch (error) {
      const current = find(path)
      if (current) {
        current.status = 'error'
        current.error = toHarnessError(error).message
      }
    }
  }

  async function write(path: string, content: string, baseEtag: string | null): Promise<void> {
    await runner(() => api.pluginFiles.write({
      params: { id: pluginId, path },
      body: baseEtag === null ? { content } : { content, baseEtag },
    }))
  }

  async function saveFile(path: string, force: boolean): Promise<void> {
    const file = find(path)
    if (!file || file.status !== 'ready' || (!force && file.content === file.savedContent))
      return
    const content = file.content
    busy.value = 'saving'
    try {
      await write(path, content, force ? null : file.etag)
      const etag = await etagOf(path, content)
      const saved = find(path)
      if (saved) {
        saved.savedContent = content
        saved.etag = etag
      }
      savedAt.value = Date.now()
    }
    finally {
      busy.value = null
    }
    void loadTree().catch(() => {})
  }

  async function saveAll(): Promise<void> {
    for (const path of dirtyPaths.value)
      await saveFile(path, false)
  }

  const workspace: SourceWorkspace = {
    pluginId,
    entries,
    treeLoaded,
    treeError,
    files,
    activePath,
    active,
    dirtyPaths,
    busy,
    savedAt,
    lastBuild,
    diagnostics,
    isDirty,

    attach: (next) => {
      runner = next
      return () => {
        if (runner === next)
          runner = plainRunner
      }
    },

    loadTree,

    open: async (path) => {
      activePath.value = path
      if (find(path))
        return
      files.push({ path, content: '', savedContent: '', etag: null, status: 'loading', error: null })
      await load(path)
    },

    close: (path) => {
      const index = files.findIndex(file => file.path === path)
      if (index < 0)
        return
      files.splice(index, 1)
      if (activePath.value === path)
        activePath.value = files[Math.min(index, files.length - 1)]?.path ?? null
    },

    update: (path, content) => {
      const file = find(path)
      if (file && file.status === 'ready')
        file.content = content
    },

    save: path => saveFile(path, false),
    saveAll,
    overwrite: path => saveFile(path, true),
    reload: path => load(path),

    build: async () => {
      await saveAll()
      busy.value = 'building'
      try {
        const result = await runner(() => api.pluginFiles.build({ params: { id: pluginId }, body: { reload: true } }))
        lastBuild.value = result
        diagnostics.value = result.diagnostics
        return result
      }
      finally {
        busy.value = null
      }
    },

    createFile: async (path, content = '') => {
      await write(path, content, null)
      await loadTree().catch(() => {})
      await workspace.open(path)
    },

    renameFile: async (from, to) => {
      const file = find(from)
      const content = file?.status === 'ready' ? file.content : (await api.pluginFiles.read({ params: { id: pluginId, path: from } })).content
      await write(to, content, null)
      await runner(() => api.pluginFiles.remove({ params: { id: pluginId, path: from } }))
      const renamed = find(from)
      if (renamed) {
        renamed.path = to
        renamed.content = content
        renamed.savedContent = content
        renamed.etag = await etagOf(to, content)
        if (activePath.value === from)
          activePath.value = to
      }
      diagnostics.value = diagnostics.value.filter(diagnostic => diagnostic.file !== from)
      await loadTree().catch(() => {})
    },

    deleteFile: async (path) => {
      await runner(() => api.pluginFiles.remove({ params: { id: pluginId, path } }))
      workspace.close(path)
      diagnostics.value = diagnostics.value.filter(diagnostic => diagnostic.file !== path)
      await loadTree().catch(() => {})
    },

    discardAll: () => {
      for (const file of files) {
        if (file.status === 'ready')
          file.content = file.savedContent
      }
    },
  }
  return workspace
}

// ---------- cache ----------

const workspaces = new Map<string, SourceWorkspace>()
let unloadGuardInstalled = false

/** True while any cached workspace has unsaved changes. */
export function hasUnsavedSourceChanges(): boolean {
  return [...workspaces.values()].some(workspace => workspace.dirtyPaths.value.length > 0)
}

function installUnloadGuard(): void {
  if (unloadGuardInstalled || typeof window === 'undefined')
    return
  unloadGuardInstalled = true
  window.addEventListener('beforeunload', (event) => {
    if (hasUnsavedSourceChanges())
      event.preventDefault()
  })
}

/** The cached workspace of a plugin (created on first use). */
export function getSourceWorkspace(pluginId: string, api: ApiClient): SourceWorkspace {
  let workspace = workspaces.get(pluginId)
  if (!workspace) {
    workspace = createSourceWorkspace(pluginId, api)
    workspaces.set(pluginId, workspace)
    installUnloadGuard()
  }
  return workspace
}

/** Forgets a workspace without unsaved changes (the Source tab unmounted). */
export function releaseSourceWorkspace(pluginId: string): void {
  const workspace = workspaces.get(pluginId)
  if (workspace && workspace.dirtyPaths.value.length === 0)
    workspaces.delete(pluginId)
}

/** Tests: forget every workspace. */
export function resetSourceWorkspaces(): void {
  workspaces.clear()
}
