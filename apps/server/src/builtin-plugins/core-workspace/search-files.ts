// The `search_files` tool of `core-workspace` (ADR-032; policy `safe`, access `read`, timeout 60 s): lines of the project
// files that match a JavaScript regular expression (or plain text with `literal`; case-sensitive unless
// `case_sensitive` is false).
//
// 1. The pattern's syntax is checked on the main thread (`compileSearchRegex`), the optional `glob` compiled
//    (`compileGlob`, the `find_files` rules);
// 2. `path` (default `.`) resolves through the frozen path guard: a folder is walked (`walkWorkspace`: `.git` always
//    skipped, `node_modules` and gitignored paths unless `include_ignored`), a single file is searched alone;
// 3. secret-looking files (`workspace/sensitive.ts`, also a link to one) are never read, even with `include_ignored`
//    (a single secret-looking file named in `path` is refused); files over 1 MiB and files whose first 8 KiB do not
//    look like text are skipped; every file opens through the frozen `openWorkspaceFile`;
// 4. the glob filter and the matching run in the pattern Worker (`workspace/pattern-worker.ts`), terminated after
//    20 s with "The search timed out — use a simpler pattern or a narrower path.", so `(a+)+$` on a long line never
//    blocks the event loop.
//
// The output has at most `max_results` matches (default 100, at most 500) in walk order; `truncated` when more lines
// matched, the walk stopped early or the read budget ran out. The model sees `path:line: text` lines.
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { SearchFilesMatch, SearchFilesToolInput, SearchFilesToolOutput } from '@harness-forge/shared'
import type { PatternWorkerText } from '../../workspace/pattern-worker.ts'
import { Buffer } from 'node:buffer'
import { lstat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { searchFilesToolInputSchema, searchFilesToolOutputSchema, WORKSPACE_LIMITS, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { looksLikeText } from '../../plugins/scaffold/paths.ts'
import { openWorkspaceFile, resolveWorkspacePath, workspacePathError } from '../../workspace/paths.ts'
import { compileGlob, compileSearchRegex, startPatternWorker } from '../../workspace/pattern-worker.ts'
import { baseNameOf, isSecretLookingPath } from '../../workspace/sensitive.ts'
import { plural } from '../../workspace/text.ts'
import { fitItems } from '../../workspace/trim.ts'
import { walkWorkspace } from '../../workspace/walk.ts'
import { requireWorkspace, SEARCH_TOOL_TIMEOUT_MS, textModelOutput } from './common.ts'
import { TEXT_SNIFF_BYTES } from './read-file.ts'

export const SEARCH_FILES_TOOL_NAME = 'search_files'

/** Files read at the same time. */
const READ_CONCURRENCY = 8
/** A batch goes to the Worker once it holds this many characters or files. */
const BATCH_CHARS = 2_097_152
const BATCH_FILES = 256
/** Reading stops after this long (`truncated`), well inside the 60 s guard. */
export const SEARCH_READ_BUDGET_MS = 30_000

export interface SearchFilesToolOptions {
  /** The pattern Worker's timeout (tests); default `SEARCH_WORKER_TIMEOUT_MS`. */
  workerTimeoutMs?: number
}

/** A file to search: project-relative and relative to the searched folder (for the glob). */
interface Candidate {
  rel: string
  fromStart: string
}

/**
 * The text of a file to search, or null when it is skipped: gone, not a regular file, over
 * `WORKSPACE_LIMITS.searchFileMaxBytes`, a link to a secret-looking file, or not text.
 */
async function readSearchText(root: string, rel: string): Promise<PatternWorkerText | null> {
  let opened
  try {
    opened = await openWorkspaceFile(root, rel)
  }
  catch {
    return null
  }
  const { resolved, handle, stats } = opened
  try {
    const maxBytes = WORKSPACE_LIMITS.searchFileMaxBytes
    if (stats.size > maxBytes || isSecretLookingPath(resolved.rel))
      return null
    // One byte more than the size tells a file that grew past the cap.
    const buffer = Buffer.alloc(Math.min(stats.size, maxBytes) + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0)
        break
      length += bytesRead
      if (length === buffer.length)
        break
    }
    if (length > maxBytes)
      return null
    const bytes = buffer.subarray(0, length)
    if (!looksLikeText(bytes.subarray(0, TEXT_SNIFF_BYTES)))
      return null
    return { path: rel, text: new TextDecoder('utf-8').decode(bytes) }
  }
  catch {
    return null
  }
  finally {
    await handle.close()
  }
}

/** The text the model sees for a `search_files` output. */
export function searchFilesModelText(output: SearchFilesToolOutput): string {
  if (output.matches.length === 0) {
    const searched = `${plural(output.filesSearched, 'file')} searched`
    return output.truncated ? `No matches (${searched}; the search stopped early, narrow the path).` : `No matches (${searched}).`
  }
  const lines = output.matches.map(match => `${match.path}:${match.line}: ${match.text}`)
  if (output.truncated)
    lines.push(`[truncated: showing ${plural(output.matches.length, 'match', 'matches')}; narrow the pattern, the glob or the path]`)
  return lines.join('\n')
}

export function createSearchFilesTool(options: SearchFilesToolOptions = {}): ToolDefinition<SearchFilesToolInput, SearchFilesToolOutput> {
  return {
    name: SEARCH_FILES_TOOL_NAME,
    description: 'Search the contents of the project files with a JavaScript regular expression (or plain text with literal: true; case-sensitive unless case_sensitive is false). Returns matching lines as "path:line: text". Narrow it with glob and path; .git, node_modules, gitignored, very large and secret-looking files are skipped.',
    inputSchema: searchFilesToolInputSchema,
    policy: 'safe',
    timeoutMs: SEARCH_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.search_files,
    async execute(input, c) {
      const startedAt = performance.now()
      const { root } = requireWorkspace(c)
      const regex = compileSearchRegex(input.pattern, { literal: input.literal === true, caseSensitive: input.case_sensitive !== false })
      const glob = input.glob === undefined ? null : compileGlob(input.glob, 'glob')
      const maxResults = input.max_results ?? WORKSPACE_LIMITS.searchDefaultResults

      const resolved = await resolveWorkspacePath(root, input.path ?? '.')
      const stats = await lstat(resolved.absolute)
      let candidates: Candidate[]
      let truncated = false
      if (stats.isDirectory()) {
        const walk = await walkWorkspace({ root, start: resolved.absolute, includeIgnored: input.include_ignored === true, signal: c.signal })
        candidates = walk.files.filter(file => !isSecretLookingPath(file.rel))
        truncated = walk.truncated
      }
      else if (stats.isFile()) {
        if (isSecretLookingPath(resolved.rel))
          throw workspacePathError(`"${resolved.rel}" looks like a secret file: search_files does not read it (read_file asks first).`)
        candidates = [{ rel: resolved.rel, fromStart: baseNameOf(resolved.rel) }]
      }
      else {
        throw workspacePathError(`"${resolved.rel}" is not a regular file or folder.`)
      }

      const matches: SearchFilesMatch[] = []
      let filesSearched = 0
      if (candidates.length > 0) {
        const worker = startPatternWorker({ glob, regex, signal: c.signal, timeoutMs: options.workerTimeoutMs })
        try {
          if (glob !== null) {
            const keep = await worker.filterPaths(candidates.map(file => file.fromStart))
            candidates = keep.map(index => candidates[index]!)
          }
          let batch: PatternWorkerText[] = []
          let batchChars = 0
          const flush = async (): Promise<void> => {
            if (batch.length === 0)
              return
            // One more than needed tells whether more lines match.
            const found = await worker.searchTexts(batch, maxResults - matches.length + 1)
            matches.push(...found)
            batch = []
            batchChars = 0
          }
          for (let index = 0; index < candidates.length && matches.length <= maxResults; index += READ_CONCURRENCY) {
            c.signal.throwIfAborted()
            if (performance.now() - startedAt > SEARCH_READ_BUDGET_MS) {
              truncated = true
              break
            }
            const texts = await Promise.all(candidates.slice(index, index + READ_CONCURRENCY).map(file => readSearchText(root, file.rel)))
            for (const text of texts) {
              if (text === null)
                continue
              batch.push(text)
              batchChars += text.text.length
              filesSearched++
            }
            if (batchChars >= BATCH_CHARS || batch.length >= BATCH_FILES)
              await flush()
          }
          if (matches.length <= maxResults)
            await flush()
        }
        finally {
          await worker.close()
        }
      }
      if (matches.length > maxResults) {
        truncated = true
        matches.length = maxResults
      }
      const base: SearchFilesToolOutput = { pattern: input.pattern, matches: [], filesSearched, truncated: true }
      const { kept, cut } = fitItems(base, matches)
      return { pattern: input.pattern, matches: kept, filesSearched, truncated: truncated || cut }
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(searchFilesToolOutputSchema, output, searchFilesModelText)
    },
  }
}
