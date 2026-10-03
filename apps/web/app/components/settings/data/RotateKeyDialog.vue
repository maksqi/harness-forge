<script setup lang="ts">
// "Rotate the master key?" (docs/UI.md 9.8; ADR-034): the effects list (counts from status), "Type ROTATE to confirm"
// (key-rotate-confirm, case-sensitive) and Rotate key (key-rotate-submit, destructive, enabled only for exactly
// ROTATE), which submits keys.rotate() through useFreshAuth().run(…, { required: true }); success -> toast,
// rotated(result), the dialog closes.
// Contract (docs/UI.md 10.4): props / emits below; root key-rotate-dialog (the dialog content).
// Stub (C15, P7-0b): implemented by W7.13 in P7-A; props and emits are frozen. The stub shows the title only.
import type { KeyRotationResult, KeyStatus } from '@harness-forge/shared'
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
  /** The counts of the effects list; null while unknown. */
  status: KeyStatus | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'rotated': [result: KeyRotationResult]
}>()
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent :data-testid="testIds.keyRotateDialog">
      <DialogHeader>
        <DialogTitle>Rotate the master key?</DialogTitle>
        <DialogDescription>A new key encrypts every stored secret again.</DialogDescription>
      </DialogHeader>
    </DialogContent>
  </Dialog>
</template>
