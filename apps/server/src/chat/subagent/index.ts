// Sub-agents (Phase 9, ADR-043 amends ADR-036, ARCHITECTURE.md 6.22): the child runner of a run, created per run in
// `modelStream` (`pipeline.ts`) and reached by the `task` tool through the agent scope (`agentScopeOf(c).runSubagent`).
// Signatures FROZEN after P9-0b (C26); the implementation is W9.5's.
//
// W9.5: model `settings.subagentModelRef ?? the run model`; `buildRunParams` with the child's tools (`childTools`) and
// a preamble carrying `SUBAGENT_INSTRUCTIONS_MARKER`; messages `[user: prompt]`; `stopWhen:
// isStepCount(settings.subagentMaxSteps)`; the step composer with the context guard in silent mode and the finalize
// nudge (the last allowed step: `activeTools: []` and "Write the final report now."); `AbortSignal.any([options.signal,
// AbortSignal.timeout(LIMITS.subagentTimeoutMs)])`; a per-run semaphore (`LIMITS.subagentParallelMax` running, the
// others yield `queued`) and `LIMITS.subagentsPerRunMax` children per run (more fail); a `TaskOutput` snapshot on every
// tool start / finish and step end (the last `LIMITS.taskStepsShownMax` steps + `stepsOmitted`); `limit` when the step
// limit or the deadline ended it; one usage row with purpose `subagent` per child, its cost through
// `session.addExtraCost`. No agent scope is bound in a child (depth 1). Prompts and outputs are never logged at info.
//
// P9-0b stub: `run` yields one `failed` output ("Sub-agents are not available yet.").
import type { TaskInput, TaskOutput, ToolMode } from '@harness-forge/shared'
import type { ResolvedModel } from '../../providers/types.ts'
import type { OpenWorkspace } from '../../services/projects/types.ts'
import type { WorkspaceRunScopeInit } from '../../workspace/run-scope.ts'
import type { RunSubagentOptions } from '../agent-scope.ts'
import type { RunSession } from '../pipeline.ts'

/** The error of the P9-0b stub. */
export const SUBAGENTS_UNAVAILABLE_TEXT = 'Sub-agents are not available yet.'

export interface SubagentRunnerInput {
  /**
   * The parent run: deps, settings (`subagentModelRef`, `subagentMaxSteps`), chat and reply ids, `addExtraCost`, the run
   * signal, the clock and the logger.
   */
  readonly session: RunSession
  /** The parent's model (the model of a child when `subagentModelRef` is unset or cannot be resolved). */
  readonly model: ResolvedModel
  /** The parent's permission mode (a child's tools and approvals follow it, `childTools`). */
  readonly toolMode: ToolMode
  /** The parent run's open project folder (`prepared.workspace`), or null. */
  readonly workspace: OpenWorkspace | null
  /** The parent run scope (journal, shell rules, shell folder), or null without a workspace. */
  readonly scope: WorkspaceRunScopeInit | null
}

export interface SubagentRunner {
  /**
   * `AgentRunScope.runSubagent`: runs one child and yields `TaskOutput` snapshots; the last one is the final output.
   * Never throws for a failed child (it yields a `failed` / `aborted` / `limit` output).
   */
  readonly run: (input: TaskInput, options: RunSubagentOptions) => AsyncIterable<TaskOutput>
}

/** The sub-agent runner of a run (stub until W9.5; see the module comment). */
export function createSubagentRunner(input: SubagentRunnerInput): SubagentRunner {
  const { session, model } = input
  return {
    async* run(task) {
      const now = session.ctx.now()
      yield {
        status: 'failed',
        type: task.type,
        description: task.description,
        modelRef: model.modelRef,
        steps: [],
        stepsOmitted: 0,
        report: '',
        startedAt: now,
        finishedAt: now,
        error: SUBAGENTS_UNAVAILABLE_TEXT,
      }
    },
  }
}
