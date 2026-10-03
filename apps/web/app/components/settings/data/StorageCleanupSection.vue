<script setup lang="ts">
// Settings -> Data, "Storage cleanup" (docs/UI.md 9.8; docs/API.md 5.19; ADR-035): Check for unused files
// (data-cleanup-check -> `GET /api/data/cleanup`, a dry run that reads every message, so it shows a spinner), the
// summary (data-cleanup-summary), Remove… (data-cleanup-run, enabled only after a check found something) and its
// ConfirmDialog (data-cleanup-confirm -> `POST /api/data/cleanup`, not a fresh-auth route) -> toast "Removed {files}
// files ({size})"; then the check runs again and the summary line reloads. The confirm counts come from the last check
// (the server re-checks every file when it deletes). 409 `busy` -> the busy toast; other failures -> an error toast.
// Contract (docs/UI.md 10.4): no props, no emits; root data-cleanup-section.
import type { DataCleanupPreview } from '@harness-forge/shared'
import { ScanSearchIcon, Trash2Icon } from '@lucide/vue'
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import RelativeTime from '~/components/common/RelativeTime.vue'
import { useApi } from '~/composables/useApi'
import { withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'
import SettingsSection from '../SettingsSection.vue'
import {
  BUSY_MESSAGE,
  cleanupConfirmText,
  cleanupHeadline,
  cleanupResultMessage,
  hasRemovableFiles,
  isBusyConflict,
  recentFilesLine,
} from './data'
import { useDataSettingsContext } from './data-context'

const api = useApi()
const page = useDataSettingsContext()

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
