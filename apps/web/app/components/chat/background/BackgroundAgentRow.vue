<script setup lang="ts">
// One background agent in the dock list (docs/UI.md 7.29, 10.7; ADR-046): the details chevron (TaskBody with the live
// input and output when open), the type icon and label, the description, the latest step, "{n} tool calls ·
// {duration}", the status and Stop (only while it runs; "Report pending" once it finished undelivered). Props, emits and
// the root test id are frozen from Gate P10-0b (C33 stub); W10.10 implements the row in P10-A. The stub shows the
// label, the description and Stop.
import type { BackgroundTask } from '@harness-forge/shared'
import { SquareIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { testIds } from '~/utils/testids'
import { taskKindOf, taskTypeLabel } from '../agent/agent-tools'

const props = defineProps<{ task: BackgroundTask, stopping: boolean, open?: boolean }>()

const emit = defineEmits<{ 'stop': [], 'update:open': [open: boolean] }>()

const type = computed(() => props.task.output.type)
const running = computed(() => props.task.status === 'running')
</script>

<template>
  <div
    :data-testid="testIds.backgroundAgent"
    :data-task-id="task.id"
    :data-state="task.status"
    :data-kind="taskKindOf(type)"
    :data-agent-type="type"
    class="flex min-h-(--row-height) min-w-0 items-center gap-2 text-sm"
  >
    <span class="shrink-0 font-medium">{{ taskTypeLabel(type) }}</span>
    <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ task.output.description }}</span>
    <template v-if="running">
      <Spinner v-if="stopping" class="size-3" />
      <Button
        v-else
        type="button"
        variant="ghost"
        size="icon-sm"
        :data-testid="testIds.backgroundAgentStop"
        :aria-label="`Stop ${task.output.description}`"
        class="pointer-coarse:size-10"
        @click="emit('stop')"
      >
        <SquareIcon aria-hidden="true" />
      </Button>
    </template>
  </div>
</template>
