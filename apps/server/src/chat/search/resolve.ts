// The resolution helpers of a turn's web search (Phase 14, ADR-062 / ADR-063, ARCHITECTURE.md 6.43). Signatures written
// by C52 in P14-0b and FROZEN after Gate P14-0b; W14.4 implemented them in P14-A. The call site is `turnWebSearch`
// (`turn.ts`), used by the chat pipeline and by sub-agents.
// - `providerWebSearch(resolved, request, logger)`: the provider's `ProviderDefinition.webSearch(model, request)` hook,
//   synchronous and guarded like `providerReasoning` (`params.ts`): a throw is ignored with a warning, and the answer is
//   read by the registry's `checkWebSearchParams` (`registry/validate.ts`: only provider-defined tools under valid tool
//   keys, provider options that are JSON objects keyed by provider, a boolean `exclusive`; a bad part is ignored with a
//   warning). Never logs a tool's arguments or the provider options (only the provider id and the problems).
// - `applyWebSearch(assembled, resolution, params)`: the turn's tool set with the resolution applied
//   (`AppliedWebSearch`, `types.ts`): `native` adds the provider-defined tools of `params.tools` whose keys no other
//   tool of the turn takes (their names in `nativeTools`, appended to `activeTools` when that list is set; a colliding
//   key is ignored with a warning when the answer came from `providerWebSearch`) and passes a copy of
//   `params.providerOptions` on (the caller deep-merges it over the run's, `mergeProviderOptions`); `search_web` of
//   `core-search` stays only for `builtin`. Never adds a function tool, never changes its input.
import type { WebSearchParams, WebSearchRequest } from '@harness-forge/plugin-sdk'
import type { WebSearchResolution } from '@harness-forge/shared'
import type { Tool, ToolSet } from 'ai'
import type { Logger } from '../../logger.ts'
import type { ResolvedModelBase } from '../../providers/types.ts'
import type { ApprovalTool } from '../approval.ts'
import type { AppliedWebSearch, WebSearchToolSet } from './types.ts'
import { SEARCH_WEB_TOOL_NAME, WEB_SEARCH_MAX_USES } from '@harness-forge/shared'
import { checkWebSearchParams, isProviderToolShape, webSearchToolCollisions } from '../../registry/validate.ts'
import { SEARCH_TOOL_PLUGIN_ID } from './types.ts'

/** Highest `maxUses` passed to a provider (a larger request value is capped). */
const MAX_USES_CAP = 20

/**
 * Where an answer of `providerWebSearch` came from: `applyWebSearch` warns about a colliding tool key through it. Keyed
 * by the answer object (a fresh object per call), so nothing outlives the turn.
 */
const answerOrigins = new WeakMap<WebSearchParams, { readonly logger: Logger, readonly providerId: string }>()

/** The request passed to the hook: whole numbers, `functionTools` ≥ 0, `maxUses` 1 … 20 (else the defaults). */
function hookRequest(request: WebSearchRequest): WebSearchRequest {
  const functionTools = Number.isInteger(request.functionTools) && request.functionTools >= 0 ? request.functionTools : 0
  const maxUses = Number.isInteger(request.maxUses) && request.maxUses >= 1 ? Math.min(request.maxUses, MAX_USES_CAP) : WEB_SEARCH_MAX_USES
  return Object.freeze({ functionTools, maxUses })
}

/**
 * The provider's native search additions for one turn (`ProviderDefinition.webSearch(resolved.info, request)`), or
 * undefined when the provider has none for the model, the hook throws or answers nothing usable (see the module
 * comment). Never throws.
 */
export function providerWebSearch(resolved: ResolvedModelBase, request: WebSearchRequest, logger: Logger): WebSearchParams | undefined {
  let value: unknown
  try {
    const definition = resolved.provider.definition
    if (typeof definition.webSearch !== 'function')
      return undefined
    value = definition.webSearch(resolved.info, hookRequest(request))
  }
  catch (error) {
    logger.warn('provider webSearch() failed', { providerId: resolved.providerId, err: error })
    return undefined
  }
  const checked = checkWebSearchParams(value)
  if (checked.problems.length > 0)
    logger.warn('provider webSearch() answer ignored in part', { providerId: resolved.providerId, modelRef: resolved.modelRef, problems: checked.problems })
  if (checked.params !== undefined)
    answerOrigins.set(checked.params, { logger, providerId: resolved.providerId })
  return checked.params
}

/** `core-search`'s `search_web` (recognized by owner and name; a tool of that name from another plugin is a plain tool). */
export function isBuiltinSearchTool(name: string, tool: Pick<ApprovalTool, 'pluginId'> | undefined): boolean {
  return name === SEARCH_WEB_TOOL_NAME && tool?.pluginId === SEARCH_TOOL_PLUGIN_ID
}

/**
 * A provider-defined tool (`type: 'provider'`, an id `<provider>.<tool>`, an `args` object), the only kind a native
 * search may add (`isProviderToolShape` of the registry).
 */
export function isProviderTool(tool: unknown): tool is Tool {
  try {
    return isProviderToolShape(tool)
  }
  catch {
    return false
  }
}

/** The native tools and provider options of `params` that `tools` / `byName` leave room for (see the module comment). */
function nativeAdditions(params: WebSearchParams, tools: ToolSet, byName: ReadonlyMap<string, ApprovalTool>): { tools: [string, Tool][], providerOptions: WebSearchParams['providerOptions'] } {
  // A direct caller (a test, a sub-agent double) may pass an answer that `providerWebSearch` did not read: read it here.
  const checked = answerOrigins.has(params) ? params : checkWebSearchParams(params).params
  if (checked === undefined)
    return { tools: [], providerOptions: undefined }
  const taken = (name: string): boolean => Object.hasOwn(tools, name) || byName.has(name)
  const collisions = webSearchToolCollisions(checked, taken)
  const origin = answerOrigins.get(params)
  if (collisions.length > 0 && origin !== undefined)
    origin.logger.warn('provider webSearch() tools ignored: another tool of the turn has their names', { providerId: origin.providerId, tools: collisions })
  const additions = Object.entries(checked.tools ?? {}).filter(([name, tool]) => !taken(name) && isProviderTool(tool))
  const options = checked.providerOptions
  return {
    tools: additions,
    providerOptions: typeof options === 'object' && options !== null && Object.keys(options).length > 0 ? structuredClone(options) : undefined,
  }
}

/** The turn's tools with `resolution` applied (see the module comment and `AppliedWebSearch`). Never throws. */
export function applyWebSearch(assembled: WebSearchToolSet, resolution: WebSearchResolution, params: WebSearchParams | undefined): AppliedWebSearch {
  const keepBuiltin = resolution.kind === 'builtin'
  const removed = new Set<string>()
  const tools: ToolSet = {}
  for (const [name, tool] of Object.entries(assembled.tools)) {
    if (!keepBuiltin && isBuiltinSearchTool(name, assembled.byName.get(name))) {
      removed.add(name)
      continue
    }
    tools[name] = tool
  }
  const byName = new Map<string, ApprovalTool>()
  for (const [name, tool] of assembled.byName) {
    if (!removed.has(name))
      byName.set(name, tool)
  }
  const nativeTools = new Set<string>()
  let providerOptions: WebSearchParams['providerOptions']
  if (resolution.kind === 'native' && params !== undefined) {
    try {
      const additions = nativeAdditions(params, tools, byName)
      for (const [name, tool] of additions.tools) {
        tools[name] = tool
        nativeTools.add(name)
      }
      providerOptions = additions.providerOptions
    }
    catch {
      // A hostile answer (a throwing getter): the native tools read so far.
    }
  }
  const activeTools = assembled.activeTools === undefined
    ? undefined
    : [...assembled.activeTools.filter(name => !removed.has(name)), ...nativeTools]
  return {
    tools,
    byName,
    ...(activeTools === undefined ? {} : { activeTools }),
    nativeTools,
    ...(providerOptions === undefined ? {} : { providerOptions }),
  }
}
