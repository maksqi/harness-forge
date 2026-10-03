// Output trimming of the workspace tools (Phase 7, ADR-032): every stored output stays under
// `WORKSPACE_LIMITS.outputMaxBytes` of serialized JSON (60 KiB, below the 64 KB host cap that would replace it with a
// truncation marker). A list output keeps the longest prefix of its items that fits.
import { WORKSPACE_LIMITS } from '@harness-forge/shared'
import { jsonBytes } from './text.ts'

/**
 * The longest prefix of `items` such that `base` (the output with the list empty) plus the items serializes to at most
 * `maxBytes`. `cut` is true when items were dropped.
 */
export function fitItems<T>(base: unknown, items: readonly T[], maxBytes: number = WORKSPACE_LIMITS.outputMaxBytes): { kept: T[], cut: boolean } {
  let bytes = jsonBytes(base)
  for (let index = 0; index < items.length; index++) {
    bytes += jsonBytes(items[index]) + (index === 0 ? 0 : 1)
    if (bytes > maxBytes)
      return { kept: items.slice(0, index), cut: true }
  }
  return { kept: [...items], cut: false }
}

/**
 * The longest prefix of `lines` such that `base` (the output with an empty text) plus the lines joined with `\n` as one
 * JSON string serializes to at most `maxBytes`.
 */
export function fitLines(base: unknown, lines: readonly string[], maxBytes: number = WORKSPACE_LIMITS.outputMaxBytes): { kept: string[], cut: boolean } {
  let bytes = jsonBytes(base)
  for (let index = 0; index < lines.length; index++) {
    // The escaped line without its quotes, plus the escaped `\n` before it.
    bytes += jsonBytes(lines[index]) - 2 + (index === 0 ? 0 : 2)
    if (bytes > maxBytes)
      return { kept: lines.slice(0, index), cut: true }
  }
  return { kept: [...lines], cut: false }
}
