<script setup lang="ts">
// Export of Settings -> Data (docs/UI.md 9.8, docs/API.md 5.19): "Include attachments" and "Include settings" (both on)
// become the query of `GET /api/data/export`; every backup also holds the personal agents, commands and skills of
// Settings -> Customize (Phase 10, `customizations.json`; Phase 11: the personal output styles too, never the personal
// hooks, the project approvals or the project MCP variables); the zip streams in and is saved through
// `downloadResponse`. A warning shows while the attachments alone exceed what the browser import accepts. A failure,
// e.g. 413 `payload_too_large` when the zip would exceed the server's limits, becomes a toast with the server message.
import type { DataSummary } from '@harness-forge/shared'
import { DownloadIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useApi } from '~/composables/useApi'
import { downloadResponse } from '~/utils/download'
import { withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'
import SettingsSection from '../SettingsSection.vue'
import { BACKUP_FILE_NAME, exceedsImportLimit, EXPORT_LIMIT_WARNING, filesLabel } from './data'

const props = defineProps<{
  /** `GET /api/data`, or null while it loads or after it failed. */
  summary: DataSummary | null
}>()

const api = useApi()
const ids = { files: useId(), settings: useId() }

const includeFiles = ref(true)
const includeSettings = ref(true)
const exporting = ref(false)

const filesHint = computed(() => (props.summary
  ? filesLabel(props.summary.files, props.summary.fileBytes)
  : 'Files attached to your messages.'))
const tooLargeToImport = computed(() => includeFiles.value && props.summary !== null && exceedsImportLimit(props.summary))

async function exportBackup(): Promise<void> {
  if (exporting.value)
    return
  exporting.value = true
  try {
    const response = await withHarnessErrors(api.data.export({
      query: { files: includeFiles.value, settings: includeSettings.value },
    }))
    await downloadResponse(response, BACKUP_FILE_NAME)
  }
  catch (error) {
    toastError(error)
  }
  finally {
    exporting.value = false
  }
}
</script>

<template>
  <SettingsSection
    title="Export"
    description="Download a zip with every chat, including archived chats and every message version, and your personal agents, commands, skills and output styles. API keys, passwords, plugins, MCP servers, hooks, project approvals and share links are never included."
  >
    <div class="grid gap-4 sm:grid-cols-2">
      <Field orientation="horizontal">
        <Switch
          :id="ids.files"
          v-model="includeFiles"
          class="mt-0.5"
          :disabled="exporting"
          :data-testid="testIds.dataExportFiles"
        />
        <FieldContent>
          <FieldLabel :for="ids.files">
            Include attachments
          </FieldLabel>
          <FieldDescription class="tabular-nums">
            {{ filesHint }}
          </FieldDescription>
        </FieldContent>
      </Field>
      <Field orientation="horizontal">
        <Switch
          :id="ids.settings"
          v-model="includeSettings"
          class="mt-0.5"
          :disabled="exporting"
          :data-testid="testIds.dataExportSettings"
        />
        <FieldContent>
          <FieldLabel :for="ids.settings">
            Include settings
          </FieldLabel>
          <FieldDescription>General and appearance settings. They are restored only when you choose to.</FieldDescription>
        </FieldContent>
      </Field>
    </div>

    <Alert
      v-if="tooLargeToImport"
      :data-testid="testIds.dataExportWarning"
      class="border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning"
    >
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription class="text-foreground">
        {{ EXPORT_LIMIT_WARNING }}
      </AlertDescription>
    </Alert>

    <div class="flex justify-end">
      <Button
        type="button"
        class="w-full sm:w-auto"
        :disabled="exporting"
        :aria-busy="exporting || undefined"
        :data-testid="testIds.dataExport"
        @click="exportBackup"
      >
        <Spinner v-if="exporting" data-icon="inline-start" />
        <DownloadIcon v-else aria-hidden="true" data-icon="inline-start" />
        Export backup
      </Button>
    </div>
  </SettingsSection>
</template>
