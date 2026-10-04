<script setup lang="ts">
// One background agent in the dock list (docs/UI.md 7.29, 10.7, 14; ADR-046). Props, emits and the root test id are
// frozen from Gate P10-0b (C33 stub); W10.10 implements the row.
// Line 1: the details toggle (`background-agent-toggle`, "Show details of {description}" / "Hide details of …",
// `aria-expanded`; it holds the chevron, the type icon and label, and the description, which wraps under the label below
// `sm`), "{n} tool calls · {duration}" (the duration ticks while it runs and hides below `sm`), the status (a spinner,
// or the final status icon and word) and Stop (`background-agent-stop`, `Square`, "Stop {description}", 32px, 40px on
// coarse pointers; only while it runs; a spinner in its place and `aria-busy` while the stop is in flight). A finished
// row whose report was not delivered yet shows "Report pending" instead of Stop. Line 2 (`aria-hidden`): the latest step
// while it runs (mono, `└ shell "pnpm vitest --run"`), else the first sentence of its report or error. Open: TaskBody
// with the input of the launching `task` call (BACKGROUND_TASK_INPUT, from ChatView) and the live output; without that
// input (the call is not on the shown path) the row has no details toggle.
// Root `background-agent` (`data-task-id`, `data-state` = the task status, `data-kind` explore | general | custom,
// `data-agent-type`).
import type { BackgroundTask } from '@harness-forge/shared'
import {
  BotIcon,
  BotMessageSquareIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  Loader2Icon,
  SquareIcon,
  TelescopeIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
import { computed, inject, onBeforeUnmount, ref, useId, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { firstSentence, taskKindOf, taskStepLine, taskTypeLabel, toolCallsText } from '../agent/agent-tools'
import TaskBody from '../agent/TaskBody.vue'
import { BACKGROUND_TASK_INPUT } from '../chat-context'
import { formatDuration } from '../chat-format'
import { ENDED_STATUS_WORDS, isRunningTask, taskRunMs, taskToolCallCount } from './background-agents'

const props = withDefaults(defineProps<{ task: BackgroundTask, stopping: boolean, open?: boolean }>(), {
  // Absent = uncontrolled (a boolean prop would otherwise be cast to false).
  open: undefined,
})

const emit = defineEmits<{ 'stop': [], 'update:open': [open: boolean] }>()

const inputOf = inject(BACKGROUND_TASK_INPUT, null)

const detailsId = useId()
/** The open state when the parent does not control it. */
const localOpen = ref(false)
const isOpen = computed(() => props.open ?? localOpen.value)

const type = computed(() => props.task.output.type)
const kind = computed(() => taskKindOf(type.value))
const description = computed(() => props.task.output.description)
const running = computed(() => isRunningTask(props.task))
const input = computed(() => inputOf?.(props.task) ?? null)
const endedWord = computed(() => (running.value ? '' : ENDED_STATUS_WORDS[props.task.status as keyof typeof ENDED_STATUS_WORDS] ?? ''))

// The duration ticks once a second while the agent runs.
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
function stopTicker() {
  if (ticker !== undefined) {
    clearInterval(ticker)
    ticker = undefined
  }
}
watch(running, (isRunning) => {
  stopTicker()
  if (!isRunning)
    return
  now.value = Date.now()
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 1000)
}, { immediate: true })
onBeforeUnmount(stopTicker)

const toolCalls = computed(() => toolCallsText(taskToolCallCount(props.task)))
const duration = computed(() => formatDuration(taskRunMs(props.task, now.value)))

/** Line 2: the latest step while it runs; the first sentence of the report (else of the error) once it ended. */
const liveLine = computed(() => {
  const output = props.task.output
  if (running.value) {
    const step = output.steps.at(-1)
    return step ? `└ ${taskStepLine(step)}` : ''
  }
  return firstSentence(output.report) || (output.error ? firstSentence(output.error) : '')
})

/** The details toggle's attributes (a plain span without the launching call's input). */
const toggleAttrs = computed(() => {
  if (!input.value)
    return {}
  return {
    'type': 'button',
    'data-testid': testIds.backgroundAgentToggle,
    'data-state': isOpen.value ? 'open' : 'closed',
    'aria-expanded': isOpen.value,
    'aria-controls': isOpen.value ? detailsId : undefined,
    'aria-label': `${isOpen.value ? 'Hide' : 'Show'} details of ${description.value}`,
  }
})

function toggle() {
  const next = !isOpen.value
  localOpen.value = next
  emit('update:open', next)
}

function onStop() {
  if (!props.stopping && running.value)
    emit('stop')
}
</script>

<template>
  <li
    :data-testid="testIds.backgroundAgent"
    :data-task-id="task.id"
    :data-state="task.status"
    :data-kind="kind"
    :data-agent-type="type"
    :aria-busy="stopping || undefined"
    class="flex min-w-0 flex-col py-0.5"
  >
    <div class="flex min-h-9 min-w-0 items-center gap-2 text-sm pointer-coarse:min-h-10">
      <component
        :is="input ? 'button' : 'span'"
        v-bind="toggleAttrs"
        :class="cn(
          '-ml-1.5 flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left pointer-coarse:min-h-10',
          input && 'outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
        )"
        @click="input && toggle()"
      >
        <ChevronRightIcon
          v-if="input"
          aria-hidden="true"
          :class="cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-base)', isOpen && 'rotate-90')"
        />
        <span v-else aria-hidden="true" class="size-3.5 shrink-0" />
        <span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
          <span class="inline-flex shrink-0 items-center gap-1.5">
            <TelescopeIcon v-if="kind === 'explore'" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
            <BotIcon v-else-if="kind === 'general'" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
            <BotMessageSquareIcon v-else aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="font-medium">{{ taskTypeLabel(type) }}</span>
          </span>
          <span class="min-w-0 truncate text-muted-foreground max-sm:basis-full">{{ description }}</span>
        </span>
      </component>

      <span data-slot="background-agent-meta" class="shrink-0 text-xs text-muted-foreground tabular-nums">
        {{ toolCalls }}<span v-if="duration" class="max-sm:hidden"> · {{ duration }}</span>
      </span>

      <span data-slot="background-agent-status" class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <template v-if="running">
          <Loader2Icon aria-hidden="true" class="size-3 animate-spin" />
          <span class="sr-only">Running</span>
        </template>
        <template v-else>
          <CheckIcon v-if="task.status === 'completed'" aria-hidden="true" class="size-3.5 text-success" />
          <XIcon v-else-if="task.status === 'failed'" aria-hidden="true" class="size-3.5 text-destructive" />
          <TriangleAlertIcon v-else-if="task.status === 'limit'" aria-hidden="true" class="size-3.5 text-warning" />
          <CircleSlashIcon v-else aria-hidden="true" class="size-3.5" />
          <span>{{ endedWord }}</span>
        </template>
      </span>

      <template v-if="running">
        <span v-if="stopping" data-slot="background-agent-stopping" class="flex size-8 shrink-0 items-center justify-center pointer-coarse:size-10">
          <Loader2Icon aria-hidden="true" class="size-4 animate-spin text-muted-foreground" />
        </span>
        <Tooltip v-else>
          <TooltipTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              :data-testid="testIds.backgroundAgentStop"
              :aria-label="`Stop ${description}`"
              class="shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:size-10"
              @click="onStop"
            >
              <SquareIcon aria-hidden="true" class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Stop {{ description }}
          </TooltipContent>
        </Tooltip>
      </template>
      <span v-else-if="task.deliveredAt === null" data-slot="background-agent-pending" class="shrink-0 text-xs text-muted-foreground">
        Report pending
      </span>
    </div>
    <p
      v-if="liveLine"
      data-slot="background-agent-live"
      aria-hidden="true"
      :class="cn('min-w-0 truncate pl-5 text-xs leading-5 text-muted-foreground', running && 'font-mono')"
    >
      {{ liveLine }}
    </p>
    <div v-if="input && isOpen" :id="detailsId" class="min-w-0 pt-1.5 pb-1 pl-5">
      <TaskBody :input="input" :output="task.output" :running="running" />
    </div>
  </li>
</template>
