// The run scope of the agent workspace (Phase 8, ADR-036 / ADR-038, ARCHITECTURE.md 6.13 "Run scope and journaled
// writes"). FROZEN after P8-0b (C19, complete).
//
// A server-internal side channel: the chat pipeline (`chat/pipeline.ts`, W8.5) builds one scope per run with a
// workspace (`{ chatId, messageId, projectId, journal, shellRules, shellCwd }`); `wrapToolExecute` binds it, with the
// call's `toolCallId`, to the `ToolCallContext` object right before `definition.execute`, and `evaluatePolicy` binds it
// to the context object of a policy function. Server code (the builtin `core-workspace` tools: `journaledWrite`,
// `shellPolicy`, the sticky working folder) reads it back with `runScopeOf(c)`.
//
// The binding lives in a module-private `WeakMap` keyed by the context object: nothing is added to the object (no
// property, no symbol), so a third-party plugin that receives the same context cannot reach the journal, the rules or
// the folder (the plugin API stays 1.2.0), and a context that is no longer referenced releases its scope.
import type { CheckpointJournal } from '../services/checkpoints/types.ts'
import type { ShellRuleSet } from '../services/shell-rules/types.ts'

/** The working folder a run's shell calls share (`shellCwd.current`). */
export interface ShellCwdState {
  /**
   * The folder the next `shell` call starts in, relative to the project folder (POSIX, `.` = the project folder):
   * `initialShellCwd(history)` at the run start (`workspace/shell-cwd.ts`, W8.4), then the end folder of each finished
   * call (for parallel calls in one step, the call that finishes last wins). Mutable: one shared object per run.
   */
  current: string
}

/** What a workspace tool of one call can reach through `runScopeOf(c)`. */
export interface WorkspaceRunScope {
  readonly chatId: string
  /** The assistant message of the run (a continuation after an approval keeps the id). */
  readonly messageId: string
  /** The chat's project (the run's workspace). */
  readonly projectId: string
  /** The tool call the scope is bound for. */
  readonly toolCallId: string
  /** `checkpoints.journal({ chatId, messageId, projectId })`; null writes without recording. */
  readonly journal: CheckpointJournal | null
  /** `await shellRules.forRun(projectId)`, read once per run (the `shell` policy matches against it). */
  readonly shellRules: ShellRuleSet
  /** The sticky working folder: the same object for every call of the run. */
  readonly shellCwd: ShellCwdState
}

/** The scope of a run before a tool call binds it (`WorkspaceRunScope` without `toolCallId`). */
export type WorkspaceRunScopeInit = Omit<WorkspaceRunScope, 'toolCallId'>

const scopes = new WeakMap<object, WorkspaceRunScope>()

/**
 * Binds `scope` to the context object `c` (a `ToolCallContext`, or the context of a policy call); binding the same
 * object again replaces the scope. The stored scope is a frozen shallow copy: `shellCwd` (and the journal) stay the
 * run's shared objects.
 */
export function bindRunScope(c: object, scope: WorkspaceRunScope): void {
  scopes.set(c, Object.freeze({ ...scope }))
}

/** The scope bound to the context object `c`, or null (a call outside a run with a workspace, a plugin's own object). */
export function runScopeOf(c: object): WorkspaceRunScope | null {
  return scopes.get(c) ?? null
}
