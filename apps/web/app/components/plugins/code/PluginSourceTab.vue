<script setup lang="ts">
// Source tab of a code plugin (docs/UI.md 8.10, 10.4, 12, 14.5): file tree | editor tabs + CodeMirror over the build /
// log panel, in resizable panels (below lg: a file select above the editor, the build panel starts collapsed).
// Mod+S saves the active file (`PUT /api/plugins/:id/files/*` with its etag); "Build & reload" saves dirty files and
// runs `POST /api/plugins/:id/build`, whose diagnostics become editor lint markers and problems in the panel. Writes of
// code plugins and builds need fresh auth: a `403 forbidden` + `action: 'login'` opens ConfirmPasswordDialog and the
// request runs again (the server then re-pins a `created` plugin, so saves never make it untrusted). Unsaved edits
// survive tab switches (the workspace is cached per plugin); leaving the plugin with unsaved edits asks first.
import type { BuildDiagnostic } from '@harness-forge/shared'
import type { SourceTabItem } from './SourceEditorTabs.vue'
import { FileCodeIcon, FilePlusIcon, HammerIcon, LockIcon, MoreHorizontalIcon, PencilIcon, SaveIcon, TerminalIcon, Trash2Icon } from '@lucide/vue'
import { useMediaQuery } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Spinner } from '@/components/ui/spinner'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { errorTitle } from '~/components/common/harness-error'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { useApi } from '~/composables/useApi'
import { useShortcuts } from '~/composables/useShortcuts'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import BuildLogPanel from './BuildLogPanel.vue'
import { isFreshAuthCancelled, useFreshAuth } from './fresh-auth'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useColorMode } from './nuxt-imports'
import { baseName, clockTime, existingPaths, folderOf, problemsText } from './source-files'
import { getSourceWorkspace, releaseSourceWorkspace } from './source-workspace'
import SourceConflictDialog from './SourceConflictDialog.vue'
import SourceEditor from './SourceEditor.vue'
import SourceEditorTabs from './SourceEditorTabs.vue'
import SourceFileDialog from './SourceFileDialog.vue'
import SourceFileTree from './SourceFileTree.vue'

const props = withDefaults(defineProps<{
  pluginId: string
  readonly?: boolean
}>(), {
  readonly: false,
})

const MANIFEST = 'plugin.json'
const SOURCE_LABELS: Record<string, string> = {
  npm: 'npm',
  zip: 'a zip file',
  url: 'a URL',
  builtin: 'the server',
}

const api = useApi()
const plugins = usePluginsStore()
const colorMode = useColorMode()
const freshAuth = useFreshAuth()
const isDesktop = useMediaQuery('(min-width: 1024px)')
const editor = useTemplateRef<InstanceType<typeof SourceEditor>>('editor')

// ---------- workspace ----------

const workspace = computed(() => getSourceWorkspace(props.pluginId, api))
let detach = workspace.value.attach(freshAuth.run)

const detail = computed(() => plugins.details[props.pluginId])
const isReadonly = computed(() => props.readonly || detail.value?.editable === false)
const readonlyText = computed(() => {
  const source = detail.value?.source
  return `Installed from ${(source && SOURCE_LABELS[source]) ?? 'another source'}. Editing is disabled.`
})
const entryPath = computed(() => detail.value?.manifest.main ?? null)
const protectedPaths = computed(() => [MANIFEST, ...(entryPath.value ? [entryPath.value] : [])])
const dark = computed(() => colorMode.value === 'dark')

const files = computed(() => workspace.value.files)
const active = computed(() => workspace.value.active.value)
const activePath = computed(() => workspace.value.activePath.value)
const dirtyPaths = computed(() => workspace.value.dirtyPaths.value)
const tabs = computed<SourceTabItem[]>(() => files.value.map(file => ({ path: file.path, dirty: workspace.value.isDirty(file.path) })))
const busy = computed(() => workspace.value.busy.value)
const diagnostics = computed(() => workspace.value.diagnostics.value)
const activeDiagnostics = computed(() => diagnostics.value.filter(diagnostic => diagnostic.file !== null && diagnostic.file === activePath.value))
const activeDirty = computed(() => activePath.value !== null && workspace.value.isDirty(activePath.value))
const entries = computed(() => workspace.value.entries.value)
const existing = computed(() => existingPaths(entries.value))
/** Files of the select shown below lg (sorted like the tree). */
const fileOptions = computed(() => entries.value.filter(entry => entry.type === 'file').map(entry => entry.path).sort((a, b) => a.localeCompare(b)))

const status = computed(() => {
  if (busy.value === 'saving')
    return 'Saving…'
  if (busy.value === 'building')
    return 'Building…'
  const problems = problemsText(diagnostics.value)
  if (problems)
    return problems
  if (activeDirty.value)
    return 'Unsaved changes'
  const savedAt = workspace.value.savedAt.value
  return savedAt === null ? '' : `Saved ${clockTime(savedAt)}`
})

const logOpen = ref(isDesktop.value)

async function openInitialFile(): Promise<void> {
  const current = workspace.value
  if (current.activePath.value !== null)
    return
  const paths = new Set(current.entries.value.filter(entry => entry.type === 'file').map(entry => entry.path))
  const first = [entryPath.value, MANIFEST].find(path => path !== null && paths.has(path))
    ?? current.entries.value.find(entry => entry.type === 'file' && entry.editable)?.path
  if (first)
    await current.open(first)
}

async function init(): Promise<void> {
  try {
    await workspace.value.loadTree()
    await openInitialFile()
  }
  catch (error) {
    report(error)
  }
}

onMounted(() => {
  if (!detail.value)
    void plugins.fetchOne(props.pluginId).catch(() => {})
  void init()
})

watch(workspace, (next, previous) => {
  detach()
  releaseSourceWorkspace(previous.pluginId)
  detach = next.attach(freshAuth.run)
  if (!plugins.details[next.pluginId])
    void plugins.fetchOne(next.pluginId).catch(() => {})
  void init()
})

// The entry becomes known once the detail arrives: open it when nothing is open yet.
watch(entryPath, () => {
  if (workspace.value.treeLoaded.value)
    void openInitialFile()
})

onBeforeUnmount(() => {
  detach()
  releaseSourceWorkspace(props.pluginId)
})

// ---------- errors ----------

const conflictPath = ref<string | null>(null)
const conflictPending = ref(false)

function isStale(error: unknown): boolean {
  const failure = toHarnessError(error)
  return failure.code === 'conflict' && (failure.details as { reason?: unknown } | undefined)?.reason === 'stale'
}

/** Toasts a failure (a cancelled password prompt is silent). */
function report(error: unknown): void {
  if (isFreshAuthCancelled(error))
    return
  const failure = toHarnessError(error)
  toast.error(errorTitle(failure), { description: failure.message })
}

// ---------- files ----------

async function openFile(path: string): Promise<void> {
  await workspace.value.open(path)
}

function onEditorChange(path: string, content: string): void {
  workspace.value.update(path, content)
}

async function save(path: string | null = activePath.value): Promise<void> {
  if (path === null || isReadonly.value || !workspace.value.isDirty(path))
    return
  try {
    await workspace.value.save(path)
  }
  catch (error) {
    if (isStale(error))
      conflictPath.value = path
    else
      report(error)
  }
}

async function resolveConflict(action: 'reload' | 'overwrite'): Promise<void> {
  const path = conflictPath.value
  if (path === null)
    return
  conflictPending.value = true
  try {
    if (action === 'reload')
      await workspace.value.reload(path)
    else
      await workspace.value.overwrite(path)
    conflictPath.value = null
  }
  catch (error) {
    report(error)
  }
  finally {
    conflictPending.value = false
  }
}

async function buildAndReload(): Promise<void> {
  if (isReadonly.value || busy.value !== null)
    return
  try {
    const result = await workspace.value.build()
    // The build output arrives as `plugin.log` events; fetching also covers a stream that is reconnecting.
    void plugins.fetchOne(props.pluginId).catch(() => {})
    void plugins.fetchLogs(props.pluginId).catch(() => {})
    if (!result.ok)
      logOpen.value = true
  }
  catch (error) {
    if (isStale(error)) {
      conflictPath.value = workspace.value.dirtyPaths.value[0] ?? null
      return
    }
    report(error)
  }
}

async function selectDiagnostic(diagnostic: BuildDiagnostic): Promise<void> {
  if (diagnostic.file === null || diagnostic.line === null)
    return
  await openFile(diagnostic.file)
  await nextTick()
  editor.value?.goTo(diagnostic.line, diagnostic.column)
}

// Tabs: closing a dirty tab asks first.
const discardPath = ref<string | null>(null)

function closeTab(path: string): void {
  if (workspace.value.isDirty(path)) {
    discardPath.value = path
    return
  }
  closeNow(path)
}

function closeNow(path: string): void {
  workspace.value.close(path)
  editor.value?.forget(path)
}

function confirmDiscard(): void {
  const path = discardPath.value
  discardPath.value = null
  if (path !== null)
    closeNow(path)
}

// New file and rename.
const fileDialog = ref<{ mode: 'create' | 'rename', initialPath: string, from: string | null } | null>(null)
const fileDialogPending = ref(false)
const fileDialogError = ref<string | null>(null)

function startCreate(folder = ''): void {
  fileDialogError.value = null
  fileDialog.value = { mode: 'create', initialPath: folder === '' ? '' : `${folder}/`, from: null }
}

function startRename(path: string): void {
  fileDialogError.value = null
  fileDialog.value = { mode: 'rename', initialPath: path, from: path }
}

async function submitFileDialog(path: string): Promise<void> {
  const dialog = fileDialog.value
  if (!dialog)
    return
  fileDialogPending.value = true
  fileDialogError.value = null
  try {
    if (dialog.mode === 'create') {
      await workspace.value.createFile(path)
    }
    else if (dialog.from !== null) {
      await workspace.value.renameFile(dialog.from, path)
      editor.value?.forget(dialog.from)
    }
    fileDialog.value = null
  }
  catch (error) {
    if (!isFreshAuthCancelled(error))
      fileDialogError.value = toHarnessError(error).message
  }
  finally {
    fileDialogPending.value = false
  }
}

// Delete.
const deletePath = ref<string | null>(null)
const deletePending = ref(false)

async function confirmDelete(): Promise<void> {
  const path = deletePath.value
  if (path === null)
    return
  deletePending.value = true
  try {
    await workspace.value.deleteFile(path)
    editor.value?.forget(path)
    deletePath.value = null
  }
  catch (error) {
    report(error)
  }
  finally {
    deletePending.value = false
  }
}

const activeChangeable = computed(() => {
  const path = activePath.value
  const entry = entries.value.find(item => item.path === path)
  return !isReadonly.value && path !== null && entry?.editable === true && !protectedPaths.value.includes(path)
})

// ---------- keyboard ----------

const root = useTemplateRef<HTMLElement>('root')

useShortcuts().register({
  id: 'editor-save',
  keys: 'mod+s',
  description: 'Save the active file',
  group: 'Editor',
  allowInInputs: true,
  allowInEditor: true,
  // The detail page keeps a visited Source tab mounted in an inactive (hidden) tab panel: only the shown one saves.
  when: () => root.value !== null && root.value.closest('[hidden], [data-state="inactive"]') === null,
  handler: () => void save(),
})

// ---------- unsaved changes ----------

const leaveOpen = ref(false)
let leaveDecision: ((leave: boolean) => void) | null = null

function askToLeave(): Promise<boolean> {
  leaveOpen.value = true
  return new Promise((resolve) => {
    leaveDecision = resolve
  })
}

function decideLeave(leave: boolean): void {
  leaveOpen.value = false
  if (leave)
    workspace.value.discardAll()
  leaveDecision?.(leave)
  leaveDecision = null
}

onBeforeRouteLeave(() => (dirtyPaths.value.length === 0 ? true : askToLeave()))
onBeforeRouteUpdate((to, from) => (to.params.id === from.params.id || dirtyPaths.value.length === 0 ? true : askToLeave()))
</script>

<template>
  <div
    ref="root"
    class="flex h-[calc(100dvh-13rem)] min-h-[28rem] flex-col gap-3"
    :data-plugin-id="pluginId"
  >
    <Alert v-if="isReadonly" :data-testid="testIds.codeReadonlyBanner">
      <LockIcon aria-hidden="true" />
      <AlertDescription>{{ readonlyText }}</AlertDescription>
    </Alert>

    <div class="flex min-h-0 flex-1 overflow-hidden rounded-lg border bg-background">
      <ResizablePanelGroup v-if="isDesktop" direction="horizontal">
        <ResizablePanel :order="1" :default-size="208" :min-size="160" :max-size="480" size-unit="px" class="bg-muted/30">
          <SourceFileTree
            :entries="entries"
            :active-path="activePath"
            :dirty-paths="dirtyPaths"
            :readonly="isReadonly"
            :protected-paths="protectedPaths"
            :loading="!workspace.treeLoaded.value"
            @open="openFile"
            @new-file="startCreate"
            @rename="startRename"
            @delete="deletePath = $event"
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel :order="2" :min-size="30">
          <div class="flex h-full min-w-0 flex-col">
            <div class="flex h-9 shrink-0 items-stretch border-b bg-muted/30">
              <SourceEditorTabs class="min-w-0 flex-1" :tabs="tabs" :active-path="activePath" @select="openFile" @close="closeTab" />
              <div class="flex shrink-0 items-center gap-2 pr-2 pl-3">
                <span role="status" aria-live="polite" class="hidden text-xs whitespace-nowrap text-muted-foreground xl:inline">{{ status }}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  :disabled="isReadonly || !activeDirty || busy !== null"
                  :data-testid="testIds.codeEditorSave"
                  aria-keyshortcuts="Meta+S Control+S"
                  @click="save()"
                >
                  <SaveIcon aria-hidden="true" data-icon="inline-start" />
                  Save
                  <KbdCombo keys="mod+s" class="hidden lg:inline-flex" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  :disabled="isReadonly || busy !== null"
                  :aria-busy="busy === 'building' || undefined"
                  :data-testid="testIds.codeBuildReload"
                  @click="buildAndReload"
                >
                  <Spinner v-if="busy === 'building'" data-icon="inline-start" />
                  <HammerIcon v-else aria-hidden="true" data-icon="inline-start" />
                  Build &amp; reload
                </Button>
              </div>
            </div>
            <ResizablePanelGroup direction="vertical" class="min-h-0 flex-1">
              <ResizablePanel :order="1" :default-size="70" :min-size="20">
                <div class="relative h-full">
                  <SourceEditor
                    ref="editor"
                    :path="active?.status === 'ready' ? active.path : null"
                    :content="active?.content ?? ''"
                    :readonly="isReadonly"
                    :dark="dark"
                    :diagnostics="activeDiagnostics"
                    @change="onEditorChange"
                  />
                  <div v-if="!active" class="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
                    <span class="grid justify-items-center gap-2">
                      <FileCodeIcon aria-hidden="true" class="size-6" />
                      Open a file from the tree.
                    </span>
                  </div>
                  <div v-else-if="active.status === 'loading'" class="absolute inset-0 grid place-items-center bg-background">
                    <Spinner class="text-muted-foreground" />
                  </div>
                  <div v-else-if="active.status === 'error'" role="alert" class="absolute inset-0 grid place-items-center bg-background p-6 text-center text-sm">
                    <span class="grid justify-items-center gap-3">
                      <span class="text-destructive">{{ active.error }}</span>
                      <Button type="button" variant="outline" size="sm" @click="workspace.reload(active.path)">Retry</Button>
                    </span>
                  </div>
                </div>
              </ResizablePanel>
              <template v-if="logOpen">
                <ResizableHandle />
                <ResizablePanel :order="2" :default-size="30" :min-size="10">
                  <BuildLogPanel
                    :plugin-id="pluginId"
                    :diagnostics="diagnostics"
                    :last-build="workspace.lastBuild.value"
                    :building="busy === 'building'"
                    @select="selectDiagnostic"
                    @collapse="logOpen = false"
                  />
                </ResizablePanel>
              </template>
            </ResizablePanelGroup>
            <button
              v-if="!logOpen"
              type="button"
              class="flex h-8 shrink-0 items-center gap-2 border-t px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
              @click="logOpen = true"
            >
              <TerminalIcon aria-hidden="true" class="size-3.5" />
              Build output
              <span v-if="diagnostics.length > 0" class="text-destructive normal-case">{{ problemsText(diagnostics) }}</span>
            </button>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <!-- Below lg: a file select above the editor; the build panel starts collapsed. -->
      <div v-else class="flex h-full min-w-0 flex-1 flex-col">
        <div class="flex shrink-0 items-center gap-2 border-b p-2">
          <select
            :value="activePath ?? ''"
            aria-label="File"
            class="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            @change="openFile(($event.target as HTMLSelectElement).value)"
          >
            <option v-if="activePath === null" value="" disabled>
              Choose a file
            </option>
            <option v-for="path in fileOptions" :key="path" :value="path">
              {{ path }}{{ dirtyPaths.includes(path) ? ' (unsaved)' : '' }}
            </option>
          </select>
          <DropdownMenu v-if="!isReadonly">
            <DropdownMenuTrigger as-child>
              <Button type="button" variant="outline" size="icon" aria-label="File actions">
                <MoreHorizontalIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-44">
              <DropdownMenuItem :data-testid="testIds.codeNewFile" @select="startCreate(activePath ? folderOf(activePath) : '')">
                <FilePlusIcon aria-hidden="true" />
                New file…
              </DropdownMenuItem>
              <DropdownMenuItem :disabled="!activeChangeable" :data-testid="testIds.codeFileRename" @select="activePath && startRename(activePath)">
                <PencilIcon aria-hidden="true" />
                Rename…
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" :disabled="!activeChangeable" :data-testid="testIds.codeFileDelete" @select="deletePath = activePath">
                <Trash2Icon aria-hidden="true" />
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div class="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
          <span role="status" aria-live="polite" class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ status }}</span>
          <Button type="button" variant="ghost" size="sm" :disabled="isReadonly || !activeDirty || busy !== null" :data-testid="testIds.codeEditorSave" @click="save()">
            <SaveIcon aria-hidden="true" data-icon="inline-start" />
            Save
          </Button>
          <Button type="button" size="sm" :disabled="isReadonly || busy !== null" :data-testid="testIds.codeBuildReload" @click="buildAndReload">
            <Spinner v-if="busy === 'building'" data-icon="inline-start" />
            <HammerIcon v-else aria-hidden="true" data-icon="inline-start" />
            Build &amp; reload
          </Button>
        </div>
        <div class="relative min-h-0 flex-1">
          <SourceEditor
            ref="editor"
            :path="active?.status === 'ready' ? active.path : null"
            :content="active?.content ?? ''"
            :readonly="isReadonly"
            :dark="dark"
            :diagnostics="activeDiagnostics"
            @change="onEditorChange"
          />
          <div v-if="active && active.status !== 'ready'" class="absolute inset-0 grid place-items-center bg-background text-sm">
            <Spinner v-if="active.status === 'loading'" class="text-muted-foreground" />
            <span v-else role="alert" class="text-destructive">{{ active.error }}</span>
          </div>
        </div>
        <div v-if="logOpen" class="h-48 shrink-0 border-t">
          <BuildLogPanel
            :plugin-id="pluginId"
            :diagnostics="diagnostics"
            :last-build="workspace.lastBuild.value"
            :building="busy === 'building'"
            @select="selectDiagnostic"
            @collapse="logOpen = false"
          />
        </div>
        <button
          v-else
          type="button"
          class="flex h-8 shrink-0 items-center gap-2 border-t px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
          @click="logOpen = true"
        >
          <TerminalIcon aria-hidden="true" class="size-3.5" />
          Build output
          <span v-if="diagnostics.length > 0" class="text-destructive normal-case">{{ problemsText(diagnostics) }}</span>
        </button>
      </div>
    </div>

    <ConfirmPasswordDialog
      :open="freshAuth.open.value"
      :pending="freshAuth.pending.value"
      :error="freshAuth.error.value"
      description="Changing the code of a plugin needs your password."
      @update:open="freshAuth.setOpen"
      @submit="freshAuth.submit"
    />
    <SourceFileDialog
      :open="fileDialog !== null"
      :mode="fileDialog?.mode ?? 'create'"
      :initial-path="fileDialog?.initialPath ?? ''"
      :existing="existing"
      :pending="fileDialogPending"
      :error="fileDialogError"
      @update:open="value => { if (!value) fileDialog = null }"
      @submit="submitFileDialog"
    />
    <ConfirmDialog
      :open="deletePath !== null"
      :title="`Delete ${deletePath ? baseName(deletePath) : ''}?`"
      description="The file is removed from the plugin folder. This cannot be undone."
      confirm-label="Delete"
      :pending="deletePending"
      @update:open="value => { if (!value) deletePath = null }"
      @confirm="confirmDelete"
    />
    <ConfirmDialog
      :open="discardPath !== null"
      title="Discard changes?"
      :description="`${discardPath ? baseName(discardPath) : ''} has unsaved changes.`"
      confirm-label="Discard"
      @update:open="value => { if (!value) discardPath = null }"
      @confirm="confirmDiscard"
    />
    <ConfirmDialog
      :open="leaveOpen"
      title="Discard unsaved changes?"
      :description="`${dirtyPaths.length} ${dirtyPaths.length === 1 ? 'file has' : 'files have'} unsaved changes.`"
      confirm-label="Discard changes"
      cancel-label="Keep editing"
      @update:open="value => { if (!value) decideLeave(false) }"
      @confirm="decideLeave(true)"
    />
    <SourceConflictDialog
      :open="conflictPath !== null"
      :path="conflictPath ?? ''"
      :pending="conflictPending"
      @update:open="value => { if (!value) conflictPath = null }"
      @reload="resolveConflict('reload')"
      @overwrite="resolveConflict('overwrite')"
    />
  </div>
</template>
