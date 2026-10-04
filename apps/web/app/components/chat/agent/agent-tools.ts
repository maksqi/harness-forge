// Pure helpers of the agent tool renderers (docs/UI.md 7.2, 7.25, 7.27; ADR-041, ADR-043): the values of `todo_write`,
// `exit_plan_mode` and `task` parts as the rows, the plan card, the task blocks and the share page show them. Every
// value is parsed with the shared schemas; a value that does not parse yields null, so the caller keeps the generic
// tool row. No Vue components, no stores (the share page uses these too).
// Phase 10 (W10.11; ADR-045 … ADR-047; docs/UI.md 7.27 – 7.29): custom agent types (`taskKindOf`, `taskTypeLabel`, the
// agent source line), background calls (the launch, the live state from the background task or its delivered result),
// the skill row's source and the task result note's texts.
import type {
  BackgroundTask,
  CustomizationSource,
  TaskAgent,
  TaskInput,
  TaskOutput,
  TaskResultData,
  TaskStatus,
  TaskStep,
  TaskType,
  TodoItem,
} from '@harness-forge/shared'
import type { ToolPartLike } from '../chat-format'
import {
  exitPlanModeInputSchema,
  exitPlanModeOutputSchema,
  safeParseModelRef,
  taskInputSchema,
  taskOutputSchema,
  taskTypeSchema,
  todoWriteInputSchema,
  todoWriteOutputSchema,
} from '@harness-forge/shared'
import { formatTokenCount } from '~/components/common/format'
import { firstStringArg, formatCost, formatDuration } from '../chat-format'

/** The todo tool of `core-agent`. */
export const TODO_TOOL_NAME = 'todo_write'

// ---------- todos ----------

/** The item in progress: the first `in_progress` item, or null. */
export function currentTodo(todos: readonly TodoItem[]): TodoItem | null {
  return todos.find(todo => todo.status === 'in_progress') ?? null
}

/** What an item reads: the `activeForm` while it is in progress (when set), else its content. */
export function todoLabel(todo: TodoItem): string {
  return todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content
}

/** Items with status `completed`. */
export function doneTodos(todos: readonly TodoItem[]): number {
  return todos.reduce((count, todo) => count + (todo.status === 'completed' ? 1 : 0), 0)
}

/**
 * The list of a `todo_write` call: the stored output once it parses, else the input (a call that still runs), else
 * null (an invalid list keeps the generic row).
 */
export function todoListOf(input: unknown, output: unknown): readonly TodoItem[] | null {
  const stored = todoWriteOutputSchema.safeParse(output)
  if (stored.success)
    return stored.data.todos
  if (output !== undefined && output !== null)
    return null
  const sent = todoWriteInputSchema.safeParse(input)
  return sent.success ? sent.data.todos : null
}

/** The row argument of a `todo_write` call: the current item's `activeForm`, else its content; null without one. */
export function todoRowArgument(input: unknown): string | null {
  const parsed = todoWriteInputSchema.safeParse(input)
  if (!parsed.success)
    return null
  const current = currentTodo(parsed.data.todos)
  return current ? firstStringArg(current.activeForm || current.content) : null
}

// ---------- plans ----------

const HEADING = /^ {0,3}#{1,6}[ \t]+(\S.*)$/
/** The optional closing sequence of an ATX heading (`## Title ##`). */
const CLOSING_HASHES = /[ \t]+#+[ \t]*$/

/** The title of a plan: its first Markdown heading, else its first non-empty line (one line, at most 60 characters). */
export function planTitle(plan: string): string | null {
  const lines = plan.split(/\r?\n/)
  for (const line of lines) {
    const heading = line.match(HEADING)
    if (heading)
      return firstStringArg(heading[1]!.replace(CLOSING_HASHES, ''))
  }
  for (const line of lines) {
    const text = firstStringArg(line.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, ''))
    if (text)
      return text
  }
  return null
}

/** The plan of an `exit_plan_mode` input, or null when the input does not parse. */
export function planOf(input: unknown): string | null {
  const parsed = exitPlanModeInputSchema.safeParse(input)
  return parsed.success ? parsed.data.plan : null
}

/** The mode an approved plan switched to (the `exit_plan_mode` output), or null when the output does not parse. */
export function planModeOf(output: unknown): 'edits' | 'ask' | null {
  const parsed = exitPlanModeOutputSchema.safeParse(output)
  return parsed.success ? parsed.data.mode : null
}

/**
 * + Phase 10 (ADR-047): the plan file of an approved `exit_plan_mode` output (`planPath` / `planError`, absent in v1.5
 * outputs and while plan files are off); both null when the output does not parse.
 */
export function planFileOf(output: unknown): { planPath: string | null, planError: string | null } {
  const parsed = exitPlanModeOutputSchema.safeParse(output)
  if (!parsed.success)
    return { planPath: null, planError: null }
  return { planPath: parsed.data.planPath ?? null, planError: parsed.data.planError ?? null }
}

/** The row status text of a decided plan: "Approved · Accept edits" / "Approved · Ask". */
export function planApprovedText(mode: 'edits' | 'ask'): string {
  return mode === 'edits' ? 'Approved · Accept edits' : 'Approved · Ask'
}

// ---------- sub-agents ----------

/** The state of a task block (`task-block[data-state]`). */
export type TaskBlockState = TaskStatus | 'approval' | 'denied'

/** The stored text of a tool call the run stopped before it finished (`finalizeParts` on the server). */
const STOPPED_ERROR = /\bstopped\b/i

/** The input of a `task` call, or null when it does not parse. */
export function taskInputOf(input: unknown): TaskInput | null {
  const parsed = taskInputSchema.safeParse(input)
  return parsed.success ? parsed.data : null
}

/** The output (a snapshot or the final value) of a `task` call, or null when it does not parse. */
export function taskOutputOf(output: unknown): TaskOutput | null {
  const parsed = taskOutputSchema.safeParse(output)
  return parsed.success ? parsed.data : null
}

/** The sub-agent type of a (possibly still streaming) input, or null. */
export function taskTypeOf(input: unknown): TaskType | null {
  if (typeof input !== 'object' || input === null)
    return null
  const parsed = taskTypeSchema.safeParse((input as Record<string, unknown>).type)
  return parsed.success ? parsed.data : null
}

/** + Phase 10: `task-block[data-kind]` and the icon of a type (`Telescope`, `Bot`, `BotMessageSquare`). */
export type TaskKind = 'explore' | 'general' | 'custom'

/** The kind of a sub-agent type (Phase 10, ADR-045): the builtins `explore` and `general` (alias `general-purpose`), else `custom`. */
export function taskKindOf(type: string): TaskKind {
  const name = type.trim().toLowerCase()
  if (name === 'explore')
    return 'explore'
  if (name === 'general' || name === 'general-purpose')
    return 'general'
  return 'custom'
}

/** The label of a sub-agent type: "Explore", "Agent" (general), or the custom agent's name. */
export function taskTypeLabel(type: string): string {
  switch (taskKindOf(type)) {
    case 'explore':
      return 'Explore'
    case 'general':
      return 'Agent'
    case 'custom':
      return type.trim()
  }
}

/** + Phase 10: characters of a custom agent's name shown in a block's label (the full name is in its tooltip). */
export const TASK_TYPE_LABEL_MAX_CHARS = 24

/** + Phase 10: the shown label of a type: `taskTypeLabel`, a custom name cut at 24 characters with "…". */
export function taskTypeLabelShort(type: string): string {
  const label = taskTypeLabel(type)
  return label.length > TASK_TYPE_LABEL_MAX_CHARS ? `${label.slice(0, TASK_TYPE_LABEL_MAX_CHARS - 1)}…` : label
}

/** The raw agent type of a (possibly still streaming) input: any non-empty name (Phase 10), or null. */
export function taskAgentTypeOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null)
    return null
  const type = (input as Record<string, unknown>).type
  return typeof type === 'string' && type.trim() !== '' ? type.trim().toLowerCase() : null
}

/**
 * + Phase 10 (`task-block[data-agent-type]`): the agent type of a call: the output's (the resolved name), else the
 * input's lowercased; `general-purpose` reads as `general`. Null while the input has no type yet.
 */
export function taskAgentTypeName(input: unknown, output: Pick<TaskOutput, 'type'> | null): string | null {
  const type = output?.type ?? taskAgentTypeOf(input)
  if (type === null)
    return null
  return type === 'general-purpose' ? 'general' : type
}

/**
 * + Phase 10 (ADR-045): the source line of an agent snapshot (`output.agent`): "Built-in agent", "Personal agent",
 * "From {plugin}" (the plugin's name when known, else "a plugin") or "Project: {path}" ("Project agent" without a path).
 */
export function taskAgentSourceText(agent: Pick<TaskAgent, 'source' | 'path'>, pluginName: string | null = null): string {
  switch (agent.source) {
    case 'builtin':
      return 'Built-in agent'
    case 'user':
      return 'Personal agent'
    case 'plugin':
      return `From ${pluginName ?? 'a plugin'}`
    case 'project':
      return agent.path ? `Project: ${agent.path}` : 'Project agent'
  }
}

/** + Phase 10 (ADR-046): a call that asked for a background sub-agent (`input.background: true`, also while it streams). */
export function taskIsBackground(input: unknown, output: Pick<TaskOutput, 'status'> | null = null): boolean {
  if (output?.status === 'background')
    return true
  return typeof input === 'object' && input !== null && (input as Record<string, unknown>).background === true
}

/**
 * + Phase 10 (ADR-046; docs/UI.md 7.27): the state of a launched background call (its output has `status:
 * 'background'`): the live background task first (`queued` / `running` while it runs, else its final status), else
 * the delivered result on the shown path, else `background` (nothing is known: an import, a pruned task list, a share).
 * `output` is the snapshot to show (the task's latest output, else the result's), null when nothing is known.
 */
export function backgroundTaskState(
  task: Pick<BackgroundTask, 'status' | 'output'> | null,
  result: Pick<TaskResultData, 'output'> | null,
): { state: TaskBlockState, output: TaskOutput | null } {
  if (task) {
    if (task.status === 'running')
      return { state: task.output.status === 'queued' ? 'queued' : 'running', output: task.output }
    return { state: task.status, output: task.output }
  }
  if (result) {
    const status = result.output.status
    // A delivered result is final; a snapshot status there (never sent by the server) reads as completed.
    const final = status === 'queued' || status === 'running' || status === 'background' ? 'completed' : status
    return { state: final, output: result.output }
  }
  return { state: 'background', output: null }
}

/**
 * + Phase 10 (ADR-045): the source of a loaded skill on its row: "Project", "Personal", the plugin's name ("Plugin"
 * when unknown) or "Built-in".
 */
export function skillSourceText(source: CustomizationSource, pluginName: string | null = null): string {
  switch (source) {
    case 'project':
      return 'Project'
    case 'user':
      return 'Personal'
    case 'plugin':
      return pluginName ?? 'Plugin'
    case 'builtin':
      return 'Built-in'
  }
}

/** + Phase 10: the skill name of a (possibly still streaming) `skill` input, trimmed and lowercased, or null. */
export function skillNameOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null)
    return null
  const name = (input as Record<string, unknown>).name
  return typeof name === 'string' && name.trim() !== '' ? name.trim().toLowerCase() : null
}

/** + Phase 10 (docs/UI.md 7.29): the first line of a result note by the final status. */
export function taskResultHeading(status: TaskStatus): string {
  switch (status) {
    case 'failed':
      return 'Background agent failed'
    case 'aborted':
      return 'Background agent stopped'
    case 'limit':
      return 'Background agent reached its step limit'
    default:
      return 'Background agent finished'
  }
}

/** + Phase 10: the second line of a result note: the report's first sentence, else the error's, else "No report.". */
export function taskResultSummary(output: Pick<TaskOutput, 'report' | 'error'>): string {
  return firstSentence(output.report) || firstSentence(output.error ?? '') || 'No report.'
}

/** The description of a (possibly still streaming) input, or ''. */
export function taskDescriptionOf(input: unknown): string {
  if (typeof input !== 'object' || input === null)
    return ''
  const description = (input as Record<string, unknown>).description
  return typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : ''
}

/**
 * The state of a task block (docs/UI.md 7.27): `approval` while the call asks (a user override `ask` on `task`; `denied`
 * once a newer message superseded it), `running` for a preliminary output while the message streams (`queued` while
 * the snapshot says so), `aborted` for a preliminary output after the stream ended and for the stored error of a
 * stopped run, else the status of the final output.
 */
export function taskBlockState(part: ToolPartLike, opts: { streaming: boolean, superseded: boolean }): TaskBlockState {
  switch (part.state) {
    case 'approval-requested':
      return opts.superseded ? 'denied' : 'approval'
    case 'approval-responded':
      if (part.approval.approved === false)
        return 'denied'
      return opts.streaming ? 'running' : 'aborted'
    case 'output-denied':
      return 'denied'
    case 'output-error':
      return STOPPED_ERROR.test(part.errorText) ? 'aborted' : 'failed'
    case 'output-available': {
      const output = taskOutputOf(part.output)
      const live = part.preliminary === true || output?.status === 'running' || output?.status === 'queued'
      if (live) {
        if (!opts.streaming)
          return 'aborted'
        return output?.status === 'queued' ? 'queued' : 'running'
      }
      return output?.status ?? 'completed'
    }
    default:
      return opts.streaming ? 'running' : 'aborted'
  }
}

/** Every tool call of a sub-agent: the kept steps and the earlier ones that were not kept. */
export function taskToolCalls(output: TaskOutput | null): number {
  return output ? output.steps.length + output.stepsOmitted : 0
}

/** "1 tool call" / "4 tool calls". */
export function toolCallsText(count: number): string {
  return `${count} tool call${count === 1 ? '' : 's'}`
}

/** The words of a state in the trigger's name ("running", "completed", "step limit reached", …). */
export const TASK_STATE_WORDS: Readonly<Record<TaskBlockState, string>> = {
  queued: 'waiting',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  aborted: 'stopped',
  limit: 'step limit reached',
  // + Phase 10 (ADR-046): a background call whose live state is unknown ("Started in the background").
  background: 'started in the background',
  approval: 'needs approval',
  denied: 'denied',
}

/**
 * The trigger's accessible name: "Explore sub-agent: {description}, running, 4 tool calls" ("Sub-agent: …" for general;
 * + Phase 10: "Sub-agent {name}: …" for a custom agent type, and ", running in the background" appended while a
 * background agent waits or runs).
 */
export function taskTriggerLabel(
  type: string | null,
  description: string,
  state: TaskBlockState,
  toolCalls: number,
  opts: { background?: boolean } = {},
): string {
  const kind = type === null ? 'general' : taskKindOf(type)
  const prefix = kind === 'explore' ? 'Explore sub-agent' : kind === 'general' ? 'Sub-agent' : `Sub-agent ${type!.trim()}`
  const running = opts.background === true && (state === 'running' || state === 'queued')
  return `${prefix}: ${description || 'no description'}, ${TASK_STATE_WORDS[state]}, ${toolCallsText(toolCalls)}${running ? ', running in the background' : ''}`
}

/** A step as one line: `read_file "src/auth.ts"` (the summary quoted when present). */
export function taskStepLine(step: TaskStep): string {
  const summary = step.summary.replace(/\s+/g, ' ').trim()
  return summary ? `${step.toolName} "${summary}"` : step.toolName
}

/** The first sentence of a Markdown text on one line (headings, list and quote markers, emphasis and code marks removed). */
export function firstSentence(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map(item => item.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)*/, '').replace(/[*_`]/g, '').trim())
    .find(item => item.length > 0) ?? ''
  const end = line.search(/[.!?](?:\s|$)/)
  return end === -1 ? line : line.slice(0, end + 1)
}

/** Milliseconds a sub-agent ran: until `finishedAt`, else until `now` (clamped at 0). */
export function taskDurationMs(output: TaskOutput, now: number): number {
  return Math.max(0, (output.finishedAt ?? now) - output.startedAt)
}

/** The meta line of a finished sub-agent: "{model} · 18K tokens · $0.004 · 41s" (parts without a value are left out). */
export function taskMetaLine(output: TaskOutput): string {
  const model = safeParseModelRef(output.modelRef)?.modelId ?? output.modelRef
  const usage = output.usage
  const tokens = usage?.totalTokens ?? (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined
    ? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
    : undefined)
  const items = [
    model,
    tokens === undefined ? '' : `${formatTokenCount(tokens)} tokens`,
    formatCost(output.costUsd),
    output.finishedAt === undefined ? '' : formatDuration(taskDurationMs(output, output.finishedAt)),
  ]
  return items.filter(item => item !== '').join(' · ')
}
