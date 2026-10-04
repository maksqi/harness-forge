<script setup lang="ts">
// Tool call row (docs/UI.md 7.2): `▸ icon name "first argument" [server] … status`, the whole row toggles the body
// (input / output / error, 4 KB previews) and never opens by itself. MCP tools (`mcp__<server>__<tool>`) show the tool
// name plus a server badge (the server's name; the MCP list loads on first need). While approval is requested,
// ToolApprovalCard renders below the row. The builtin generate_image tool (Phase 6) is a normal row whose first
// argument is the prompt; its output stays JSON (file references) and its images are the file parts the server appends
// after the call, rendered as a gallery below the row.
// Phase 7 (7.19): `core-workspace` tools get their icon, argument and summary (`+12 −3`, `exit 1`, ...) from the
// workspace registry, and their body is WorkspaceToolBody (diff, terminal, file content, file list) with the generic
// blocks behind "Raw input and output"; a running shell shows its terminal with "Running…". A value that does not
// parse with the shared schemas keeps the generic blocks.
// Phase 8 (C20 wires it, W8.10 finishes it): a shell output with `allowedBy` (the command ran because shell rules
// matched, ADR-038) shows ToolRuleBadge before the summary; the approval payload passes the card's `allowRules` on; a
// running shell's terminal shows the folder it starts in (the call's `cwd` input, else the chat's current shell folder
// from TOOL_APPROVAL_CONTEXT.shellCwd()).
// Phase 9 (C25 wires it, W9.10 owns it; ADR-041, ADR-043; docs/UI.md 7.2, 7.25): an `exit_plan_mode` call of
// `core-agent` awaiting its decision shows PlanApprovalCard instead of ToolApprovalCard, and its decision goes up as the
// approval's `planMode` / `reason`; a preliminary output (`output-available` with `preliminary: true`, an async-generator
// tool such as `task`) is running while the message streams and stopped otherwise. The agent rows of `core-agent`:
// `todo_write` (`ListTodo`, the current item as the argument, the summary "3/7", the body TodoList) and
// `exit_plan_mode` (`ClipboardList`, the plan's first heading as the argument, the status "Plan ready for review",
// "Kept planning" or "Approved · Accept edits" / "Approved · Ask", the body PlanBody with "Your feedback: …"); both
// keep the generic blocks behind "Raw input and output", and a value that fails its schema keeps the generic row.
// Phase 10 (W10.11; ADR-045, ADR-047; docs/UI.md 7.25, 7.28, 14.2): the `skill` row of `core-agent`
// (`tool-row[data-tool-name="skill"]`): `BookOpen`, "Loaded skill" and the mono skill name (the input's while it runs:
// "Loading skill", shimmering; "Couldn't load skill" when it failed, the error in the body), the source on the right
// ("Project", "Personal", the plugin's name, "Built-in") and the status; the row is named "Loaded skill {name},
// {source}". Its agent body is SkillToolBody, with the generic blocks behind "Raw input and output". The body of an
// approved `exit_plan_mode` starts with PlanFileChip (the output's `planPath` / `planError`; Show changes in project
// chats).
import type { TodoItem } from '@harness-forge/shared'
import type { ToolPartLike } from '../chat-format'
import type { WorkspaceRowSummary } from './tools/workspace-tools'
import type { AllowRules } from '~/components/workspace/allowlist/allow-rule'
import { shellToolOutputSchema, skillOutputSchema, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import {
  BanIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  ClipboardListIcon,
  ListTodoIcon,
  PencilLineIcon,
  ServerIcon,
  WrenchIcon,
  XIcon,
} from '@lucide/vue'
import { computed, inject, ref, watch } from 'vue'
import { Tool as AiTool, ToolContent as AiToolContent } from '@/components/ai-elements/tool'
import { Badge } from '@/components/ui/badge'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import {
  doneTodos,
  planApprovedText,
  planFileOf,
  planModeOf,
  planOf,
  skillNameOf,
  skillSourceText,
  TODO_TOOL_NAME,
  todoListOf,
} from '../agent/agent-tools'
import AgentToolBody from '../agent/AgentToolBody.vue'
import PlanApprovalCard from '../agent/PlanApprovalCard.vue'
import PlanBody from '../agent/PlanBody.vue'
import PlanFileChip from '../agent/PlanFileChip.vue'
import SkillToolBody from '../agent/SkillToolBody.vue'
import TodoList from '../agent/TodoList.vue'
import { TRANSCRIPT_SCROLL } from '../chat-context'
import {
  CORE_AGENT_PLUGIN_ID,
  formatToolValue,
  isServerTruncated,
  isSupersededDenial,
  PLAN_TOOL_NAME,
  SKILL_TOOL_NAME,
  splitMcpToolName,
  toolNameOf,
} from '../chat-format'
import { TOOL_APPROVAL_CONTEXT } from './tool-approval-context'
import { toolRowArgument } from './tool-row'
import ToolApprovalCard from './ToolApprovalCard.vue'
import ToolRowSummary from './tools/ToolRowSummary.vue'
import ToolRuleBadge from './tools/ToolRuleBadge.vue'
import {
  isWorkspaceToolName,
  workspaceRowSummary,
  workspaceToolIcon,
  workspaceToolView,
} from './tools/workspace-tools'
import WorkspaceToolBody from './tools/WorkspaceToolBody.vue'
import ToolValueBlock from './ToolValueBlock.vue'

const props = withDefaults(defineProps<{
  part: ToolPartLike
  /** The message is streaming (spinners only spin while it does). */
  streaming: boolean
  /**
   * A later message exists: an approval still requested here was superseded (the server resolves it as denied when
   * the user sends a new message), so no card is offered.
   */
  superseded?: boolean
}>(), {
  superseded: false,
})

const emit = defineEmits<{
  /**
   * + Phase 7: `acceptEdits` = "Accept all edits in this chat" (the session switches the mode to `edits`). + Phase 8:
   * `allowRules` = the shell rules to create before the approval is sent (passed through from the card). + Phase 9:
   * `planMode` / `reason` = the plan card's mode and feedback (the session sets the mode before answering).
   */
  approval: [response: { id: string, approved: boolean, toolName: string, alwaysAllow: boolean, acceptEdits?: boolean, allowRules?: AllowRules, planMode?: 'edits' | 'ask', reason?: string }]
}>()

const plugins = usePluginsStore()
const open = ref(false)
const scroll = inject(TRANSCRIPT_SCROLL, null)
const approvalContext = inject(TOOL_APPROVAL_CONTEXT, null)
watch(open, (isOpen) => {
  if (isOpen)
    scroll?.holdPosition()
})

const name = computed(() => toolNameOf(props.part))
const tool = computed(() => plugins.tools.find(item => item.name === name.value))
const mcp = computed(() => splitMcpToolName(name.value))
const serverId = computed(() => tool.value?.mcpServerId ?? mcp.value?.serverId ?? null)
const serverName = computed(() => {
  if (!serverId.value)
    return null
  return plugins.mcp.find(server => server.id === serverId.value)?.name ?? serverId.value
})
const displayName = computed(() => mcp.value?.tool ?? name.value)
// The badge names the server; a transcript opened after a reload may be the first place that needs the MCP list.
watch(serverId, (id) => {
  if (id && !plugins.mcpLoaded)
    plugins.fetchMcp().catch(() => {})
}, { immediate: true })
const firstArg = computed(() => toolRowArgument(name.value, props.part.input))
/** + Phase 9: a tool of `core-agent` (before the tool list has loaded, any tool with an agent tool's name). */
const coreAgent = computed(() => tool.value === undefined || tool.value.pluginId === CORE_AGENT_PLUGIN_ID)
/** + Phase 9: the plan tool of `core-agent`. */
const isPlanTool = computed(() => name.value === PLAN_TOOL_NAME && coreAgent.value)
/** + Phase 9: the todo tool of `core-agent`. */
const isTodoTool = computed(() => name.value === TODO_TOOL_NAME && coreAgent.value)
/** + Phase 10: the skill tool of `core-agent`. */
const isSkillTool = computed(() => name.value === SKILL_TOOL_NAME && coreAgent.value)
const rowIcon = computed(() => {
  if (serverId.value)
    return ServerIcon
  if (isPlanTool.value)
    return ClipboardListIcon
  if (isTodoTool.value)
    return ListTodoIcon
  if (isSkillTool.value)
    return BookOpenIcon
  return workspaceToolIcon(name.value) ?? WrenchIcon
})
/**
 * `ToolSummary.workspace` of the tool; before the tool list has loaded, the access of the `core-workspace` tool with
 * this name (so a shell card never offers "Always allow").
 */
const workspaceAccess = computed(() => {
  if (tool.value)
    return tool.value.workspace
  return isWorkspaceToolName(name.value) ? WORKSPACE_TOOL_ACCESS[name.value] : null
})

type RowStatus = 'running' | 'approval' | 'done' | 'error' | 'denied' | 'stopped'

const approved = computed(() => {
  const approval = props.part.approval
  return approval && 'approved' in approval ? approval.approved : undefined
})

const status = computed<RowStatus>(() => {
  switch (props.part.state) {
    case 'input-streaming':
    case 'input-available':
      return props.streaming ? 'running' : 'stopped'
    case 'approval-requested':
      return props.superseded ? 'denied' : 'approval'
    case 'approval-responded':
      if (approved.value === false)
        return 'denied'
      return props.streaming ? 'running' : 'stopped'
    case 'output-available':
      // + Phase 9: a preliminary output is a snapshot of a tool that still runs (or stopped without a final value).
      if (props.part.preliminary === true)
        return props.streaming ? 'running' : 'stopped'
      return 'done'
    case 'output-error':
      return 'error'
    case 'output-denied':
      return 'denied'
    default:
      return 'running'
  }
})

const awaitingDecision = computed(() => props.part.state === 'approval-requested' && !props.superseded)
const supersededDenial = computed(() => status.value === 'denied'
  && (isSupersededDenial(props.part) || props.part.state === 'approval-requested'))
const statusLabel = computed(() => ({
  running: 'Running',
  approval: 'Needs approval',
  done: 'Done',
  error: 'Failed',
  denied: 'Denied',
  stopped: 'Stopped',
})[status.value])

/**
 * + Phase 10 (7.28): the skill row: the name (the output's, else the input's while it runs), the source of a loaded
 * skill (the plugin's name from the plugins store: the output has no plugin id), the label by status and the row's
 * accessible name; null for every other tool.
 */
const skillRow = computed(() => {
  if (!isSkillTool.value)
    return null
  const parsed = props.part.state === 'output-available' ? skillOutputSchema.safeParse(props.part.output) : null
  const output = parsed?.success ? parsed.data : null
  const skillName = output?.name ?? skillNameOf(props.part.input) ?? ''
  const pluginName = output?.source === 'plugin'
    ? plugins.items.find(plugin => plugin.contributions.skills.includes(output.name))?.name ?? null
    : null
  const source = output ? skillSourceText(output.source, pluginName) : null
  const label = status.value === 'running' ? 'Loading skill' : status.value === 'error' ? 'Couldn\'t load skill' : 'Loaded skill'
  const named = skillName ? `${label} ${skillName}` : label
  let ariaLabel = named
  if (status.value === 'done')
    ariaLabel = source ? `${named}, ${source}` : named
  else if (status.value !== 'running' && status.value !== 'error')
    ariaLabel = `${named}, ${statusLabel.value.toLowerCase()}`
  return { name: skillName, source, label, ariaLabel }
})

const inputText = computed(() => formatToolValue(props.part.input))
const hasOutput = computed(() => props.part.state === 'output-available')
const outputText = computed(() => (hasOutput.value ? formatToolValue(props.part.output) : ''))
const outputTruncated = computed(() => hasOutput.value && isServerTruncated(props.part.output))
const errorText = computed(() => (props.part.state === 'output-error' ? props.part.errorText : ''))

/**
 * + Phase 9: the agent view of a `todo_write` / `exit_plan_mode` row (7.25): the list (the output's, else the input's
 * while the call runs) or the plan with the mode an approval chose; null keeps the generic blocks (an error, or a value
 * that fails its schema).
 */
type AgentView
  = | { kind: 'todo', todos: readonly TodoItem[] }
    | { kind: 'plan', plan: string, mode: 'edits' | 'ask' | null, planPath: string | null, planError: string | null }
    | { kind: 'skill' }

const agentView = computed<AgentView | null>(() => {
  if (props.part.state === 'output-error')
    return null
  const output = hasOutput.value ? props.part.output : undefined
  if (isTodoTool.value) {
    const todos = todoListOf(props.part.input, output)
    return todos === null ? null : { kind: 'todo', todos }
  }
  if (isPlanTool.value) {
    const plan = planOf(props.part.input)
    const mode = planModeOf(output)
    if (plan === null || (hasOutput.value && mode === null))
      return null
    return { kind: 'plan', plan, mode, ...planFileOf(output) }
  }
  // + Phase 10: a loaded skill (SkillToolBody); a running call or an output that fails its schema keeps the generic row.
  if (isSkillTool.value && hasOutput.value && skillOutputSchema.safeParse(output).success)
    return { kind: 'skill' }
  return null
})
/** + Phase 10: the chat belongs to a project (PlanFileChip offers Show changes there). */
const projectChat = computed(() => (approvalContext?.projectId() ?? null) !== null)
/** + Phase 9: the status text of an approved plan ("Approved · Accept edits" / "Approved · Ask"). */
const planApproved = computed(() => {
  const view = agentView.value
  return status.value === 'done' && view?.kind === 'plan' && view.mode ? planApprovedText(view.mode) : null
})
/** + Phase 9: the feedback sent with the plan decision (the approval's reason; a superseded denial has none). */
const planFeedback = computed(() => {
  const approval = props.part.approval
  const reason = approval && 'reason' in approval ? approval.reason : undefined
  return typeof reason === 'string' && reason.trim() !== '' && !isSupersededDenial(props.part) ? reason : null
})

/** The row summary of a finished workspace tool (7.19); + Phase 9: "3/7" of a todo list. */
const summary = computed<WorkspaceRowSummary | null>(() => {
  const view = agentView.value
  if (view?.kind === 'todo') {
    const done = doneTodos(view.todos)
    return { text: `${done}/${view.todos.length}`, tone: 'muted', label: `${done} of ${view.todos.length} tasks done` }
  }
  return hasOutput.value ? workspaceRowSummary(name.value, props.part.output) : null
})
/** + Phase 8: the prefixes of the shell rules that let a finished `shell` call run without a card (ToolRuleBadge). */
const allowedBy = computed<readonly string[]>(() => {
  if (!hasOutput.value || name.value !== 'shell')
    return []
  const parsed = shellToolOutputSchema.safeParse(props.part.output)
  return parsed.success ? parsed.data.allowedBy ?? [] : []
})
/**
 * The workspace body: the finished output, or the terminal of a shell command that is running (its input is complete);
 * null keeps the generic blocks.
 */
const view = computed(() => {
  if (hasOutput.value) {
    const output = props.part.output
    return output === undefined || output === null ? null : workspaceToolView(name.value, props.part.input, output)
  }
  const runningShell = name.value === 'shell' && status.value === 'running'
    && (props.part.state === 'input-available' || props.part.state === 'approval-responded')
  const running = runningShell ? workspaceToolView(name.value, props.part.input, null) : null
  // Without a `cwd` input the command starts where the chat's previous shell call ended (the sticky folder).
  if (running?.kind === 'terminal' && running.cwd === null)
    return { ...running, cwd: approvalContext?.shellCwd() ?? null }
  return running
})

/** + Phase 9: the plan card's decision as the approval of the call (`planMode` only with an approval). */
function onPlanDecide(decision: { approved: boolean, mode?: 'edits' | 'ask', feedback?: string }) {
  const approval = props.part.approval
  if (!approval)
    return
  emit('approval', {
    id: approval.id,
    approved: decision.approved,
    toolName: name.value,
    alwaysAllow: false,
    ...(decision.approved && decision.mode ? { planMode: decision.mode } : {}),
    ...(decision.feedback ? { reason: decision.feedback } : {}),
  })
}

function onDecide(decision: { approved: boolean, alwaysAllow: boolean, acceptEdits?: boolean, allowRules?: AllowRules }) {
  const approval = props.part.approval
  if (!approval)
    return
  emit('approval', {
    id: approval.id,
    approved: decision.approved,
    toolName: name.value,
    alwaysAllow: decision.alwaysAllow,
    ...(decision.acceptEdits === undefined ? {} : { acceptEdits: decision.acceptEdits }),
    ...(decision.allowRules === undefined ? {} : { allowRules: decision.allowRules }),
  })
}
</script>

<template>
  <div data-slot="tool-part" class="flex flex-col gap-1.5">
    <AiTool v-model:open="open" class="mb-0 rounded-md border-0">
      <div
        :data-testid="testIds.toolRow"
        :data-tool-name="name"
        :data-state="part.state"
        :data-status="status"
      >
        <CollapsibleTrigger
          :aria-label="skillRow?.ariaLabel"
          class="group/tool-row -mx-1.5 flex h-(--row-height) pointer-coarse:h-10 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRightIcon
            aria-hidden="true"
            class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-base) group-data-[state=open]/tool-row:rotate-90"
          />
          <component :is="rowIcon" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
          <template v-if="skillRow">
            <span data-slot="skill-row-label" :class="cn('shrink-0 font-medium', status === 'running' && 'hf-shimmer-text')">{{ skillRow.label }}</span>
            <span v-if="skillRow.name" data-slot="skill-row-name" class="min-w-0 truncate font-mono text-[13px]">{{ skillRow.name }}</span>
          </template>
          <template v-else>
            <span class="shrink-0 font-mono text-[13px] font-medium">{{ displayName }}</span>
            <span v-if="firstArg" class="min-w-0 truncate font-mono text-xs text-muted-foreground">"{{ firstArg }}"</span>
          </template>
          <Badge v-if="serverName" variant="outline" class="h-4 shrink-0 px-1.5 text-[10px] font-normal text-muted-foreground">
            {{ serverName }}
          </Badge>
          <span class="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
            <span v-if="skillRow?.source" data-slot="skill-row-source" class="max-w-[16ch] truncate">{{ skillRow.source }}</span>
            <ToolRuleBadge v-if="allowedBy.length > 0" :prefixes="allowedBy" />
            <ToolRowSummary v-if="summary" :summary="summary" class="mr-0.5" />
            <Spinner v-if="status === 'running'" class="size-3" />
            <template v-else-if="status === 'approval' && isPlanTool">
              <span aria-hidden="true" class="size-2 rounded-full bg-info" />
              <span>Plan ready for review</span>
            </template>
            <template v-else-if="status === 'approval'">
              <span aria-hidden="true" class="size-2 rounded-full bg-warning" />
              <span>Needs approval</span>
            </template>
            <template v-else-if="planApproved">
              <CheckIcon aria-hidden="true" class="size-3.5 text-success" />
              <span>{{ planApproved }}</span>
            </template>
            <CheckIcon v-else-if="status === 'done'" aria-hidden="true" class="size-3.5 text-success" />
            <XIcon v-else-if="status === 'error'" aria-hidden="true" class="size-3.5 text-destructive" />
            <template v-else-if="status === 'denied'">
              <Tooltip v-if="supersededDenial">
                <TooltipTrigger as-child>
                  <span class="inline-flex items-center gap-1.5">
                    <BanIcon aria-hidden="true" class="size-3.5" />
                    <span>Denied</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Skipped because you sent a new message</TooltipContent>
              </Tooltip>
              <template v-else-if="isPlanTool">
                <PencilLineIcon aria-hidden="true" class="size-3.5" />
                <span>Kept planning</span>
              </template>
              <template v-else>
                <BanIcon aria-hidden="true" class="size-3.5" />
                <span>Denied</span>
              </template>
            </template>
            <template v-else-if="status === 'stopped'">
              <CircleSlashIcon aria-hidden="true" class="size-3.5" />
              <span>Stopped</span>
            </template>
            <span v-if="status === 'running' || (status === 'done' && !planApproved) || status === 'error'" class="sr-only">{{ statusLabel }}</span>
          </span>
        </CollapsibleTrigger>
      </div>
      <AiToolContent :data-testid="testIds.toolRowOutput" class="min-w-0 pt-1 pl-6">
        <AgentToolBody v-if="agentView">
          <TodoList v-if="agentView.kind === 'todo'" :todos="agentView.todos" />
          <SkillToolBody v-else-if="agentView.kind === 'skill'" :input="part.input" :output="hasOutput ? part.output : undefined" />
          <template v-else>
            <PlanFileChip :plan-path="agentView.planPath" :plan-error="agentView.planError" :project-chat="projectChat" />
            <PlanBody :plan="agentView.plan" :feedback="planFeedback" />
          </template>
          <template #raw>
            <div class="flex min-w-0 flex-col gap-3 rounded-md bg-muted/50 p-3">
              <ToolValueBlock label="Input" :value="inputText || '{}'" />
              <ToolValueBlock v-if="hasOutput" label="Output" :value="outputText" :server-truncated="outputTruncated" />
            </div>
          </template>
        </AgentToolBody>
        <WorkspaceToolBody v-else-if="view" :view="view" :running="status === 'running'">
          <template #raw>
            <div class="flex min-w-0 flex-col gap-3 rounded-md bg-muted/50 p-3">
              <ToolValueBlock label="Input" :value="inputText || '{}'" />
              <ToolValueBlock v-if="hasOutput" label="Output" :value="outputText" :server-truncated="outputTruncated" />
            </div>
          </template>
        </WorkspaceToolBody>
        <div v-else class="flex min-w-0 flex-col gap-3 rounded-md bg-muted/50 p-3">
          <ToolValueBlock label="Input" :value="inputText || '{}'" />
          <ToolValueBlock v-if="hasOutput" label="Output" :value="outputText" :server-truncated="outputTruncated" />
          <ToolValueBlock v-if="errorText" label="Error" :value="errorText" tone="error" />
        </div>
      </AiToolContent>
    </AiTool>
    <PlanApprovalCard
      v-if="awaitingDecision && isPlanTool"
      :part="part"
      :source="tool?.pluginId ?? CORE_AGENT_PLUGIN_ID"
      @decide="onPlanDecide"
    />
    <ToolApprovalCard
      v-else-if="awaitingDecision"
      :part="part"
      :tool-name="name"
      :source="tool?.pluginId ?? null"
      :workspace="workspaceAccess"
      @decide="onDecide"
    />
  </div>
</template>
