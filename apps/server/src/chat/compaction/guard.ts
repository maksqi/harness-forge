// The context guard (Phase 9, ADR-040, ARCHITECTURE.md 6.18): the first piece of the step composer (`steps.ts`), run
// before every model call of a run (step 0 included), so the pre-run and the in-run compaction are one code path.
// Signatures FROZEN after P9-0b (C26); the implementation is W9.1's.
//
// W9.1: estimate = max(`estimateTokens(messages, instructions)`, the last step's input + output tokens); compact when
// the estimate is above `COMPACT_TRIGGER_RATIO` (0.8) of the model's context window, `autoCompact` is on, the window is
// known and the guard compacted fewer than `LIMITS.compactionsPerRunMax` times: summarize (`summarizeHistory`), inject
// `data-compaction` (`trigger: 'auto'`) for the step through `session.inject`, and return `[merge(summary, keptUser)]`
// (`keep: 'last-user'`; `keep: 'none'` when that would still exceed 0.85 of the window), with the transient
// `data-activity` `compacting` / `idle` around the call (`session.writeTransient`). A non-abort failure or `autoCompact`
// off: `trimToContext` on step 0 only, plus the notice `compaction-failed` (failure) or `context-trimmed` (off). An
// abort re-throws. `silent` (sub-agents): no marker, no notice, no activity; the usage row only.
//
// P9-0b stub: a piece that changes nothing; the v1.4 step-0 trim stays in `pipeline.ts` until W9.1 moves it here.
import type { ModelMessage } from 'ai'
import type { ResolvedModel } from '../../providers/types.ts'
import type { RunSession } from '../pipeline.ts'
import type { StepPiece } from '../steps.ts'
import { noopStepPiece } from '../steps.ts'

/** Share of the context window above which the guard compacts. */
export const COMPACT_TRIGGER_RATIO = 0.8

export interface ContextGuardInput {
  /**
   * The run (the parent run of a sub-agent): deps, settings (`autoCompact`, `compactModelRef`), chat and reply ids,
   * history, `inject` / `writeTransient` / `addExtraCost` / notices, the run signal and the logger.
   */
  readonly session: RunSession
  /** The model of the guarded calls (the run model, or a sub-agent's model): its context window, the summary default. */
  readonly model: ResolvedModel
  /**
   * The user message kept after an automatic compaction (`keep: 'last-user'`), as the model sees it: the run's turn user
   * message after expansions and files and before any summary was merged into it (converted lazily, once), or a
   * sub-agent's prompt; null keeps none.
   */
  readonly keptUser: () => Promise<ModelMessage | null>
  /** Sub-agents: no marker, no notice, no activity; the usage row only (default false). */
  readonly silent?: boolean
  /** The signal of the guarded calls (default: the run signal). */
  readonly signal?: AbortSignal
}

/** The context guard piece (stub until W9.1: changes nothing; see the module comment). */
export function createContextGuard(_input: ContextGuardInput): StepPiece {
  return noopStepPiece
}
