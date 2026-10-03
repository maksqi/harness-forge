// Agent tools of the builtin plugin `core-agent` (Phase 9): `todo_write` and `exit_plan_mode` (ADR-041), `task`
// (sub-agents, ADR-043). Input schemas are what the model sends; output schemas are what the tool parts store (the
// model gets a short text through `toModelOutput`). API.md sections 4.25 and 6.9.
import { z } from 'zod'
import { taskTypeSchema, todoStatusSchema } from '../enums.ts'
import { modelRefSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { messageUsageSchema } from './usage.ts'

/** The tools of `core-agent`. */
export const AGENT_TOOL_NAMES = ['todo_write', 'exit_plan_mode', 'task'] as const

export const agentToolNameSchema = z.enum(AGENT_TOOL_NAMES)
export type AgentToolName = z.infer<typeof agentToolNameSchema>

const countSchema = z.int().min(0)

// ---------- todo_write ----------

/** One item of the agent's todo list. */
export const todoItemSchema = z.object({
  /** Stable id chosen by the model (unique in the list), 1..64 characters. */
  id: z.string().min(1).max(64),
  /** What to do, 1..500 characters. */
  content: z.string().min(1).max(500),
  status: todoStatusSchema,
  /** Present-continuous form shown while the item is in progress ("Running the tests"); at most 200 characters. */
  activeForm: z.string().max(200).optional(),
})
export type TodoItem = z.infer<typeof todoItemSchema>

/**
 * Input of `todo_write` (policy `safe`, no workspace access): the complete new list, which replaces the previous one
 * (at most `LIMITS.todoItemsMax` items, unique ids). The todo state of a chat is the output of the latest
 * `todo_write` call on the active path (`latestTodos`).
 */
export const todoWriteInputSchema = z.object({
  todos: z
    .array(todoItemSchema)
    .max(LIMITS.todoItemsMax)
    .refine(todos => new Set(todos.map(todo => todo.id)).size === todos.length, 'Todo ids must be unique.'),
})
export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>

/** Counts of a todo list by status. */
export const todoCountsSchema = z.object({
  pending: countSchema,
  inProgress: countSchema,
  completed: countSchema,
  total: countSchema,
})
export type TodoCounts = z.infer<typeof todoCountsSchema>

/** Output of `todo_write`: the stored list and its counts. */
export const todoWriteOutputSchema = z.object({
  todos: z.array(todoItemSchema).max(LIMITS.todoItemsMax),
  counts: todoCountsSchema,
})
export type TodoWriteOutput = z.infer<typeof todoWriteOutputSchema>

// ---------- exit_plan_mode ----------

/**
 * Input of `exit_plan_mode` (policy `always`; offered only in the `plan` mode): the plan as Markdown, 1..50 000
 * characters. The call always shows the plan approval card (overrides and hooks cannot approve it).
 */
export const exitPlanModeInputSchema = z.object({
  plan: z.string().min(1).max(LIMITS.planMaxChars),
})
export type ExitPlanModeInput = z.infer<typeof exitPlanModeInputSchema>

/**
 * Output of an approved `exit_plan_mode`: the permission mode the user chose for the implementation. A rejection is a
 * denied approval (with the user's feedback as its `reason`), so it has no output.
 */
export const exitPlanModeOutputSchema = z.object({
  approved: z.literal(true),
  mode: z.enum(['edits', 'ask']),
})
export type ExitPlanModeOutput = z.infer<typeof exitPlanModeOutputSchema>

// ---------- task ----------

/** Input of `task` (policy `safe`): starts one sub-agent with its own context. */
export const taskInputSchema = z.object({
  /** A short title shown in the UI, 3..80 characters. */
  description: z.string().min(3).max(80),
  /** The complete instructions for the sub-agent (it does not see the conversation), 1..20 000 characters. */
  prompt: z.string().min(1).max(LIMITS.taskPromptMaxChars),
  /** `explore` (read-only tools) or `general` (the tools that run without approval in the parent's mode). */
  type: taskTypeSchema,
})
export type TaskInput = z.infer<typeof taskInputSchema>

/** State of one tool call of a sub-agent; `denied`: the call needed an approval, which sub-agents never ask for. */
export const taskStepStateSchema = z.enum(['running', 'done', 'error', 'denied'])
export type TaskStepState = z.infer<typeof taskStepStateSchema>

/** One tool call of a sub-agent. */
export const taskStepSchema = z.object({
  /** The tool call id inside the sub-agent. */
  toolCallId: z.string().min(1).max(256),
  toolName: z.string().min(1).max(64),
  /** One line about the call (a path, a pattern, a command), at most 200 characters. */
  summary: z.string().max(200),
  state: taskStepStateSchema,
  /** The start of the result or of the error, at most 300 characters. */
  resultPreview: z.string().max(300).optional(),
})
export type TaskStep = z.infer<typeof taskStepSchema>

/**
 * Status of a sub-agent: `queued` (waiting for a free slot), `running`, `completed`, `failed`, `aborted` (Stop) or
 * `limit` (the step limit or the deadline ended it; `report` holds what it wrote so far).
 */
export const taskStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'aborted', 'limit'])
export type TaskStatus = z.infer<typeof taskStatusSchema>

/**
 * Output of `task`. While the sub-agent runs, the tool streams preliminary outputs (snapshots of this shape); the last
 * one is the final output. The model only gets the report (`toModelOutput`).
 */
export const taskOutputSchema = z.object({
  status: taskStatusSchema,
  type: taskTypeSchema,
  description: z.string().max(80),
  /** The model of the sub-agent. */
  modelRef: modelRefSchema,
  /** The latest tool calls (at most `LIMITS.taskStepsShownMax`). */
  steps: z.array(taskStepSchema).max(LIMITS.taskStepsShownMax),
  /** Earlier tool calls that were not kept in `steps`. */
  stepsOmitted: countSchema,
  /** The final report (Markdown), at most 32 000 characters; empty until the sub-agent writes it. */
  report: z.string().max(LIMITS.taskReportMaxChars),
  /** Tokens of every step of the sub-agent. */
  usage: messageUsageSchema.optional(),
  costUsd: z.number().min(0).optional(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.optional(),
  /** Why the sub-agent failed or stopped (`failed`, `aborted`, `limit`). */
  error: z.string().max(2000).optional(),
})
export type TaskOutput = z.infer<typeof taskOutputSchema>

// ---------- by tool ----------

/** Input and output schema of every agent tool. */
export const AGENT_TOOL_SCHEMAS = {
  todo_write: { input: todoWriteInputSchema, output: todoWriteOutputSchema },
  exit_plan_mode: { input: exitPlanModeInputSchema, output: exitPlanModeOutputSchema },
  task: { input: taskInputSchema, output: taskOutputSchema },
} as const satisfies Record<AgentToolName, { input: z.ZodType, output: z.ZodType }>
