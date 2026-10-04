// The `task` tool of `core-agent` (ADR-043; policy `safe`, no workspace access, timeout 600 s, the guard maximum):
// starts one sub-agent, a separate agent loop with its own context. `execute` is an async generator (plugin API 1.3.0)
// that delegates to the run's agent scope (`agentScopeOf(c).runSubagent`, `chat/agent-scope.ts`): every yielded
// `TaskOutput` snapshot is a preliminary output (the UI shows the child's progress), the last one is the final output.
// A call without an agent scope (inside a sub-agent: depth 1, or outside a chat run) yields one `failed` output.
//
// Phase 10 (ADR-045, ADR-046): `type` names any agent of the run's catalog (the "Agent types" block of the
// instructions lists them; the description stays static), and `background: true` starts a background sub-agent: the
// call returns at once with `status: 'background'` and a `taskId`, and the report arrives later as a message.
//
// P9-0b (C27), P10-0b (C32): the definition (name, description, schema, policy, timeout, model text) is final and
// frozen; W9.5 / W10.3 (`task*`, `chat/subagent/**`) implement the runner behind the scope.
//
// The model reads only the report (`completed`, or `limit` with a report); for a background launch "Started background
// agent <taskId>. Its report will arrive as a message; keep working."; otherwise "Sub-agent failed: <error>; partial
// report: <report>" (`(none)` for an empty report). It parses only `{ status, report, error?, taskId? }`, so a stored
// output that later runs reduce (`reduceAgentOutputs`, `chat/subagent/history.ts`) still reads as text.
import type { ToolCallContext, ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { TaskInput, TaskOutput, TaskStatus } from '@harness-forge/shared'
import { taskInputSchema, taskOutputSchema } from '@harness-forge/shared'
import { agentScopeOf } from '../../chat/agent-scope.ts'
import { TASK_TIMEOUT_MS, textModelOutput } from './common.ts'

export const TASK_TOOL_NAME = 'task'

export const TASK_DESCRIPTION = 'Start a sub-agent: a separate agent with its own context that works on one self-contained task and returns a report. It does not see this conversation, so the prompt must hold everything it needs (the goal, the relevant paths and facts, what to report back). type is one of the "Agent types" listed in your instructions: "explore" searches and reads the project read-only, "general" also gets the tools that run without approval in the current permission mode. Sub-agents never ask the user: a call that would need approval is denied. Several task calls in one step run in parallel (at most 3 at a time). With background: true the call returns at once and the sub-agent keeps working while you go on; its report arrives later as a message. Use it for broad searches or independent sub-tasks that would fill your own context; do small lookups yourself. The user does not see the report unless you relay it.'

/** The error of a `task` call without an agent scope. */
export const TASK_UNAVAILABLE_ERROR = 'Sub-agents can only be started from a chat (a sub-agent cannot start another one).'

/** What the model text reads of an output: full outputs and reduced ones (`reduceAgentOutputs`) both parse. */
export const taskModelOutputSchema = taskOutputSchema.pick({ status: true, report: true, error: true, taskId: true })

/** The failure reason the model reads for a status without an `error`. */
const STATUS_ERRORS: Readonly<Record<TaskStatus, string>> = {
  queued: 'it never started',
  running: 'it did not finish',
  completed: 'unknown error',
  failed: 'unknown error',
  aborted: 'it was stopped',
  limit: 'it reached its limit without a report',
  // A background launch has its own model text (`taskModelText`); this entry only completes the record.
  background: 'it runs in the background',
}

/** The text the model reads for a background launch (`status: 'background'`). */
export function taskBackgroundModelText(taskId: string | undefined): string {
  return `Started background agent ${taskId ?? '(unknown id)'}. Its report will arrive as a message; keep working.`
}

/** The text the model reads for a `task` output (see the module comment). */
export function taskModelText(output: Pick<TaskOutput, 'status' | 'report' | 'error' | 'taskId'>): string {
  if (output.status === 'background')
    return taskBackgroundModelText(output.taskId)
  const report = output.report.trim()
  if (output.status === 'completed')
    return report === '' ? 'The sub-agent finished without a report.' : report
  if (output.status === 'limit' && report !== '')
    return report
  const error = (output.error ?? '').trim().replace(/\.+$/, '') || STATUS_ERRORS[output.status]
  return `Sub-agent failed: ${error}; partial report: ${report === '' ? '(none)' : report}`
}

/** The single output of a call without an agent scope. */
export function taskUnavailableOutput(input: TaskInput, c: ToolCallContext, now = Date.now()): TaskOutput {
  return {
    status: 'failed',
    type: input.type,
    description: input.description,
    modelRef: c.modelRef,
    steps: [],
    stepsOmitted: 0,
    report: '',
    startedAt: now,
    finishedAt: now,
    error: TASK_UNAVAILABLE_ERROR,
  }
}

export function createTaskTool(): ToolDefinition<TaskInput, TaskOutput> {
  return {
    name: TASK_TOOL_NAME,
    description: TASK_DESCRIPTION,
    inputSchema: taskInputSchema,
    policy: 'safe',
    timeoutMs: TASK_TIMEOUT_MS,
    async* execute(input, c) {
      const scope = agentScopeOf(c)
      if (scope === null) {
        yield taskUnavailableOutput(input, c)
        return
      }
      yield* scope.runSubagent(input, { toolCallId: c.toolCallId, signal: c.signal })
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(taskModelOutputSchema, output, taskModelText)
    },
  }
}
