<script setup lang="ts">
// Folder browser of the Add project dialog (docs/UI.md 2.13, 9.10; ADR-031): with no folder open it lists the roots
// from projects.browse() (a missing root is disabled with "Not found"); then a breadcrumb inside nav "Folder path"
// (folder-browser-crumb, data-path; the current one aria-current="page"), Parent folder (folder-browser-up) and the
// subfolders as buttons (folder-browser-entry, data-path); folders that already are projects show a "Project" badge
// and are disabled. The open folder is the selected folder ("Selected: {path}"). Each browse request aborts the
// previous one; a polite live region announces "Opened {folder}, {n} folders". Errors inline (folder-browser-error,
// data-code).
// Contract (docs/UI.md 10.4): props / emits below (v-model: the open folder, null = the roots); root folder-browser
// (data-path = the open folder, '' for the roots; data-state = loading | ready | empty | error).
// Stub (C15, P7-0b): implemented by W7.9 in P7-A; props and emits are frozen. The stub loads nothing.
import { testIds } from '~/utils/testids'

withDefaults(defineProps<{
  /** v-model: the open (= selected) folder; null = the roots. */
  modelValue: string | null
  disabled?: boolean
}>(), {
  disabled: false,
})

defineEmits<{ 'update:modelValue': [path: string | null] }>()
</script>

<template>
  <div
    :data-testid="testIds.folderBrowser"
    :data-path="modelValue ?? ''"
    data-state="empty"
    :aria-disabled="disabled || undefined"
    class="flex min-h-40 flex-col rounded-md border"
  />
</template>
