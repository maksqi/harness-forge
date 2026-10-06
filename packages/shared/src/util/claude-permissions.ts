/**
 * Claude Code permission rules (Phase 12, ADR-055 / ADR-057): parses `permissions.allow` / `deny` / `ask` entries of a
 * Claude Code `settings.json` (`Bash(npm run test:*)`, `Read(./.env)`, `WebFetch`, `mcp__github__*`) and maps the safe
 * subset onto harness concepts: a `Bash(...)` allow rule → a shell rule prefix (checked with `parseShellRule`, which
 * fails closed), a whole-tool `deny` → a tool override `deny`. The hook `if` field (`matchHookIf` in `hooks.ts`) uses
 * the same rule parser. Pure and isomorphic; never throws.
 * Contract skeleton written by the coordinator in P12-0a; implemented by C41. Adding members is fine; renaming or
 * removing one is a CCR.
 *
 * Rule grammar: `Tool` or `Tool(specifier)`, the tool a name of `[A-Za-z0-9_-]` starting with a letter or `_`
 * (`mcp__…` names may end with `*`), no blank between the tool and `(`, the rule ends with the closing `)`; the
 * specifier is the text between the first `(` and the last `)` (trimmed; it may hold parentheses). No control
 * characters, at most `PERMISSION_RULE_MAX_CHARS` characters.
 *
 * Bash mapping (`shellRuleFromPermission`): `Bash(p:*)` (the legacy suffix) and `Bash(p *)` → `p`; `Bash(p)` → `p`
 * with `prefix-broader` (a shell rule is a prefix, so it also allows `p --more`); the prefix is then validated and
 * canonicalized by `parseShellRule` (`npm  run` → `npm run`). Not mapped: other tools (`not-bash`), bare `Bash`
 * (`whole-tool`), `Bash(*)` / `Bash(:*)` (`wildcard-only`), any other `*` (`inner-wildcard`, also `Bash(npm*)`),
 * prefixes `parseShellRule` refuses as too powerful (`refused-prefix`: command runners, interpreters without a
 * script, shell builtins, `cd`) or cannot read (`invalid`: empty, too long, more than one segment, quoting it cannot
 * tokenize, globs).
 */
import { parseShellRule } from './shell-command.ts'
import { hasControlChars } from './text.ts'
import { CLAUDE_TOOL_ALIASES } from './tool-names.ts'

/** Longest rule accepted by `parseClaudePermissionRule`. */
export const PERMISSION_RULE_MAX_CHARS = 4096

export interface ClaudePermissionRule {
  /** The tool part (`Bash`, `Read`, `WebFetch`, `mcp__github__create_issue`, `mcp__github__*`). */
  readonly tool: string
  /** The text inside the parentheses, or null for a whole-tool rule. */
  readonly specifier: string | null
  /** The rule as written (trimmed). */
  readonly raw: string
}

/** Longest tool part of a rule. */
const TOOL_MAX_CHARS = 128
/** `Tool` or `Tool(specifier)`; the specifier runs to the last character, which must be `)`. */
const RULE_PATTERN = /^([A-Z_][\w-]*\*?)(?:\(([\s\S]*)\))?$/i
/** An MCP tool rule: `mcp__server`, `mcp__server__tool`, `mcp__server__*`, `mcp__*`. */
const MCP_RULE_PATTERN = /^mcp__[\w-]*\*?$/
const MCP_PREFIX = 'mcp__'

/** Parses one rule; null when it is not a `Tool` or `Tool(specifier)` string (≤ 4096 characters). */
export function parseClaudePermissionRule(raw: string): ClaudePermissionRule | null {
  if (typeof raw !== 'string' || raw.length > PERMISSION_RULE_MAX_CHARS)
    return null
  const trimmed = raw.trim()
  if (trimmed === '' || hasControlChars(trimmed))
    return null
  const match = trimmed.match(RULE_PATTERN)
  if (match === null)
    return null
  const tool = match[1] ?? ''
  if (tool.length > TOOL_MAX_CHARS)
    return null
  if (tool.endsWith('*') && !(tool.startsWith(MCP_PREFIX) && MCP_RULE_PATTERN.test(tool)))
    return null
  const inner = match[2]
  return { tool, specifier: inner === undefined ? null : inner.trim(), raw: trimmed }
}

export const SHELL_RULE_FROM_PERMISSION_REASONS = [
  'not-bash',
  'whole-tool',
  'wildcard-only',
  'inner-wildcard',
  'refused-prefix',
  'invalid',
] as const
export type ShellRuleFromPermissionReason = (typeof SHELL_RULE_FROM_PERMISSION_REASONS)[number]

export type ShellRuleFromPermission
  = | {
    readonly ok: true
    /** The harness shell rule prefix (`npm run test`). */
    readonly prefix: string
    /** `prefix-broader`: an exact `Bash(cmd)` rule became a prefix rule, which also allows longer commands. */
    readonly warning?: 'prefix-broader'
  }
  | { readonly ok: false, readonly reason: ShellRuleFromPermissionReason }

/** One English sentence per reason (import plan summaries, hook diagnostics). */
export const SHELL_RULE_FROM_PERMISSION_MESSAGES: Readonly<Record<ShellRuleFromPermissionReason, string>> = {
  'not-bash': 'Only Bash rules become shell rules.',
  'whole-tool': 'A rule for every Bash command has no shell rule equivalent; add shell rules for the commands you trust.',
  'wildcard-only': 'A rule for every Bash command has no shell rule equivalent; add shell rules for the commands you trust.',
  'inner-wildcard': 'Shell rules are command prefixes; a wildcard inside a Bash rule has no equivalent.',
  'refused-prefix': 'Shell rules cannot allow command runners, interpreters without a script, shell builtins or cd.',
  'invalid': 'The Bash rule could not be read as one command prefix.',
}

function refused(reason: ShellRuleFromPermissionReason): ShellRuleFromPermission {
  return { ok: false, reason }
}

/**
 * Maps an allow rule to a shell rule: `Bash(p:*)`, `Bash(p *)` → `p`; `Bash(p)` → `p` + `prefix-broader`; bare
 * `Bash`, `Bash(*)`, inner wildcards and prefixes `parseShellRule` refuses (command runners, interpreters, `cd`) → not
 * mapped.
 */
export function shellRuleFromPermission(rule: ClaudePermissionRule): ShellRuleFromPermission {
  if (typeof rule !== 'object' || rule === null || rule.tool !== 'Bash')
    return refused('not-bash')
  if (rule.specifier === null || rule.specifier === undefined)
    return refused('whole-tool')
  if (typeof rule.specifier !== 'string')
    return refused('invalid')
  const specifier = rule.specifier.trim()
  if (specifier === '')
    return refused('invalid')
  let prefix: string
  let exact = false
  if (specifier.endsWith(':*')) {
    prefix = specifier.slice(0, -2).trimEnd()
  }
  else if (specifier === '*' || /\s\*$/.test(specifier)) {
    prefix = specifier.slice(0, -1).trimEnd()
  }
  else {
    prefix = specifier
    exact = true
  }
  if (prefix === '' || /^[\s*:]*$/.test(prefix))
    return refused('wildcard-only')
  if (prefix.includes('*'))
    return refused('inner-wildcard')
  const parsed = parseShellRule(prefix)
  if (!parsed.ok) {
    switch (parsed.reason) {
      case 'command-runner':
      case 'shell-builtin':
      case 'interpreter':
      case 'cd':
        return refused('refused-prefix')
      default:
        return refused('invalid')
    }
  }
  return exact ? { ok: true, prefix: parsed.canonical, warning: 'prefix-broader' } : { ok: true, prefix: parsed.canonical }
}

/**
 * The harness tool names a whole-tool Claude rule names (`WebFetch` → `web_fetch`, `Write` → `write_file`,
 * `mcp__github__*` stays as is); empty for rules with a specifier and for unknown tools.
 */
export function toolNamesFromPermission(rule: ClaudePermissionRule): readonly string[] {
  if (typeof rule !== 'object' || rule === null || rule.specifier !== null || typeof rule.tool !== 'string')
    return []
  const tool = rule.tool
  if (tool.startsWith(MCP_PREFIX))
    return tool.length <= TOOL_MAX_CHARS && MCP_RULE_PATTERN.test(tool) && tool !== MCP_PREFIX ? [tool] : []
  const alias = Object.hasOwn(CLAUDE_TOOL_ALIASES, tool) ? CLAUDE_TOOL_ALIASES[tool] : undefined
  return typeof alias === 'string' ? [alias] : []
}
