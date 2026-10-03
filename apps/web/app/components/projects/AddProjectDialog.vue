<script setup lang="ts">
// Add project dialog (docs/UI.md 2.13, 9.10; ADR-031): FolderBrowser, then New folder (folder-browser-new, revealing
// the "Folder name" input folder-browser-new-input, checked like folderNameSchema), the Name input (add-project-name,
// the selected folder's basename until edited) and Add project (add-project-submit), which submits through
// useFreshAuth().run(() => projects.create(body), { required: true }). Inline errors by code (add-project-error,
// data-code); every root missing -> the "No workspace folders" alert. Full width minus 1rem at 390px, max-h-[90dvh].
// Opened from Settings -> Projects (also `?add=1`) and from the project switcher.
// Contract (docs/UI.md 10.4): props / emits below; root add-project-dialog (the dialog content).
// Stub (C15, P7-0b): implemented by W7.9 in P7-A; props and emits are frozen. The stub shows the folder browser only.
import type { ProjectSummary } from '@harness-forge/shared'
import { ref, watch } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { testIds } from '~/utils/testids'
import FolderBrowser from './FolderBrowser.vue'

const props = withDefaults(defineProps<{
  open: boolean
  /** The folder to open first; default: the roots. */
  initialPath?: string | null
}>(), {
  initialPath: null,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'created': [project: ProjectSummary]
}>()

const folder = ref<string | null>(props.initialPath)

watch(() => props.open, (open) => {
  if (open)
    folder.value = props.initialPath
})
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      :data-testid="testIds.addProjectDialog"
      class="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto"
    >
      <DialogHeader>
        <DialogTitle>Add project</DialogTitle>
        <DialogDescription>Choose a folder on the server that chats can read and edit.</DialogDescription>
      </DialogHeader>
      <FolderBrowser v-model="folder" />
    </DialogContent>
  </Dialog>
</template>
