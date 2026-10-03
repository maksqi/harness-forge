<script setup lang="ts">
// Project instructions dialog (docs/UI.md 9.10; ADR-031): title "Instructions for {name}", a Textarea
// (project-instructions-input, at most 20,000 characters with the counter), the note about AGENTS.md / CLAUDE.md, Cancel
// and Save (project-instructions-save) -> projects.update(id, { instructions }) (an empty text saves null), then
// saved(project).
// Contract (docs/UI.md 10.4): props / emits below; root project-instructions-dialog (the dialog content).
// Stub (C15, P7-0b): implemented by W7.9 in P7-A; props and emits are frozen. The stub shows the title only.
import type { ProjectSummary } from '@harness-forge/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { testIds } from '~/utils/testids'

defineProps<{
  open: boolean
  project: ProjectSummary | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'saved': [project: ProjectSummary]
}>()
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent :data-testid="testIds.projectInstructionsDialog" class="max-h-[90dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Instructions for {{ project?.name ?? 'this project' }}</DialogTitle>
        <DialogDescription>Sent with every chat in this project, after AGENTS.md / CLAUDE.md from the folder.</DialogDescription>
      </DialogHeader>
    </DialogContent>
  </Dialog>
</template>
