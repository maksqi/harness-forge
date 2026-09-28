// Shared pieces of the effort -> request mappings (PROVIDERS.md section 4). `auto` never reaches the provider: every
// mapping returns `undefined` for it.
import type { ReasoningEffort, ReasoningLevel, ReasoningParams } from '@harness-forge/plugin-sdk'

/** An effort the host may pass to `reasoning()` (the host never passes `auto`, the mappings still handle it). */
export type Effort = Exclude<ReasoningEffort, 'auto'>

/** The portable AI SDK v7 mapping: `off` -> `none`, `low` / `medium` / `high` -> same, `max` -> `xhigh`. */
export const TOP_LEVEL_REASONING: Readonly<Record<Effort, ReasoningLevel>> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
}

/** `{ reasoning: TOP_LEVEL_REASONING[effort] }`, `undefined` for `auto`. */
export function topLevelReasoning(effort: ReasoningEffort): ReasoningParams | undefined {
  return effort === 'auto' ? undefined : { reasoning: TOP_LEVEL_REASONING[effort] }
}

/** Efforts offered when a model can switch thinking on and off but has no effort levels (`high` = on). */
export const ON_OFF_EFFORTS: readonly ReasoningEffort[] = ['off', 'high']
