// The web search of one turn (Phase 14, ADR-062 / ADR-063, ARCHITECTURE.md 6.43). Written by C52 in P14-0b: COMPLETE and
// FROZEN after Gate P14-0b (a change is a CCR). The one place where a run (`pipeline.ts`) or a sub-agent
// (`subagent/tools.ts`) turns its effective mode into tools, always with the shared resolver (`resolveWebSearch`):
// 1. the resolver's inputs: the mode (`off` / `auto`), the tool mode, the model's native support
//    (`CatalogModel.webSearch`, absent = null), `webSearchNative`, whether `core-search`'s `search_web` is offered this
//    turn (`builtinAvailable`), the model's `capabilities.tools`, and the function tools the turn offers besides
//    `search_web` (`activeTools` when set, else every tool);
// 2. a `native` resolution asks the provider (`providerWebSearch` with `{ functionTools, maxUses: WEB_SEARCH_MAX_USES }`).
//    An answer that is `exclusive` while the turn offers function tools (Gemini 2.x would drop them) resolves again as an
//    `exclusive` model (→ the builtin, or `tools-conflict`); no answer, or one with nothing to add, resolves again without
//    native support (→ the builtin, `no-backend` or `tools-unsupported`). The second resolution can never be native, so
//    native and builtin search are never offered in one request;
// 3. `applyWebSearch` applies the final resolution to the assembled tools.
// The caller writes the notice of an `unavailable` resolution (a chat run, `web-search-unavailable`; a sub-agent writes
// nothing). Nothing is logged at `info` (the resolution's kind and reason at `debug`).
import type { WebSearchParams } from '@harness-forge/plugin-sdk'
import type { ToolMode, WebSearchMode, WebSearchResolution, WebSearchResolveInput } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { ResolvedModelBase } from '../../providers/types.ts'
import type { TurnWebSearch, WebSearchToolSet } from './types.ts'
import { resolveWebSearch, SEARCH_WEB_TOOL_NAME, WEB_SEARCH_MAX_USES } from '@harness-forge/shared'
import { applyWebSearch, isBuiltinSearchTool, isProviderTool, providerWebSearch } from './resolve.ts'

export interface TurnWebSearchInput {
  /** The turn's effective mode (`PreparedRun.webSearch`: body > chat > global; a sub-agent inherits its parent's). */
  readonly mode: WebSearchMode
  /** The turn's tool mode (a sub-agent: its parent's; the resolver treats `off` as `tool-mode-off`). */
  readonly toolMode: ToolMode
  /** The model of the turn (its catalog entry and provider hook). */
  readonly model: ResolvedModelBase
  /** The global setting `webSearchNative` (false = always the builtin). */
  readonly preferNative: boolean
  /** The tools the turn assembled (before web search). */
  readonly assembled: WebSearchToolSet
  readonly logger: Logger
}

/** `core-search`'s `search_web` is offered this turn (in the tool set and callable). */
export function builtinSearchOffered(assembled: WebSearchToolSet): boolean {
  const offered = assembled.activeTools === undefined || assembled.activeTools.includes(SEARCH_WEB_TOOL_NAME)
  return offered && Object.hasOwn(assembled.tools, SEARCH_WEB_TOOL_NAME) && isBuiltinSearchTool(SEARCH_WEB_TOOL_NAME, assembled.byName.get(SEARCH_WEB_TOOL_NAME))
}

/** The function tools the turn offers besides `core-search`'s `search_web` (the names the model may call). */
export function functionToolCount(assembled: WebSearchToolSet): number {
  const names = assembled.activeTools ?? Object.keys(assembled.tools)
  return names.filter(name => Object.hasOwn(assembled.tools, name) && !isBuiltinSearchTool(name, assembled.byName.get(name))).length
}

/** True when a native answer adds something to the turn: a provider tool whose key no tool of the turn takes, or options. */
function addsSomething(params: WebSearchParams, assembled: WebSearchToolSet): boolean {
  try {
    const tools = Object.entries(params.tools ?? {}).some(([name, tool]) => isProviderTool(tool) && !Object.hasOwn(assembled.tools, name) && !assembled.byName.has(name))
    const options = typeof params.providerOptions === 'object' && params.providerOptions !== null && Object.keys(params.providerOptions).length > 0
    return tools || options
  }
  catch {
    return false
  }
}

/** The web search of one turn (see the module comment). Never throws. */
export function turnWebSearch(input: TurnWebSearchInput): TurnWebSearch {
  const { assembled, model, logger } = input
  const functionTools = functionToolCount(assembled)
  const native = model.entry.webSearch === 'native' || model.entry.webSearch === 'exclusive' ? model.entry.webSearch : null
  const base: WebSearchResolveInput = {
    mode: input.mode,
    toolMode: input.toolMode,
    native,
    preferNative: input.preferNative,
    builtinAvailable: builtinSearchOffered(assembled),
    modelTools: model.entry.capabilities.tools === true,
    functionTools,
  }
  let resolution: WebSearchResolution = resolveWebSearch(base)
  let params: WebSearchParams | undefined
  if (resolution.kind === 'native') {
    const answer = providerWebSearch(model, { functionTools, maxUses: WEB_SEARCH_MAX_USES }, logger)
    if (answer !== undefined && answer.exclusive === true && functionTools > 0)
      resolution = resolveWebSearch({ ...base, native: 'exclusive' })
    else if (answer === undefined || !addsSomething(answer, assembled))
      resolution = resolveWebSearch({ ...base, native: null })
    else
      params = answer
  }
  if (resolution.kind !== 'off')
    logger.debug('web search resolved', { modelRef: model.modelRef, kind: resolution.kind, ...(resolution.kind === 'unavailable' ? { reason: resolution.reason } : {}) })
  return { ...applyWebSearch(assembled, resolution, resolution.kind === 'native' ? params : undefined), resolution }
}
