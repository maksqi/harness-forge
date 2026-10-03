// The `todo_write` tool of `core-agent` (ADR-041; policy `safe`, no workspace access, so it is offered in every chat
// with tools, plan mode included; timeout 60 s). The model sends the complete list every time; the output is the
// stored list and its counts (`todoWriteOutputSchema`), and the latest `output-available` call on the chat's path is
// the todo state (`latestTodos` of `@harness-forge/shared`, no table). The input schema refuses duplicate ids, so an
// invalid list never reaches `execute` (the model gets the validation error as the tool result).
//
// P9-0b (C27): the definition (name, description, schema, policy, timeout, model text) is final and frozen. W9.4:
// `execute` validates the input again with the shared schema (the host wrapper and the SDK validate first; a direct
// call or a hook-changed input still never stores an invalid list) and returns `{ todos, counts }` (`countTodos`); an
// invalid input throws `validation_error` ("Invalid todo list: <path>: <issue>"), which the run turns into the tool's
// error result while the run goes on. Nothing is stored elsewhere and nothing is logged (todo texts are user content).
//
// The model reads one line: "Todo list updated: 1 in progress, 2 pending, 0 completed." ("Todo list cleared." for an
// empty list).
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { HarnessError, TodoWriteInput, TodoWriteOutput } from '@harness-forge/shared'
import type { z } from 'zod'
import { countTodos, todoWriteInputSchema, todoWriteOutputSchema, validationError } from '@harness-forge/shared'
import { textModelOutput, TODO_WRITE_TIMEOUT_MS } from './common.ts'

export const TODO_WRITE_TOOL_NAME = 'todo_write'

export const TODO_WRITE_DESCRIPTION = 'Create and update your todo list for the current task; the user sees it next to the chat. Send the complete list every time: it replaces the previous one. Use it for work with three or more steps, or when the user gives you several tasks; skip it for a single, simple step. Each item has a unique id, content (what to do), status (pending, in_progress or completed) and activeForm (what you are doing while it runs, e.g. "Running the tests"). Keep exactly one item in_progress while you work, mark each item completed as soon as it is done (not in batches), and add the items you discover on the way.'

/** The line the model reads for a `todo_write` output. */
export function todoWriteModelText(output: TodoWriteOutput): string {
  const { counts } = output
  if (counts.total === 0)
    return 'Todo list cleared.'
  return `Todo list updated: ${counts.inProgress} in progress, ${counts.pending} pending, ${counts.completed} completed.`
}

/** The `validation_error` of an invalid `todo_write` input: "Invalid todo list: <path>: <issue>" (the first issue). */
export function invalidTodoListError(error: z.ZodError): HarnessError {
  return validationError(error, `Invalid todo list: ${validationError(error).message}`)
}

/**
 * The output of a `todo_write` call: the validated list (unknown keys dropped) and its counts. Throws
 * `invalidTodoListError` for an input the shared schema refuses (duplicate ids, more than 50 items, a bad status, …).
 */
export function todoWriteOutput(input: unknown): TodoWriteOutput {
  const parsed = todoWriteInputSchema.safeParse(input)
  if (!parsed.success)
    throw invalidTodoListError(parsed.error)
  const { todos } = parsed.data
  return { todos, counts: countTodos(todos) }
}

export function createTodoWriteTool(): ToolDefinition<TodoWriteInput, TodoWriteOutput> {
  return {
    name: TODO_WRITE_TOOL_NAME,
    description: TODO_WRITE_DESCRIPTION,
    inputSchema: todoWriteInputSchema,
    policy: 'safe',
    timeoutMs: TODO_WRITE_TIMEOUT_MS,
    async execute(input) {
      return todoWriteOutput(input)
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(todoWriteOutputSchema, output, todoWriteModelText)
    },
  }
}
