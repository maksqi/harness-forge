<script setup lang="ts">
// One tool call of a sub-agent (docs/UI.md 2.16, 7.27, 10.6; ADR-043), inside TaskBody. Store-free. Props and root test
// id frozen from Gate P9-0b (C25).
// The tool's icon and name, the summary (mono, quoted), the result preview (muted), the status: `Spinner` while the
// sub-agent runs (`CircleSlash` once it stopped), `Check`, `X`, or `Ban` + "Skipped" for a denied step, whose tooltip
// and sr-only text say "Sub-agents can't ask for approval, so this was skipped." (a sub-agent never asks; ADR-043).
// Root `task-step` (`data-tool-name`, `data-state` running | done | error | denied).
import type { TaskStep, TaskStepState } from '@harness-forge/shared'
import { BanIcon, CheckIcon, CircleSlashIcon, ServerIcon, WrenchIcon, XIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { splitMcpToolName } from '../chat-format'
import { workspaceToolIcon } from '../parts/tools/workspace-tools'

const props = defineProps<{
  step: TaskStep
  /** The sub-agent is running (a `running` step spins only then). */
  running: boolean
}>()

/** Why a denied step was skipped (tooltip and sr-only text). */
const DENIED_REASON = 'Sub-agents can\'t ask for approval, so this was skipped.'

const STATE_LABELS: Record<TaskStepState, string> = {
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  denied: 'Skipped',
}

const mcp = computed(() => splitMcpToolName(props.step.toolName))
const name = computed(() => mcp.value?.tool ?? props.step.toolName)
const icon = computed(() => (mcp.value ? ServerIcon : workspaceToolIcon(props.step.toolName) ?? WrenchIcon))
const summary = computed(() => props.step.summary.replace(/\s+/g, ' ').trim())
const preview = computed(() => (props.step.resultPreview ?? '').replace(/\s+/g, ' ').trim())
const stopped = computed(() => props.step.state === 'running' && !props.running)
</script>

<template>
  <div
    :data-testid="testIds.taskStep"
    :data-tool-name="step.toolName"
    :data-state="step.state"
    class="flex h-7 min-w-0 items-center gap-2 text-xs pointer-coarse:h-8"
  >
    <component :is="icon" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
    <span class="shrink-0 font-mono text-[12px] font-medium">{{ name }}</span>
    <span v-if="summary" class="min-w-0 truncate font-mono text-muted-foreground">"{{ summary }}"</span>
    <span class="ml-auto flex min-w-0 shrink-0 items-center gap-1.5 pl-2 text-muted-foreground">
      <span v-if="preview && step.state !== 'denied'" data-slot="task-step-preview" class="hidden max-w-48 truncate sm:inline">{{ preview }}</span>
      <template v-if="step.state === 'running'">
        <Spinner v-if="!stopped" class="size-3" />
        <template v-else>
          <CircleSlashIcon aria-hidden="true" class="size-3.5" />
          <span>Stopped</span>
        </template>
      </template>
      <CheckIcon v-else-if="step.state === 'done'" aria-hidden="true" class="size-3.5 text-success" />
      <XIcon v-else-if="step.state === 'error'" aria-hidden="true" class="size-3.5 text-destructive" />
      <Tooltip v-else>
        <TooltipTrigger as-child>
          <span tabindex="0" class="inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <BanIcon aria-hidden="true" class="size-3.5" />
            <span>Skipped</span>
            <span class="sr-only">. {{ DENIED_REASON }}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ DENIED_REASON }}</TooltipContent>
      </Tooltip>
      <span v-if="step.state !== 'denied' && !stopped" class="sr-only">{{ STATE_LABELS[step.state] }}</span>
    </span>
  </div>
</template>
