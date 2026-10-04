// Pure helpers of the agent tool renderers (docs/UI.md 7.2, 7.25, 7.27; ADR-041, ADR-043): the values of `todo_write`,
// `exit_plan_mode` and `task` parts as the rows, the plan card, the task blocks and the share page show them. Every
// value is parsed with the shared schemas; a value that does not parse yields null, so the caller keeps the generic
// tool row. No Vue components, no stores (the share page uses these too).
import type { TaskInput, TaskOutput, TaskStatus, TaskStep, TaskType, TodoItem } from '@harness-forge/shared'
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
  // P10-0a (C28) compile fix: a `task` call that launched a background agent (ADR-046); W10.11 owns the final wording.
  background: 'in the background',
  approval: 'needs approval',
  denied: 'denied',
}

/** The trigger's accessible name: "Explore sub-agent: {description}, running, 4 tool calls" ("Sub-agent: …" for general). */
export function taskTriggerLabel(type: string | null, description: string, state: TaskBlockState, toolCalls: number): string {
  const kind = type === 'explore' ? 'Explore sub-agent' : 'Sub-agent'
  return `${kind}: ${description || 'no description'}, ${TASK_STATE_WORDS[state]}, ${toolCallsText(toolCalls)}`
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
