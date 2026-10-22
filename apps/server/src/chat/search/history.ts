// The history stage of web search (Phase 14, ADR-062, ARCHITECTURE.md 6.43). Signature written by C52 in P14-0b and
// FROZEN after Gate P14-0b; W14.4 implements it in P14-A. The call site is `modelStream` (`pipeline.ts`): the model
// history after `buildModelHistory` and `prepareModelFiles`, before `toolPartsAsText`.
// Provider-executed tool parts (`isProviderExecutedPart`: a native search call with its encrypted results) of an
// assistant message are kept only when that message's provider (`metadata.modelRef`, split on the first colon) is the
// current provider, which keeps Anthropic's encrypted search results and thought signatures intact; after a switch to
// another provider they are removed (another provider cannot read them). Function tool parts are never touched; the
// stored transcript is never changed (new message objects only where a part was removed).
// P14-0b stub: the identity (no turn has provider-executed parts before W14.4 offers native search).
import type { HarnessUIMessage } from '@harness-forge/shared'

/** `messages` without the provider-executed parts of other providers' replies (see the module comment). Never throws. */
export function stripForeignProviderParts(messages: readonly HarnessUIMessage[], _providerId: string): HarnessUIMessage[] {
  return [...messages]
}
