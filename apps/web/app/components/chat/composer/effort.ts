// Reasoning effort options of the effort menu (docs/UI.md 7.10): Auto ("Provider default"), then only the efforts a
// model lists in `reasoningEfforts`, in the order Off, Low, Medium, High, Max. A value the model does not offer is
// treated as `auto` by the server (docs/PLUGINS.md), so the menu shows it as Auto.
import type { CatalogModel, ReasoningEffort } from '@harness-forge/shared'

export const EFFORT_LABELS: Readonly<Record<ReasoningEffort, string>> = {
  auto: 'Auto',
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
}

/** Canonical menu order after Auto. */
export const EFFORT_ORDER: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max']

export const EFFORT_AUTO_DESCRIPTION = 'Provider default'

/**
 * The effort menu options of a model: `auto` plus the efforts it offers, in canonical order. Empty when the model
 * has no effort control (unknown model, `reasoningEfforts: []`, or only `auto`): the menu is hidden then.
 */
export function effortOptions(model: Pick<CatalogModel, 'reasoningEfforts'> | null | undefined): ReasoningEffort[] {
  const offered = new Set(model?.reasoningEfforts ?? [])
  const levels = EFFORT_ORDER.filter(effort => offered.has(effort))
  return levels.length > 0 ? ['auto', ...levels] : []
}

/** The effort that applies to a request: the value when the model offers it, else `auto`. */
export function effectiveEffort(value: ReasoningEffort, options: readonly ReasoningEffort[]): ReasoningEffort {
  return options.includes(value) ? value : 'auto'
}
