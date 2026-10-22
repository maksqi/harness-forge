// The sources of the builtin search tool (Phase 14, ADR-063, ARCHITECTURE.md 6.44). Signature written by C52 in P14-0b
// and FROZEN after Gate P14-0b; W14.5 implements it in P14-A. The call site is `modelStream` (`pipeline.ts`): the last
// transform of the run's UI stream, after `generatedFiles`, so what it adds reaches the saved message, share pages and
// exports like every other chunk.
// After each final (not preliminary) `tool-output-available` of `core-search`'s `search_web` (the call's tool name
// tracked from `tool-input-available` chunks and from the continued message's tool parts, like `storeGeneratedFiles`;
// the owner through `SourcesTransformOptions.toolOwner`), one `source-url` chunk per result URL (http(s) only,
// deduplicated by URL within the reply, the result title kept). A tool of that name from another plugin adds nothing.
// Search queries, titles and snippets are never logged.
// P14-0b stub: a pass-through (no `search_web` is registered before W14.5).
import type { HarnessUIMessageChunk } from '../generated-files.ts'
import type { SourcesTransformOptions } from './types.ts'

/** The sources transform of a run (see the module comment). */
export function createSourcesTransform(_options: SourcesTransformOptions): TransformStream<HarnessUIMessageChunk, HarnessUIMessageChunk> {
  return new TransformStream<HarnessUIMessageChunk, HarnessUIMessageChunk>()
}
