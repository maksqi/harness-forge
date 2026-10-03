<script setup lang="ts">
// "Rewind files to here?" (docs/UI.md 2.15, 7.22, 14.1; docs/API.md 5.24; ADR-036), owned by ChatView like the
// delete-version dialog. Opening it on a message loads `GET /api/chats/:id/rewind?messageId=` (aborted when it closes;
// a skeleton meanwhile) and lists the files that would change (rewind-file: data-path, data-action = restore | delete |
// unavailable, data-conflict; files that already match are left out; "and more files" when the server cut the list),
// the unchecked "Also restore files changed outside this chat" (rewind-force) when a listed file conflicts, the muted
// "Shell changes aren't tracked.", the commands that ran after the message (rewind-shell-command, at most 10, then "and
// {n} more") and the other tools that changed files. Cancel · Restore files and edit (rewind-restore-edit) · Restore
// files (rewind-restore) -> `POST /api/chats/:id/rewind { messageId, conflicts: 'force' | 'skip' }`; the dialog cannot
// be dismissed while that runs, then emits `restored(result, then)` and closes (ChatView shows the result toast with
// Undo and, for 'edit', opens the editor on the message). An empty preview reads "Nothing to restore. The files already
// match." with Close only. A `404` or a `409 run-active` closes the dialog and goes to the REWIND_DIALOG_HOST (ChatView:
// the toasts, following the run, reloading the path); every other failure shows inline (rewind-error, data-code).
// Focus: on Restore files once the preview arrived (Close when there is nothing to restore); the owner puts it back on
// "Rewind files to here" (or into the editor) when the dialog closes, so reka's own return is turned off.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and emits below; root rewind-dialog (data-state = loading |
// ready | empty | error | restoring) on the wrapper of the dialog's content (reka owns the DialogContent's own
// data-state open | closed, which drives its animations).
import type { HarnessError, RestoreResult, RewindPreview } from '@harness-forge/shared'
import type { RewindFileRow } from './rewind'
import { CircleAlertIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, inject, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApi } from '~/composables/useApi'
import { isAbortError, toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { isRewindRefusal, REWIND_DIALOG_HOST, rewindView } from './rewind'

const props = defineProps<{
  open: boolean
  chatId: string
  /** The user message to rewind the files to; null while closed. */
  messageId: string | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** After a restore: `then` = 'edit' for "Restore files and edit" (ChatView opens the editor on the message). */
  'restored': [result: RestoreResult, then: 'none' | 'edit']
}>()

type RewindState = 'loading' | 'ready' | 'empty' | 'error' | 'restoring'

interface RewindFailure {
  title: string
  message: string
  code: string
}

const BADGES: Record<RewindFileRow['action'], string> = {
  restore: 'Restore',
  delete: 'Delete',
  unavailable: 'Can\'t restore',
}

const api = useApi()
const host = inject(REWIND_DIALOG_HOST, null)
const ids = { force: useId(), dismiss: useId(), restore: useId(), error: useId() }

const state = ref<RewindState>('loading')
const preview = ref<RewindPreview | null>(null)
const failure = ref<RewindFailure | null>(null)
const force = ref(false)
const restoringAs = ref<'none' | 'edit' | null>(null)

const visible = computed(() => props.open && props.messageId !== null)
const view = computed(() => (preview.value ? rewindView(preview.value) : null))
const restoring = computed(() => state.value === 'restoring')
/** The preview lists a file: Restore files and Restore files and edit are offered (else only Close). */
const canRestore = computed(() => (view.value?.files.length ?? 0) > 0)

// Bumped on every open and close, so an answer that outlives its dialog session cannot touch the next one.
let session = 0
let controller: AbortController | null = null

function abortPreview(): void {
  controller?.abort()
  controller = null
}

function focusById(id: string): boolean {
  const element = document.getElementById(id)
  element?.focus()
  return element !== null
}

/** Restore files when there is something to restore, else the Cancel / Close button. */
function focusDefault(): void {
  if (!canRestore.value || !focusById(ids.restore))
    focusById(ids.dismiss)
}

/** A failure the host reports (`404`, `409 run-active`): the dialog closes. False when it stays inline. */
function handOver(error: HarnessError): boolean {
  if (!host || !isRewindRefusal(error))
    return false
  host.refused(error)
  emit('update:open', false)
  return true
}

async function loadPreview(chatId: string, messageId: string): Promise<void> {
  const current = ++session
  abortPreview()
  const abort = new AbortController()
  controller = abort
  state.value = 'loading'
  preview.value = null
  failure.value = null
  force.value = false
  restoringAs.value = null
  try {
    const answer = await api.changes.rewindPreview({ params: { id: chatId }, query: { messageId }, signal: abort.signal })
    if (current !== session)
      return
    preview.value = answer
    state.value = rewindView(answer).files.length > 0 ? 'ready' : 'empty'
    await nextTick()
    focusDefault()
  }
  catch (error) {
    if (current !== session || isAbortError(error))
      return
    const harnessError = toHarnessError(error)
    if (handOver(harnessError))
      return
    failure.value = { title: 'Couldn\'t check the files', message: harnessError.message, code: harnessError.code }
    state.value = 'error'
  }
  finally {
    if (controller === abort)
      controller = null
  }
}

watch([visible, () => props.chatId, () => props.messageId], ([shown, chatId, messageId]) => {
  if (shown && messageId) {
    void loadPreview(chatId, messageId)
  }
  else {
    // Closed: drop a preview still loading; the content keeps its last state through the closing animation.
    session += 1
    abortPreview()
  }
}, { immediate: true })

onBeforeUnmount(() => {
  session += 1
  abortPreview()
})

function onOpenChange(value: boolean): void {
  if (!value && restoring.value)
    return
  emit('update:open', value)
}

async function restore(then: 'none' | 'edit'): Promise<void> {
  const messageId = props.messageId
  if (!messageId || !canRestore.value || restoring.value)
    return
  const current = session
  const chatId = props.chatId
  state.value = 'restoring'
  restoringAs.value = then
  failure.value = null
  let result: RestoreResult
  try {
    result = await api.changes.rewind({
      params: { id: chatId },
      body: { messageId, conflicts: force.value ? 'force' : 'skip' },
    })
  }
  catch (error) {
    restoringAs.value = null
    if (current !== session)
      return
    const harnessError = toHarnessError(error)
    state.value = 'ready'
    if (handOver(harnessError))
      return
    failure.value = { title: 'Couldn\'t restore the files', message: harnessError.message, code: harnessError.code }
    state.value = 'error'
    await nextTick()
    focusDefault()
    return
  }
  restoringAs.value = null
  state.value = 'ready'
  // The files changed on the server even if the dialog session ended meanwhile: always report the result.
  emit('restored', result, then)
  if (current === session)
    emit('update:open', false)
}

function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
  focusDefault()
}

function onCloseAutoFocus(event: Event): void {
  // The owner moves focus: back to "Rewind files to here", or into the message editor.
  event.preventDefault()
}
</script>

<template>
  <Dialog :open="visible" @update:open="onOpenChange">
    <DialogContent
      class="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      @open-auto-focus="onOpenAutoFocus"
      @close-auto-focus="onCloseAutoFocus"
    >
      <div
        :data-testid="testIds.rewindDialog"
        :data-state="state"
        :aria-busy="state === 'loading' || restoring || undefined"
        class="grid min-w-0 gap-5"
      >
        <DialogHeader>
          <DialogTitle>Rewind files to here?</DialogTitle>
          <DialogDescription>
            Files the agent changed after this message go back to how they were before it. The conversation stays as it
            is.
          </DialogDescription>
        </DialogHeader>

        <div v-if="state === 'loading'" data-slot="rewind-loading" aria-hidden="true" class="grid gap-2">
          <Skeleton class="h-9 w-full" />
          <Skeleton class="h-9 w-full" />
          <Skeleton class="h-4 w-2/5" />
        </div>

        <template v-if="view">
          <p v-if="view.files.length === 0" data-slot="rewind-empty" class="text-sm">
            Nothing to restore. The files already match.
          </p>
          <ul
            v-else
            aria-label="Files to restore"
            class="max-h-64 min-w-0 divide-y divide-border overflow-y-auto rounded-lg border border-border"
          >
            <li
              v-for="file in view.files"
              :key="file.path"
              :data-testid="testIds.rewindFile"
              :data-path="file.path"
              :data-action="file.action"
              :data-conflict="file.conflict ? 'true' : undefined"
              class="flex min-w-0 items-center gap-2 px-3 py-2"
            >
              <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="file.path">{{ file.path }}</span>
              <template v-if="file.conflict">
                <TriangleAlertIcon aria-hidden="true" class="size-3.5 shrink-0 text-warning" />
                <span class="sr-only">changed outside this chat</span>
              </template>
              <Tooltip v-if="file.action === 'unavailable'">
                <TooltipTrigger as-child>
                  <Badge as="span" variant="outline" tabindex="0" class="text-muted-foreground">
                    {{ BADGES[file.action] }}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>The earlier version of this file is no longer stored.</TooltipContent>
              </Tooltip>
              <Badge v-else as="span" :variant="file.action === 'delete' ? 'destructive' : 'secondary'">
                {{ BADGES[file.action] }}
              </Badge>
            </li>
            <li v-if="view.moreFiles" class="px-3 py-2 text-xs text-muted-foreground">
              and more files
            </li>
          </ul>

          <div v-if="view.hasConflict" class="flex items-center gap-2.5">
            <Checkbox
              :id="ids.force"
              v-model="force"
              class="pointer-coarse:after:-inset-[13px]"
              :disabled="restoring"
              :data-testid="testIds.rewindForce"
            />
            <label :for="ids.force" class="text-sm select-none">Also restore files changed outside this chat</label>
          </div>

          <div class="grid min-w-0 gap-2">
            <p class="text-sm text-muted-foreground">
              Shell changes aren't tracked.
            </p>
            <Alert
              v-if="view.shellCount > 0"
              data-slot="rewind-shell"
              class="min-w-0 border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning"
            >
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription class="min-w-0 text-foreground">
                <p>These commands ran after this message; their effects on files stay:</p>
                <ul class="mt-1 grid w-full min-w-0 gap-0.5">
                  <li
                    v-for="(item, index) in view.commands"
                    :key="index"
                    :data-testid="testIds.rewindShellCommand"
                    :title="item.command"
                    class="truncate font-mono text-xs"
                  >
                    {{ item.firstLine }}
                  </li>
                </ul>
                <p v-if="view.moreCommands > 0" class="mt-1 text-muted-foreground">
                  and {{ view.moreCommands }} more
                </p>
              </AlertDescription>
            </Alert>
            <p v-if="view.tools.length > 0" class="text-sm text-muted-foreground">
              Other tools changed files too: {{ view.tools.join(', ') }}. Their changes stay.
            </p>
          </div>
        </template>

        <Alert
          v-if="failure"
          :id="ids.error"
          variant="destructive"
          role="alert"
          :data-testid="testIds.rewindError"
          :data-code="failure.code"
          class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10 *:data-[slot=alert-description]:text-foreground/80"
        >
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{{ failure.title }}</AlertTitle>
          <AlertDescription>{{ failure.message }}</AlertDescription>
        </Alert>

        <DialogFooter>
          <Button
            :id="ids.dismiss"
            type="button"
            variant="outline"
            class="pointer-coarse:h-10"
            :disabled="restoring"
            @click="onOpenChange(false)"
          >
            {{ canRestore || state === 'loading' ? 'Cancel' : 'Close' }}
          </Button>
          <template v-if="canRestore">
            <Button
              type="button"
              variant="outline"
              class="pointer-coarse:h-10"
              :disabled="restoring"
              :aria-busy="restoringAs === 'edit' || undefined"
              :aria-describedby="failure ? ids.error : undefined"
              :data-testid="testIds.rewindRestoreEdit"
              @click="restore('edit')"
            >
              <Spinner v-if="restoringAs === 'edit'" data-icon="inline-start" />
              Restore files and edit
            </Button>
            <Button
              :id="ids.restore"
              type="button"
              class="pointer-coarse:h-10"
              :disabled="restoring"
              :aria-busy="restoringAs === 'none' || undefined"
              :aria-describedby="failure ? ids.error : undefined"
              :data-testid="testIds.rewindRestore"
              @click="restore('none')"
            >
              <Spinner v-if="restoringAs === 'none'" data-icon="inline-start" />
              Restore files
            </Button>
          </template>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</template>
