<script setup lang="ts">
// The revert confirmation of the changes panel (docs/UI.md 2.15, 7.21; a ConfirmDialog): "Revert {name}?", the text by
// view and status, the changed-outside warning, "The current version is saved first, so you can undo this." and the
// destructive Revert file (changes-revert-confirm). Confirm -> workspace.revert(chatId, { source: view, path,
// expectedSha }) (expectedSha left out when undefined); success -> the "Reverted {path}" toast with Undo
// (workspace.undo) and `reverted`; the 409 run-active / stale, 400 and 404 toasts. Not dismissable while it runs.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and emits below; the confirm button carries
// changes-revert-confirm. Stub (C20, P8-0b): the title and the buttons; Revert file only closes the dialog.
import type { RestoreResult } from '@harness-forge/shared'
import type { ChangesRow, ChangesView } from './changes-rows'
import { computed } from 'vue'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{
  open: boolean
  chatId: string
  view: ChangesView
  row: ChangesRow | null
  /**
   * `FileDiff.currentSha` of the row's loaded diff (null = that diff showed the file missing); undefined = the diff was
   * never loaded, nothing is sent.
   */
  expectedSha?: string | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** After a successful revert (the panel moves focus to the next row). */
  'reverted': [result: RestoreResult, path: string]
}>()

/** The file name of the row ("Revert parser.ts?"). */
const name = computed(() => props.row?.path.split('/').pop() ?? '')
</script>

<template>
  <ConfirmDialog
    :open="open && row !== null"
    :title="`Revert ${name}?`"
    description="The current version is saved first, so you can undo this."
    confirm-label="Revert file"
    :data-testid="testIds.changesRevertConfirm"
    @update:open="emit('update:open', $event)"
    @confirm="emit('update:open', false)"
  />
</template>
