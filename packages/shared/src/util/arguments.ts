/**
 * Command arguments (Phase 10, ADR-045): `$ARGUMENTS` = the whole input, `$1` … `$9` = whitespace-split words (double
 * and single quotes group words), `{{input}}` = the whole input (template compatibility). Without any placeholder the
 * input is appended after a blank line (the `expandTemplate` rule of `apps/server/src/chat/commands.ts`). `!` lines and
 * `@file` references stay plain text. Pure and isomorphic; never throws.
 *
 * Phase 12 (ADR-058, C42): with `options`, `expandArguments` also reads Claude Code's newer placeholders:
 * `$ARGUMENTS[N]` and `$N` relative to the argument base (Claude Code counts from 0, Phase 10 counted `$1` as the first
 * word: `argumentBase` keeps every earlier template's meaning), `$name` for the names of an `arguments` list, `\$` for a
 * literal `$`, and `${NAME}` variables (`CLAUDE_SKILL_DIR`, `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, plugin variables)
 * from `options.vars` (unknown ones stay as written). Without `options` the Phase 10 behavior is unchanged.
 */

export interface ExpandedArguments {
  readonly text: string
  /** True when the body contained at least one placeholder. */
  readonly usedPlaceholder: boolean
}

export interface ExpandArgumentsOptions {
  /** The `arguments` names of the definition (`$name` = the word at that position, counted from the first word). */
  readonly names?: readonly string[]
  /** The index `$0` / `$ARGUMENTS[0]` stands for: 0 (Claude Code) or 1 (Phase 10); default `argumentBase(body, names)`. */
  readonly base?: 0 | 1
  /** `${NAME}` values (`CLAUDE_SKILL_DIR`, `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, `CLAUDE_PLUGIN_ROOT`, …). */
  readonly vars?: Readonly<Record<string, string>>
}

/** `$ARGUMENTS`, `{{input}}`, and `$1` … `$9` when no other digit follows (`$10` stays text). */
const PLACEHOLDER = /\$ARGUMENTS|\{\{input\}\}|\$([1-9])(?!\d)/g
/**
 * Phase 12 placeholders, in priority order: an escaped `$`, `$ARGUMENTS[N]`, `$ARGUMENTS`, `{{input}}`, `${NAME}`,
 * `$N` (one digit), `$name` (a lowercase name not followed by a name character).
 */
const EXTENDED_PLACEHOLDER = /\\\$|\$ARGUMENTS\[(\d{1,4})\]|\$ARGUMENTS|\{\{input\}\}|\$\{([A-Z_a-z]\w{0,63}(?:\.[\w-]{1,64})?)\}|\$(\d)(?!\d)|\$([a-z_][\da-z_]{0,31})\b/g
/** `$0` (not escaped, no digit after it) or `$ARGUMENTS[`: the body counts arguments from 0. */
const ZERO_BASED = /(?<!\\)\$0(?!\d)|(?<!\\)\$ARGUMENTS\[/
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
 * The argument base of a body (Phase 12, ADR-058): 0 when it uses `$0` or `$ARGUMENTS[` or the definition declares
 * named `arguments` (Claude Code counting: `$0` is the first word); otherwise 1 (Phase 10: `$1` is the first word), so
 * every v1.6 / v1.7 template keeps its meaning.
 */
export function argumentBase(body: string, names?: readonly string[] | null): 0 | 1 {
  if (Array.isArray(names) && names.length > 0)
    return 0
  return typeof body === 'string' && ZERO_BASED.test(body) ? 0 : 1
}

/**
 * Expands the placeholders of a command body in one pass (an argument that contains a placeholder stays as typed):
 * `$ARGUMENTS` and `{{input}}` become the trimmed input, `$1` … `$9` the words of `splitArguments` (`''` past the
 * last word). A body without placeholders gets the trimmed input appended after a blank line (nothing when the input
 * is empty). With `options` (Phase 12): `$ARGUMENTS[N]` and `$N` are the word `N - base` (`''` past the last word; a
 * negative index stays as written, so `$0` of a 1-based body is text), `$name` the word at the name's position (a name
 * that is not declared stays as written), `\$` a literal `$`, `${NAME}` the value of `options.vars` (unknown names
 * stay as written). Variables and escapes are no placeholders (a body with only those still gets the input appended).
 */
export function expandArguments(body: string, input: string, options?: ExpandArgumentsOptions): ExpandedArguments {
  const template = typeof body === 'string' ? body : ''
  const trimmed = typeof input === 'string' ? input.trim() : ''
  let words: string[] | null = null
  const word = (index: number): string => {
    words ??= splitArguments(trimmed)
    return words[index] ?? ''
  }
  let usedPlaceholder = false
  let text: string
  if (options === undefined || options === null || typeof options !== 'object') {
    text = template.replace(PLACEHOLDER, (_match: string, digit: string | undefined) => {
      usedPlaceholder = true
      return digit === undefined ? trimmed : word(Number(digit) - 1)
    })
  }
  else {
    const names = Array.isArray(options.names) ? options.names.filter((name): name is string => typeof name === 'string') : []
    const base = options.base === 0 || options.base === 1 ? options.base : argumentBase(template, names)
    const vars = typeof options.vars === 'object' && options.vars !== null ? options.vars : {}
    const positional = (match: string, index: number): string => {
      if (index < 0)
        return match
      usedPlaceholder = true
      return word(index)
    }
    text = template.replace(EXTENDED_PLACEHOLDER, (match: string, indexed: string | undefined, variable: string | undefined, digit: string | undefined, name: string | undefined) => {
      if (match === '\\$')
        return '$'
      if (indexed !== undefined)
        return positional(match, Number(indexed) - base)
      if (variable !== undefined) {
        const value = Object.hasOwn(vars, variable) ? vars[variable] : undefined
        return typeof value === 'string' ? value : match
      }
      if (digit !== undefined)
        return positional(match, Number(digit) - base)
      if (name !== undefined) {
        const position = names.indexOf(name)
        return position === -1 ? match : positional(match, position)
      }
      usedPlaceholder = true
      return trimmed
    })
  }
  if (usedPlaceholder)
    return { text, usedPlaceholder }
  return { text: trimmed === '' ? text : `${text}\n\n${trimmed}`, usedPlaceholder }
}
