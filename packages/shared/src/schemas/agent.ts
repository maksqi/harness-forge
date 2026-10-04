// Agent tools of the builtin plugin `core-agent` (Phase 9): `todo_write` and `exit_plan_mode` (ADR-041), `task`
// (sub-agents, ADR-043); Phase 10: `skill` (ADR-045), custom and background sub-agents (ADR-045, ADR-046) and plan files
// (ADR-047). Input schemas are what the model sends; output schemas are what the tool parts store (the model gets a
// short text through `toModelOutput`). API.md sections 4.25 and 6.9.
import { z } from 'zod'
import { customizationSourceSchema, todoStatusSchema } from '../enums.ts'
import { AGENT_NAME_PATTERN, agentNameSchema, backgroundTaskIdSchema, modelRefSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { DEFINITION_LIMITS } from '../util/definitions.ts'
import { messageUsageSchema } from './usage.ts'

/** The tools of `core-agent` (`skill`: Phase 10, ADR-045). */
export const AGENT_TOOL_NAMES = ['todo_write', 'exit_plan_mode', 'task', 'skill'] as const

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
 * denied approval (with the user's feedback as its `reason`), so it has no output. Phase 10 (ADR-047): with the setting
 * `planFiles` on in a project chat, the plan is also written to the project (`planPath`); a failed write never fails
 * the approval (`planError`). Outputs of v1.5 carry neither key.
 */
export const exitPlanModeOutputSchema = z.object({
  approved: z.literal(true),
  mode: z.enum(['edits', 'ask']),
  /** The project-relative path of the saved plan file (`<planDirectory>/<YYYY-MM-DD>-<slug>.md`). */
  planPath: z.string().min(1).max(LIMITS.workspacePathMaxChars).optional(),
  /** Why the plan file could not be written (one sentence, safe to show). */
  planError: z.string().max(500).optional(),
})
export type ExitPlanModeOutput = z.infer<typeof exitPlanModeOutputSchema>

// ---------- task ----------

/** A catalog name as a model sends it: trimmed, lowercased, then `AGENT_NAME_PATTERN`. */
function catalogNameInputSchema(message: string) {
  return z.string().trim().toLowerCase().regex(AGENT_NAME_PATTERN, message)
}

/**
 * `task.type` as the model sends it (Phase 10, ADR-045): the name of an agent of the catalog (the builtins `explore` and
 * `general`, a plugin, personal or project agent), trimmed and lowercased; the alias `general-purpose` (=`general`)
 * matches too. Whether the agent exists is checked by the runner (an unknown type ends the call as `failed`, listing the
 * available types).
 */
export const agentTypeInputSchema = catalogNameInputSchema('Agent types start with a-z and use up to 64 characters of a-z, 0-9 and "-".')

/** Input of `task` (policy `safe`): starts one sub-agent with its own context. */
export const taskInputSchema = z.object({
  /** A short title shown in the UI, 3..80 characters. */
  description: z.string().min(3).max(80),
  /** The complete instructions for the sub-agent (it does not see the conversation), 1..20 000 characters. */
  prompt: z.string().min(1).max(LIMITS.taskPromptMaxChars),
  /**
   * The agent type: `explore` (read-only tools), `general` (the tools that run without approval in the parent's mode)
   * or a custom agent of the catalog (its `tools` narrow that set, never widen it; ADR-045).
   */
  type: agentTypeInputSchema,
  /**
   * Phase 10 (ADR-046): run the sub-agent in the background. The call returns at once (`status: 'background'`, a
   * `taskId`); the result is delivered later as a `data-task-result` part. Absent = false.
   */
  background: z.boolean().optional(),
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
 * `limit` (the step limit or the deadline ended it; `report` holds what it wrote so far). Phase 10 (ADR-046):
 * `background` is the final status of a `task` call that launched a background sub-agent (the output has `taskId`, no
 * steps and no report; the task itself has its own status, `BackgroundTask.status`).
 */
export const taskStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'aborted', 'limit', 'background'])
export type TaskStatus = z.infer<typeof taskStatusSchema>

/**
 * A snapshot of the agent definition a sub-agent ran with (Phase 10, ADR-045), taken at call time so tooltips and
 * shares survive later changes of the catalog.
 */
export const taskAgentSchema = z.object({
  source: customizationSourceSchema,
  /** The agent's description, cut to 200 characters. */
  description: z.string().max(200),
  /** Project agents: the project-relative path of the definition file. */
  path: z.string().max(LIMITS.workspacePathMaxChars).optional(),
})
export type TaskAgent = z.infer<typeof taskAgentSchema>

/**
 * Output of `task`. While the sub-agent runs, the tool streams preliminary outputs (snapshots of this shape); the last
 * one is the final output. The model only gets the report (`toModelOutput`).
 */
export const taskOutputSchema = z.object({
  status: taskStatusSchema,
  /** The agent type (Phase 10: any catalog agent name, aliases resolved; v1.5 outputs hold `explore` or `general`). */
  type: agentNameSchema,
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
  /** Phase 10 (ADR-046): the background task of a `background: true` call (`status: 'background'`, and its results). */
  taskId: backgroundTaskIdSchema.optional(),
  /** Phase 10 (ADR-045): the agent definition the sub-agent ran with (absent in v1.5 outputs). */
  agent: taskAgentSchema.optional(),
})
export type TaskOutput = z.infer<typeof taskOutputSchema>

// ---------- skill ----------

/**
 * A skill name as a model sends it (Phase 10, ADR-045): trimmed and lowercased, then `AGENT_NAME_PATTERN`. Whether the
 * skill exists is checked by the tool.
 */
export const skillNameInputSchema = catalogNameInputSchema('Skill names start with a-z and use up to 64 characters of a-z, 0-9 and "-".')

/**
 * Input of `skill` (Phase 10, ADR-045; policy `safe`, no workspace access): loads the body of one skill of the catalog.
 * Offered only when the catalog has skills, never inside a sub-agent.
 */
export const skillInputSchema = z.object({
  name: skillNameInputSchema,
})
export type SkillInput = z.infer<typeof skillInputSchema>

/**
 * Output of `skill`: the skill body (Markdown) the model reads. Project skills also name their folder (`baseDir`,
 * project-relative) and its supporting files (relative to `baseDir`), which the model reads with `read_file`.
 */
export const skillOutputSchema = z.object({
  name: agentNameSchema,
  description: z.string().max(DEFINITION_LIMITS.descriptionMaxChars),
  source: customizationSourceSchema,
  /** The SKILL.md body, at most 65 536 characters. */
  content: z.string().max(LIMITS.customizationContentBytes),
  /** The body was cut. */
  truncated: z.boolean(),
  /** Project skills: the project-relative folder of the skill (`.harness/skills/<name>`). */
  baseDir: z.string().max(LIMITS.workspacePathMaxChars).optional(),
  /** Project skills: supporting files of the folder, relative to `baseDir` (at most 50, no links, no hidden files). */
  files: z.array(z.string().min(1).max(LIMITS.workspacePathMaxChars)).max(LIMITS.skillFilesListedMax).optional(),
})
export type SkillOutput = z.infer<typeof skillOutputSchema>

// ---------- by tool ----------

/** Input and output schema of every agent tool. */
export const AGENT_TOOL_SCHEMAS = {
  todo_write: { input: todoWriteInputSchema, output: todoWriteOutputSchema },
  exit_plan_mode: { input: exitPlanModeInputSchema, output: exitPlanModeOutputSchema },
  task: { input: taskInputSchema, output: taskOutputSchema },
  skill: { input: skillInputSchema, output: skillOutputSchema },
} as const satisfies Record<AgentToolName, { input: z.ZodType, output: z.ZodType }>
