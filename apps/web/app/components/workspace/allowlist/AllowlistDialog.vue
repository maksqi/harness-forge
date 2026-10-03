<script setup lang="ts">
// "Allowed commands in {name}" (docs/UI.md 2.15, 7.23, 9.10; ADR-038), opened by the "Allowed commands…" item of a
// project row menu (project-allowlist) in Settings -> Projects: AllowlistEditor with the project's id.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and emits below; root allowlist-dialog (the dialog
// content). Stub (C20, P8-0b): the title and the editor stub (W8.11).
import type { ProjectSummary } from '@harness-forge/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { testIds } from '~/utils/testids'
import AllowlistEditor from './AllowlistEditor.vue'

defineProps<{
  open: boolean
  /** The project whose rules are edited; null while closed. */
  project: ProjectSummary | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()
</script>

<template>
  <Dialog :open="open && project !== null" @update:open="emit('update:open', $event)">
    <DialogContent
      :data-testid="testIds.allowlistDialog"
      class="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto"
    >
      <DialogHeader>
        <DialogTitle>Allowed commands in {{ project?.name }}</DialogTitle>
        <DialogDescription>
          Shell commands that start with one of these run without asking in this project.
        </DialogDescription>
      </DialogHeader>
      <AllowlistEditor v-if="project" :project-id="project.id" />
    </DialogContent>
  </Dialog>
</template>
