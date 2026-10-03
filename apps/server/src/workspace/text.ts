// Small text helpers of the workspace tools (Phase 7, ADR-032): line counting, line cutting and the plural forms of the
// model texts.
import { Buffer } from 'node:buffer'

/** The byte order mark kept by edits. */
export const BOM = '\uFEFF'

/**
 * Lines of a text: the number of `\n` plus one for a last line without a newline (`''` has 0 lines, `'a\n'` 1,
 * `'a\nb'` 2).
 */
export function countLines(text: string): number {
  if (text === '')
    return 0
  let lines = 0
  let index = text.indexOf('\n')
  while (index !== -1) {
    lines++
    index = text.indexOf('\n', index + 1)
  }
  return text.endsWith('\n') ? lines : lines + 1
}

/** The first `maxChars` UTF-16 code units of `line`, never splitting a surrogate pair. */
export function cutLine(line: string, maxChars: number): string {
  if (line.length <= maxChars)
    return line
  let end = maxChars
  const code = line.charCodeAt(end - 1)
  if (code >= 0xD800 && code <= 0xDBFF)
    end--
  return line.slice(0, end)
}

/** UTF-8 bytes of `text`. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** UTF-8 bytes of `value` serialized as JSON. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
}

/** `1 line`, `2 lines`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}
