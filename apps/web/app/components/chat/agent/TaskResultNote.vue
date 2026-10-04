<script setup lang="ts">
// The result of a background agent in the transcript (docs/UI.md 7.29, 10.7, 14; ADR-046): a full-width dashed note,
// `role="note"` named "Background agent result: {description}". Line 1: the type icon, "Background agent finished /
// failed / stopped / reached its step limit · {label} · {description}" and, on the right, "{n} tool calls · 3m 2s"
// (`data-slot="task-result-meta"`, hidden below `sm`). Line 2: the report's first sentence (else the error, else "No
// report.") and Show report / Hide report (`task-result-toggle`, `aria-expanded`, `aria-controls`, `data-state`), which
// opens the report (`task-result-report`): the 7.27 alert for a failed agent, the report as Markdown (`max-h-[50dvh]`,
// scrolls) with "Copy report", and the meta line "{model} · {tokens} tokens · {cost} · {duration}". Collapsed by
// default, not persisted. Store-free: ChatMessage renders it for block kind `task-result` (variant inline) and for a
// carrier message (variant turn, the turn the server started for finished background agents). Props and the root test
// id are frozen from Gate P10-0b (C33). ChatView's "Go to the result" scrolls to the note and opens its report by
// clicking its closed toggle.
import type { TaskResultData } from '@harness-forge/shared'
import { BotIcon, BotMessageSquareIcon, ChevronRightIcon, CircleAlertIcon, TelescopeIcon } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'
import CopyButton from '~/components/common/CopyButton.vue'
import Markdown from '~/components/common/Markdown.vue'
import { testIds } from '~/utils/testids'
import { formatDuration } from '../chat-format'
import {
  taskDurationMs,
  taskKindOf,
  taskMetaLine,
  taskResultHeading,
  taskResultSummary,
  taskToolCalls,
  taskTypeLabel,
  toolCallsText,
} from './agent-tools'

const props = defineProps<{ result: TaskResultData, variant: 'inline' | 'turn' }>()

const open = ref(false)
const reportId = useId()

const output = computed(() => props.result.output)
const kind = computed(() => taskKindOf(output.value.type))
const heading = computed(() => taskResultHeading(output.value.status))
const label = computed(() => taskTypeLabel(output.value.type))
const summary = computed(() => taskResultSummary(output.value))
/** "{n} tool calls · 3m 2s": the duration until it finished (else until the result was delivered). */
const meta = computed(() => {
  const value = output.value
  const duration = formatDuration(taskDurationMs(value, value.finishedAt ?? props.result.deliveredAt))
  return [toolCallsText(taskToolCalls(value)), duration].filter(Boolean).join(' · ')
})
const report = computed(() => output.value.report.trim())
const failure = computed(() => (output.value.status === 'failed' ? output.value.error?.trim() || 'unknown error' : null))
const metaLine = computed(() => taskMetaLine(output.value))
</script>

<template>
  <div
    :data-testid="testIds.taskResult"
    :data-task-id="result.taskId"
    :data-status="output.status"
    :data-variant="variant"
    role="note"
    :aria-label="`Background agent result: ${output.description}`"
    class="flex w-full min-w-0 flex-col gap-0.5 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm"
  >
    <div class="flex min-w-0 items-center gap-2">
      <TelescopeIcon v-if="kind === 'explore'" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
      <BotMessageSquareIcon v-else-if="kind === 'custom'" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
      <BotIcon v-else aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
      <p class="min-w-0 truncate">
        <span class="font-medium">{{ heading }}</span>
        <span class="text-muted-foreground"> · {{ label }} · {{ output.description }}</span>
      </p>
      <span data-slot="task-result-meta" class="ml-auto shrink-0 pl-2 text-xs text-muted-foreground tabular-nums max-sm:hidden">
        {{ meta }}
      </span>
    </div>
    <div class="flex min-w-0 items-center gap-2">
      <p data-slot="task-result-summary" class="min-w-0 flex-1 truncate text-muted-foreground">
        {{ summary }}
      </p>
      <button
        type="button"
        :data-testid="testIds.taskResultToggle"
        :data-state="open ? 'open' : 'closed'"
        :aria-expanded="open"
        :aria-controls="open ? reportId : undefined"
        class="flex h-7 shrink-0 items-center gap-1 rounded-sm px-1 -mr-1 text-xs font-medium text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
        @click="open = !open"
      >
        {{ open ? 'Hide report' : 'Show report' }}
        <ChevronRightIcon
          aria-hidden="true"
          :class="cn('size-3 transition-transform duration-(--duration-base)', open && 'rotate-90')"
        />
      </button>
    </div>
    <div
      v-if="open"
      :id="reportId"
      :data-testid="testIds.taskResultReport"
      class="mt-1.5 flex min-w-0 flex-col gap-2 border-t border-dashed pt-2"
    >
      <Alert v-if="failure" variant="destructive" class="py-2">
        <CircleAlertIcon aria-hidden="true" />
        <AlertDescription class="break-words">
          The sub-agent failed: {{ failure }}
        </AlertDescription>
      </Alert>
      <section v-if="report" class="min-w-0">
        <div class="mb-1 flex h-6 items-center justify-between gap-2">
          <h4 class="font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Report
          </h4>
          <CopyButton :text="() => report" label="Copy report" />
        </div>
        <div data-slot="task-result-markdown" class="max-h-[50dvh] min-w-0 overflow-y-auto">
          <Markdown :content="report" :final="true" />
        </div>
      </section>
      <p v-else-if="!failure" data-slot="task-result-empty" class="break-words text-muted-foreground">
        {{ output.error?.trim() || 'No report.' }}
      </p>
      <p v-if="metaLine" data-slot="task-meta" class="text-xs text-muted-foreground tabular-nums">
        {{ metaLine }}
      </p>
    </div>
  </div>
</template>
