<script setup lang="ts">
// Queued messages in the composer dock (docs/UI.md 2.16, 7.26, 10.6; ADR-042): ChatView mounts it between TodoStrip
// and the composer with the session's `queue`; hidden while the queue is empty. Props, emits and root test id frozen
// from Gate P9-0b (C25); W9.8 builds the list behind them: the header "Queued · {n} · sent at the next step" ("Sent
// after you answer the approval" while `waitingForApproval`), one row per message (`queued-message`, `data-message-id`,
// `data-state` queued | cancelling) with Edit (`queued-message-edit`) and Cancel (`queued-message-cancel`); a row
// whose id is in `cancelling` shows a spinner and disabled actions.
// Root `queued-messages` (`data-count`, `data-state` queued | approval).
import type { QueueItem } from '@harness-forge/shared'
import { testIds } from '~/utils/testids'

withDefaults(defineProps<{
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

// The stub has no rows to act on (W9.8 emits them).
defineEmits<{
  cancel: [id: string]
  edit: [id: string]
}>()
</script>

<template>
  <div
    v-if="items.length > 0"
    :data-testid="testIds.queuedMessages"
    :data-count="items.length"
    :data-state="waitingForApproval ? 'approval' : 'queued'"
    class="rounded-lg border bg-card px-3 py-2 text-sm"
  >
    Queued · {{ items.length }}
  </div>
</template>
