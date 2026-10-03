<script setup lang="ts">
// The expanded part of a sub-agent block (docs/UI.md 2.16, 7.27, 10.6; ADR-043), also the share page's task body
// (ShareToolRow). Store-free. Props frozen from Gate P9-0b (C25); `input` and `output` are parsed inside
// (`taskInputSchema` / `taskOutputSchema`): an unparsable input renders nothing, a missing or unparsable output leaves
// out the steps, the report and the meta line.
// "Prompt" (ToolValueBlock), the steps (TaskStepRow: the latest 10 first, "Show all {n} steps" = `task-steps-more` when
// more are kept, "{k} earlier steps were not kept" when the server dropped older ones), an alert "The sub-agent
// failed: {error}" above the partial report, "Report" as Markdown with a copy button (`task-report`) and the meta line
// "{model} · 18K tokens · $0.004 · 41s". No root test id (`data-slot="task-body"`).
import { CircleAlertIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import CopyButton from '~/components/common/CopyButton.vue'
import Markdown from '~/components/common/Markdown.vue'
import { testIds } from '~/utils/testids'
import ToolValueBlock from '../parts/ToolValueBlock.vue'
import { taskInputOf, taskMetaLine, taskOutputOf } from './agent-tools'
import TaskStepRow from './TaskStepRow.vue'

const props = defineProps<{
  input: unknown
  output: unknown
  /** The sub-agent is running (its last step may still run). */
  running: boolean
}>()

/** Steps shown before "Show all {n} steps". */
const STEPS_SHOWN = 10

const task = computed(() => taskInputOf(props.input))
const result = computed(() => taskOutputOf(props.output))
const showAll = ref(false)

const steps = computed(() => result.value?.steps ?? [])
const shownSteps = computed(() => (showAll.value ? steps.value : steps.value.slice(-STEPS_SHOWN)))
const hiddenSteps = computed(() => steps.value.length - shownSteps.value.length)
const omitted = computed(() => result.value?.stepsOmitted ?? 0)
const report = computed(() => result.value?.report.trim() ?? '')
const failure = computed(() => {
  const output = result.value
  if (!output || output.status !== 'failed')
    return null
  return output.error?.trim() || 'unknown error'
})
const meta = computed(() => (result.value && !props.running ? taskMetaLine(result.value) : ''))
</script>

<template>
  <div v-if="task" data-slot="task-body" class="flex min-w-0 flex-col gap-3 rounded-md bg-muted/50 p-3">
    <ToolValueBlock label="Prompt" :value="task.prompt" />
    <section v-if="steps.length > 0 || omitted > 0" data-slot="task-steps" class="flex min-w-0 flex-col">
      <h4 class="mb-1 flex h-6 items-center font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Steps
      </h4>
      <button
        v-if="hiddenSteps > 0"
        type="button"
        :data-testid="testIds.taskStepsMore"
        class="mb-1 flex h-7 items-center self-start rounded-sm px-1 -ml-1 text-[11px] font-medium text-muted-foreground underline decoration-primary/60 underline-offset-2 outline-none hover:text-foreground hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
        @click="showAll = true"
      >
        Show all {{ steps.length }} steps
      </button>
      <p v-else-if="omitted > 0" data-slot="task-steps-omitted" class="mb-1 text-[11px] text-muted-foreground">
        {{ omitted }} earlier {{ omitted === 1 ? 'step was' : 'steps were' }} not kept
      </p>
      <TaskStepRow v-for="step in shownSteps" :key="step.toolCallId" :step="step" :running="running" />
    </section>
    <Alert v-if="failure" variant="destructive" class="py-2">
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription class="break-words">
        The sub-agent failed: {{ failure }}
      </AlertDescription>
    </Alert>
    <section v-if="report" :data-testid="testIds.taskReport" class="min-w-0">
      <div class="mb-1 flex h-6 items-center justify-between gap-2">
        <h4 class="font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Report
        </h4>
        <CopyButton :text="() => report" label="Copy report" />
      </div>
      <Markdown :content="report" :final="!running" />
    </section>
    <p v-if="meta" data-slot="task-meta" class="text-xs text-muted-foreground tabular-nums">
      {{ meta }}
    </p>
  </div>
</template>
