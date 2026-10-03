<script setup lang="ts">
// Queued messages in the composer dock (docs/UI.md 2.16, 7.26, 10.6, 14; ADR-042): ChatView mounts it between TodoStrip
// and the composer with the session's `queue`; hidden while the queue is empty. Props, emits and root test id frozen
// from Gate P9-0b (C25); built by W9.8.
// The header reads "Queued · {n} · sent at the next step" ("… · Sent after you answer the approval" while
// `waitingForApproval`); a list named "Queued messages" holds one row per message (`queued-message`, `data-message-id`,
// `data-state` queued | cancelling): `Clock`, a paperclip count when it has files, the first line of its text, "Runs
// after this response" for a server command, and Edit (`queued-message-edit`) / Cancel (`queued-message-cancel`). A row
// whose id is in `cancelling` shows a spinner and disabled actions. On phones more than two rows collapse behind
// "Show {n} more". After a cancel, focus moves to the next row's Cancel, else the previous row's, else the textarea.
// Root `queued-messages` (`data-count`, `data-state` queued | approval).
import type { QueueItem } from '@harness-forge/shared'
import { ClockIcon, Loader2Icon, PaperclipIcon, PencilIcon, XIcon } from '@lucide/vue'
import { useMediaQuery } from '@vueuse/core'
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { queueItemFileCount, queueItemPreview } from './queued-messages'

const props = withDefaults(defineProps<{
  /** The chat's queue, oldest first (`session.queue`). */
  items: readonly QueueItem[]
  /** The chat awaits an approval: the messages wait for the next run. */
  waitingForApproval?: boolean
  /** Ids of the items whose cancel is in flight. */
  cancelling?: readonly string[]
}>(), {
  waitingForApproval: false,
  cancelling: () => [],
})

const emit = defineEmits<{
  cancel: [id: string]
  edit: [id: string]
}>()

/** Rows shown on phones before "Show {n} more". */
const PHONE_ROWS = 2

const ui = useUiStore()
const root = useTemplateRef<HTMLElement>('root')
const phone = useMediaQuery('(max-width: 767px)')
const expanded = ref(false)

const rows = computed(() => props.items.map(item => ({
  item,
  preview: queueItemPreview(item),
  files: queueItemFileCount(item),
  cancelling: props.cancelling.includes(item.id),
})))
const hidden = computed(() => (phone.value && !expanded.value ? Math.max(0, rows.value.length - PHONE_ROWS) : 0))
const visibleRows = computed(() => (hidden.value > 0 ? rows.value.slice(0, PHONE_ROWS) : rows.value))

// A short queue collapses again next time it grows.
watch(() => props.items.length, (count) => {
  if (count <= PHONE_ROWS)
    expanded.value = false
})

function filesLabel(count: number): string {
  return count === 1 ? '1 file attached' : `${count} files attached`
}

// ---------- cancel, edit and the focus after a cancel ----------

/** The row whose Cancel was pressed: once it leaves the list, focus goes to its neighbour. */
let focusAfterCancel: { id: string, index: number } | null = null

function onCancel(id: string, index: number) {
  if (props.cancelling.includes(id))
    return
  focusAfterCancel = { id, index }
  emit('cancel', id)
}

function onEdit(id: string) {
  if (!props.cancelling.includes(id))
    emit('edit', id)
}

function focusIsHere(): boolean {
  if (typeof document === 'undefined')
    return false
  const active = document.activeElement
  return !active || active === document.body || !!root.value?.contains(active)
}

watch(() => props.items, (next) => {
  const pending = focusAfterCancel
  if (!pending || next.some(item => item.id === pending.id))
    return
  focusAfterCancel = null
  if (!focusIsHere())
    return
  void nextTick(() => {
    const buttons = Array.from(root.value?.querySelectorAll<HTMLElement>(`[data-testid="${testIds.queuedMessageCancel}"]`) ?? [])
    const target = buttons[pending.index] ?? buttons[pending.index - 1] ?? buttons.at(-1)
    if (target)
      target.focus()
    else
      ui.requestComposerFocus()
  })
}, { flush: 'post' })

const ACTION_CLASS = 'shrink-0 text-muted-foreground hover:text-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50 pointer-coarse:size-10'
</script>

<template>
  <div
    v-if="items.length > 0"
    ref="root"
    :data-testid="testIds.queuedMessages"
    :data-count="items.length"
    :data-state="waitingForApproval ? 'approval' : 'queued'"
    class="rounded-xl border bg-card px-3 py-2 text-sm shadow-xs"
  >
    <p class="truncate pb-1 text-xs font-medium text-muted-foreground">
      Queued · {{ items.length }} · {{ waitingForApproval ? 'Sent after you answer the approval' : 'sent at the next step' }}
    </p>
    <ul role="list" aria-label="Queued messages" class="flex flex-col">
      <li
        v-for="(row, index) in visibleRows"
        :key="row.item.id"
        :data-testid="testIds.queuedMessage"
        :data-message-id="row.item.id"
        :data-state="row.cancelling ? 'cancelling' : 'queued'"
        :aria-busy="row.cancelling || undefined"
        class="flex min-h-9 min-w-0 items-center gap-2"
      >
        <Loader2Icon v-if="row.cancelling" aria-hidden="true" class="size-4 shrink-0 animate-spin text-muted-foreground" />
        <ClockIcon v-else aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
        <span v-if="row.files > 0" class="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
          <PaperclipIcon aria-hidden="true" class="size-3.5" />
          <span aria-hidden="true">{{ row.files }}</span>
          <span class="sr-only">{{ filesLabel(row.files) }},</span>
        </span>
        <span class="min-w-0 flex-1 truncate">{{ row.preview }}</span>
        <span v-if="row.item.turnOnly" class="shrink-0 truncate text-xs text-muted-foreground max-sm:max-w-[40%]">Runs after this response</span>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              :data-testid="testIds.queuedMessageEdit"
              aria-label="Edit queued message"
              :aria-disabled="row.cancelling || undefined"
              :class="ACTION_CLASS"
              @click="onEdit(row.item.id)"
            >
              <PencilIcon aria-hidden="true" class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Edit queued message
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              :data-testid="testIds.queuedMessageCancel"
              aria-label="Cancel queued message"
              :aria-disabled="row.cancelling || undefined"
              :class="ACTION_CLASS"
              @click="onCancel(row.item.id, index)"
            >
              <XIcon aria-hidden="true" class="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Cancel queued message
          </TooltipContent>
        </Tooltip>
      </li>
    </ul>
    <Button
      v-if="hidden > 0"
      type="button"
      variant="ghost"
      size="sm"
      data-slot="queued-messages-more"
      class="mt-1 h-8 w-full justify-start px-2 text-muted-foreground pointer-coarse:h-10"
      @click="expanded = true"
    >
      Show {{ hidden }} more
    </Button>
  </div>
</template>
