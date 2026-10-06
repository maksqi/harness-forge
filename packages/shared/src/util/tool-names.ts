/**
 * Tool lists of definition files (Phase 10, ADR-044 / ADR-045): Claude Code tool names map to harness tools (Read →
 * read_file, Write → write_file, Edit / MultiEdit → edit_file, Grep → search_files, Glob → find_files, LS →
 * list_directory, Bash → shell, WebFetch → web_fetch); `mcp__*` names are kept; patterns such as `Bash(git:*)` keep the
 * tool and add a `tool-pattern` diagnostic; other names that look like tool names are kept for the catalog to check
 * against the live tool list; anything else is dropped with an `unknown-tool` diagnostic. A list only ever narrows a
 * tool set. Pure and isomorphic; never throws. Phase 12 adds the Claude Code names of the agent tools and agent types
 * (hook matching only; `CLAUDE_TOOL_ALIASES` is unchanged).
 */
import type { DefinitionDiagnostic, DefinitionDiagnosticCode, DefinitionDiagnosticLevel } from './definitions.ts'
import { MCP_TOOL_PREFIX, TOOL_NAME_PATTERN } from '../ids.ts'

/** Claude Code tool name → harness tool name. */
export const CLAUDE_TOOL_ALIASES: Readonly<Record<string, string>> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  Grep: 'search_files',
  Glob: 'find_files',
  LS: 'list_directory',
  Bash: 'shell',
  WebFetch: 'web_fetch',
}

/**
 * Claude Code names of the `core-agent` tools (Phase 12, ADR-057): hooks match them (`hookTargetNames`; Claude Code
 * renamed `Task` to `Agent`, both match `task`) and the hook `if` rule accepts them. Never used by `normalizeToolList`
 * (a definition's `tools: TodoWrite` keeps its Phase 10 meaning).
 */
export const CLAUDE_AGENT_TOOL_ALIASES: Readonly<Record<string, string>> = {
  Task: 'task',
  Agent: 'task',
  TodoWrite: 'todo_write',
  ExitPlanMode: 'exit_plan_mode',
  Skill: 'skill',
}

/**
 * Claude Code agent types → harness agent types (Phase 12, ADR-057): a `SubagentStart` / `SubagentStop` matcher
 * written for Claude Code (`general-purpose`, `Explore`) matches the harness builtins (`general`, `explore`).
 */
export const CLAUDE_AGENT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  'general-purpose': 'general',
  'Explore': 'explore',
}

/** The names an agent type is matched under: the type itself, then its Claude Code names (`general` → `general-purpose`). */
export function claudeAgentTypeNames(type: string): string[] {
  if (typeof type !== 'string' || type === '')
    return []
  const names = [type]
  for (const [claude, harness] of Object.entries(CLAUDE_AGENT_TYPE_ALIASES)) {
    if (harness === type && !names.includes(claude))
      names.push(claude)
  }
  return names
}

export interface NormalizedToolList {
  /** Deduplicated harness tool names in input order; null when the value is absent (no restriction). */
  readonly tools: readonly string[] | null
  readonly diagnostics: readonly DefinitionDiagnostic[]
}

/** Entries kept from one list (`DEFINITION_LIMITS.toolsMax`; a value import would make a module cycle). */
const TOOL_LIST_MAX = 64
/** `unknown-tool` diagnostics reported one by one; the rest are counted in one more diagnostic. */
const UNKNOWN_TOOL_DIAGNOSTICS_MAX = 10
/** A prefix entry for MCP tools: `mcp__server__*`, `mcp__*` (the `*` makes it one character longer than a name). */
const MCP_PREFIX_ENTRY = /^mcp__[\w-]{0,59}\*$/
/** `Name(pattern)`: Claude Code permission patterns such as `Bash(git add:*)` or `Read(./src/**)`. */
const PATTERN_ENTRY = /^([A-Z_][\w-]*)\s*\((.*)\)$/is

function diagnostic(level: DefinitionDiagnosticLevel, code: DefinitionDiagnosticCode, message: string): DefinitionDiagnostic {
  return { level, code, message }
}

/** Splits `text` on the commas outside parentheses. */
function splitOnCommas(text: string): string[] {
  const entries: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '(') {
      depth++
    }
    else if (char === ')' && depth > 0) {
      depth--
    }
    else if (char === ',' && depth === 0) {
      entries.push(text.slice(start, index))
      start = index + 1
    }
  }
  entries.push(text.slice(start))
  return entries
}

/** A string value: split on commas, else on whitespace when it has no parenthesis (`Read Grep Glob`). */
function splitToolString(text: string): string[] {
  if (text.includes(','))
    return splitOnCommas(text)
  if (text.includes('('))
    return [text]
  return text.split(/\s+/)
}

function isAcceptedName(name: string): boolean {
  if (TOOL_NAME_PATTERN.test(name))
    return true
  return name.startsWith(MCP_TOOL_PREFIX) && MCP_PREFIX_ENTRY.test(name)
}

/**
 * Normalizes a frontmatter `tools` / `allowed-tools` value (comma string or list). Never throws. With `mode: 'deny'`
 * (Phase 12, `disallowedTools` / `disallowed-tools`) the messages speak of removed tools and a value that is not a list
 * is ignored (`tools: null`, nothing removed) instead of allowing no tool.
 */
export function normalizeToolList(value: unknown, options?: { readonly mode?: 'allow' | 'deny' }): NormalizedToolList {
  const deny = options?.mode === 'deny'
  if (value === undefined || value === null)
    return { tools: null, diagnostics: [] }
  let entries: readonly unknown[]
  if (typeof value === 'string') {
    entries = splitToolString(value)
  }
  else if (Array.isArray(value)) {
    entries = value
  }
  else {
    const message = deny
      ? 'The disallowed tool list must be a comma-separated text or a list; it was ignored.'
      : 'The tool list must be a comma-separated text or a list; no tool is allowed.'
    return { tools: deny ? null : [], diagnostics: [diagnostic('warning', 'invalid-field', message)] }
  }

  const diagnostics: DefinitionDiagnostic[] = []
  const tools: string[] = []
  const seen = new Set<string>()
  const patterned = new Set<string>()
  let position = 0
  let unknown = 0
  const drop = (message: string): void => {
    unknown++
    if (unknown <= UNKNOWN_TOOL_DIAGNOSTICS_MAX)
      diagnostics.push(diagnostic('warning', 'unknown-tool', message))
  }

  for (const entry of entries) {
    if (typeof entry !== 'string') {
      position++
      drop(`Entry ${position} of the tool list is not text; it was dropped.`)
      continue
    }
    const trimmed = entry.trim()
    if (trimmed === '')
      continue
    position++
    const pattern = trimmed.match(PATTERN_ENTRY)
    const base = pattern?.[1] ?? trimmed
    const name = Object.hasOwn(CLAUDE_TOOL_ALIASES, base) ? CLAUDE_TOOL_ALIASES[base] ?? base : base
    if (!isAcceptedName(name)) {
      drop(`Entry ${position} of the tool list is not a tool name; it was dropped.`)
      continue
    }
    if (pattern !== null && !patterned.has(name)) {
      patterned.add(name)
      const effect = deny ? `${name} is removed entirely` : `${name} is allowed without its pattern`
      diagnostics.push(diagnostic('warning', 'tool-pattern', `Tool patterns are not supported; ${effect}.`))
    }
    if (!seen.has(name)) {
      seen.add(name)
      tools.push(name)
    }
  }

  if (unknown > UNKNOWN_TOOL_DIAGNOSTICS_MAX) {
    const more = unknown - UNKNOWN_TOOL_DIAGNOSTICS_MAX
    diagnostics.push(diagnostic('warning', 'unknown-tool', `${more} more ${more === 1 ? 'entry' : 'entries'} of the tool list were dropped.`))
  }
  if (tools.length > TOOL_LIST_MAX) {
    tools.length = TOOL_LIST_MAX
    diagnostics.push(diagnostic('warning', 'limit', `The tool list has more than ${TOOL_LIST_MAX} entries; only the first ${TOOL_LIST_MAX} are used.`))
  }
  return { tools, diagnostics }
}

/**
 * True when `toolName` passes the allowlist: an exact entry; an entry ending in `*` is a prefix (`mcp__github__*`);
 * an `mcp__server` entry without a tool part matches every tool of that server (`mcp__server__*`).
 */
export function matchToolAllowlist(toolName: string, allowlist: readonly string[]): boolean {
  if (typeof toolName !== 'string' || toolName === '' || !Array.isArray(allowlist))
    return false
  for (const entry of allowlist) {
    if (typeof entry !== 'string' || entry === '')
      continue
    if (entry === toolName)
      return true
    if (entry.endsWith('*')) {
      if (toolName.startsWith(entry.slice(0, -1)))
        return true
      continue
    }
    const server = entry.startsWith(MCP_TOOL_PREFIX) ? entry.slice(MCP_TOOL_PREFIX.length) : null
    if (server !== null && server !== '' && !server.includes('__') && toolName.startsWith(`${entry}__`))
      return true
  }
  return false
}
