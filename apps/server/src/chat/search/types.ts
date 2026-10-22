// Shared types of the web search modules of a turn (Phase 14, ADR-062 / ADR-063, ARCHITECTURE.md 6.43 / 6.44). Written
// by C52 in P14-0b and FROZEN after Gate P14-0b (open point 16: a change is a CCR):
// - `resolve.ts` (W14.4): `providerWebSearch` (the provider's `webSearch` hook, guarded) and `applyWebSearch` (the turn's
//   tool set with the resolution applied);
// - `history.ts` (W14.4): `stripForeignProviderParts` (the history stage before `toolPartsAsText`);
// - `sources.ts` (W14.5): `createSourcesTransform` (`source-url` chunks after each final `search_web` output);
// - `turn.ts` (C52, complete): `turnWebSearch`, the one call site of the resolver for a chat run (`pipeline.ts`) and a
//   sub-agent (`subagent/tools.ts`).
import type { ProviderOptions } from '@harness-forge/plugin-sdk'
import type { HarnessUIMessage, WebSearchResolution } from '@harness-forge/shared'
import type { ToolSet } from 'ai'
import type { Logger } from '../../logger.ts'
import type { ApprovalTool } from '../approval.ts'

/** The builtin plugin whose `search_web` is the builtin search tool (a tool of that name elsewhere is a plain tool). */
export const SEARCH_TOOL_PLUGIN_ID = 'core-search'

/**
 * The tools a turn assembled before web search is applied (`AssembledTools` of `tools.ts`, or a sub-agent's ceiling):
 * the AI SDK tool set, the tools by name (what the approval function sees) and the names the model may call.
 */
export interface WebSearchToolSet {
  readonly tools: ToolSet
  readonly byName: ReadonlyMap<string, ApprovalTool>
  /** The names the model may call (`streamText({ activeTools })`); absent = every tool of `tools`. */
  readonly activeTools?: readonly string[]
}

/**
 * The tools of a turn with its web search resolution applied (`applyWebSearch`):
 * - `native`: the provider's tools (`WebSearchParams.tools`, only `type: 'provider'` tools whose key no function tool
 *   takes) added to `tools`, their names in `nativeTools` and appended to `activeTools` when that list is set, the
 *   provider options returned for the caller to deep-merge; `search_web` of `core-search` removed;
 * - `builtin`: `search_web` of `core-search` kept, no provider tool, no provider option;
 * - `off` / `unavailable`: `search_web` of `core-search` removed, nothing added.
 * Native and builtin search are never in one result. `byName` never holds a native tool (the approval function answers
 * provider-executed native calls from `nativeTools`, `approval.ts`).
 */
export interface AppliedWebSearch {
  /** The AI SDK tool set of the turn (empty when no tool is sent). */
  readonly tools: ToolSet
  /** The function tools of the turn by name, for the approval function. */
  readonly byName: Map<string, ApprovalTool>
  /** The names the model may call; absent = every tool of `tools`. */
  readonly activeTools?: string[]
  /** The names of the provider-executed native search tools of the turn (`ToolApprovalContext.nativeTools`). */
  readonly nativeTools: ReadonlySet<string>
  /** Provider options of the native search (deep-merged over the run's by the caller); absent = none. */
  readonly providerOptions?: ProviderOptions
}

/** What `createSourcesTransform` needs (`sources.ts`, W14.5; the call site is `pipeline.ts`, after `generatedFiles`). */
export interface SourcesTransformOptions {
  /**
   * The owner plugin of a tool of the run by name (`AssembledTools.byName` before web search is applied, so an approval
   * continuation still recognizes `search_web`): only `core-search`'s `search_web` adds sources.
   */
  readonly toolOwner: (toolName: string) => string | undefined
  /** The continued message of an approval continuation: its tool parts seed the `toolCallId -> toolName` map. */
  readonly continued?: HarnessUIMessage | null
  readonly logger: Logger
}

/** The web search of one turn (`turnWebSearch`): the resolution and the tools with it applied. */
export interface TurnWebSearch extends AppliedWebSearch {
  /** The resolution the tools follow (an `unavailable` one is the notice `web-search-unavailable` of a chat run). */
  readonly resolution: WebSearchResolution
}
