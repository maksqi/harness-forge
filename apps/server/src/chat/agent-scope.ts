// The agent scope of a run (Phase 9, ADR-041 / ADR-043, ARCHITECTURE.md 6.19 and 6.22). FROZEN after P9-0b (C26,
// complete); Phase 10 (C31-T4, ADR-045 / ADR-047) adds `loadSkill` and `savePlan`; FROZEN again after P10-0b.
//
// A server-internal side channel like `workspace/run-scope.ts`: the chat pipeline (`chat/pipeline.ts`) builds one
// scope per run with tools (a project chat or not) and `wrapToolExecute` binds it to the `ToolCallContext` object of
// every call, next to `bindRunScope`, right before `definition.execute`. The builtin `core-agent` tools read it back
// with `agentScopeOf(c)`: `exit_plan_mode` reads `toolMode` (and, Phase 10, writes the approved plan with `savePlan`),
// `task` delegates to `runSubagent`, `skill` (Phase 10) to `loadSkill`. Sub-agent runs never bind it (depth 1: a `task`
// or `skill` call inside a child finds no scope and fails).
//
// The binding lives in a module-private `WeakMap` keyed by the context object: nothing is added to the object (no
// property, no symbol), so a third-party plugin that receives the same context cannot reach the sub-agent runner (the
// plugin API 1.3.0 has no `ToolCallContext.agent`), and a context that is no longer referenced releases its scope.
// Phase 11 (C37, ADR-048; FROZEN again after P11-0b): the scope gains nothing. A run's command hooks reach its
// sub-agents through the host (`ChildSession.hooks`, `subagent/host.ts`: `RunSession.hooks.forChild(…)` when the runner
// starts a child), never through this scope or the call context, so no plugin tool can run or skip a hook.
import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { ExitPlanModeOutput, SkillOutput, TaskInput, TaskOutput, TodoState, ToolMode } from '@harness-forge/shared'

/** The call-specific options of `AgentRunScope.runSubagent`. */
export interface RunSubagentOptions {
  /** The parent's `task` tool call id (a child's journal ids are `<toolCallId>/<child call id>`). */
  readonly toolCallId: string
  /** The `task` call's abort signal (the run's Stop, the tool timeout); the child also has its own deadline. */
  readonly signal: AbortSignal
}

/**
 * What `AgentRunScope.savePlan` reports (Phase 10, ADR-047; the `exit_plan_mode` output fields): `planPath` when the
 * plan file was written, `planError` when writing it failed; `{}` when no file is due (`planFiles` off, no project).
 */
export type SavedPlan = Pick<ExitPlanModeOutput, 'planPath' | 'planError'>

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
  /**
   * Phase 10 (ADR-045; `chat/skills.ts`, W10.5): loads one skill of the run's catalog for `skill` (the body read and
   * validated again; a project skill also lists its supporting files). Rejects for an unknown, disabled or unreadable
   * skill (the tool error the model reads names the available skills) and when `signal` aborts.
   */
  loadSkill: (name: string, signal: AbortSignal) => Promise<SkillOutput>
  /**
   * Phase 10 (ADR-047; `chat/plan-file.ts`, W10.5): writes an approved plan to the project when `planFiles` is on and the
   * call context `c` has a workspace (journaled through the run scope bound to `c`). Never rejects: a failed write is
   * `{ planError }` and never fails the approval.
   */
  savePlan: (plan: string, c: ToolCallContext) => Promise<SavedPlan>
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
