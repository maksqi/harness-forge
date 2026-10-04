// Plan files (Phase 10, ADR-047; ARCHITECTURE.md 6.27, API.md 4.25). Signature FROZEN after P10-0b (C31 stub); W10.5
// implements it.
//
// `savePlan(context, plan, c)` is what the run binds as `AgentRunScope.savePlan` (`pipeline.ts`), for `core-agent`'s
// `exit_plan_mode` on the approved continuation: only with the setting `planFiles` on and a workspace on the call context
// (`c.workspace`, a project chat); the path is `<planDirectory>/<YYYY-MM-DD>-<slug>.md` (UTC date from `context.now`,
// the slug from the plan's first heading or first line: `[a-z0-9-]`, at most 48, fallback `plan`; `-2`, `-3` … when the
// name is taken), written with `journaledWrite(c, c.workspace.root, { tool: 'exit_plan_mode', path }, produce)` under
// the run scope bound to `c` (rewind removes it, undo restores it); the folder is created through the workspace guard.
// Never rejects: `{ planPath }` when written, `{ planError }` (one safe sentence, logged as a warning) when the write
// failed, `{}` when no file is due. Plan texts are never logged at info.
//
// P10-0b stub: never writes a file (`{}`).
import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { Settings } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { AppDeps } from '../types.ts'
import type { SavedPlan } from './agent-scope.ts'

/** What `savePlan` reads (bound once per run by the pipeline). */
export interface PlanFileContext {
  /** The services. */
  readonly deps: AppDeps
  /** The settings of the run (`planFiles`, `planDirectory`). */
  readonly settings: Settings
  readonly logger: Logger
  /** The clock (the date of the file name). */
  readonly now: () => number
}

/** Writes an approved plan into the project (see the module comment). */
export async function savePlan(context: PlanFileContext, plan: string, c: ToolCallContext): Promise<SavedPlan> {
  void context
  void plan
  void c
  return {}
}
