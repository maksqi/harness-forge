/**
 * MCP prompts as slash commands (Phase 14, ADR-061): the command name of an MCP prompt (`/mcp__<serverId>__<prompt>`,
 * like Claude Code; sanitized and capped like `mcpToolName`), its argument hint, and how the text after the command
 * binds to the prompt's declared arguments. Pure and isomorphic; never throws.
 * Contract skeleton written by the coordinator in P14-0a; implemented by C49. Adding members is fine; renaming or
 * removing one is a CCR.
 *
 * Declared arguments: the first `MCP_PROMPT_ARGUMENTS_MAX` entries of the prompt's list; an entry without a non-empty
 * string `name`, or with the name of an earlier entry, is left out (the hint and the binding read the same list).
 *
 * Binding (`bindMcpPromptArguments`): words are split like a shell would split plain words (double and single quotes
 * group, no escapes beyond `\"` inside double quotes); a word `name=value` whose `name` is a declared argument binds by
 * name; the other words bind positionally to the remaining arguments in declared order; the last declared argument
 * takes the rest of the line (its words joined by one space). Missing required arguments are reported (the server
 * answers with a `failed` command reply); extra words beyond the arguments are joined into the last one.
 * Precisely (C49):
 * - Words: whitespace (JavaScript `\s`) separates words; `"…"` and `'…'` group characters (the quotes are removed, `""`
 *   is an empty word, `a"b c"` is one word `ab c`); inside double quotes `\"` is a literal `"` (every other backslash is
 *   literal); an unclosed quote takes the rest of the input. Only the first `MCP_PROMPT_INPUT_MAX_CHARS` characters of
 *   the input are read.
 * - By name: a word binds by name when the text before its first `=` is unquoted and is the name of a declared argument
 *   (`title="Fix the bug"` binds `title`; `"title=x"`, `x=y` with no argument `x`, and `=y` are plain positional words).
 *   When a name is given twice, the last value wins.
 * - Positionally: the positional words fill the arguments not given by name, in declared order; the last of them takes
 *   every remaining word (joined by one space). An empty word (`""`) fills its argument with nothing, so it skips an
 *   optional argument. When every argument was given by name, each remaining word is appended (after one space) to the
 *   argument named last before it, or to the last declared argument when no `name=value` word precedes it.
 * - Values: cut to `MCP_PROMPT_ARGUMENT_VALUE_MAX_CHARS` characters (never inside a surrogate pair); an empty value
 *   counts as not given, so `values` holds non-empty strings only. A required argument without a value is `missing`
 *   (declared order). A prompt without arguments ignores the input.
 */
import { MCP_SERVER_ID_PATTERN, mcpToolName } from '../ids.ts'

/** Prefix of every MCP prompt command name. */
export const MCP_PROMPT_PREFIX = 'mcp__'

/** An MCP prompt command name (without the leading `/`): `mcp__` + 1..59 characters of `[A-Za-z0-9_-]`. */
export const MCP_PROMPT_NAME_PATTERN = /^mcp__[\w-]{1,59}$/

/** Most arguments one prompt may declare (more are ignored with a diagnostic on the server). */
export const MCP_PROMPT_ARGUMENTS_MAX = 20

/**
 * Longest argument hint: the cap of every other argument hint (`DEFINITION_LIMITS.argumentHintMaxChars`, the
 * `commandSummarySchema.argumentHint` maximum).
 */
export const MCP_PROMPT_ARGUMENT_HINT_MAX_CHARS = 100

/** Longest value one argument binds (longer values are cut). */
export const MCP_PROMPT_ARGUMENT_VALUE_MAX_CHARS = 16_384

/** Characters of the input `bindMcpPromptArguments` reads (the rest is ignored). */
export const MCP_PROMPT_INPUT_MAX_CHARS = 65_536

export interface McpPromptArgument {
  readonly name: string
  readonly description?: string | null
  readonly required?: boolean
}

export type McpPromptBinding
  = | { readonly ok: true, readonly values: Readonly<Record<string, string>> }
    | { readonly ok: false, readonly missing: readonly string[] }

/** Characters of one argument name in the hint (a longer name ends in `…`). */
const HINT_NAME_MAX_CHARS = 32
const WHITESPACE = /\s/u

/** The command name of a prompt (`mcp__<serverId>__<prompt>`, sanitized and ≤ 64 characters, see `mcpToolName`). */
export function mcpPromptCommandName(serverId: string, promptName: string): string {
  return mcpToolName(serverId, promptName)
}

/** True for a name of the MCP prompt command shape (`MCP_PROMPT_NAME_PATTERN`). */
export function isMcpPromptCommandName(name: string): boolean {
  return typeof name === 'string' && MCP_PROMPT_NAME_PATTERN.test(name)
}

/**
 * The server id of an MCP prompt command name (`mcp__<serverId>__…`), or null. Server ids hold no `_`, so the id ends
 * at the first `__` after the prefix; a name built by `mcpPromptCommandName` always keeps its whole server id (even a
 * shortened one: the id ends within the first 39 characters). The server still compares the full name with
 * `mcpPromptCommandName(serverId, prompt.name)` of that server's prompts.
 */
export function mcpPromptServerId(name: string): string | null {
  if (!isMcpPromptCommandName(name))
    return null
  const rest = name.slice(MCP_PROMPT_PREFIX.length)
  const end = rest.indexOf('__')
  if (end <= 0)
    return null
  const serverId = rest.slice(0, end)
  return MCP_SERVER_ID_PATTERN.test(serverId) ? serverId : null
}

interface DeclaredArgument {
  readonly name: string
  readonly required: boolean
}

/** The declared arguments (see the module comment): first `MCP_PROMPT_ARGUMENTS_MAX` entries, usable names, no duplicates. */
function declaredArguments(args: unknown): DeclaredArgument[] {
  const result: DeclaredArgument[] = []
  try {
    if (!Array.isArray(args))
      return result
    const seen = new Set<string>()
    for (const entry of (args as readonly unknown[]).slice(0, MCP_PROMPT_ARGUMENTS_MAX)) {
      try {
        if (typeof entry !== 'object' || entry === null)
          continue
        const { name, required } = entry as { name?: unknown, required?: unknown }
        if (typeof name !== 'string' || name === '' || seen.has(name))
          continue
        seen.add(name)
        result.push({ name, required: required === true })
      }
      catch {
        // A throwing getter: the entry is left out.
      }
    }
  }
  catch {
    // A hostile list (a throwing proxy): the entries read so far.
  }
  return result
}

/** `text` cut to at most `max` UTF-16 code units, never inside a surrogate pair. */
function cutText(text: string, max: number): string {
  if (text.length <= max)
    return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xD800 && code <= 0xDBFF ? max - 1 : max)
}

/** A name for the hint: blanks and brackets become `_`, no control or format characters, ≤ 32 characters. */
function displayName(name: string, position: number): string {
  const text = name
    .replace(/[\s<>[\]]+/gu, '_')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
  if (text === '')
    return `arg${position}`
  const characters = Array.from(text)
  return characters.length <= HINT_NAME_MAX_CHARS ? text : `${characters.slice(0, HINT_NAME_MAX_CHARS - 1).join('')}…`
}

/**
 * The argument hint shown as ghost text: `<required> [optional]` in declared order, or null without arguments. Names
 * are sanitized for display (blanks and `<>[]` replaced by `_`, control and format characters dropped, ≤ 32
 * characters, `arg<N>` when nothing is left); a hint longer than `MCP_PROMPT_ARGUMENT_HINT_MAX_CHARS` keeps its first
 * whole items and ends in ` …`. Never throws.
 */
export function mcpPromptArgumentHint(args: readonly McpPromptArgument[]): string | null {
  const declared = declaredArguments(args)
  if (declared.length === 0)
    return null
  const items = declared.map((arg, index) => {
    const name = displayName(arg.name, index + 1)
    return arg.required ? `<${name}>` : `[${name}]`
  })
  const full = items.join(' ')
  if (full.length <= MCP_PROMPT_ARGUMENT_HINT_MAX_CHARS)
    return full
  const suffix = ' …'
  let hint = items[0] as string
  for (const item of items.slice(1)) {
    if (hint.length + 1 + item.length + suffix.length > MCP_PROMPT_ARGUMENT_HINT_MAX_CHARS)
      break
    hint += ` ${item}`
  }
  return `${hint}${suffix}`
}

interface Word {
  readonly text: string
  /** Index of the first `=` when every character before it was unquoted, else -1. */
  readonly assignment: number
}

/** Splits the input into words (see the module comment). */
function splitWords(input: string): Word[] {
  const words: Word[] = []
  let current = ''
  let started = false
  let quote: '"' | '\'' | null = null
  let unquoted = true
  let assignment = -1
  const finish = (): void => {
    words.push({ text: current, assignment })
    current = ''
    started = false
    unquoted = true
    assignment = -1
  }
  for (let index = 0; index < input.length; index++) {
    const char = input[index] as string
    if (quote === '"') {
      if (char === '\\' && input[index + 1] === '"') {
        current += '"'
        index++
      }
      else if (char === '"') {
        quote = null
      }
      else {
        current += char
      }
      continue
    }
    if (quote === '\'') {
      if (char === '\'')
        quote = null
      else
        current += char
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      started = true
      unquoted = false
      continue
    }
    if (WHITESPACE.test(char)) {
      if (started)
        finish()
      continue
    }
    if (char === '=' && unquoted && assignment === -1)
      assignment = current.length
    current += char
    started = true
  }
  if (started)
    finish()
  return words
}

interface PositionalWord {
  readonly text: string
  /** The argument named by the last `name=value` word before this word, or null. */
  readonly after: string | null
}

function bindUnchecked(args: readonly McpPromptArgument[], input: string): McpPromptBinding {
  const declared = declaredArguments(args)
  if (declared.length === 0)
    return { ok: true, values: {} }
  const names = new Set(declared.map(arg => arg.name))
  const text = typeof input === 'string' ? cutText(input, MCP_PROMPT_INPUT_MAX_CHARS) : ''
  const byName = new Map<string, string>()
  const positional: PositionalWord[] = []
  let lastNamed: string | null = null
  for (const word of splitWords(text)) {
    if (word.assignment > 0) {
      const name = word.text.slice(0, word.assignment)
      if (names.has(name)) {
        byName.set(name, word.text.slice(word.assignment + 1))
        lastNamed = name
        continue
      }
    }
    positional.push({ text: word.text, after: lastNamed })
  }

  // Null prototype: an argument named `__proto__` is an ordinary key.
  const values = Object.create(null) as Record<string, string>
  for (const [name, value] of byName)
    values[name] = value
  const slots = declared.filter(arg => !byName.has(arg.name))
  slots.forEach((slot, index) => {
    if (index >= positional.length)
      return
    values[slot.name] = index === slots.length - 1
      ? positional.slice(index).map(word => word.text).join(' ')
      : (positional[index] as PositionalWord).text
  })
  if (slots.length === 0) {
    const last = (declared.at(-1) as DeclaredArgument).name
    for (const word of positional) {
      const target = word.after ?? last
      const value = values[target] ?? ''
      values[target] = value === '' ? word.text : `${value} ${word.text}`
    }
  }

  const result = Object.create(null) as Record<string, string>
  for (const arg of declared) {
    const value = values[arg.name]
    if (value !== undefined && value !== '')
      result[arg.name] = cutText(value, MCP_PROMPT_ARGUMENT_VALUE_MAX_CHARS)
  }
  const missing = declared.filter(arg => arg.required && !Object.hasOwn(result, arg.name)).map(arg => arg.name)
  if (missing.length > 0)
    return { ok: false, missing }
  return { ok: true, values: { ...result } }
}

/** Binds the text after the command to the prompt's arguments (see the module comment). */
export function bindMcpPromptArguments(args: readonly McpPromptArgument[], input: string): McpPromptBinding {
  try {
    return bindUnchecked(args, input)
  }
  catch {
    // Unreachable for plain data; a hostile object binds nothing.
    return { ok: true, values: {} }
  }
}
