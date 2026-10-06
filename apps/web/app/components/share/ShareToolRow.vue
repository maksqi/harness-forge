<script setup lang="ts">
// One tool call of a shared chat (docs/UI.md 7.2, 7.15): the one-line row of the transcript without approvals —
// Wrench (Server and a server badge for `mcp__<server>__<tool>`), the tool name, the first argument when the share
// includes tool details (the prompt for generate_image), and the outcome (done, error, denied, stopped). With tool
// details the row is a button that expands Input / Output (ToolValueBlock) and the error text; without them it is
// static. Store-free.
// Phase 7 (docs/UI.md 7.19): `core-workspace` tools use the same registry as ToolPart (icon, argument, summary) and,
// with tool details, WorkspaceToolBody with the generic blocks behind "Raw input and output"; a value the server cut
// at the share limit (a `[truncated]` string) fails the schemas and keeps the generic blocks.
// Phase 8 (W8.10, docs/UI.md 7.19): the same spoken summary labels (ToolRowSummary), the terminal's folder prompt, "Now
// in {folder}" and "Allowed by rule: …" (TerminalOutput), and the rule badge (ToolRuleBadge) of a shell call that ran
// because shell rules matched (`allowedBy`; only with tool details: the output carries it).
// Phase 9 (W9.10, docs/UI.md 7.15, 7.25, 7.27): the agent tools of `core-agent` render like in the chat when tool details
// are shared: a `task` call as "Explore" / "Agent" with its description and TaskBody, `todo_write` with the summary "3/7"
// and TodoList, `exit_plan_mode` with PlanBody ("Approved · …" / "Kept planning"), the latter two with the generic
// blocks behind "Raw input and output" (same test ids as in the chat). Without tool details the rows read "Sub-agent",
// "Updated tasks" and "Plan" (no argument) and stay static. A value that fails its schema keeps the generic row.
// Phase 10 (W10.11, docs/UI.md 7.27, 7.28, 7.29): a custom agent type reads as its name (`BotMessageSquare`, cut at 24
// characters) and a background call adds "· in the background"; a `skill` call reads "Loaded skill {name}" (`BookOpen`)
// with SkillToolBody behind "Raw input and output" when tool details are shared, "Loaded skill" without them. The
// server drops task results from shares, so no result note reaches this row.
// Phase 11 (docs/UI.md 7.31): shares carry no hook records, so a call a hook denied reads "Denied" (no hook badge or
// notes).
// Contract (docs/UI.md 10.4): `part` is the snapshot's tool part (toolName, status, input?, output?, errorText?).
import type { TodoItem } from '@harness-forge/shared'
import type { Component } from 'vue'
import type { ShareToolPart } from './share-view'
import type { WorkspaceRowSummary } from '~/components/chat/parts/tools/workspace-tools'
import { shellToolOutputSchema, skillOutputSchema } from '@harness-forge/shared'
import {
  BanIcon,
  BookOpenIcon,
  BotIcon,
  BotMessageSquareIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  ClipboardListIcon,
  ListTodoIcon,
  PencilLineIcon,
  ServerIcon,
  TelescopeIcon,
  WrenchIcon,
  XIcon,
} from '@lucide/vue'
import { computed, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import {
  doneTodos,
  planApprovedText,
  planModeOf,
  planOf,
  skillNameOf,
  taskAgentTypeName,
  taskInputOf,
  taskIsBackground,
  taskKindOf,
  taskOutputOf,
  taskTypeLabelShort,
  TODO_TOOL_NAME,
  todoListOf,
} from '~/components/chat/agent/agent-tools'
import AgentToolBody from '~/components/chat/agent/AgentToolBody.vue'
import PlanBody from '~/components/chat/agent/PlanBody.vue'
import SkillToolBody from '~/components/chat/agent/SkillToolBody.vue'
import TaskBody from '~/components/chat/agent/TaskBody.vue'
import TodoList from '~/components/chat/agent/TodoList.vue'
import {
  formatToolValue,
  isServerTruncated,
  PLAN_TOOL_NAME,
  SKILL_TOOL_NAME,
  splitMcpToolName,
  TASK_TOOL_NAME,
} from '~/components/chat/chat-format'
import { toolRowArgument } from '~/components/chat/parts/tool-row'
import ToolRowSummary from '~/components/chat/parts/tools/ToolRowSummary.vue'
import ToolRuleBadge from '~/components/chat/parts/tools/ToolRuleBadge.vue'
import { workspaceRowSummary, workspaceToolIcon, workspaceToolView } from '~/components/chat/parts/tools/workspace-tools'
import WorkspaceToolBody from '~/components/chat/parts/tools/WorkspaceToolBody.vue'
import ToolValueBlock from '~/components/chat/parts/ToolValueBlock.vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{ part: ShareToolPart }>()

const open = ref(false)

const mcp = computed(() => splitMcpToolName(props.part.toolName))
const displayName = computed(() => mcp.value?.tool ?? props.part.toolName)
const hasInput = computed(() => props.part.input !== undefined)
const hasOutput = computed(() => props.part.output !== undefined)
/** Tool details are shared: the server sends inputs, outputs and errors only with `options.toolDetails`. */
const expandable = computed(() => hasInput.value || hasOutput.value || !!props.part.errorText)
const firstArg = computed(() => (hasInput.value ? toolRowArgument(props.part.toolName, props.part.input) : null))
const inputText = computed(() => formatToolValue(props.part.input))
const outputText = computed(() => formatToolValue(props.part.output))
// A value over the share limit arrives as its JSON text, cut and marked "[truncated]" (ADR-025).
const inputTruncated = computed(() => hasInput.value && isServerTruncated(props.part.input))
const outputTruncated = computed(() => hasOutput.value && isServerTruncated(props.part.output))
/** + Phase 9: the agent tool of this row (by name; the snapshot has no plugin id), or null; + Phase 10: `skill`. */
const agentTool = computed<'task' | 'todo' | 'plan' | 'skill' | null>(() => {
  switch (props.part.toolName) {
    case TASK_TOOL_NAME:
      return 'task'
    case TODO_TOOL_NAME:
      return 'todo'
    case PLAN_TOOL_NAME:
      return 'plan'
    case SKILL_TOOL_NAME:
      return 'skill'
    default:
      return null
  }
})
/** + Phase 9: what an agent row reads without tool details (+ Phase 10: "Loaded skill"). */
const AGENT_LABELS = { task: 'Sub-agent', todo: 'Updated tasks', plan: 'Plan', skill: 'Loaded skill' } as const
/**
 * + Phase 9: the agent view with tool details (7.25, 7.27): the sub-agent (its input parses, and its output when there
 * is one), the todo list or the plan; null keeps the generic row (no details, an error, a value the share cut).
 */
const agentView = computed<
  | { kind: 'task', type: 'explore' | 'general' | 'custom', label: string, description: string, background: boolean }
  | { kind: 'todo', todos: readonly TodoItem[] }
  | { kind: 'plan', plan: string, mode: 'edits' | 'ask' | null }
  | { kind: 'skill', name: string }
  | null
>(() => {
  if (!agentTool.value || !hasInput.value || props.part.status === 'error')
    return null
  const output = hasOutput.value ? props.part.output : undefined
  if (agentTool.value === 'task') {
    const task = taskInputOf(props.part.input)
    const result = hasOutput.value ? taskOutputOf(output) : null
    if (!task || (hasOutput.value && !result))
      return null
    // + Phase 10: any agent type (the output's resolved name first) and background calls.
    const type = taskAgentTypeName(props.part.input, result) ?? task.type
    return {
      kind: 'task',
      type: taskKindOf(type),
      label: taskTypeLabelShort(type),
      description: task.description,
      background: taskIsBackground(props.part.input, result),
    }
  }
  if (agentTool.value === 'skill') {
    // + Phase 10: a loaded skill (its output parses); anything else keeps the generic row.
    const skill = hasOutput.value ? skillOutputSchema.safeParse(output) : null
    const name = skill?.success ? skill.data.name : skillNameOf(props.part.input)
    if (!skill?.success || !name)
      return null
    return { kind: 'skill', name }
  }
  if (agentTool.value === 'todo') {
    const todos = todoListOf(props.part.input, output)
    return todos === null ? null : { kind: 'todo', todos }
  }
  const plan = planOf(props.part.input)
  const mode = planModeOf(output)
  if (plan === null || (hasOutput.value && mode === null))
    return null
  return { kind: 'plan', plan, mode }
})
/** + Phase 9: the label of an agent row without tool details ("Sub-agent", "Updated tasks", "Plan"). */
const agentLabel = computed(() => (agentTool.value && !expandable.value ? AGENT_LABELS[agentTool.value] : null))
const rowIcon = computed<Component>(() => {
  if (mcp.value)
    return ServerIcon
  if (agentTool.value === 'task') {
    const type = agentView.value?.kind === 'task' ? agentView.value.type : 'general'
    return type === 'explore' ? TelescopeIcon : type === 'custom' ? BotMessageSquareIcon : BotIcon
  }
  if (agentTool.value === 'skill')
    return BookOpenIcon
  if (agentTool.value === 'todo')
    return ListTodoIcon
  if (agentTool.value === 'plan')
    return ClipboardListIcon
  return workspaceToolIcon(props.part.toolName) ?? WrenchIcon
})
/** + Phase 9: the status text of an approved plan. */
const planApproved = computed(() => {
  const view = agentView.value
  return props.part.status === 'done' && view?.kind === 'plan' && view.mode ? planApprovedText(view.mode) : null
})
/** The workspace summary and body of a finished call whose output parses (7.19); + Phase 9: "3/7" of a todo list. */
const summary = computed<WorkspaceRowSummary | null>(() => {
  const view = agentView.value
  if (view?.kind === 'todo') {
    const done = doneTodos(view.todos)
    return { text: `${done}/${view.todos.length}`, tone: 'muted', label: `${done} of ${view.todos.length} tasks done` }
  }
  return props.part.status === 'done' && hasOutput.value ? workspaceRowSummary(props.part.toolName, props.part.output) : null
})
/** The prefixes of the shell rules that let a finished `shell` call run without a card (ToolRuleBadge). */
const allowedBy = computed<readonly string[]>(() => {
  if (props.part.status !== 'done' || props.part.toolName !== 'shell' || !hasOutput.value)
    return []
  const parsed = shellToolOutputSchema.safeParse(props.part.output)
  return parsed.success ? parsed.data.allowedBy ?? [] : []
})
const view = computed(() => {
  if (agentView.value || props.part.status !== 'done' || props.part.output === undefined || props.part.output === null)
    return null
  return workspaceToolView(props.part.toolName, props.part.input, props.part.output)
})
const statusLabel = computed(() => ({ done: 'Done', error: 'Failed', denied: 'Denied', stopped: 'Stopped' })[props.part.status])

const ROW_CLASS = '-mx-1.5 flex h-(--row-height) w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm pointer-coarse:h-10'
</script>

<template>
  <Collapsible
    v-model:open="open"
    :data-testid="testIds.shareToolRow"
    :data-tool-name="part.toolName"
    :data-status="part.status"
    class="flex min-w-0 flex-col"
  >
    <component
      :is="expandable ? CollapsibleTrigger : 'div'"
      :class="cn(
        ROW_CLASS,
        expandable && 'group/tool-row outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
      )"
    >
      <ChevronRightIcon
        v-if="expandable"
        aria-hidden="true"
        class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-base) group-data-[state=open]/tool-row:rotate-90"
      />
      <component :is="rowIcon" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
      <span v-if="agentLabel" data-slot="agent-tool-label" class="min-w-0 truncate font-medium">{{ agentLabel }}</span>
      <template v-else-if="agentView?.kind === 'task'">
        <span class="shrink-0 font-medium">{{ agentView.label }}</span>
        <span class="min-w-0 truncate text-muted-foreground">{{ agentView.description }}</span>
        <span v-if="agentView.background" data-slot="share-task-background" class="shrink-0 text-muted-foreground">· in the background</span>
      </template>
      <template v-else-if="agentView?.kind === 'skill'">
        <span class="shrink-0 font-medium">Loaded skill</span>
        <span class="min-w-0 truncate font-mono text-[13px]">{{ agentView.name }}</span>
      </template>
      <template v-else>
        <span class="shrink-0 font-mono text-[13px] font-medium">{{ displayName }}</span>
        <span v-if="firstArg" class="min-w-0 truncate font-mono text-xs text-muted-foreground">"{{ firstArg }}"</span>
      </template>
      <Badge v-if="mcp" variant="outline" class="h-4 shrink-0 px-1.5 text-[10px] font-normal text-muted-foreground">
        {{ mcp.serverId }}
      </Badge>
      <span class="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
        <ToolRuleBadge v-if="allowedBy.length > 0" :prefixes="allowedBy" />
        <ToolRowSummary v-if="summary" :summary="summary" class="mr-0.5" />
        <template v-if="planApproved">
          <CheckIcon aria-hidden="true" class="size-3.5 text-success" />
          <span>{{ planApproved }}</span>
        </template>
        <CheckIcon v-else-if="part.status === 'done'" aria-hidden="true" class="size-3.5 text-success" />
        <XIcon v-else-if="part.status === 'error'" aria-hidden="true" class="size-3.5 text-destructive" />
        <template v-else-if="part.status === 'denied' && agentTool === 'plan'">
          <PencilLineIcon aria-hidden="true" class="size-3.5" />
          <span>Kept planning</span>
        </template>
        <template v-else-if="part.status === 'denied'">
          <BanIcon aria-hidden="true" class="size-3.5" />
          <span>Denied</span>
        </template>
        <template v-else>
          <CircleSlashIcon aria-hidden="true" class="size-3.5" />
          <span>Stopped</span>
        </template>
        <span v-if="(part.status === 'done' && !planApproved) || part.status === 'error'" class="sr-only">{{ statusLabel }}</span>
      </span>
    </component>
    <CollapsibleContent
      v-if="expandable"
      :data-testid="testIds.shareToolRowOutput"
      class="min-w-0 overflow-hidden pt-1 pl-6 data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0"
    >
      <TaskBody v-if="agentView?.kind === 'task'" :input="part.input" :output="part.output" :running="false" />
      <AgentToolBody v-else-if="agentView">
        <TodoList v-if="agentView.kind === 'todo'" :todos="agentView.todos" />
        <SkillToolBody v-else-if="agentView.kind === 'skill'" :input="part.input" :output="part.output" />
        <PlanBody v-else :plan="agentView.plan" />
        <template #raw>
          <div class="flex min-w-0 flex-col gap-3 rounded-md bg-muted/50 p-3">
            <ToolValueBlock label="Input" :value="inputText || '{}'" :server-truncated="inputTruncated" />
            <ToolValueBlock v-if="hasOutput" label="Output" :value="outputText" :server-truncated="outputTruncated" />
          </div>
        </template>
      </AgentToolBody>
      <WorkspaceToolBody v-else-if="view" :view="view">
        <template #raw>
          <div class="flex min-w-0 flex-col gap-3 rounded-md bg-muted/50 p-3">
            <ToolValueBlock v-if="hasInput" label="Input" :value="inputText || '{}'" :server-truncated="inputTruncated" />
            <ToolValueBlock label="Output" :value="outputText" :server-truncated="outputTruncated" />
          </div>
        </template>
      </WorkspaceToolBody>
      <div v-else class="flex min-w-0 flex-col gap-3 rounded-md bg-muted/50 p-3">
        <ToolValueBlock v-if="hasInput" label="Input" :value="inputText || '{}'" :server-truncated="inputTruncated" />
        <ToolValueBlock v-if="hasOutput" label="Output" :value="outputText" :server-truncated="outputTruncated" />
        <ToolValueBlock v-if="part.errorText" label="Error" :value="part.errorText" tone="error" />
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>
