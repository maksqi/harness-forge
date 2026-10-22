// The resolution helpers of a turn's web search (Phase 14, ADR-062 / ADR-063, ARCHITECTURE.md 6.43). Signatures written
// by C52 in P14-0b and FROZEN after Gate P14-0b; W14.4 implements behind them in P14-A. The call site is `turnWebSearch`
// (`turn.ts`), used by the chat pipeline and by sub-agents.
// - `providerWebSearch(resolved, request, logger)`: the provider's `ProviderDefinition.webSearch(model, request)` hook,
//   synchronous and guarded like `providerReasoning` (`params.ts`: a throw or an invalid answer is ignored with a
//   warning). P14-0b stub: undefined (no provider offers native search yet, so every turn resolves without it).
// - `applyWebSearch(assembled, resolution, params)`: the turn's tool set with the resolution applied
//   (`AppliedWebSearch`, `types.ts`). P14-0b baseline (complete enough for the seams; W14.4 adds the validation of the
//   hook's answer and its diagnostics): `native` adds the `type: 'provider'` tools of `params.tools` whose keys no other
//   tool of the turn takes (their names in `nativeTools`, appended to `activeTools` when that list is set) and passes
//   `params.providerOptions` on; `search_web` of `core-search` stays only for `builtin`. Never adds a function tool.
import type { WebSearchParams, WebSearchRequest } from '@harness-forge/plugin-sdk'
import type { WebSearchResolution } from '@harness-forge/shared'
import type { Tool, ToolSet } from 'ai'
import type { Logger } from '../../logger.ts'
import type { ResolvedModelBase } from '../../providers/types.ts'
import type { ApprovalTool } from '../approval.ts'
import type { AppliedWebSearch, WebSearchToolSet } from './types.ts'
import { SEARCH_WEB_TOOL_NAME } from '@harness-forge/shared'
import { SEARCH_TOOL_PLUGIN_ID } from './types.ts'

/**
 * The provider's native search additions for one turn (`ProviderDefinition.webSearch(resolved.info, request)`), or
 * undefined when the provider has none for the model, the hook throws or answers something invalid. Never throws.
 * P14-0b stub: undefined (W14.4).
 */
export function providerWebSearch(_resolved: ResolvedModelBase, _request: WebSearchRequest, _logger: Logger): WebSearchParams | undefined {
  return undefined
}

/** `core-search`'s `search_web` (recognized by owner and name; a tool of that name from another plugin is a plain tool). */
export function isBuiltinSearchTool(name: string, tool: Pick<ApprovalTool, 'pluginId'> | undefined): boolean {
  return name === SEARCH_WEB_TOOL_NAME && tool?.pluginId === SEARCH_TOOL_PLUGIN_ID
}

/** A provider-defined tool (`type: 'provider'`), the only kind a native search may add. */
export function isProviderTool(tool: unknown): tool is Tool {
  return typeof tool === 'object' && tool !== null && (tool as { type?: unknown }).type === 'provider'
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
      for (const [name, tool] of Object.entries(params.tools ?? {})) {
        if (Object.hasOwn(tools, name) || byName.has(name) || !isProviderTool(tool))
          continue
        tools[name] = tool
        nativeTools.add(name)
      }
      if (typeof params.providerOptions === 'object' && params.providerOptions !== null)
        providerOptions = params.providerOptions
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
