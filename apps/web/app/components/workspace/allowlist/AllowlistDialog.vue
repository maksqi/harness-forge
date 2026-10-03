<script setup lang="ts">
// "Allowed commands in {name}" (docs/UI.md 2.15, 7.23, 9.10; ADR-038), opened by the "Allowed commands…" item of a
// project row menu (project-allowlist) in Settings -> Projects: the explanation and AllowlistEditor with the project's
// id. It opens with focus on the add input (not on the first rule's Remove, which acts at once); closing gives focus
// back to the row menu button (reka).
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and emits below; root allowlist-dialog (the dialog
// content).
import type { ProjectSummary } from '@harness-forge/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { testIds } from '~/utils/testids'
import { allowlistDescription } from './allowlist'
import AllowlistEditor from './AllowlistEditor.vue'

defineProps<{
  open: boolean
  /** The project whose rules are edited; null while closed. */
  project: ProjectSummary | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

function onOpenAutoFocus(event: Event): void {
  // The event is dispatched on the dialog content (reka FocusScope).
  const scope: ParentNode = event.currentTarget instanceof HTMLElement ? event.currentTarget : document
  const input = scope.querySelector<HTMLInputElement>(`[data-testid="${testIds.allowlistInput}"]`)
  if (!input)
    return
  event.preventDefault()
  input.focus()
}
</script>

<template>
  <Dialog :open="open && project !== null" @update:open="emit('update:open', $event)">
    <DialogContent
      :data-testid="testIds.allowlistDialog"
      class="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto"
      @open-auto-focus="onOpenAutoFocus"
    >
      <DialogHeader>
        <DialogTitle class="pr-6 break-words">
          Allowed commands in {{ project?.name }}
        </DialogTitle>
        <DialogDescription>
          {{ allowlistDescription('project') }}
        </DialogDescription>
      </DialogHeader>
      <AllowlistEditor v-if="project" :project-id="project.id" />
    </DialogContent>
  </Dialog>
</template>
