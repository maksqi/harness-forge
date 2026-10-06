<script setup lang="ts">
// The hook import of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 9.13, 10.8): a form dialog "Import hooks"
// with the JSON textarea (`hook-import-input`), Choose file… (`hook-import-file`, `.json`, at most 256 KB), the preview
// "Found {n} hooks" (`hook-import-preview`, `hook-import-item` with a checkbox; invalid items unchecked and disabled),
// the notes of what was left out, the errors (`hook-import-error`) and "Add {n} hooks" (`hook-import-submit`: one
// personal hook per checked item under one password prompt). The text is read by `importHooks` (the shared
// `readSettingsHooks` / `readHooksConfig`). Mounted by HooksPanel. Props, emits and the root test id are frozen from Gate
// P11-0b (C39 stub); W11.8 implements the dialog in P11-A. The stub shows the title and the help, and closes.
import type { PersonalHook } from '@harness-forge/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { testIds } from '~/utils/testids'
import { HOOK_COPY } from './hooks'

defineProps<{ open: boolean }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'imported': [hooks: PersonalHook[]] }>()
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent :data-testid="testIds.hookImportDialog" class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ HOOK_COPY.importTitle }}</DialogTitle>
        <DialogDescription>{{ HOOK_COPY.importHelp }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="outline" @click="emit('update:open', false)">
          Cancel
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
