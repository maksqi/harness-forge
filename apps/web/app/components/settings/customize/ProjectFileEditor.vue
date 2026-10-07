<script setup lang="ts">
// The project file editor (Phase 12, ADR-056; docs/UI.md 2.19, 9.14, 10.9, 12, 14): a right-side sheet (`w-full
// sm:max-w-2xl`, sticky footer; `project-file-editor`, `data-kind` agent | command | skill | style | mcp, `data-path`,
// `data-mode` edit | new) titled "Edit {file}" ("New {kind} in {project}" for a new file). It edits the **raw** file
// (`project-file-content`: MarkdownEditor for definitions with the parser's lint markers, a plain mono textarea with the
// `mcpServers` object as JSON for `.mcp.json`), so unknown keys survive byte for byte; the path in mono with Copy path;
// beside the text the parsed summary ("Agent reviewer · Not allowed: shell · Max turns 12 · Purple", "{n} servers") and
// the diagnostics of the shared parsers (errors block saving; warnings and info do not); the note "Saving never approves
// hooks or shell lines.". A new definition (`entry.create`, opened by New file… of a project section) asks for the
// Folder (`.harness` / `.claude`) and the Name and starts from a small frontmatter; `.mcp.json` is read even when it is
// created (an existing file keeps its sha256).
// Save file (`project-file-save`, also Mod+Enter) → `useCustomizationsStore().saveProjectFile(projectId, { path,
// expectedSha256, content | mcpServers })` (no password, never approves, allowed while a chat of the project runs: there
// is no busy state) → the toast "Saved {path}." or "Saved {path}. {n} items need your approval." with Review (emits
// `review`: the host opens ProjectTrustDialog on the first pending item), `saved({ path, pending })`, close. A changed
// file (409 `conflict` reason `stale`) shows `project-file-conflict` (`role="alert"`, takes focus) "{file} changed on
// disk after you opened it." with Load from disk (`project-file-reload`: drops the edits) and Overwrite
// (`project-file-overwrite`: reads the current sha256 and saves the text again); errors `project-file-error`
// (`data-code`; a 400 lists its diagnostics; a gone file reads "This file no longer exists." with Close). Closing with
// edits asks "Discard changes?" (`project-file-discard-confirm`). Mounted by CustomizeSettings (Edit… of project rows,
// the viewer's Edit, New file…) and ProjectMcpDialog (Edit .mcp.json…, kind `mcp`).
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); W12.11 implements it in P12-A.
// W12.19: the Folder list opens as a popper below its trigger; on a coarse pointer the trigger and the × Close are 40 px.
import type { ProjectDefinitionWriteBody } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import type { ProjectFileTarget } from './customize'
import { CircleAlertIcon, FileXIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { AGENT_COLOR_TOKENS } from '~/components/chat/agent/agent-tools'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import CopyButton from '~/components/common/CopyButton.vue'
import MarkdownEditor from '~/components/common/MarkdownEditor.vue'
import { useCustomizationsStore } from '~/stores/customizations'
import { useProjectsStore } from '~/stores/projects'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import {
  AGENT_COLOR_LABELS,
  checkProjectFile,
  mcpServersOf,
  mcpServersText,
  nameError,
  newProjectFileContent,
  newProjectFilePath,
  PROJECT_FILE_NOTE,
  projectFileName,
  projectFileTitle,
  projectSavedText,
  SHEET_CLOSE_TOUCH_CLASS,
} from './customize'

type Folder = '.harness' | '.claude'

const props = defineProps<{ open: boolean, projectId: string | null, entry: ProjectFileTarget | null }>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  'saved': [saved: { path: string, pending: number }]
  'review': [sha256?: string]
}>()

const FOLDERS: readonly Folder[] = ['.harness', '.claude']

const customizations = useCustomizationsStore()
const projects = useProjectsStore()
const ids = { name: useId(), nameError: useId(), folder: useId(), problems: useId(), path: useId() }
const markdownEditor = useTemplateRef<InstanceType<typeof MarkdownEditor>>('markdownEditor')
const sheet = useTemplateRef<HTMLElement>('sheet')

/** The text in the editor and the text it was opened (or last saved) with. */
const text = ref('')
const loaded = ref('')
/** The sha256 the file had when it was read (null = the file must not exist yet). */
const sha256 = ref<string | null>(null)
/** The path of an existing file a new definition switched to (after Load from disk or Overwrite), else null. */
const adopted = ref<string | null>(null)
const exists = ref(false)
const loading = ref(false)
const saving = ref(false)
const conflict = ref(false)
const gone = ref(false)
const discardOpen = ref(false)
const error = ref<{ code: string, message: string, lines: string[] } | null>(null)
/** New definitions: the folder, the name and the frontmatter the text started from (replaced while untouched). */
const folder = ref<Folder>('.harness')
const name = ref('')
const nameTouched = ref(false)
let session = 0

const kind = computed(() => props.entry?.kind ?? 'agent')
/** A new markdown definition: Folder and Name decide the path. */
const newDefinition = computed(() => !!props.entry?.create && props.entry.kind !== 'mcp' && adopted.value === null)
const mode = computed<'edit' | 'new'>(() => {
  if (!props.entry)
    return 'edit'
  if (props.entry.kind === 'mcp')
    return props.entry.create && !exists.value ? 'new' : 'edit'
  return newDefinition.value ? 'new' : 'edit'
})
const path = computed(() => {
  const entry = props.entry
  if (!entry)
    return ''
  if (adopted.value !== null)
    return adopted.value
  if (newDefinition.value)
    return newProjectFilePath(entry.kind, folder.value, name.value)
  return entry.path
})
/** The path as shown (a new definition without a name yet shows `…` in its place). */
const shownPath = computed(() => {
  const entry = props.entry
  if (entry && newDefinition.value && name.value.trim() === '')
    return newProjectFilePath(entry.kind, folder.value, '…')
  return path.value
})
const projectName = computed(() => (props.projectId ? projects.byId(props.projectId)?.name ?? null : null))
const title = computed(() => (props.entry ? projectFileTitle({ kind: kind.value, path: path.value }, mode.value, projectName.value) : 'Edit file'))
const fileName = computed(() => projectFileName(path.value))
const dirty = computed(() => text.value !== loaded.value)
const check = computed(() => checkProjectFile(kind.value, path.value, text.value))
const nameProblem = computed(() => (newDefinition.value && kind.value !== 'mcp' ? nameError(kind.value, name.value) : null))
const canSave = computed(() => !!props.entry && !!props.projectId && !loading.value && !saving.value && !gone.value
  && !check.value.blocked && nameProblem.value === null)
const colorStyle = computed(() => (check.value.color ? { backgroundColor: `var(--${AGENT_COLOR_TOKENS[check.value.color]})` } : undefined))

// ---------- loading ----------

function reset(): void {
  text.value = ''
  loaded.value = ''
  sha256.value = null
  adopted.value = null
  exists.value = false
  conflict.value = false
  gone.value = false
  error.value = null
  name.value = ''
  nameTouched.value = false
}

function setError(failure: unknown): void {
  if (failure instanceof SyntaxError) {
    error.value = { code: 'validation_error', message: 'This isn\'t valid JSON.', lines: [] }
    return
  }
  const harnessError = toHarnessError(failure)
  const details = harnessError.details as { diagnostics?: unknown } | undefined
  const lines = (Array.isArray(details?.diagnostics) ? details.diagnostics : [])
    .map(entry => (entry && typeof entry === 'object' && typeof (entry as { message?: unknown }).message === 'string' ? (entry as { message: string }).message : null))
    .filter((line): line is string => line !== null)
  error.value = { code: harnessError.code, message: harnessError.message, lines }
}

/** Shows a file as read from disk (the text for `.mcp.json` is its `mcpServers` object). */
function show(content: string | null, digest: string | null, onDisk: boolean): void {
  const value = kind.value === 'mcp' ? mcpServersText(content) : content ?? ''
  text.value = value
  loaded.value = value
  sha256.value = digest
  exists.value = onDisk
}

/** Reads the file at the current path; a missing file is "gone" while editing an existing one. */
async function read(): Promise<boolean> {
  const current = session
  const entry = props.entry
  const projectId = props.projectId
  if (!entry || !projectId)
    return false
  loading.value = true
  try {
    const file = await customizations.readProjectFile(projectId, path.value)
    if (current !== session)
      return false
    if (!file.exists && !entry.create) {
      gone.value = true
      return false
    }
    if (file.exists && newDefinition.value)
      adopted.value = path.value
    show(file.content, file.sha256, file.exists)
    return true
  }
  catch (failure) {
    if (current !== session)
      return false
    if (toHarnessError(failure).code === 'not_found' && !entry.create)
      gone.value = true
    else
      setError(failure)
    return false
  }
  finally {
    if (current === session)
      loading.value = false
  }
}

function defaultFolder(entry: ProjectFileTarget): Folder {
  return entry.path.startsWith('.claude/') ? '.claude' : '.harness'
}

async function openFile(): Promise<void> {
  session += 1
  reset()
  const entry = props.entry
  if (!entry || !props.projectId)
    return
  if (entry.create && entry.kind !== 'mcp') {
    folder.value = defaultFolder(entry)
    name.value = entry.name ?? ''
    const template = newProjectFileContent(entry.kind, name.value)
    text.value = template
    loaded.value = template
    focusName()
    return
  }
  if (await read())
    focusEditor()
}

watch(() => [props.open, props.projectId, props.entry?.path, props.entry?.create] as const, ([open]) => {
  if (open) {
    void openFile()
  }
  else {
    session += 1
    discardOpen.value = false
  }
}, { immediate: true })

// A new definition keeps its starting frontmatter in step with the name until the text is edited.
watch(name, (value, previous) => {
  const entry = props.entry
  if (!entry || !newDefinition.value || entry.kind === 'mcp')
    return
  const before = newProjectFileContent(entry.kind, previous)
  if (text.value === before) {
    const next = newProjectFileContent(entry.kind, value)
    text.value = next
    if (loaded.value === before)
      loaded.value = next
  }
})

// ---------- focus ----------

/** Moves focus into the raw editor (the sheet opens and CodeMirror loads lazily: tries for a moment until it is there). */
function focusEditor(attempt = 0, current = session): void {
  void nextTick(() => {
    if (current !== session || !props.open)
      return
    const root = sheet.value?.querySelector<HTMLElement>(`[data-testid="${testIds.projectFileContent}"]`)
    if (root?.tagName === 'TEXTAREA') {
      root.focus()
      return
    }
    // A stand-in without `focus` (tests) is skipped.
    if (root)
      (markdownEditor.value as { focus?: () => void } | null)?.focus?.()
    if (!(root?.contains(document.activeElement)) && attempt < 20)
      setTimeout(focusEditor, 50, attempt + 1, current)
  })
}

/** Moves focus to the Name field of a new definition once the sheet shows it. */
function focusName(attempt = 0, current = session): void {
  void nextTick(() => {
    if (current !== session || !props.open)
      return
    const input = document.getElementById(ids.name)
    input?.focus()
    if (document.activeElement !== input && attempt < 20)
      setTimeout(focusName, 50, attempt + 1, current)
  })
}

onBeforeUnmount(() => {
  session += 1
})

function focusConflict(): void {
  void nextTick(() => sheet.value?.querySelector<HTMLElement>(`[data-testid="${testIds.projectFileConflict}"]`)?.focus())
}

function onOpenAutoFocus(event: Event): void {
  // A file is not there yet: focus moves into it once it has loaded. A new definition starts on its Name.
  event.preventDefault()
  if (newDefinition.value)
    void nextTick(() => document.getElementById(ids.name)?.focus())
}

// ---------- saving ----------

function isStale(failure: unknown): boolean {
  const harnessError = toHarnessError(failure)
  return harnessError.code === 'conflict' && (harnessError.details as { reason?: unknown } | undefined)?.reason === 'stale'
}

function bodyOf(expected: string | null): ProjectDefinitionWriteBody {
  if (kind.value === 'mcp')
    return { path: '.mcp.json', expectedSha256: expected, mcpServers: mcpServersOf(text.value) }
  return { path: path.value, expectedSha256: expected, content: text.value }
}

async function save(expected: string | null = sha256.value): Promise<void> {
  const projectId = props.projectId
  if (!projectId || !props.entry || saving.value)
    return
  if (!canSave.value) {
    if (nameProblem.value)
      document.getElementById(ids.name)?.focus()
    return
  }
  saving.value = true
  error.value = null
  conflict.value = false
  try {
    const result = await customizations.saveProjectFile(projectId, bodyOf(expected))
    loaded.value = text.value
    sha256.value = result.sha256
    exists.value = true
    const message = projectSavedText(result.path, result.trust.pending)
    if (result.trust.pending > 0)
      toast.success(message, { action: { label: 'Review', onClick: () => emit('review') } })
    else
      toast.success(message)
    emit('saved', { path: result.path, pending: result.trust.pending })
    emit('update:open', false)
  }
  catch (failure) {
    if (isStale(failure)) {
      conflict.value = true
      focusConflict()
    }
    else if (toHarnessError(failure).code === 'not_found' && !props.entry.create) {
      gone.value = true
    }
    else {
      setError(failure)
    }
  }
  finally {
    saving.value = false
  }
}

function submit(): void {
  void save()
}

function onKeydown(event: KeyboardEvent): void {
  // The markdown editor handles its own Mod+Enter (it prevents the default and emits submit).
  if (event.defaultPrevented || event.isComposing || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey))
    return
  event.preventDefault()
  submit()
}

/** Load from disk: drops the edits and shows the file as it is now. */
async function reload(): Promise<void> {
  conflict.value = false
  error.value = null
  if (await read())
    focusEditor()
}

/** Overwrite: reads the current sha256 and saves the text again with it. */
async function overwrite(): Promise<void> {
  const projectId = props.projectId
  if (!projectId || !props.entry)
    return
  try {
    const file = await customizations.readProjectFile(projectId, path.value)
    conflict.value = false
    await save(file.exists ? file.sha256 : null)
    if (!conflict.value)
      focusEditor()
  }
  catch (failure) {
    setError(failure)
  }
}

// ---------- closing ----------

function requestClose(value: boolean): void {
  if (value) {
    emit('update:open', true)
    return
  }
  if (saving.value)
    return
  if (dirty.value && !gone.value) {
    discardOpen.value = true
    return
  }
  emit('update:open', false)
}

function discard(): void {
  discardOpen.value = false
  text.value = loaded.value
  emit('update:open', false)
}

function onFolder(value: AcceptableValue): void {
  if (value === '.harness' || value === '.claude')
    folder.value = value
}
</script>

<template>
  <Sheet :open="open" @update:open="requestClose">
    <SheetContent
      side="right"
      :data-testid="testIds.projectFileEditor"
      :data-kind="entry?.kind"
      :data-path="path"
      :data-mode="mode"
      class="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      :class="SHEET_CLOSE_TOUCH_CLASS"
      @open-auto-focus="onOpenAutoFocus"
      @keydown="onKeydown"
    >
      <SheetHeader class="border-b pr-14">
        <SheetTitle class="truncate">
          {{ title }}
        </SheetTitle>
        <SheetDescription class="sr-only">
          {{ PROJECT_FILE_NOTE }}
        </SheetDescription>
      </SheetHeader>

      <div ref="sheet" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
        <div class="flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
          <span :id="ids.path" class="min-w-0 flex-1 truncate font-mono text-xs" :title="shownPath">{{ shownPath }}</span>
          <CopyButton :text="() => shownPath" label="Copy path" size="sm" class="shrink-0 pointer-coarse:h-10" />
        </div>

        <Alert
          v-if="conflict"
          role="alert"
          tabindex="-1"
          :data-testid="testIds.projectFileConflict"
          class="border-warning/40 bg-warning/5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-warning/10 *:[svg]:text-warning"
        >
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>{{ fileName }} changed on disk after you opened it.</AlertTitle>
          <AlertDescription class="flex flex-wrap items-center gap-2 text-foreground">
            <Button type="button" size="sm" variant="outline" :disabled="loading || saving" :data-testid="testIds.projectFileReload" class="pointer-coarse:h-10" @click="reload">
              Load from disk
            </Button>
            <Button type="button" size="sm" variant="outline" :disabled="loading || saving" :data-testid="testIds.projectFileOverwrite" class="pointer-coarse:h-10" @click="overwrite">
              Overwrite
            </Button>
            <span class="text-xs text-muted-foreground">or keep editing</span>
          </AlertDescription>
        </Alert>

        <Alert
          v-if="gone"
          role="alert"
          :data-testid="testIds.projectFileError"
          data-code="not_found"
        >
          <FileXIcon aria-hidden="true" />
          <AlertDescription class="text-foreground">
            This file no longer exists.
          </AlertDescription>
        </Alert>
        <Alert
          v-else-if="error"
          role="alert"
          :data-testid="testIds.projectFileError"
          :data-code="error.code"
          class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10"
        >
          <CircleAlertIcon aria-hidden="true" class="text-destructive" />
          <AlertTitle>{{ error.message }}</AlertTitle>
          <AlertDescription v-if="error.lines.length > 0">
            <ul class="flex flex-col gap-0.5">
              <li v-for="(line, index) in error.lines" :key="index">
                {{ line }}
              </li>
            </ul>
          </AlertDescription>
        </Alert>

        <div v-if="newDefinition" class="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
          <div class="grid gap-2">
            <Label :for="ids.folder">Folder</Label>
            <Select :model-value="folder" @update:model-value="onFolder">
              <SelectTrigger :id="ids.folder" data-slot="project-file-folder" :data-value="folder" class="w-full font-mono text-[13px] pointer-coarse:data-[size=default]:h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem v-for="item in FOLDERS" :key="item" :value="item" class="font-mono text-[13px]">
                  {{ item }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-2">
            <Label :for="ids.name">Name</Label>
            <Input
              :id="ids.name"
              v-model="name"
              data-slot="project-file-name"
              :aria-invalid="nameTouched && nameProblem ? true : undefined"
              :aria-describedby="nameTouched && nameProblem ? ids.nameError : undefined"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              class="font-mono text-[13px] pointer-coarse:h-10"
              @blur="nameTouched = true"
            />
            <p v-if="nameTouched && nameProblem" :id="ids.nameError" class="text-xs text-destructive">
              {{ nameProblem }}
            </p>
          </div>
        </div>

        <template v-if="!gone">
          <div v-if="loading" aria-busy="true" class="grid h-64 place-items-center rounded-md border">
            <Spinner class="text-muted-foreground" />
            <span class="sr-only">Loading {{ fileName }}…</span>
          </div>
          <Textarea
            v-else-if="kind === 'mcp'"
            v-model="text"
            aria-label="File content"
            :aria-describedby="check.problems.length > 0 ? ids.problems : undefined"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            wrap="off"
            :data-testid="testIds.projectFileContent"
            class="max-h-[50dvh] min-h-64 resize-y overflow-auto font-mono text-[13px] whitespace-pre sm:max-h-[70dvh]"
          />
          <MarkdownEditor
            v-else
            ref="markdownEditor"
            v-model="text"
            label="File content"
            :diagnostics="check.markers"
            :aria-describedby="check.problems.length > 0 ? ids.problems : undefined"
            :data-testid="testIds.projectFileContent"
            @submit="submit"
          />

          <p v-if="check.summary.length > 0 || check.color" data-slot="project-file-summary" class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
            <template v-for="(item, index) in check.summary" :key="index">
              <span v-if="index > 0" aria-hidden="true" class="text-muted-foreground">·</span>
              <span :class="index === 0 ? 'font-medium' : 'text-muted-foreground'">{{ item }}</span>
            </template>
            <template v-if="check.color">
              <span v-if="check.summary.length > 0" aria-hidden="true" class="text-muted-foreground">·</span>
              <span class="inline-flex items-center gap-1 text-muted-foreground">
                <span aria-hidden="true" data-slot="customization-color-dot" :data-value="check.color" class="size-2 shrink-0 rounded-full" :style="colorStyle" />
                {{ AGENT_COLOR_LABELS[check.color] }}
              </span>
            </template>
          </p>
          <ul
            v-if="check.problems.length > 0"
            :id="ids.problems"
            data-slot="project-file-diagnostics"
            :aria-label="`Problems in ${fileName}`"
            class="flex flex-col gap-0.5 border-l-2 pl-3 text-xs"
            :class="check.blocked ? 'border-destructive/50' : 'border-warning/50'"
          >
            <li
              v-for="(problem, index) in check.problems"
              :key="index"
              :data-level="problem.level"
              :class="problem.level === 'error' ? 'text-destructive' : 'text-muted-foreground'"
            >
              {{ problem.message }}
            </li>
          </ul>
          <p class="text-xs text-muted-foreground">
            {{ PROJECT_FILE_NOTE }}
          </p>
        </template>
      </div>

      <SheetFooter class="mt-0 flex-col-reverse gap-2 border-t bg-popover p-4 sm:flex-row sm:justify-end">
        <Button v-if="gone" type="button" variant="outline" class="pointer-coarse:h-10" @click="emit('update:open', false)">
          Close
        </Button>
        <template v-else>
          <Button type="button" variant="outline" :disabled="saving" class="pointer-coarse:h-10" @click="requestClose(false)">
            Cancel
          </Button>
          <Button
            type="button"
            :disabled="!canSave"
            :aria-busy="saving || undefined"
            :data-testid="testIds.projectFileSave"
            class="pointer-coarse:h-10"
            @click="submit"
          >
            <Spinner v-if="saving" data-icon="inline-start" />
            Save file
          </Button>
        </template>
      </SheetFooter>
    </SheetContent>
  </Sheet>
  <ConfirmDialog
    :open="discardOpen"
    title="Discard changes?"
    description="Your changes are lost."
    confirm-label="Discard"
    cancel-label="Keep editing"
    :data-testid="testIds.projectFileDiscardConfirm"
    @update:open="value => discardOpen = value"
    @confirm="discard"
  />
</template>
