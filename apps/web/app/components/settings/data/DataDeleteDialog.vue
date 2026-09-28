<script setup lang="ts">
// "Delete all data?" (docs/UI.md 9.8, 14.1): what gets deleted, "Also delete uploaded files" and "Also delete usage
// history" (both unchecked, like the API defaults) and "Type DELETE to confirm" (case-sensitive, focused on open);
// "Delete everything" is enabled only when the input is exactly DELETE. Every opening starts over. Presentational: it
// emits `confirm` with the choices, and the parent sends the request and passes `pending`. The `trigger` slot becomes
// the dialog trigger, so closing the dialog returns focus to it.
import type { DataSummary } from '@harness-forge/shared'
import type { DeleteAllOptions } from './data'
import { computed, ref, useId, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { testIds } from '~/utils/testids'
import { DELETE_CONFIRMATION, deleteDescription } from './data'

const props = withDefaults(defineProps<{
  open: boolean
  /** Counts for the text; null leaves them out. */
  summary: DataSummary | null
  /** The request (or its password prompt) is running: nothing can change and the dialog stays open. */
  pending?: boolean
}>(), {
  pending: false,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'confirm': [options: DeleteAllOptions]
}>()

defineSlots<{
  /** The button that opens the dialog ("Delete all data…"). */
  trigger?: () => any
}>()

const ids = { confirm: useId(), submit: useId() }

const typed = ref('')
const deleteFiles = ref(false)
const deleteUsage = ref(false)

const confirmed = computed(() => typed.value === DELETE_CONFIRMATION)
const description = computed(() => deleteDescription(props.summary))

watch(() => props.open, (open) => {
  if (!open)
    return
  typed.value = ''
  deleteFiles.value = false
  deleteUsage.value = false
})

function onOpenChange(value: boolean): void {
  if (!value && props.pending)
    return
  emit('update:open', value)
}

function onOpenAutoFocus(event: Event): void {
  const input = document.getElementById(ids.confirm)
  if (!input)
    return
  event.preventDefault()
  input.focus()
}

function onSubmit(): void {
  if (!confirmed.value || props.pending)
    return
  emit('confirm', { files: deleteFiles.value, usage: deleteUsage.value })
}

/** Moves focus to "Delete everything", e.g. after a password prompt on top of this dialog was closed. */
function focusSubmit(): void {
  document.getElementById(ids.submit)?.focus()
}

defineExpose({ focusSubmit })
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogTrigger v-if="$slots.trigger" as-child>
      <slot name="trigger" />
    </DialogTrigger>
    <DialogContent
      :data-testid="testIds.dataDeleteDialog"
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
      @open-auto-focus="onOpenAutoFocus"
    >
      <form class="grid gap-5" novalidate @submit.prevent="onSubmit">
        <DialogHeader>
          <DialogTitle>Delete all data?</DialogTitle>
          <DialogDescription>{{ description }}</DialogDescription>
        </DialogHeader>

        <div class="grid gap-2">
          <Label class="items-start gap-2.5 rounded-lg border px-3 py-2.5 font-normal">
            <Checkbox
              :model-value="deleteFiles"
              :disabled="pending"
              :data-testid="testIds.dataDeleteFiles"
              class="mt-0.5"
              @update:model-value="value => deleteFiles = value === true"
            />
            <span class="flex flex-col gap-0.5">
              <span class="font-medium">Also delete uploaded files</span>
              <span class="text-xs leading-normal text-muted-foreground">Attachments are removed from the disk too.</span>
            </span>
          </Label>
          <Label class="items-start gap-2.5 rounded-lg border px-3 py-2.5 font-normal">
            <Checkbox
              :model-value="deleteUsage"
              :disabled="pending"
              :data-testid="testIds.dataDeleteUsage"
              class="mt-0.5"
              @update:model-value="value => deleteUsage = value === true"
            />
            <span class="flex flex-col gap-0.5">
              <span class="font-medium">Also delete usage history</span>
              <span class="text-xs leading-normal text-muted-foreground">Otherwise token and cost records are kept without their chats.</span>
            </span>
          </Label>
        </div>

        <div class="grid gap-2">
          <Label :for="ids.confirm">
            Type DELETE to confirm
          </Label>
          <Input
            :id="ids.confirm"
            v-model="typed"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            autofocus
            class="font-mono"
            :disabled="pending"
            :data-testid="testIds.dataDeleteConfirmInput"
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" :disabled="pending" @click="onOpenChange(false)">
            Cancel
          </Button>
          <Button
            :id="ids.submit"
            type="submit"
            variant="destructive"
            :disabled="!confirmed || pending"
            :aria-busy="pending || undefined"
            :data-testid="testIds.dataDeleteSubmit"
          >
            <Spinner v-if="pending" data-icon="inline-start" />
            Delete everything
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
