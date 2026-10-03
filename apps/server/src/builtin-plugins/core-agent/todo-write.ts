// The `todo_write` tool of `core-agent` (ADR-041; policy `safe`, no workspace access, so it is offered in every chat
// with tools, plan mode included; timeout 60 s). The model sends the complete list every time; the output is the
// stored list and its counts (`todoWriteOutputSchema`), and the latest `output-available` call on the chat's path is
// the todo state (`latestTodos` of `@harness-forge/shared`, no table). The input schema refuses duplicate ids, so an
// invalid list never reaches `execute` (the model gets the validation error as the tool result).
//
// P9-0b (C27): the definition (name, description, schema, policy, timeout, model text) is final and frozen; `execute`
// is a stub until W9.4 (`todo-write*`) implements it: `{ todos: input.todos, counts: countTodos(input.todos) }`.
//
// The model reads one line: "Todo list updated: 1 in progress, 2 pending, 0 completed." ("Todo list cleared." for an
// empty list).
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { TodoWriteInput, TodoWriteOutput } from '@harness-forge/shared'
import { todoWriteInputSchema, todoWriteOutputSchema } from '@harness-forge/shared'
import { agentToolNotImplemented, textModelOutput, TODO_WRITE_TIMEOUT_MS } from './common.ts'

export const TODO_WRITE_TOOL_NAME = 'todo_write'

export const TODO_WRITE_DESCRIPTION = 'Create and update your todo list for the current task; the user sees it next to the chat. Send the complete list every time: it replaces the previous one. Use it for work with three or more steps, or when the user gives you several tasks; skip it for a single, simple step. Each item has a unique id, content (what to do), status (pending, in_progress or completed) and activeForm (what you are doing while it runs, e.g. "Running the tests"). Keep exactly one item in_progress while you work, mark each item completed as soon as it is done (not in batches), and add the items you discover on the way.'

/** The line the model reads for a `todo_write` output. */
export function todoWriteModelText(output: TodoWriteOutput): string {
  const { counts } = output
  if (counts.total === 0)
    return 'Todo list cleared.'
  return `Todo list updated: ${counts.inProgress} in progress, ${counts.pending} pending, ${counts.completed} completed.`
}

export function createTodoWriteTool(): ToolDefinition<TodoWriteInput, TodoWriteOutput> {
  return {
    name: TODO_WRITE_TOOL_NAME,
    description: TODO_WRITE_DESCRIPTION,
    inputSchema: todoWriteInputSchema,
    policy: 'safe',
    timeoutMs: TODO_WRITE_TIMEOUT_MS,
    async execute() {
      throw agentToolNotImplemented(TODO_WRITE_TOOL_NAME)
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(todoWriteOutputSchema, output, todoWriteModelText)
    },
  }
}
