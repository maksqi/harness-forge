// The call scope of one `skill` tool call (Phase 12, ADR-053 / ADR-058; W12.7): what `loadSkill` (`skills.ts`) needs of
// the call besides the frozen `LoadSkillOptions` (`agent-scope.ts`: `file`, `toolCallId`): the chat id
// (`${CLAUDE_SESSION_ID}` of the skill body) and the run's sub-agent runner (a fork skill's child, `context: fork`).
//
// A server-internal side channel like `agent-scope.ts`: `core-agent`'s `skill` tool builds the options object of its
// `loadSkill` call with `skillCallOptions(options, scope)`, which binds the call scope to that very object in a
// module-private `WeakMap`; the pipeline passes the object through unchanged (`AgentRunScope.loadSkill`), and
// `skillCallScopeOf(options)` reads it back. Nothing is added to the object, so the options stay the frozen shape and a
// plugin never reaches the runner. Options built elsewhere have no call scope: the body of a fork skill is returned then.
import type { TaskInput, TaskOutput } from '@harness-forge/shared'
import type { LoadSkillOptions, RunSubagentOptions } from './agent-scope.ts'

/** What one `skill` call adds to `loadSkill`. */
export interface SkillCallScope {
  /** The chat of the call (`${CLAUDE_SESSION_ID}`). */
  readonly chatId: string
  /** The run's sub-agent runner (`AgentRunScope.runSubagent`): a fork skill runs its child through it. */
  readonly runSubagent?: (input: TaskInput, options: RunSubagentOptions) => AsyncIterable<TaskOutput>
}

const scopes = new WeakMap<object, SkillCallScope>()

/** A copy of `options` bound to `scope` (frozen; pass it to `AgentRunScope.loadSkill`). */
export function skillCallOptions(options: LoadSkillOptions, scope: SkillCallScope): LoadSkillOptions {
  const bound: LoadSkillOptions = Object.freeze({ ...options })
  scopes.set(bound, Object.freeze({ ...scope }))
  return bound
}

/** The call scope bound to `options`, or null (no options, or options built without `skillCallOptions`). */
export function skillCallScopeOf(options: LoadSkillOptions | null | undefined): SkillCallScope | null {
  if (typeof options !== 'object' || options === null)
    return null
  return scopes.get(options) ?? null
}
