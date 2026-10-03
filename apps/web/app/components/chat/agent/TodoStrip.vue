<script setup lang="ts">
// The todo strip in the composer dock (docs/UI.md 7.25, 10.6; ADR-041): ChatView mounts it above QueuedMessages with
// the session's `todos`. Renders nothing unless `todoStripVisible(state, running)`. Props and root test id frozen from
// Gate P9-0b (C25); W9.10 builds the strip (the collapsible TodoList, progress bar, `todo-strip-toggle`,
// `localStorage['hf-todo-expanded']`) behind them.
// Root `todo-strip` (`data-state` open | closed, `data-count` = total, `data-value` = done).
import type { TodoState } from './todos'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import { todoStripVisible, todoSummary } from './todos'

const props = defineProps<{
  /** The todo state of the shown path (`session.todos`); null = no list. */
  state: TodoState | null
  /** A run of the chat is active. */
  running: boolean
}>()

const visible = computed(() => todoStripVisible(props.state, props.running))
</script>

<template>
  <div
    v-if="visible && state"
    :data-testid="testIds.todoStrip"
    data-state="closed"
    :data-count="state.total"
    :data-value="state.done"
    class="flex h-9 items-center gap-2 rounded-lg border bg-card px-3 text-sm"
  >
    {{ todoSummary(state) }}
  </div>
</template>
