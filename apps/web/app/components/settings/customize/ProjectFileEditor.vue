<script setup lang="ts">
// The project file editor (Phase 12, ADR-056; docs/UI.md 2.19, 9.14, 10.9): a right-side sheet (`project-file-editor`,
// `data-kind` agent | command | skill | style | mcp, `data-path`, `data-mode` edit | new) titled "Edit {file}" ("New
// {kind}" for a new file) that edits the **raw** file (`project-file-content`), so unknown keys survive byte for byte.
// Save file (`project-file-save`) → `useCustomizationsStore().saveProjectFile(projectId, { path, expectedSha256, content
// | mcpServers })` (no fresh auth, never approves; allowed while a chat runs: there is no busy state) → `saved({ path,
// pending })`; a changed file (409 `conflict` reason `stale`) shows `project-file-conflict` (`role="alert"`) with Load
// from disk (`project-file-reload`) and Overwrite (`project-file-overwrite`); errors `project-file-error` (`data-code`);
// closing with edits asks "Discard changes?" (`project-file-discard-confirm`). `review(sha256?)` asks the host to open
// ProjectTrustDialog. Mounted by CustomizeSettings (Edit… of project rows, the viewer's Edit) and ProjectMcpDialog (Edit
// .mcp.json…, kind `mcp`). Never asks for a password.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); W12.11 implements the editor in P12-A (the
// MarkdownEditor with lint markers, the parsed summary, the toast with Review, New file…).
import type { ProjectFileTarget } from './customize'
import { computed, ref, watch } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import { isStaleReview } from '~/components/plugins/install/install'
import { useCustomizationsStore } from '~/stores/customizations'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'

const props = defineProps<{ open: boolean, projectId: string | null, entry: ProjectFileTarget | null }>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  'saved': [saved: { path: string, pending: number }]
  'review': [sha256?: string]
}>()

const customizations = useCustomizationsStore()

const content = ref('')
const loaded = ref('')
const sha256 = ref<string | null>(null)
const loading = ref(false)
const saving = ref(false)
const conflict = ref(false)
const discardOpen = ref(false)
const error = ref<{ code: string, message: string } | null>(null)
let session = 0

const fileName = computed(() => props.entry?.path.split('/').at(-1) ?? '')
const mode = computed(() => (props.entry?.create ? 'new' : 'edit'))
const dirty = computed(() => content.value !== loaded.value)

async function load(): Promise<void> {
  const current = ++session
  const entry = props.entry
  content.value = ''
  loaded.value = ''
  sha256.value = null
  conflict.value = false
  error.value = null
  if (!entry || !props.projectId)
    return
  loading.value = true
  try {
    const file = await customizations.readProjectFile(props.projectId, entry.path)
    if (current !== session)
      return
    content.value = file.content ?? ''
    loaded.value = content.value
    sha256.value = file.sha256
  }
  catch (failure) {
    if (current === session) {
      const harnessError = toHarnessError(failure)
      error.value = { code: harnessError.code, message: harnessError.message }
    }
  }
  finally {
    if (current === session)
      loading.value = false
  }
}

watch(() => [props.open, props.projectId, props.entry?.path] as const, ([open]) => {
  if (open) {
    void load()
  }
  else {
    session += 1
    discardOpen.value = false
  }
}, { immediate: true })

/** The `mcpServers` object of the `.mcp.json` text (with or without the wrapper); throws on invalid JSON. */
function mcpServersOf(text: string): Record<string, unknown> | null {
  if (text.trim() === '')
    return null
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new SyntaxError('Expected a JSON object.')
  const record = parsed as Record<string, unknown>
  const servers = Object.hasOwn(record, 'mcpServers') ? record.mcpServers : record
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers) ? servers as Record<string, unknown> : {}
}

async function save(expected: string | null = sha256.value): Promise<void> {
  const entry = props.entry
  const projectId = props.projectId
  if (!entry || !projectId || saving.value)
    return
  saving.value = true
  error.value = null
  conflict.value = false
  try {
    const body = entry.kind === 'mcp'
      ? { path: '.mcp.json' as const, expectedSha256: expected, mcpServers: mcpServersOf(content.value) }
      : { path: entry.path, expectedSha256: expected, content: content.value }
    const result = await customizations.saveProjectFile(projectId, body)
    loaded.value = content.value
    sha256.value = result.sha256
    emit('saved', { path: result.path, pending: result.trust.pending })
    emit('update:open', false)
  }
  catch (failure) {
    if (isStaleReview(failure)) {
      conflict.value = true
    }
    else {
      const harnessError = failure instanceof SyntaxError ? { code: 'validation_error', message: 'This isn\'t valid JSON.' } : toHarnessError(failure)
      error.value = { code: harnessError.code, message: harnessError.message }
    }
  }
  finally {
    saving.value = false
  }
}

async function overwrite(): Promise<void> {
  const entry = props.entry
  if (!entry || !props.projectId)
    return
  try {
    const file = await customizations.readProjectFile(props.projectId, entry.path)
    await save(file.sha256)
  }
  catch (failure) {
    const harnessError = toHarnessError(failure)
    error.value = { code: harnessError.code, message: harnessError.message }
  }
}

function requestClose(value: boolean): void {
  if (!value && dirty.value && !saving.value) {
    discardOpen.value = true
    return
  }
  emit('update:open', value)
}

function discard(): void {
  discardOpen.value = false
  content.value = loaded.value
  emit('update:open', false)
}
</script>

<template>
  <Sheet :open="open" @update:open="requestClose">
    <SheetContent
      :data-testid="testIds.projectFileEditor"
      :data-kind="entry?.kind"
      :data-path="entry?.path"
      :data-mode="mode"
      class="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
    >
      <SheetHeader class="border-b p-4">
        <SheetTitle>{{ mode === 'new' ? `New ${entry?.kind ?? 'file'}` : `Edit ${fileName}` }}</SheetTitle>
        <SheetDescription class="font-mono text-xs">
          {{ entry?.path }}
        </SheetDescription>
      </SheetHeader>
      <div class="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-4">
        <Alert v-if="conflict" role="alert" tabindex="-1" :data-testid="testIds.projectFileConflict">
          <AlertDescription class="flex flex-wrap items-center gap-2 text-foreground">
            <span>{{ fileName }} changed on disk after you opened it.</span>
            <Button type="button" size="sm" variant="outline" :data-testid="testIds.projectFileReload" @click="load">
              Load from disk
            </Button>
            <Button type="button" size="sm" variant="outline" :data-testid="testIds.projectFileOverwrite" @click="overwrite">
              Overwrite
            </Button>
          </AlertDescription>
        </Alert>
        <Textarea
          v-model="content"
          aria-label="File content"
          spellcheck="false"
          class="min-h-64 font-mono text-[13px]"
          :disabled="loading"
          :data-testid="testIds.projectFileContent"
        />
        <p v-if="error" role="alert" :data-testid="testIds.projectFileError" :data-code="error.code" class="text-sm text-destructive">
          {{ error.message }}
        </p>
        <p class="text-xs text-muted-foreground">
          Saving never approves hooks or shell lines.
        </p>
      </div>
      <SheetFooter class="mt-0 flex-col-reverse gap-2 border-t p-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" @click="requestClose(false)">
          Cancel
        </Button>
        <Button type="button" :disabled="loading || saving" :data-testid="testIds.projectFileSave" @click="save()">
          Save file
        </Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
  <ConfirmDialog
    :open="discardOpen"
    title="Discard changes?"
    description="Your changes are lost."
    confirm-label="Discard"
    cancel-label="Keep editing"
    destructive
    :data-testid="testIds.projectFileDiscardConfirm"
    @update:open="value => discardOpen = value"
    @confirm="discard"
  />
</template>
