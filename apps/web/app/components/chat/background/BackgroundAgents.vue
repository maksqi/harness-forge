<script setup lang="ts">
// The background agents of a chat in the dock, between TodoStrip and QueuedMessages (docs/UI.md 5.8, 7.29, 10.7;
// ADR-046). Renders nothing without visible tasks; collapsed: one line that is the toggle ("2 background agents ·
// {latest description} · 1m 12s"); expanded: "Background agents · {n} running", Stop all, the rows and the footnote. A
// polite region announces the transitions this tab observed. ChatView mounts it with the session's visible tasks.
// Props, emits and the root test id are frozen from Gate P10-0b (C33 stub); W10.10 implements the list in P10-A
// (the open state in `localStorage['hf-background-expanded']`, the ticking duration, the focus moves after a stop). The
// stub shows the collapsed line.
import type { BackgroundTask } from '@harness-forge/shared'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import { isRunningTask, summaryLine } from './background-agents'

const props = defineProps<{
  /** The chat's visible tasks (`visibleTasks`), newest first. */
  tasks: readonly BackgroundTask[]
  /** Task ids with a stop in flight. */
  stopping?: readonly string[]
  /** A "Show in background agents" request (n bumps on each request). */
  reveal?: { taskId: string, n: number } | null
}>()

defineEmits<{ 'stop': [taskId: string], 'stop-all': [] }>()

const running = computed(() => props.tasks.filter(isRunningTask).length)
const line = computed(() => summaryLine(props.tasks, Date.now()))
</script>

<template>
  <div
    v-if="tasks.length > 0"
    :data-testid="testIds.backgroundAgents"
    data-state="closed"
    :data-count="running"
    :data-total="tasks.length"
    class="flex min-w-0 flex-col rounded-xl border bg-card text-sm"
  >
    <button
      type="button"
      :data-testid="testIds.backgroundAgentsToggle"
      aria-expanded="false"
      :aria-label="`Show background agents, ${running > 0 ? `${running} running` : `${tasks.length} finished`}`"
      class="flex h-9 min-w-0 items-center gap-2 px-3 text-left pointer-coarse:h-10"
    >
      <span class="min-w-0 truncate">{{ line }}</span>
    </button>
    <div data-slot="background-agents-announcer" class="sr-only" aria-live="polite" />
  </div>
</template>
