/**
 * Command arguments (Phase 10, ADR-045): `$ARGUMENTS` = the whole input, `$1` … `$9` = whitespace-split words (double
 * and single quotes group words), `{{input}}` = the whole input (template compatibility). Without any placeholder the
 * input is appended after a blank line (the `expandTemplate` rule of `apps/server/src/chat/commands.ts`). `!` lines and
 * `@file` references stay plain text. Pure and isomorphic; never throws.
 */

export interface ExpandedArguments {
  readonly text: string
  /** True when the body contained at least one placeholder. */
  readonly usedPlaceholder: boolean
}

/** `$ARGUMENTS`, `{{input}}`, and `$1` … `$9` when no other digit follows (`$10` stays text). */
const PLACEHOLDER = /\$ARGUMENTS|\{\{input\}\}|\$([1-9])(?!\d)/g
const WHITESPACE = /\s/u

/**
 * Splits the input into words: whitespace separates words; `"…"` and `'…'` group characters into a word (the quotes
 * are removed, `""` is an empty word, `a"b c"` is one word `ab c`); an unclosed quote takes the rest of the input.
 * There are no escapes. Never throws.
 */
export function splitArguments(input: string): string[] {
  const words: string[] = []
  if (typeof input !== 'string')
    return words
  let current = ''
  let started = false
  let quote: string | null = null
  for (const char of input) {
    if (quote !== null) {
      if (char === quote)
        quote = null
      else
        current += char
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      started = true
      continue
    }
    if (WHITESPACE.test(char)) {
      if (started) {
        words.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started)
    words.push(current)
  return words
}

/**
 * Expands the placeholders of a command body in one pass (an argument that contains a placeholder stays as typed):
 * `$ARGUMENTS` and `{{input}}` become the trimmed input, `$1` … `$9` the words of `splitArguments` (`''` past the
 * last word). A body without placeholders gets the trimmed input appended after a blank line (nothing when the input
 * is empty).
 */
export function expandArguments(body: string, input: string): ExpandedArguments {
  const template = typeof body === 'string' ? body : ''
  const trimmed = typeof input === 'string' ? input.trim() : ''
  let words: string[] | null = null
  let usedPlaceholder = false
  const text = template.replace(PLACEHOLDER, (_match: string, digit: string | undefined) => {
    usedPlaceholder = true
    if (digit === undefined)
      return trimmed
    words ??= splitArguments(trimmed)
    return words[Number(digit) - 1] ?? ''
  })
  if (usedPlaceholder)
    return { text, usedPlaceholder }
  return { text: trimmed === '' ? template : `${template}\n\n${trimmed}`, usedPlaceholder }
}
