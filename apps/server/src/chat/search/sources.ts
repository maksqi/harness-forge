// The sources of the builtin search tool (Phase 14, ADR-063, ARCHITECTURE.md 6.44). Signature written by C52 in P14-0b
// and FROZEN after Gate P14-0b; W14.5 implemented it in P14-A. The call site is `modelStream` (`pipeline.ts`): the last
// transform of the run's UI stream, after `generatedFiles`, so what it adds reaches the saved message, share pages and
// exports like every other chunk.
// After each final (not preliminary) `tool-output-available` of `core-search`'s `search_web` (the call's tool name
// tracked from `tool-input-available` chunks and from the continued message's tool parts, like `storeGeneratedFiles`;
// the owner through `SourcesTransformOptions.toolOwner`), one `source-url` chunk per result URL (http(s) only,
// deduplicated by URL within the reply, the result title kept). A tool of that name from another plugin adds nothing.
// Search queries, titles and snippets are never logged.
// Details (W14.5): "within the reply" covers the continued message's `source-url` parts and every `source-url` chunk
// of the stream (a provider's own sources included); each result is checked on its own with `searchWebResultSchema`
// (a result that does not pass is skipped, the others still count); a dynamic, provider-executed or preliminary output
// adds nothing. The `sourceId` is `search-` + the first 24 hex digits of the URL's sha256 (stable across a resume
// replay, at most 64 characters like a share snapshot's).
import type { HarnessUIMessageChunk } from '../generated-files.ts'
import type { SourcesTransformOptions } from './types.ts'
import { createHash } from 'node:crypto'
import { SEARCH_WEB_TOOL_NAME, searchWebResultSchema } from '@harness-forge/shared'
import { toolNamesOf } from '../generated-files.ts'
import { SEARCH_TOOL_PLUGIN_ID } from './types.ts'

type ToolOutputChunk = Extract<HarnessUIMessageChunk, { type: 'tool-output-available' }>

/** The `sourceId` of a search result's `source-url` part. */
export function searchSourceId(url: string): string {
  return `search-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`
}

/** The results of a `search_web` output that are valid sources (each checked on its own), in order. */
export function searchOutputSources(output: unknown): Array<{ url: string, title: string }> {
  const results = typeof output === 'object' && output !== null && !Array.isArray(output) ? (output as { results?: unknown }).results : undefined
  if (!Array.isArray(results))
    return []
  return results.flatMap((entry: unknown) => {
    const result = searchWebResultSchema.safeParse(entry)
    return result.success ? [{ url: result.data.url, title: result.data.title }] : []
  })
}

/** The sources transform of a run (see the module comment). */
export function createSourcesTransform(options: SourcesTransformOptions): TransformStream<HarnessUIMessageChunk, HarnessUIMessageChunk> {
  const toolNames = toolNamesOf(options.continued)
  const seen = new Set<string>()
  for (const part of options.continued?.parts ?? []) {
    if (part.type === 'source-url' && typeof part.url === 'string')
      seen.add(part.url)
  }

  function isSearchOutput(chunk: ToolOutputChunk): boolean {
    if (chunk.preliminary === true || chunk.dynamic === true || chunk.providerExecuted === true)
      return false
    return toolNames.get(chunk.toolCallId) === SEARCH_WEB_TOOL_NAME && options.toolOwner(SEARCH_WEB_TOOL_NAME) === SEARCH_TOOL_PLUGIN_ID
  }

  function sourcesOf(chunk: ToolOutputChunk): HarnessUIMessageChunk[] {
    if (!isSearchOutput(chunk))
      return []
    const chunks: HarnessUIMessageChunk[] = []
    for (const source of searchOutputSources(chunk.output)) {
      if (seen.has(source.url))
        continue
      seen.add(source.url)
      chunks.push({ type: 'source-url', sourceId: searchSourceId(source.url), url: source.url, ...(source.title === '' ? {} : { title: source.title }) })
    }
    return chunks
  }

  return new TransformStream<HarnessUIMessageChunk, HarnessUIMessageChunk>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      try {
        switch (chunk.type) {
          case 'tool-input-start':
          case 'tool-input-available':
          case 'tool-input-error':
            toolNames.set(chunk.toolCallId, chunk.toolName)
            break
          case 'source-url':
            seen.add(chunk.url)
            break
          case 'tool-output-available':
            for (const source of sourcesOf(chunk))
              controller.enqueue(source)
            break
          default:
            break
        }
      }
      catch (error) {
        options.logger.warn('the sources of a web search were not added', { err: error })
      }
    },
  })
}
