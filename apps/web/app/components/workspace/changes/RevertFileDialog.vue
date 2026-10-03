<script setup lang="ts">
// The revert confirmation of the changes panel (docs/UI.md 2.15, 7.21; styled as the app's ConfirmDialog): "Revert
// {name}?", the text by view and status, the changed-outside warning, "The current version is saved first, so you can
// undo this." and the destructive Revert file (changes-revert-confirm). Confirm -> workspace.revert(chatId, { source:
// view, path, expectedSha }) (expectedSha left out when undefined); success -> the "Reverted {path}" toast with Undo
// (workspace.undo) and `reverted`; the 409 run-active / stale, 400 and 404 toasts (stale and 404 refresh the view; stale
// also tells the panel to reopen the row so its diff reloads). Not dismissable while it runs. Built on the AlertDialog
// parts rather than ConfirmDialog so a successful revert can keep reka from returning focus to the row's Revert button:
// the panel moves focus to the next row itself (14.1); a canceled or failed revert returns it there.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and emits below; the confirm button carries
// changes-revert-confirm.
import type { RestoreResult } from '@harness-forge/shared'
import type { ChangesRow, ChangesView } from './changes-rows'
import { computed, inject, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useWorkspaceStore } from '~/stores/workspace'
import { testIds } from '~/utils/testids'
import { CHANGES_PANEL_CONTEXT } from './changes-context'
import { fileName } from './changes-rows'
import { revertFailedMessage, showReverted, showRevertError } from './revert-toasts'

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

const workspace = useWorkspaceStore()
const context = inject(CHANGES_PANEL_CONTEXT, null)

const pending = ref(false)
/** The last confirm succeeded: the panel moves focus, so the dialog does not return it to the Revert button. */
let succeeded = false

/** The row shown while the dialog closes (the parent may clear `row` at once). */
const shown = ref<ChangesRow | null>(props.row)
watch(() => props.row, (row) => {
  if (row)
    shown.value = row
})
watch(() => props.open, (open) => {
  if (open)
    succeeded = false
})

/** The file name of the row ("Revert parser.ts?"). */
const name = computed(() => fileName(shown.value?.path ?? ''))

/** The body text by view and status (docs/UI.md 7.21). */
const text = computed(() => {
  const row = shown.value
  if (!row)
    return ''
  const { path } = row
  if (props.view === 'chat')
    return row.status === 'added' ? `${path} is deleted. This chat created it.` : `${path} goes back to how it was before this chat changed it.`
  if (row.status === 'untracked')
    return `${path} is deleted. Git doesn't track it.`
  if (row.status === 'added')
    return `${path} is deleted. It isn't in the last commit.`
  if (row.status === 'renamed' && row.origPath)
    return `${row.origPath} comes back and ${path} is deleted.`
  return `${path} goes back to the last commit.`
})

function setOpen(value: boolean) {
  if (!value && pending.value)
    return
  emit('update:open', value)
}

function refreshView() {
  void (props.view === 'chat' ? workspace.fetchChatChanges(props.chatId, { force: true }) : workspace.fetchGit(props.chatId, { force: true }))
}

async function confirm() {
  const row = props.row
  if (!row || pending.value)
    return
  const { path } = row
  const input: { source: ChangesView, path: string, expectedSha?: string | null } = { source: props.view, path }
  if (props.expectedSha !== undefined)
    input.expectedSha = props.expectedSha
  pending.value = true
  let result: RestoreResult
  try {
    result = await workspace.revert(props.chatId, input)
  }
  catch (error) {
    pending.value = false
    emit('update:open', false)
    const failure = showRevertError(error, path)
    if (failure === 'stale' || failure === 'not-found')
      refreshView()
    if (failure === 'stale')
      context?.revertStale(props.view, path)
    return
  }
  pending.value = false
  const skip = result.batchId === null ? result.skipped.find(item => item.path === path) ?? result.skipped[0] : undefined
  if (skip) {
    toast.error(revertFailedMessage(path), { description: skip.message })
    emit('update:open', false)
    return
  }
  succeeded = true
  emit('update:open', false)
  showReverted(props.chatId, path, result)
  emit('reverted', result, path)
}

/** The row's Revert button (where a canceled or failed revert returns focus; Safari never focused it on click). */
function revertButton(path: string): HTMLElement | null {
  const buttons = document.querySelectorAll<HTMLElement>(`[data-testid="${testIds.changesFileRevert}"]`)
  return [...buttons].find(button => button.dataset.path === path) ?? null
}

function onCloseAutoFocus(event: Event) {
  const done = succeeded
  succeeded = false
  if (done) {
    event.preventDefault()
    return
  }
  const button = shown.value ? revertButton(shown.value.path) : null
  if (button) {
    event.preventDefault()
    button.focus()
  }
}
</script>

<template>
  <AlertDialog :open="open && row !== null" @update:open="setOpen">
    <AlertDialogContent data-slot="confirm-dialog" @close-auto-focus="onCloseAutoFocus">
      <AlertDialogHeader>
        <AlertDialogTitle class="break-all">
          Revert {{ name }}?
        </AlertDialogTitle>
        <AlertDialogDescription class="flex flex-col gap-2 break-words">
          <span>{{ text }}</span>
          <span v-if="view === 'chat' && shown?.changedOutside" data-slot="revert-changed-outside">
            It also changed outside this chat after the agent's last edit. Those changes are reverted too.
          </span>
          <span>The current version is saved first, so you can undo this.</span>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="pending" class="pointer-coarse:h-10">
          Cancel
        </AlertDialogCancel>
        <Button
          type="button"
          variant="destructive"
          :disabled="pending"
          :aria-busy="pending || undefined"
          :data-testid="testIds.changesRevertConfirm"
          class="pointer-coarse:h-10"
          @click="confirm"
        >
          <Spinner v-if="pending" data-icon="inline-start" />
          Revert file
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
