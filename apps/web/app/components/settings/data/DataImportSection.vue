<script setup lang="ts">
// Import of Settings -> Data (docs/UI.md 9.8, 7.4; docs/API.md 5.19): a backup zip or a chat exported as JSON (at most
// 256 MB, checked before the upload), "If a chat already exists" (skip / copy) and "Restore settings from the backup"
// (zip only) -> `POST /api/data/import` (multipart). Phase 10 (ADR-044): the same switch also restores the personal
// agents, commands and skills of the backup (`restoreCustomizations`; a definition you already have is kept). The
// result panel lists every chat; the chat list reloads, and so do the settings when the backup restored them, and the
// customizations when it restored any. 409 `busy` and 413 become toasts, other failures show inline.
import type { DataConflictPolicy, DataImportResult } from '@harness-forge/shared'
import { CircleAlertIcon, FileArchiveIcon, FileBracesIcon, FolderOpenIcon, UploadIcon } from '@lucide/vue'
import { computed, nextTick, ref, useId } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatBytes } from '~/components/common/format'
import { useApi } from '~/composables/useApi'
import { useChatsStore } from '~/stores/chats'
import { useCustomizationsStore } from '~/stores/customizations'
import { useSettingsStore } from '~/stores/settings'
import { toHarnessError, withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'
import SettingsSection from '../SettingsSection.vue'
import { BUSY_MESSAGE, IMPORT_LIMIT_LABEL, importAnnouncement, importFileProblem, importKindOf, isBusyConflict } from './data'
import DataImportResultPanel from './DataImportResultPanel.vue'

const emit = defineEmits<{
  /** An import finished (some chats may have failed): what is stored changed. */
  imported: [result: DataImportResult]
}>()

const api = useApi()
const chats = useChatsStore()
const settings = useSettingsStore()
const customizations = useCustomizationsStore()
const ids = { fileName: useId(), policy: useId(), restore: useId() }

const POLICY_OPTIONS: ReadonlyArray<{ value: DataConflictPolicy, label: string, hint: string }> = [
  { value: 'skip', label: 'Skip it', hint: 'The chat that is already here stays as it is.' },
  { value: 'copy', label: 'Import a copy', hint: 'The chat is imported again with new ids and " (imported)" after its title.' },
]

const fileInput = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const policy = ref<DataConflictPolicy>('skip')
const restoreSettings = ref(false)
const importing = ref(false)
const failure = ref<{ code: string, message: string } | null>(null)
const result = ref<DataImportResult | null>(null)
const announcement = ref('')

const kind = computed(() => (file.value ? importKindOf(file.value) : null))
const policyHint = computed(() => POLICY_OPTIONS.find(option => option.value === policy.value)?.hint)
const restoreHint = computed(() => (kind.value === 'chat'
  ? 'A chat exported as JSON carries no settings.'
  : 'General and appearance settings, and your personal agents, commands and skills. A personal definition you already have with the same name is kept.'))

function chooseFile(): void {
  fileInput.value?.click()
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const chosen = input.files?.[0] ?? null
  // Choosing the same file again (e.g. after it changed on disk) fires `change` again.
  input.value = ''
  if (!chosen)
    return
  result.value = null
  const problem = importFileProblem(chosen)
  if (problem) {
    file.value = null
    failure.value = { code: 'payload_too_large', message: problem }
    return
  }
  failure.value = null
  file.value = chosen
}

function onPolicy(value: unknown): void {
  // A single ToggleGroup emits an empty value when the active item is clicked again: keep the choice.
  if (value === 'skip' || value === 'copy')
    policy.value = value
}

async function announce(text: string): Promise<void> {
  announcement.value = ''
  await nextTick()
  announcement.value = text
}

async function runImport(): Promise<void> {
  const chosen = file.value
  if (!chosen || importing.value)
    return
  importing.value = true
  failure.value = null
  result.value = null
  // The small fields go first: a streaming multipart parser reads them before the upload.
  const form = new FormData()
  form.set('onConflict', policy.value)
  const restore = String(kind.value === 'backup' && restoreSettings.value)
  form.set('restoreSettings', restore)
  form.set('restoreCustomizations', restore)
  form.set('file', chosen, chosen.name)
  try {
    const outcome = await withHarnessErrors(api.data.import({ form }))
    result.value = outcome
    void announce(importAnnouncement(outcome))
    emit('imported', outcome)
    // `chat.created` events add the chats as they arrive; the reload also covers events missed while the event
    // stream reconnected.
    chats.fetchPage({ reset: true }).catch(() => {})
    if (outcome.settingsRestored)
      settings.fetch().catch(() => {})
    if ((outcome.customizations?.imported ?? 0) > 0)
      customizations.refreshLoaded().catch(() => {})
  }
  catch (error) {
    const harnessError = toHarnessError(error)
    if (isBusyConflict(harnessError))
      toast.error(BUSY_MESSAGE)
    else if (harnessError.code === 'payload_too_large')
      toastError(harnessError)
    else
      failure.value = { code: harnessError.code, message: harnessError.message }
  }
  finally {
    importing.value = false
  }
}
</script>

<template>
  <SettingsSection
    title="Import"
    description="Restore a backup zip or a chat exported as JSON. Chats are imported one by one; a failed chat does not stop the others."
  >
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Button
        type="button"
        variant="outline"
        class="w-full sm:w-auto"
        :disabled="importing"
        :aria-describedby="ids.fileName"
        @click="chooseFile"
      >
        <FolderOpenIcon aria-hidden="true" data-icon="inline-start" />
        Choose file…
      </Button>
      <p :id="ids.fileName" class="flex min-w-0 items-center gap-2 text-sm" data-slot="data-import-file-name">
        <template v-if="file">
          <FileBracesIcon v-if="kind === 'chat'" aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
          <FileArchiveIcon v-else aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 truncate font-medium">{{ file.name }}</span>
          <span class="shrink-0 text-muted-foreground tabular-nums">{{ formatBytes(file.size) }}</span>
        </template>
        <span v-else class="text-muted-foreground">No file chosen. A .zip backup or a .json chat, up to {{ IMPORT_LIMIT_LABEL }}.</span>
      </p>
      <input
        ref="fileInput"
        type="file"
        accept=".zip,.json,application/zip,application/x-zip-compressed,application/json"
        class="sr-only"
        tabindex="-1"
        aria-label="Backup or chat file"
        :data-testid="testIds.dataImportFile"
        @change="onFileChange"
      >
    </div>

    <Alert
      v-if="failure"
      variant="destructive"
      :data-testid="testIds.dataImportError"
      :data-code="failure.code"
    >
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{{ failure.message }}</AlertDescription>
    </Alert>

    <FieldGroup class="gap-5">
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :id="ids.policy">
            If a chat already exists
          </FieldLabel>
          <FieldDescription>{{ policyHint }}</FieldDescription>
        </FieldContent>
        <ToggleGroup
          type="single"
          variant="outline"
          :model-value="policy"
          :disabled="importing"
          :aria-labelledby="ids.policy"
          :data-testid="testIds.dataImportPolicy"
          :data-value="policy"
          @update:model-value="onPolicy"
        >
          <ToggleGroupItem
            v-for="option in POLICY_OPTIONS"
            :key="option.value"
            :value="option.value"
            :data-value="option.value"
            class="px-3"
          >
            {{ option.label }}
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>

      <Field orientation="horizontal" :data-disabled="kind === 'chat' || undefined">
        <Switch
          :id="ids.restore"
          :model-value="kind !== 'chat' && restoreSettings"
          class="mt-0.5"
          :disabled="kind === 'chat' || importing"
          :data-testid="testIds.dataImportRestoreSettings"
          @update:model-value="value => restoreSettings = value"
        />
        <FieldContent>
          <FieldLabel :for="ids.restore">
            Restore settings from the backup
          </FieldLabel>
          <FieldDescription>{{ restoreHint }}</FieldDescription>
        </FieldContent>
      </Field>
    </FieldGroup>

    <div class="flex justify-end">
      <Button
        type="button"
        class="w-full sm:w-auto"
        :disabled="!file || importing"
        :aria-busy="importing || undefined"
        :data-testid="testIds.dataImport"
        @click="runImport"
      >
        <Spinner v-if="importing" data-icon="inline-start" />
        <UploadIcon v-else aria-hidden="true" data-icon="inline-start" />
        {{ importing ? 'Importing…' : 'Import' }}
      </Button>
    </div>

    <DataImportResultPanel v-if="result" :result="result" />

    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </div>
  </SettingsSection>
</template>
