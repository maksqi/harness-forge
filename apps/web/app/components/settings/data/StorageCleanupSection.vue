<script setup lang="ts">
import type { DataCleanupPreview, FileSweepMode, FileSweepStatus } from '@harness-forge/shared'
// Settings -> Data, "Storage cleanup" (docs/UI.md 9.8; docs/API.md 5.19; ADR-035): Check for unused files
// (data-cleanup-check -> `GET /api/data/cleanup`, a dry run that reads every message, so it shows a spinner), the
// summary (data-cleanup-summary), Remove… (data-cleanup-run, enabled only after a check found something) and its
// ConfirmDialog (data-cleanup-confirm -> `POST /api/data/cleanup`, not a fresh-auth route) -> toast "Removed {files}
// files ({size})"; then the check runs again and the summary line reloads. The confirm counts come from the last check
// (the server re-checks every file when it deletes). 409 `busy` -> the busy toast; other failures -> an error toast.
// Phase 8 (ADR-039): a scan of the plugin data that hit its budget adds a warning to the summary
// (data-slot="cleanup-plugin-data"). Below the buttons, Automatic cleanup: the switch (data-cleanup-auto) and the
// interval select (data-cleanup-interval, data-value daily | weekly; disabled while off) write the one setting
// `fileSweep` through `settings.update()` (optimistic; a failure rolls back with an error toast; turning the switch on
// writes the interval shown, default daily), and the status line (data-cleanup-auto-status, data-state off | never |
// done | skipped | failed) comes from `DataSummary.fileSweep`: the section loads `GET /api/data` itself on mount and
// after every change and cleanup (a check also brings the state along).
// Contract (docs/UI.md 10.4): no props, no emits; root data-cleanup-section.
import type { AcceptableValue } from 'reka-ui'
import type { FileSweepInterval } from './data'
import { ScanSearchIcon, Trash2Icon, TriangleAlertIcon } from '@lucide/vue'
import { computed, nextTick, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import { useSharedNow } from '~/components/common/relative-time'
import RelativeTime from '~/components/common/RelativeTime.vue'
import { useApi } from '~/composables/useApi'
import { useSettingsStore } from '~/stores/settings'
import { withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'
import SettingsSection from '../SettingsSection.vue'
import {
  AUTO_CLEANUP_DESCRIPTION,
  BUSY_MESSAGE,
  CLEANUP_PLUGIN_DATA_WARNING,
  cleanupConfirmText,
  cleanupHeadline,
  cleanupResultMessage,
  DEFAULT_FILE_SWEEP_INTERVAL,
  FILE_SWEEP_FAILED,
  FILE_SWEEP_INTERVALS,
  FILE_SWEEP_SKIPPED,
  fileSweepIntervalLabel,
  fileSweepRemovedText,
  fileSweepState,
  hasRemovableFiles,
  isBusyConflict,
  isFileSweepInterval,
  recentFilesLine,
} from './data'
import { useDataSettingsContext } from './data-context'

const api = useApi()
const page = useDataSettingsContext()
const settings = useSettingsStore()
const now = useSharedNow()
const ids = { auto: useId(), autoDescription: useId() }

const preview = ref<DataCleanupPreview | null>(null)
const checking = ref(false)
const removing = ref(false)
const confirmOpen = ref(false)
const announcement = ref('')
const checkButton = useTemplateRef<{ $el: HTMLButtonElement }>('checkButton')
const removeButton = useTemplateRef<{ $el: HTMLButtonElement }>('removeButton')

const canRemove = computed(() => preview.value !== null && hasRemovableFiles(preview.value) && !removing.value)
const headline = computed(() => (preview.value ? cleanupHeadline(preview.value) : ''))
const recentLine = computed(() => (preview.value ? recentFilesLine(preview.value) : null))
const confirmText = computed(() => (preview.value ? cleanupConfirmText(preview.value) : ''))

// ---------- automatic cleanup ----------

/** The automatic sweep state from `GET /api/data` (or the last check); null until it arrived. */
const sweep = ref<FileSweepStatus | null>(null)
let sweepSeq = 0

/** The `fileSweep` setting: the settings store once it holds values (optimistic ones included), else the status. */
const mode = computed<FileSweepMode>(() =>
  settings.settings !== null ? settings.resolved.fileSweep : (sweep.value?.mode ?? 'off'))
const autoOn = computed(() => mode.value !== 'off')
/** The interval shown: the setting while on, else the last one shown (default daily). */
const interval = ref<FileSweepInterval>(DEFAULT_FILE_SWEEP_INTERVAL)
watch(mode, (value) => {
  if (value !== 'off')
    interval.value = value
}, { immediate: true })

const sweepState = computed(() => (sweep.value ? fileSweepState(mode.value, sweep.value) : null))
const lastAttempt = computed(() => sweep.value?.lastAttempt ?? null)
const nextRunAt = computed(() => (autoOn.value ? (sweep.value?.nextRunAt ?? null) : null))

/** Loads the sweep state; a newer load wins. A failure keeps the line as it was (the page shows the summary error). */
async function loadSweep(): Promise<void> {
  const seq = ++sweepSeq
  try {
    const summary = await withHarnessErrors(api.data.summary())
    if (seq === sweepSeq)
      sweep.value = summary.fileSweep
  }
  catch {
    // Nothing to add: DataSettings shows "Could not load the data summary" for the same request.
  }
}

/** A check answered: its sweep state is as fresh as a summary. */
function takeSweep(status: FileSweepStatus): void {
  sweepSeq += 1
  sweep.value = status
}

async function saveSweep(next: FileSweepMode): Promise<void> {
  try {
    await settings.update({ fileSweep: next })
  }
  catch (error) {
    toastError(error)
    return
  }
  await loadSweep()
}

function onAutoChange(value: boolean): void {
  void saveSweep(value ? interval.value : 'off')
}

function onIntervalChange(value: AcceptableValue): void {
  if (!isFileSweepInterval(value) || value === interval.value)
    return
  interval.value = value
  if (autoOn.value)
    void saveSweep(value)
}

onMounted(() => {
  void loadSweep()
})

async function announce(text: string): Promise<void> {
  announcement.value = ''
  await nextTick()
  announcement.value = text
}

/** The dry run; true when it answered. */
async function check(): Promise<boolean> {
  if (checking.value)
    return false
  checking.value = true
  try {
    preview.value = await withHarnessErrors(api.data.cleanupPreview())
    takeSweep(preview.value.fileSweep)
  }
  catch (error) {
    if (isBusyConflict(error))
      toast.error(BUSY_MESSAGE)
    else
      toastError(error)
    return false
  }
  finally {
    checking.value = false
  }
  void announce(cleanupHeadline(preview.value))
  // "Remove…" may have become disabled under the keyboard focus: keep the focus in the section.
  await nextTick()
  const remove = removeButton.value?.$el
  if (remove && remove.disabled && document.activeElement === remove)
    checkButton.value?.$el.focus()
  return true
}

function onCheck(): void {
  void check()
}

function openConfirm(): void {
  if (canRemove.value && !checking.value)
    confirmOpen.value = true
}

function onConfirmOpenChange(value: boolean): void {
  if (!value && removing.value)
    return
  confirmOpen.value = value
}

async function onConfirmRemove(): Promise<void> {
  if (removing.value)
    return
  removing.value = true
  try {
    const result = await withHarnessErrors(api.data.cleanup())
    confirmOpen.value = false
    toast.success(cleanupResultMessage(result))
  }
  catch (error) {
    if (isBusyConflict(error))
      toast.error(BUSY_MESSAGE)
    else
      toastError(error)
    return
  }
  finally {
    removing.value = false
  }
  page.reloadSummary()
  // A manual cleanup also resets the schedule of the automatic one.
  void loadSweep()
  await check()
}
</script>

<template>
  <SettingsSection
    :data-testid="testIds.dataCleanupSection"
    title="Storage cleanup"
    description="Remove uploaded and generated files that no chat, share link, plugin or setting uses anymore. Files from the last 24 hours are kept, and deleting a chat or a version keeps its files until the next cleanup."
  >
    <div
      v-if="preview"
      :data-testid="testIds.dataCleanupSummary"
      :data-state="hasRemovableFiles(preview) ? 'removable' : 'empty'"
      class="flex flex-col gap-0.5 rounded-xl border bg-card px-4 py-3 text-sm text-card-foreground"
    >
      <p class="font-medium tabular-nums">
        {{ headline }}
      </p>
      <p v-if="recentLine" class="text-muted-foreground tabular-nums">
        {{ recentLine }}
      </p>
      <p v-if="preview.lastRunAt !== null" class="text-muted-foreground">
        Last cleanup <RelativeTime :at="preview.lastRunAt" />
      </p>
      <p v-if="preview.pluginData === 'partial'" data-slot="cleanup-plugin-data" class="mt-1 flex items-start gap-2 text-muted-foreground">
        <TriangleAlertIcon aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-warning" />
        <span>{{ CLEANUP_PLUGIN_DATA_WARNING }}</span>
      </p>
    </div>

    <div class="flex flex-col gap-2 sm:flex-row sm:justify-end">
      <Button
        ref="checkButton"
        type="button"
        variant="outline"
        class="w-full sm:w-auto"
        :disabled="checking || removing"
        :aria-busy="checking || undefined"
        :data-testid="testIds.dataCleanupCheck"
        @click="onCheck"
      >
        <Spinner v-if="checking" data-icon="inline-start" />
        <ScanSearchIcon v-else aria-hidden="true" data-icon="inline-start" />
        Check for unused files
      </Button>
      <Button
        ref="removeButton"
        type="button"
        variant="outline"
        class="w-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive sm:w-auto dark:border-destructive/40 dark:hover:bg-destructive/15"
        :disabled="!canRemove"
        :data-testid="testIds.dataCleanupRun"
        @click="openConfirm"
      >
        <Trash2Icon aria-hidden="true" data-icon="inline-start" />
        Remove…
      </Button>
    </div>

    <div class="flex flex-col gap-3 border-t pt-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <Switch
            :id="ids.auto"
            class="mt-0.5 pointer-coarse:after:-inset-y-3"
            :model-value="autoOn"
            :aria-describedby="ids.autoDescription"
            :data-testid="testIds.dataCleanupAuto"
            @update:model-value="onAutoChange"
          />
          <div class="flex min-w-0 flex-col gap-1">
            <Label :for="ids.auto">Automatic cleanup</Label>
            <p :id="ids.autoDescription" class="text-sm text-muted-foreground">
              {{ AUTO_CLEANUP_DESCRIPTION }}
            </p>
          </div>
        </div>
        <Select :model-value="interval" :disabled="!autoOn" @update:model-value="onIntervalChange">
          <SelectTrigger
            class="w-full sm:w-40 pointer-coarse:min-h-10"
            aria-label="Automatic cleanup interval"
            :data-testid="testIds.dataCleanupInterval"
            :data-value="interval"
          >
            <span>{{ fileSweepIntervalLabel(interval) }}</span>
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem v-for="option in FILE_SWEEP_INTERVALS" :key="option.value" :value="option.value" :data-value="option.value">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div
        v-if="sweepState"
        :data-testid="testIds.dataCleanupAutoStatus"
        :data-state="sweepState"
        class="flex flex-col gap-0.5 text-sm text-muted-foreground sm:pl-11"
      >
        <p v-if="sweepState === 'done' && lastAttempt">
          Last automatic cleanup <RelativeTime :at="lastAttempt.at" />: {{ fileSweepRemovedText(lastAttempt) }}
        </p>
        <p v-else-if="sweepState === 'skipped'">
          {{ FILE_SWEEP_SKIPPED }}
        </p>
        <p v-else-if="sweepState === 'failed'" class="text-destructive">
          {{ FILE_SWEEP_FAILED }}
        </p>
        <p v-if="nextRunAt !== null">
          <template v-if="nextRunAt > now">
            Next automatic cleanup <RelativeTime :at="nextRunAt" />.
          </template>
          <template v-else>
            Next automatic cleanup soon.
          </template>
        </p>
      </div>
    </div>

    <ConfirmDialog
      :open="confirmOpen"
      title="Remove unused files?"
      :description="confirmText"
      confirm-label="Remove files"
      :pending="removing"
      :data-testid="testIds.dataCleanupConfirm"
      @update:open="onConfirmOpenChange"
      @confirm="onConfirmRemove"
    />

    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </div>
  </SettingsSection>
</template>
