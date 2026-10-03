<script setup lang="ts">
// A sub-agent block (docs/UI.md 2.16, 7.27, 10.6, 14; ADR-043): ChatMessage renders it for block kind `task` (a tool
// part named `task`). Props, emit and root test id frozen from Gate P9-0b (C25).
// A Collapsible that always keeps two lines, so nothing shifts when the sub-agent finishes. Line 1 is the trigger
// (`task-block-trigger`): chevron, `Telescope` (explore) or `Bot` (general), "Explore" / "Agent", the description,
// "{n} tool calls · 41s" (hidden below `sm` while running) and the status; it is named "Explore sub-agent:
// {description}, running, 4 tool calls" ("Sub-agent: …" for general). Line 2 (`data-slot="task-live"`, `aria-hidden`):
// the latest step while running, the first sentence of the report (else of the error) when finished. Expanded:
// TaskBody. A `task` call that asks (a user override `ask`) shows ToolApprovalCard below; parallel blocks simply stack.
// The status comes from `taskBlockState` (a preliminary output is running while the message streams, stopped after).
// A call whose input (or output, once there is one) does not parse with the shared schemas falls back to ToolPart.
// Root `task-block` (`data-state` queued | running | completed | failed | limit | aborted | approval | denied,
// `data-kind` explore | general).
import type { ToolPartLike } from '../chat-format'
import {
  BanIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  ClockIcon,
  TelescopeIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { TRANSCRIPT_SCROLL } from '../chat-context'
import { formatDuration, isSupersededDenial, toolNameOf } from '../chat-format'
import ToolApprovalCard from '../parts/ToolApprovalCard.vue'
import ToolPart from '../parts/ToolPart.vue'
import {
  firstSentence,
  taskBlockState,
  taskDescriptionOf,
  taskDurationMs,
  taskInputOf,
  taskOutputOf,
  taskStepLine,
  taskToolCalls,
  taskTriggerLabel,
  taskTypeOf,
  toolCallsText,
} from './agent-tools'
import TaskBody from './TaskBody.vue'

const props = withDefaults(defineProps<{
  part: ToolPartLike
  /** The message is streaming (a preliminary output is a running sub-agent only then). */
  streaming: boolean
  /** A later message exists: an approval still requested here was superseded. */
  superseded?: boolean
}>(), {
  superseded: false,
})

const emit = defineEmits<{
  approval: [response: { id: string, approved: boolean, toolName: string, alwaysAllow: boolean }]
}>()

const plugins = usePluginsStore()
const open = ref(false)
const scroll = inject(TRANSCRIPT_SCROLL, null)
watch(open, (isOpen) => {
  if (isOpen)
    scroll?.holdPosition()
})

const name = computed(() => toolNameOf(props.part))
const tool = computed(() => plugins.tools.find(item => item.name === name.value))
const input = computed(() => taskInputOf(props.part.input))
const hasOutput = computed(() => props.part.state === 'output-available')
const output = computed(() => (hasOutput.value ? taskOutputOf(props.part.output) : null))
/** The generic row stands in when a value does not parse (a streaming input is still partial, so it never counts). */
const fallback = computed(() => (props.part.state !== 'input-streaming' && input.value === null)
  || (hasOutput.value && output.value === null))

const kind = computed(() => input.value?.type ?? taskTypeOf(props.part.input) ?? undefined)
const description = computed(() => input.value?.description ?? taskDescriptionOf(props.part.input))
const state = computed(() => taskBlockState(props.part, { streaming: props.streaming, superseded: props.superseded }))
const active = computed(() => state.value === 'running' || state.value === 'queued')
const toolCalls = computed(() => taskToolCalls(output.value))
const awaitingDecision = computed(() => props.part.state === 'approval-requested' && !props.superseded)
const supersededDenial = computed(() => state.value === 'denied'
  && (isSupersededDenial(props.part) || props.part.state === 'approval-requested'))

// A running sub-agent's duration ticks once a second (the server's start time, clamped at 0).
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
function stopTicker() {
  if (ticker !== undefined) {
    clearInterval(ticker)
    ticker = undefined
  }
}
watch(active, (isActive) => {
  stopTicker()
  if (!isActive)
    return
  now.value = Date.now()
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 1000)
}, { immediate: true })
onBeforeUnmount(stopTicker)

const duration = computed(() => {
  const value = output.value
  if (!value)
    return ''
  if (value.finishedAt === undefined && !active.value)
    return ''
  return formatDuration(taskDurationMs(value, now.value))
})
const metaText = computed(() => {
  if (!output.value)
    return ''
  return [toolCallsText(toolCalls.value), duration.value].filter(Boolean).join(' · ')
})

/** Line 2: the latest step while running; the first sentence of the report (else of the error) once finished. */
const liveLine = computed(() => {
  const value = output.value
  if (active.value) {
    const step = value?.steps.at(-1)
    return step ? `└ ${taskStepLine(step)}` : ''
  }
  if (value) {
    const sentence = firstSentence(value.report)
    if (sentence)
      return sentence
    return value.error ? firstSentence(value.error) : ''
  }
  if (props.part.state === 'output-error')
    return firstSentence(props.part.errorText)
  return ''
})

const triggerLabel = computed(() => taskTriggerLabel(kind.value ?? null, description.value, state.value, toolCalls.value))

function onDecide(decision: { approved: boolean, alwaysAllow: boolean }) {
  const approval = props.part.approval
  if (!approval)
    return
  emit('approval', { id: approval.id, approved: decision.approved, toolName: name.value, alwaysAllow: decision.alwaysAllow })
}
</script>

<template>
  <div
    :data-testid="testIds.taskBlock"
    :data-state="state"
    :data-kind="kind"
    class="flex min-w-0 flex-col gap-1.5"
  >
    <ToolPart
      v-if="fallback"
      :part="part"
      :streaming="streaming"
      :superseded="superseded"
      @approval="emit('approval', { id: $event.id, approved: $event.approved, toolName: $event.toolName, alwaysAllow: $event.alwaysAllow })"
    />
    <template v-else>
      <Collapsible v-model:open="open" class="flex min-w-0 flex-col">
        <CollapsibleTrigger
          :data-testid="testIds.taskBlockTrigger"
          :aria-label="triggerLabel"
          class="group/task -mx-1.5 flex h-(--row-height) w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
        >
          <ChevronRightIcon
            aria-hidden="true"
            class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-base) group-data-[state=open]/task:rotate-90"
          />
          <TelescopeIcon v-if="kind === 'explore'" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
          <BotIcon v-else aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="shrink-0 font-medium">{{ kind === 'explore' ? 'Explore' : 'Agent' }}</span>
          <span class="min-w-0 truncate text-muted-foreground">{{ description }}</span>
          <span class="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
            <span v-if="metaText" data-slot="task-meta-short" :class="cn('tabular-nums', active && 'max-sm:hidden')">{{ metaText }}</span>
            <template v-if="state === 'queued'">
              <ClockIcon aria-hidden="true" class="size-3.5" />
              <span>Waiting</span>
            </template>
            <Spinner v-else-if="state === 'running'" class="size-3" />
            <template v-else-if="state === 'approval'">
              <span aria-hidden="true" class="size-2 rounded-full bg-warning" />
              <span>Needs approval</span>
            </template>
            <CheckIcon v-else-if="state === 'completed'" aria-hidden="true" class="size-3.5 text-success" />
            <XIcon v-else-if="state === 'failed'" aria-hidden="true" class="size-3.5 text-destructive" />
            <template v-else-if="state === 'limit'">
              <TriangleAlertIcon aria-hidden="true" class="size-3.5 text-warning" />
              <span>Step limit reached</span>
            </template>
            <template v-else-if="state === 'aborted'">
              <CircleSlashIcon aria-hidden="true" class="size-3.5" />
              <span>Stopped</span>
            </template>
            <Tooltip v-else-if="supersededDenial">
              <TooltipTrigger as-child>
                <span class="inline-flex items-center gap-1.5">
                  <BanIcon aria-hidden="true" class="size-3.5" />
                  <span>Denied</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>Skipped because you sent a new message</TooltipContent>
            </Tooltip>
            <template v-else>
              <BanIcon aria-hidden="true" class="size-3.5" />
              <span>Denied</span>
            </template>
          </span>
        </CollapsibleTrigger>
        <p
          data-slot="task-live"
          aria-hidden="true"
          :class="cn('h-5 min-w-0 truncate pl-5 text-xs leading-5 text-muted-foreground', active && 'font-mono')"
        >
          {{ liveLine }}
        </p>
        <CollapsibleContent class="min-w-0 pt-1 pl-5 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0">
          <TaskBody :input="part.input" :output="hasOutput ? part.output : undefined" :running="active" />
        </CollapsibleContent>
      </Collapsible>
      <ToolApprovalCard
        v-if="awaitingDecision"
        :part="part"
        :tool-name="name"
        :source="tool?.pluginId ?? null"
        :workspace="tool?.workspace ?? null"
        @decide="onDecide"
      />
    </template>
  </div>
</template>
