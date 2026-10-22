// The history stage of web search (Phase 14, ADR-062, ARCHITECTURE.md 6.43). Signature written by C52 in P14-0b and
// FROZEN after Gate P14-0b; W14.4 implemented it in P14-A. The call site is `modelStream` (`pipeline.ts`): the model
// history after `buildModelHistory` and `prepareModelFiles`, before `toolPartsAsText`.
// Provider-executed tool parts (`isProviderExecutedPart`: a native search call with its encrypted results, also a
// provider's dynamic server-tool part) of an assistant message are kept only when that message's provider
// (`metadata.modelRef`, split on the first colon) is the current provider, which keeps Anthropic's encrypted search
// results and thought signatures intact; after a switch to another provider they are removed (another provider cannot
// read them), and so are those of an assistant message without a model ref (its provider is unknown). Function tool
// parts, text, reasoning, sources and every user message are never touched; the stored transcript is never changed (a
// new message object only where a part was removed, every other message is passed through as it is).
import type { HarnessUIMessage } from '@harness-forge/shared'
import { isProviderExecutedPart } from '@harness-forge/shared'

/** The provider id of a model ref (`providerId:modelId`, split on the first colon), or null when there is none. */
function providerOf(message: HarnessUIMessage): string | null {
  const modelRef: unknown = message.metadata?.modelRef
  if (typeof modelRef !== 'string')
    return null
  const colon = modelRef.indexOf(':')
  return colon > 0 ? modelRef.slice(0, colon) : null
}

/** `messages` without the provider-executed parts of other providers' replies (see the module comment). Never throws. */
export function stripForeignProviderParts(messages: readonly HarnessUIMessage[], providerId: string): HarnessUIMessage[] {
  return messages.map((message) => {
    try {
      if (message.role !== 'assistant' || !message.parts.some(part => isProviderExecutedPart(part)))
        return message
      if (providerOf(message) === providerId)
        return message
      return { ...message, parts: message.parts.filter(part => !isProviderExecutedPart(part)) }
    }
    catch {
      return message
    }
  })
}
