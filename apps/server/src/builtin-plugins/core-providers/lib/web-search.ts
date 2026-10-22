// Shared pieces of the builtin providers' `webSearch` hooks (plugin API 1.7.0, ADR-062, PROVIDERS.md 14 "Native search
// by provider"). A hook is synchronous and does no I/O: it only builds the provider package's search tool (a
// provider-defined tool object) or provider options for a model id.
import type { WebSearchRequest } from '@harness-forge/plugin-sdk'
import { WEB_SEARCH_MAX_USES } from '@harness-forge/shared'

/** Highest search count a hook passes on (a request above it is capped). */
export const WEB_SEARCH_MAX_USES_CAP = 20

/**
 * The searches one turn may run (`request.maxUses`, the host's `WEB_SEARCH_MAX_USES`): a whole number 1 … 20, else the
 * default.
 */
export function searchMaxUses(request: Pick<WebSearchRequest, 'maxUses'> | undefined): number {
  const value = request?.maxUses
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    return WEB_SEARCH_MAX_USES
  return Math.min(value, WEB_SEARCH_MAX_USES_CAP)
}

/** The model id without a fine-tune prefix (`ft:gpt-4o-mini:org::id` -> `gpt-4o-mini:org::id`), lowercase. */
export function baseModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/^ft:/, '')
}
