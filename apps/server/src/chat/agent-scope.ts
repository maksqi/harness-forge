// The agent scope of a run (Phase 9, ADR-041 / ADR-043, ARCHITECTURE.md 6.19 and 6.22). FROZEN after P9-0b (C26,
// complete).
//
// A server-internal side channel like `workspace/run-scope.ts`: the chat pipeline (`chat/pipeline.ts`) builds one
// scope per run with tools (a project chat or not) and `wrapToolExecute` binds it to the `ToolCallContext` object of
// every call, next to `bindRunScope`, right before `definition.execute`. The builtin `core-agent` tools read it back
// with `agentScopeOf(c)`: `exit_plan_mode` reads `toolMode`, `task` delegates to `runSubagent`. Sub-agent runs never
// bind it (depth 1: a `task` call inside a child finds no scope and fails).
//
// The binding lives in a module-private `WeakMap` keyed by the context object: nothing is added to the object (no
// property, no symbol), so a third-party plugin that receives the same context cannot reach the sub-agent runner (the
// plugin API 1.3.0 has no `ToolCallContext.agent`), and a context that is no longer referenced releases its scope.
import type { TaskInput, TaskOutput, TodoState, ToolMode } from '@harness-forge/shared'

/** The call-specific options of `AgentRunScope.runSubagent`. */
export interface RunSubagentOptions {
  /** The parent's `task` tool call id (a child's journal ids are `<toolCallId>/<child call id>`). */
  readonly toolCallId: string
  /** The `task` call's abort signal (the run's Stop, the tool timeout); the child also has its own deadline. */
  readonly signal: AbortSignal
}

/** What a `core-agent` tool of one call can reach through `agentScopeOf(c)`. */
export interface AgentRunScope {
  readonly chatId: string
  /** The assistant message of the run (a continuation after an approval keeps the id). */
  readonly messageId: string
  /**
   * The run's permission mode (the request's `toolMode`; after a plan approval the continuation carries the mode the
   * user picked, `edits` or `ask`).
   */
  readonly toolMode: ToolMode
  /**
   * Runs one sub-agent (`createSubagentRunner`): yields `TaskOutput` snapshots (`queued`, `running`, …); the last
   * value is the final output. Never throws for a failed child (it yields a `failed` / `aborted` / `limit` output);
   * the iteration ends when `options.signal` aborts.
   */
  runSubagent: (input: TaskInput, options: RunSubagentOptions) => AsyncIterable<TaskOutput>
  /** The todo list of the run's history (`latestTodos` of the path the run started from), or null. */
  todos: () => TodoState | null
}

const scopes = new WeakMap<object, AgentRunScope>()

/**
 * Binds `scope` to the context object `c` (a `ToolCallContext`); binding the same object again replaces the scope.
 * The stored scope is a frozen shallow copy (the functions stay the run's own).
 */
export function bindAgentScope(c: object, scope: AgentRunScope): void {
  scopes.set(c, Object.freeze({ ...scope }))
}

/** The scope bound to the context object `c`, or null (a sub-agent's call, a call outside a run, a plugin's object). */
export function agentScopeOf(c: object): AgentRunScope | null {
  return scopes.get(c) ?? null
}
