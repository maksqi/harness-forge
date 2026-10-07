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
// Phase 10 (W10.11; ADR-045, ADR-046; docs/UI.md 7.27, 13.11, 14.2): the type is any agent name. A custom type
// (`data-kind="custom"`) shows `BotMessageSquare` and its name (cut at 24 characters, the full name in a tooltip);
// `data-agent-type` names the type (the output's, else the input's; `general-purpose` reads as `general`). With an
// agent snapshot (`output.agent`) the label opens a HoverCard with the agent's description and source ("Built-in
// agent", "Personal agent", "From {plugin}", "Project: {path}"); keyboard focus on the trigger opens it too and the
// trigger's description carries the same text. A background call (`data-background="true"`) reads its live state from
// AGENT_TASK_CONTEXT (ChatView): the background task while it waits or runs (spinner, "In background", "Background ·
// {n} tool calls · {duration}", the latest step; the trigger name adds ", running in the background"), its final status
// once it ended or its result was delivered, else `data-state="background"` ("Started in the background"). Expanded, a
// background block shows TaskBody with the live snapshot and `task-block-reveal`: "Show in background agents" while it
// runs (`data-target="dock"`), "Go to the result" once its result is on the shown path (`data-target="result"`).
// Without the context (outside a chat view) a background block stays static.
// Phase 12 (ADR-058, docs/UI.md 7.34; W12.13): a custom agent with a `color` in the catalog of the chat's scope (the
// customizations store; the chat's project from TOOL_APPROVAL_CONTEXT) shows an 8px dot before its name and a 2px left
// rule on the open block, mapped to existing tokens (`AGENT_COLOR_CLASSES`): `data-slot="task-agent-color"` with
// `data-value` = the color, `aria-hidden` (the type stays text). A qualified name of a Claude Code plugin agent shows as
// it is ("review-kit:code-reviewer").
import type { ToolPartLike } from '../chat-format'
import {
  BanIcon,
  BotIcon,
  BotMessageSquareIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  ClockIcon,
  TelescopeIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
import { computed, inject, onBeforeUnmount, ref, useId, watch } from 'vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useCustomizationsStore } from '~/stores/customizations'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { AGENT_TASK_CONTEXT, TRANSCRIPT_SCROLL } from '../chat-context'
import { formatDuration, isSupersededDenial, toolNameOf } from '../chat-format'
import { TOOL_APPROVAL_CONTEXT } from '../parts/tool-approval-context'
import ToolApprovalCard from '../parts/ToolApprovalCard.vue'
import ToolPart from '../parts/ToolPart.vue'
import {
  AGENT_COLOR_CLASSES,
  agentColorOf,
  backgroundTaskState,
  firstSentence,
  taskAgentSourceText,
  taskAgentTypeName,
  taskBlockState,
  taskDescriptionOf,
  taskDurationMs,
  taskInputOf,
  taskIsBackground,
  taskKindOf,
  taskOutputOf,
  taskStepLine,
  taskToolCalls,
  taskTriggerLabel,
  taskTypeLabel,
  taskTypeLabelShort,
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
const customizations = useCustomizationsStore()
/** + Phase 12: the chat's project (the catalog scope of the agent colors). */
const approvalContext = inject(TOOL_APPROVAL_CONTEXT, null)
const open = ref(false)
const scroll = inject(TRANSCRIPT_SCROLL, null)
/** + Phase 10: the chat's background agents (absent outside a chat view: background blocks stay static). */
const tasks = inject(AGENT_TASK_CONTEXT, null)
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

/** The agent type (any catalog name since Phase 10), and its kind: explore, general or custom. */
const agentType = computed(() => taskAgentTypeName(props.part.input, output.value))
const kind = computed(() => (agentType.value === null ? undefined : taskKindOf(agentType.value)))
/** + Phase 10: the label ("Explore", "Agent" or the custom name, cut at 24 characters) and the full name. */
const label = computed(() => (agentType.value === null ? 'Agent' : taskTypeLabelShort(agentType.value)))
const fullLabel = computed(() => (agentType.value === null ? 'Agent' : taskTypeLabel(agentType.value)))
const description = computed(() => input.value?.description ?? taskDescriptionOf(props.part.input))
/** + Phase 12: the custom agent's color in the catalog of the chat's scope, or null. */
const agentColor = computed(() => {
  if (kind.value !== 'custom' || agentType.value === null)
    return null
  return agentColorOf(customizations.entriesOf(approvalContext?.projectId() ?? null, 'agent'), agentType.value)
})

// ---------- background calls (Phase 10, ADR-046) ----------

/** + Phase 10: the call asked for a background sub-agent (`data-background`). */
const background = computed(() => taskIsBackground(props.part.input, output.value))
/** + Phase 10: the call launched its background sub-agent (the final output `status: 'background'` with its task id). */
const launched = computed(() => output.value?.status === 'background')
const taskId = computed(() => (launched.value ? output.value?.taskId ?? null : null))
/** + Phase 10: the live state of a launched background agent: the task, else its delivered result, else unknown. */
const live = computed(() => {
  if (!launched.value)
    return null
  const id = taskId.value
  const task = id && tasks ? tasks.task(id) : null
  const result = id && tasks ? tasks.result(id) : null
  return backgroundTaskState(task, result)
})
/** The output the block reads: the live snapshot of a background agent, else the call's own output. */
const shown = computed(() => (live.value ? live.value.output : output.value))

const state = computed(() => live.value?.state
  ?? taskBlockState(props.part, { streaming: props.streaming, superseded: props.superseded }))
const active = computed(() => state.value === 'running' || state.value === 'queued')
/** + Phase 10: a background agent that waits or runs ("In background"). */
const runningInBackground = computed(() => live.value !== null && active.value)
const toolCalls = computed(() => taskToolCalls(shown.value))
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
  const value = shown.value
  if (!value)
    return ''
  if (value.finishedAt === undefined && !active.value)
    return ''
  return formatDuration(taskDurationMs(value, now.value))
})
const metaText = computed(() => {
  if (!shown.value)
    return ''
  const items = [toolCallsText(toolCalls.value), duration.value]
  // + Phase 10: "Background · {n} tool calls · 1m 2s".
  if (live.value)
    items.unshift('Background')
  return items.filter(Boolean).join(' · ')
})

/** Line 2: the latest step while running; the first sentence of the report (else of the error) once finished. */
const liveLine = computed(() => {
  const value = shown.value
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

const triggerLabel = computed(() => taskTriggerLabel(agentType.value, description.value, state.value, toolCalls.value, {
  background: live.value !== null,
}))

// ---------- the agent card (Phase 10, ADR-045) ----------

/** + Phase 10: the agent definition the sub-agent ran with (a snapshot taken when the call ran). */
const agent = computed(() => shown.value?.agent ?? output.value?.agent ?? null)
/**
 * + Phase 10: the plugin of a plugin agent: the snapshot's `pluginId` by its name in the plugins store (else the id);
 * a snapshot without one (written before the field existed) looks for the plugin that contributes the type.
 */
const pluginName = computed(() => {
  const value = agent.value
  if (value?.source !== 'plugin')
    return null
  if (value.pluginId)
    return plugins.byId(value.pluginId)?.name ?? value.pluginId
  const type = agentType.value
  return type === null ? null : plugins.items.find(plugin => plugin.contributions.agents.includes(type))?.name ?? null
})
const agentSource = computed(() => (agent.value ? taskAgentSourceText(agent.value, pluginName.value) : ''))
const agentCardOpen = ref(false)
const agentDescriptionId = useId()
/** The name is cut: a tooltip shows the whole name (without an agent card). */
const labelCut = computed(() => label.value !== fullLabel.value)

/** Keyboard focus on the trigger opens the agent card (a pointer opens it by hovering the label). */
function onTriggerFocus(event: FocusEvent) {
  if (!agent.value)
    return
  let keyboard = false
  try {
    keyboard = (event.target as HTMLElement | null)?.matches(':focus-visible') === true
  }
  catch {
    keyboard = false
  }
  if (keyboard)
    agentCardOpen.value = true
}

// ---------- the reveal link (Phase 10) ----------

/** + Phase 10: "Show in background agents" while it runs, "Go to the result" once its result is on the shown path. */
const revealTarget = computed<'dock' | 'result' | null>(() => {
  const id = taskId.value
  if (!id || !tasks || !live.value)
    return null
  if (active.value)
    return 'dock'
  return tasks.result(id) ? 'result' : null
})

function onReveal() {
  const id = taskId.value
  if (!id || !tasks)
    return
  if (revealTarget.value === 'dock')
    tasks.reveal(id)
  else if (revealTarget.value === 'result')
    tasks.showResult(id)
}

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
    :data-agent-type="agentType ?? undefined"
    :data-background="background ? 'true' : undefined"
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
          :aria-describedby="agent ? agentDescriptionId : undefined"
          class="group/task -mx-1.5 flex h-(--row-height) w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
          @focus="onTriggerFocus"
          @blur="agentCardOpen = false"
        >
          <ChevronRightIcon
            aria-hidden="true"
            class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-base) group-data-[state=open]/task:rotate-90"
          />
          <TelescopeIcon v-if="kind === 'explore'" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
          <BotMessageSquareIcon v-else-if="kind === 'custom'" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
          <BotIcon v-else aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
          <span
            v-if="agentColor"
            data-slot="task-agent-color"
            :data-value="agentColor"
            aria-hidden="true"
            :class="cn('size-2 shrink-0 rounded-full', AGENT_COLOR_CLASSES[agentColor].dot)"
          />
          <HoverCard v-if="agent" v-model:open="agentCardOpen" :open-delay="400" :close-delay="100">
            <HoverCardTrigger as-child>
              <span data-slot="task-agent-label" class="max-w-[24ch] shrink-0 truncate font-medium">{{ label }}</span>
            </HoverCardTrigger>
            <HoverCardContent align="start" class="w-72 p-3 text-xs" data-slot="task-agent-card">
              <p class="truncate text-sm font-medium">
                {{ fullLabel }}
              </p>
              <p v-if="agent.description" class="mt-1 break-words text-muted-foreground">
                {{ agent.description }}
              </p>
              <p data-slot="task-agent-source" class="mt-2 break-words text-muted-foreground">
                <template v-if="agent.source === 'project' && agent.path">
                  Project: <span class="font-mono text-foreground">{{ agent.path }}</span>
                </template>
                <template v-else>
                  {{ agentSource }}
                </template>
              </p>
            </HoverCardContent>
          </HoverCard>
          <Tooltip v-else-if="labelCut">
            <TooltipTrigger as-child>
              <span data-slot="task-agent-label" class="max-w-[24ch] shrink-0 truncate font-medium">{{ label }}</span>
            </TooltipTrigger>
            <TooltipContent>{{ fullLabel }}</TooltipContent>
          </Tooltip>
          <span v-else data-slot="task-agent-label" class="shrink-0 font-medium">{{ label }}</span>
          <span class="min-w-0 truncate text-muted-foreground">{{ description }}</span>
          <span v-if="agent" :id="agentDescriptionId" class="sr-only">{{ [agent.description, agentSource].filter(Boolean).join('. ') }}</span>
          <span class="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
            <span v-if="metaText" data-slot="task-meta-short" :class="cn('tabular-nums', active && 'max-sm:hidden')">{{ metaText }}</span>
            <template v-if="runningInBackground">
              <Spinner class="size-3" />
              <span>In background</span>
            </template>
            <template v-else-if="state === 'queued'">
              <ClockIcon aria-hidden="true" class="size-3.5" />
              <span>Waiting</span>
            </template>
            <Spinner v-else-if="state === 'running'" class="size-3" />
            <template v-else-if="state === 'background'">
              <CircleDashedIcon aria-hidden="true" class="size-3.5" />
              <span>Started in the background</span>
            </template>
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
        <CollapsibleContent
          :class="cn(
            'min-w-0 pt-1 pl-5 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
            agentColor && ['ml-1.5 border-l-2 pl-3', AGENT_COLOR_CLASSES[agentColor].rule],
          )"
        >
          <TaskBody :input="part.input" :output="shown ?? (hasOutput ? part.output : undefined)" :running="active" />
          <button
            v-if="revealTarget"
            type="button"
            :data-testid="testIds.taskBlockReveal"
            :data-target="revealTarget"
            class="mt-1.5 flex h-7 items-center rounded-sm px-1 -ml-1 text-xs font-medium text-muted-foreground underline decoration-primary/60 underline-offset-2 outline-none hover:text-foreground hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
            @click="onReveal"
          >
            {{ revealTarget === 'dock' ? 'Show in background agents' : 'Go to the result' }}
          </button>
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
