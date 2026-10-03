// Sub-agent outputs in the model history (Phase 9, ADR-043, ARCHITECTURE.md 6.18 step 3 / 6.22). Signature FROZEN after
// P9-0b (C26); the implementation is W9.5's.
//
// W9.5: `reduceAgentOutputs(messages)`, step 3 of `buildModelHistory` (`model-history.ts`): every stored `tool-task`
// part with an output keeps only `{ status, report }` of its `TaskOutput`, so the progress trace (steps, previews,
// usage) never reaches a model, also when the `task` tool is not offered in a later run. Messages without such parts
// are returned as the same objects.
//
// P9-0b stub: the identity.
import type { HarnessUIMessage } from '@harness-forge/shared'

/** The messages with stored sub-agent outputs reduced for the model (stub until W9.5: the identity). */
export function reduceAgentOutputs(messages: readonly HarnessUIMessage[]): HarnessUIMessage[] {
  return [...messages]
}
