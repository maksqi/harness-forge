// Rules of the Agent section of Settings -> General (docs/UI.md 9.11): the "none" label of its model selects and the
// warning of a sub-agent model that can't call tools.
import type { CatalogModel } from '@harness-forge/shared'

/** The "none" choice of the compaction and sub-agent model selects (the setting is null). */
export const SAME_MODEL_LABEL = 'Same model as the chat'

/**
 * The warning of the Sub-agent model field: a sub-agent works through tools, so a catalog model without
 * `capabilities.tools` can't run one. Null for a model that can call tools and for one the catalog does not know (the
 * select shows its unknown state; the server falls back to the chat's model).
 */
export function subagentModelWarning(model: Pick<CatalogModel, 'name' | 'capabilities'> | undefined): string | null {
  if (!model || model.capabilities.tools)
    return null
  return `${model.name} can't call tools, so sub-agents can't use it.`
}
