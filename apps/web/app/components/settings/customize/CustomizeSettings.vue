<script setup lang="ts">
// Settings -> Customize (docs/UI.md 2.17, 9.12, 10.7, 14, 15; ADR-044, ADR-045): the agents, commands and skills of
// every source, by kind (tabs synced to `?tab=`, with their row counts; the tab list scrolls sideways below `sm`) and
// scope (the Project select synced to `?project=`: "No project" and the projects by name). On mount and on every
// project change it loads `customizations.fetchCatalog(projectId, { refresh: true })` (files edited on disk show at
// once) and the scope's commands (the Built-in command rows); a stale scope (`customization.changed`, a mutation) is
// refetched quietly. Sections in order: Personal · In {project} · From plugins · Built-in (`CustomizationSection`),
// a skeleton while loading, SettingsLoadError "Could not load your customizations" with Retry. Row actions: Edit… /
// Duplicate (editor in new mode, a free `{name}-copy` name) / Copy to personal (editor in import mode, prefilled from the
// file) / View… (the viewer) / Export .md (`downloadText` of the stored content or the source file) / Turn off / Turn on
// (optimistic) / Delete… ("Delete {name}?", then the toast "Deleted {name}" with Undo, which re-creates it from the
// content kept here) / Open plugin. Import… opens the hidden `.md` input (`customize-import-input`, at most 256 KB) and
// the editor in import mode with the notes. No props, no emits; the exposes `create()` / `import()` (the page header's
// New and Import…) and the root test id are frozen from Gate P10-0b (C33).
import type { Customization, CustomizationEntry, CustomizationKind } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import type { CustomizationAction, CustomizationDraft } from './customize'
import { CUSTOMIZATION_KINDS } from '@harness-forge/shared'
import { FileUpIcon, PlusIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, markRaw, nextTick, onMounted, ref, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import { useCustomizationsStore } from '~/stores/customizations'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProjectsStore } from '~/stores/projects'
import { useProvidersStore } from '~/stores/providers'
import { downloadText } from '~/utils/download'
import { hasErrorCode } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'
import { useRoute, useRouter } from '../nuxt-imports'
import SettingsLoadError from '../SettingsLoadError.vue'
import CustomizationDeletedToast from './CustomizationDeletedToast.vue'
import CustomizationEditor from './CustomizationEditor.vue'
import CustomizationSection from './CustomizationSection.vue'
import CustomizationViewer from './CustomizationViewer.vue'
import {
  builtinCommandEntries,
  CUSTOMIZE_TABS,
  deleteCopy,
  draftFromEntry,
  draftFromUser,
  freeName,
  importDraft,
  importTooLarge,
  kindFolders,
  kindOfTab,
  sectionsOf,
} from './customize'

/** How long Undo stays offered after a delete. */
const UNDO_MS = 5000
/** The Built-in command rows reuse a command list this young. */
const COMMANDS_MAX_AGE_MS = 15_000
const NO_PROJECT = '__none__'
const TAB_LABELS: Readonly<Record<CustomizationKind, string>> = { agent: 'Agents', command: 'Commands', skill: 'Skills', style: 'Output styles' }

const route = useRoute()
const router = useRouter()
const customizations = useCustomizationsStore()
const projects = useProjectsStore()
const plugins = usePluginsStore()
const providers = useProvidersStore()
const models = useModelsStore()
const root = useTemplateRef<HTMLElement>('root')
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const ids = { project: useId() }

// ---------- scope and tab ----------

const kind = computed(() => kindOfTab(route.query.tab))
const tab = computed(() => CUSTOMIZE_TABS[kind.value])
const projectId = computed<string | null>(() => {
  const value = Array.isArray(route.query.project) ? route.query.project[0] : route.query.project
  return typeof value === 'string' && value !== '' ? value : null
})
const project = computed(() => (projectId.value ? projects.byId(projectId.value) ?? null : null))
const projectName = computed(() => project.value?.name ?? null)
const list = computed(() => customizations.catalog(projectId.value))
const builtinCommands = computed(() => builtinCommandEntries(customizations.slashCommands(projectId.value)))

/** The source sections of a kind (the Built-in commands come from the command list and the composer's own). */
function sectionsFor(of: CustomizationKind) {
  return sectionsOf(list.value, of).map((section) => {
    if (section.source !== 'builtin' || of !== 'command')
      return section
    const names = new Set(section.entries.map(entry => entry.name))
    return { ...section, entries: [...section.entries, ...builtinCommands.value.filter(entry => !names.has(entry.name))] }
  })
}

const projectIssue = computed(() => {
  const scan = list.value?.project
  if (!scan || scan.available)
    return null
  const issue = scan.issue?.trim()
  if (!issue)
    return 'The project folder is unavailable.'
  if (/^the project folder is unavailable/i.test(issue))
    return issue
  const lead = issue.length > 1 && issue[1] === issue[1]!.toLowerCase() ? issue[0]!.toLowerCase() + issue.slice(1) : issue
  return `The project folder is unavailable: ${lead}`
})
const sectionsByKind = computed(() => Object.fromEntries(CUSTOMIZATION_KINDS.map(of => [of, sectionsFor(of)])) as Record<CustomizationKind, ReturnType<typeof sectionsFor>>)
const counts = computed(() => Object.fromEntries(CUSTOMIZATION_KINDS.map(of => [
  of,
  sectionsByKind.value[of].reduce((sum, section) => sum + (section.source === 'project' && projectIssue.value ? 0 : section.entries.length), 0),
])) as Record<CustomizationKind, number>)

/** Folder-level problems of the project for this kind (a linked folder, too many files, an unreadable folder). */
const folderNotices = computed(() => (list.value?.diagnostics ?? [])
  .filter(diagnostic => diagnostic.code !== 'project-unavailable' && (diagnostic.kind === undefined || diagnostic.kind === kind.value))
  .map(diagnostic => diagnostic.path ? `${diagnostic.path}: ${diagnostic.message}` : diagnostic.message))

function setQuery(patch: Record<string, string | undefined>): void {
  const query: Record<string, unknown> = { ...route.query }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined)
      delete query[key]
    else
      query[key] = value
  }
  router.replace({ query: query as Record<string, string> }).catch(() => {})
}

function setTab(value: AcceptableValue): void {
  const next = kindOfTab(value)
  if (next === kind.value)
    return
  setQuery({ tab: CUSTOMIZE_TABS[next] })
}

function setProject(value: AcceptableValue): void {
  const next = typeof value === 'string' && value !== NO_PROJECT ? value : undefined
  if ((next ?? null) === projectId.value)
    return
  setQuery({ project: next })
}

// ---------- loading ----------

const loading = ref(false)
const loadError = shallowRef<unknown>(null)
let loadSeq = 0

async function load(): Promise<void> {
  const scope = projectId.value
  const seq = ++loadSeq
  loading.value = true
  loadError.value = null
  try {
    await Promise.all([
      customizations.fetchCatalog(scope, { refresh: true }),
      customizations.fetchCommands(scope, { maxAgeMs: COMMANDS_MAX_AGE_MS }).catch(() => []),
    ])
    // An event overtook the first answer (it was not cached): ask once more.
    if (seq === loadSeq && !customizations.catalog(scope))
      await customizations.fetchCatalog(scope)
  }
  catch (error) {
    if (seq !== loadSeq)
      return
    if (scope !== null && hasErrorCode(error, 'not_found')) {
      // A deleted or unknown project: show the global definitions instead.
      setQuery({ project: undefined })
      return
    }
    loadError.value = error
  }
  finally {
    if (seq === loadSeq)
      loading.value = false
  }
}

watch(projectId, () => void load(), { immediate: true })

// A mutation or `customization.changed` marked the shown scope stale: refetch it quietly.
watch(
  () => [customizations.stale[`catalog:${projectId.value ?? ''}`], customizations.stale[`commands:${projectId.value ?? ''}`]] as const,
  ([catalogStale, commandsStale]) => {
    if (catalogStale)
      customizations.fetchCatalog(projectId.value).catch(() => {})
    if (commandsStale)
      customizations.fetchCommands(projectId.value).catch(() => {})
  },
)

onMounted(() => {
  if (!projects.loaded)
    projects.fetchAll().catch(() => {})
  if (!plugins.loaded)
    plugins.fetchAll().catch(() => {})
  if (!providers.loaded)
    providers.fetchAll().catch(() => {})
  if (!models.loaded)
    models.fetchAll().catch(() => {})
})

/** Refetches the shown scope (after a change made here), ignoring failures. */
async function refreshScope(): Promise<void> {
  await customizations.fetchCatalog(projectId.value).catch(() => {})
}

// ---------- focus helpers ----------

function rowSelector(entry: Pick<CustomizationEntry, 'source' | 'name' | 'kind'> & Partial<CustomizationEntry>): string {
  let selector = `[data-testid="${testIds.customizationRow}"][data-kind="${entry.kind}"][data-source="${entry.source}"][data-name="${CSS.escape(entry.name)}"]`
  if (entry.source === 'user' && entry.id)
    selector = `[data-testid="${testIds.customizationRow}"][data-customization-id="${CSS.escape(entry.id)}"]`
  else if (entry.source === 'project' && entry.path)
    selector += `[data-path="${CSS.escape(entry.path)}"]`
  else if (entry.source === 'plugin' && entry.pluginId)
    selector += `[data-plugin-id="${CSS.escape(entry.pluginId)}"]`
  return selector
}

function rowMenu(row: Element | null): HTMLElement | null {
  return row?.querySelector<HTMLElement>(`[data-testid="${testIds.customizationRowMenu}"]`) ?? null
}

function focusRowMenu(entry: Parameters<typeof rowSelector>[0]): boolean {
  const trigger = rowMenu(root.value?.querySelector(rowSelector(entry)) ?? null)
  trigger?.focus()
  return !!trigger
}

function focusNew(): void {
  document.querySelector<HTMLElement>(`[data-testid="${testIds.customizeNew}"]`)?.focus()
}

// ---------- the editor ----------

const editorOpen = ref(false)
const editorKind = ref<CustomizationKind>('agent')
const editorMode = ref<'new' | 'edit' | 'import'>('new')
const editorCustomization = shallowRef<Customization | null>(null)
const editorDraft = shallowRef<CustomizationDraft | null>(null)
const editorNotes = shallowRef<readonly string[]>([])

function openEditor(of: CustomizationKind, mode: 'new' | 'edit' | 'import', options: { customization?: Customization, draft?: CustomizationDraft, notes?: readonly string[] } = {}): void {
  editorKind.value = of
  editorMode.value = mode
  editorCustomization.value = options.customization ?? null
  editorDraft.value = options.draft ?? null
  editorNotes.value = options.notes ?? []
  editorOpen.value = true
}

function create(): void {
  openEditor(kind.value, 'new')
}

async function onSaved(saved: Customization): Promise<void> {
  await refreshScope()
  if (saved.kind !== kind.value)
    setQuery({ tab: CUSTOMIZE_TABS[saved.kind] })
}

// ---------- the viewer ----------

const viewerOpen = ref(false)
const viewerEntry = shallowRef<CustomizationEntry | null>(null)

function onViewerCopy(draft: CustomizationDraft): void {
  const entry = viewerEntry.value
  viewerOpen.value = false
  // The editor returns focus where the viewer would have: the row's menu trigger.
  if (entry)
    focusRowMenu(entry)
  openEditor(draft.kind, 'import', { draft })
}

// ---------- import ----------

let importOpener: HTMLElement | null = null

function importFile(): void {
  importOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const input = fileInput.value
  if (!input)
    return
  input.value = ''
  input.click()
}

async function onFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file)
    return
  const refused = importTooLarge(file)
  if (refused) {
    toast.error(refused.title, { description: refused.description })
    return
  }
  try {
    const { draft, notes } = await importDraft(file, kind.value)
    importOpener?.focus()
    openEditor(kind.value, 'import', { draft, notes })
  }
  catch (error) {
    toastError(error)
  }
}

// ---------- row actions ----------

const busyIds = ref<string[]>([])

function setBusy(id: string, busy: boolean): void {
  busyIds.value = busy ? [...new Set([...busyIds.value, id])] : busyIds.value.filter(entry => entry !== id)
}

async function contentOf(entry: CustomizationEntry): Promise<string> {
  return customizations.sourceOf(entry, entry.source === 'user' ? null : projectId.value)
}

async function edit(entry: CustomizationEntry): Promise<void> {
  if (!entry.id)
    return
  try {
    const customization = await customizations.get(entry.id)
    openEditor(entry.kind, 'edit', { customization })
  }
  catch (error) {
    toastError(error)
  }
}

async function duplicate(entry: CustomizationEntry): Promise<void> {
  try {
    if (entry.source === 'user' && entry.id) {
      const draft = draftFromUser(await customizations.get(entry.id))
      const taken = customizations.personal(entry.kind).map(row => row.name)
      openEditor(entry.kind, 'new', { draft: { ...draft, name: freeName(entry.kind, draft.name, taken) } })
    }
    else {
      openEditor(entry.kind, 'import', { draft: draftFromEntry(entry, await contentOf(entry)) })
    }
  }
  catch (error) {
    toastError(error)
  }
}

async function exportEntry(entry: CustomizationEntry): Promise<void> {
  try {
    downloadText(await contentOf(entry), `${entry.name}.md`, 'text/markdown')
  }
  catch (error) {
    toastError(error)
  }
}

async function toggle(entry: CustomizationEntry): Promise<void> {
  if (!entry.id || busyIds.value.includes(entry.id))
    return
  const id = entry.id
  setBusy(id, true)
  try {
    await customizations.update(id, { enabled: !entry.enabled })
  }
  catch (error) {
    toastError(error)
  }
  finally {
    setBusy(id, false)
  }
}

// ---------- delete ----------

const deleteOpen = ref(false)
const deleteTarget = shallowRef<CustomizationEntry | null>(null)
const deleting = ref(false)
/** The content of the definition being deleted, kept for Undo. */
let deleteContent: Promise<Customization | null> = Promise.resolve(null)

const deleteTexts = computed(() => (deleteTarget.value ? deleteCopy(deleteTarget.value.kind, deleteTarget.value.name) : null))

function askDelete(entry: CustomizationEntry): void {
  if (!entry.id)
    return
  deleteTarget.value = entry
  deleteContent = customizations.get(entry.id).catch(() => null)
  deleteOpen.value = true
}

function onDeleteOpenChange(value: boolean): void {
  if (!value && deleting.value)
    return
  deleteOpen.value = value
}

/** The row whose menu trigger takes focus after `entry` is gone: the next row, else the previous one. */
function neighborOf(entry: CustomizationEntry): string | null {
  const row = root.value?.querySelector(rowSelector(entry))
  const next = row?.nextElementSibling ?? row?.previousElementSibling
  return next instanceof HTMLElement ? next.dataset.customizationId ?? null : null
}

async function confirmDelete(): Promise<void> {
  const entry = deleteTarget.value
  if (!entry?.id || deleting.value)
    return
  const id = entry.id
  deleting.value = true
  setBusy(id, true)
  const neighbor = neighborOf(entry)
  try {
    const kept = await deleteContent
    await customizations.remove(id)
    await refreshScope()
    deleteOpen.value = false
    await nextTick()
    if (!(neighbor && focusRowMenu({ kind: entry.kind, source: 'user', name: '', id: neighbor })))
      focusNew()
    offerUndo(entry, kept)
  }
  catch (error) {
    deleteOpen.value = false
    toastError(error)
  }
  finally {
    deleting.value = false
    setBusy(id, false)
  }
}

function offerUndo(entry: CustomizationEntry, kept: Customization | null): void {
  const texts = deleteCopy(entry.kind, entry.name)
  if (!kept) {
    toast.success(texts.toast)
    return
  }
  const toastId = toast.custom(markRaw(CustomizationDeletedToast), {
    duration: UNDO_MS,
    componentProps: {
      title: texts.toast,
      onUndo: () => {
        toast.dismiss(toastId)
        void restore(kept)
      },
    },
  })
}

async function restore(kept: Customization): Promise<void> {
  try {
    const created = await customizations.create({ kind: kept.kind, content: kept.content, enabled: kept.enabled })
    await refreshScope()
    await nextTick()
    focusRowMenu({ kind: created.kind, source: 'user', name: created.name, id: created.id })
  }
  catch (error) {
    toastError(error)
  }
}

// ---------- dispatch ----------

function onAction(action: CustomizationAction, entry: CustomizationEntry): void {
  switch (action) {
    case 'edit':
      void edit(entry)
      break
    case 'view':
      viewerEntry.value = entry
      viewerOpen.value = true
      break
    case 'duplicate':
      void duplicate(entry)
      break
    case 'export':
      void exportEntry(entry)
      break
    case 'toggle':
      void toggle(entry)
      break
    case 'delete':
      askDelete(entry)
      break
    case 'open-plugin':
      if (entry.pluginId)
        router.push(`/plugins/${entry.pluginId}`).catch(() => {})
      break
  }
}

defineExpose<{ create: () => void, import: () => void }>({ create, import: importFile })
</script>

<template>
  <div ref="root" :data-testid="testIds.customizeSettings" class="flex min-w-0 flex-col gap-2 pt-2 pb-4">
    <Tabs :model-value="tab" class="min-w-0 gap-3" @update:model-value="setTab">
      <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div class="-mx-4 min-w-0 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList aria-label="Kinds" class="w-max">
            <TabsTrigger
              v-for="of in CUSTOMIZATION_KINDS"
              :key="of"
              :value="CUSTOMIZE_TABS[of]"
              :data-testid="testIds.customizeTab"
              :data-value="CUSTOMIZE_TABS[of]"
              :data-count="list ? counts[of] : undefined"
              class="flex-none px-3 pointer-coarse:h-10"
            >
              {{ TAB_LABELS[of] }}<template v-if="list">
                <span class="sr-only">, </span>
                <span class="text-xs text-muted-foreground tabular-nums">{{ counts[of] }}</span>
              </template>
            </TabsTrigger>
          </TabsList>
        </div>
        <div class="flex min-w-0 items-center gap-2">
          <Label :for="ids.project" class="shrink-0 text-sm text-muted-foreground">Project</Label>
          <Select :model-value="projectId ?? NO_PROJECT" @update:model-value="setProject">
            <SelectTrigger
              :id="ids.project"
              :data-testid="testIds.customizeProjectSelect"
              :data-value="projectId ?? ''"
              class="w-full min-w-0 sm:w-56 pointer-coarse:h-10"
            >
              <span class="min-w-0 truncate">{{ projectId ? (projectName ?? 'Project') : 'No project' }}</span>
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem :value="NO_PROJECT" data-value="">
                No project
              </SelectItem>
              <SelectItem
                v-for="item in projects.sorted"
                :key="item.id"
                :value="item.id"
                :data-value="item.id"
              >
                <span class="min-w-0 truncate">{{ item.name }}</span>
                <span v-if="!item.available" class="text-xs text-muted-foreground">Folder not found</span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <SettingsLoadError
        v-if="loadError"
        :error="loadError"
        title="Could not load your customizations"
        :pending="loading"
        @retry="load"
      />

      <TabsContent v-for="of in CUSTOMIZATION_KINDS" :key="of" :value="CUSTOMIZE_TABS[of]" class="flex flex-col">
        <div v-if="!list && !loadError" aria-busy="true" class="flex flex-col gap-6 py-3">
          <span class="sr-only">Loading your customizations…</span>
          <div v-for="n in 2" :key="n" class="flex flex-col gap-2">
            <Skeleton class="h-4 w-32" />
            <Skeleton v-for="row in 3" :key="row" class="h-12 rounded-lg" />
          </div>
        </div>
        <template v-else-if="list">
          <CustomizationSection
            v-for="section in sectionsByKind[of]"
            :key="section.source"
            :source="section.source"
            :kind="of"
            :entries="section.entries"
            :project-name="projectName"
            :folders="section.source === 'project' ? kindFolders(list.project?.folders, of) : undefined"
            :issue="section.source === 'project' ? projectIssue : null"
            :busy-ids="busyIds"
            @action="onAction"
          >
            <template v-if="section.source === 'project' && folderNotices.length > 0 && !projectIssue" #notices>
              <Alert class="border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning">
                <TriangleAlertIcon aria-hidden="true" />
                <AlertDescription class="text-foreground">
                  <ul class="flex flex-col gap-0.5">
                    <li v-for="(notice, index) in folderNotices" :key="index">
                      {{ notice }}
                    </li>
                  </ul>
                </AlertDescription>
              </Alert>
            </template>
            <template v-if="section.source === 'user'" #empty-actions>
              <Button type="button" size="sm" data-action="new" class="pointer-coarse:h-10" @click="create">
                <PlusIcon aria-hidden="true" data-icon="inline-start" />
                New {{ of }}
              </Button>
              <Button type="button" size="sm" variant="outline" data-action="import" class="pointer-coarse:h-10" @click="importFile">
                <FileUpIcon aria-hidden="true" data-icon="inline-start" />
                Import…
              </Button>
            </template>
          </CustomizationSection>
        </template>
      </TabsContent>
    </Tabs>

    <input
      ref="fileInput"
      type="file"
      accept=".md,text/markdown"
      class="sr-only"
      tabindex="-1"
      aria-hidden="true"
      :data-testid="testIds.customizeImportInput"
      @change="onFileChosen"
    >

    <CustomizationEditor
      v-model:open="editorOpen"
      :kind="editorKind"
      :mode="editorMode"
      :customization="editorCustomization"
      :draft="editorDraft"
      :notes="editorNotes"
      @saved="onSaved"
    />
    <CustomizationViewer
      v-model:open="viewerOpen"
      :entry="viewerEntry"
      :project-id="projectId"
      @copy="onViewerCopy"
    />
    <ConfirmDialog
      :open="deleteOpen"
      :title="deleteTexts?.title ?? 'Delete?'"
      :description="deleteTexts?.description"
      :confirm-label="deleteTexts?.confirm ?? 'Delete'"
      :pending="deleting"
      :data-testid="testIds.customizationDeleteConfirm"
      @update:open="onDeleteOpenChange"
      @confirm="confirmDelete"
    />
  </div>
</template>
