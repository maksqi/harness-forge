// Shell rule copy over the shared parser (docs/UI.md 7.3, 7.23, 11.5; ADR-038): what the approval card suggests for a
// command, how a typed prefix is checked (the card and the Settings editor), the inline error texts and the project of
// a new rule. Pure and store-free. The server is the authority (it validates and canonicalizes every rule again); the
// web only suggests and validates with the same parser (`@harness-forge/shared` util/shell-command.ts).
// Complete in P8-0b (C20); frozen from Gate P8-0b.
import type { ShellRuleRejectReason } from '@harness-forge/shared'
import { LIMITS, matchShellRules, parseShellCommand, parseShellRule, suggestShellRules } from '@harness-forge/shared'

/** Where a rule applies: the chat's project ("This project") or every project ("All projects"). */
export type ShellRuleScope = 'project' | 'global'

/** The rules a shell approval creates before it is sent (`ToolApprovalDecision.allowRules`, docs/UI.md 11.5). */
export interface AllowRules {
  /** Canonical prefixes, one rule each. */
  prefixes: string[]
  scope: ShellRuleScope
}

/** Why a prefix cannot be saved: a `parseShellRule` reason, or `no-match` (the card: it does not cover the command). */
export type RulePrefixErrorCode = ShellRuleRejectReason | 'no-match'

export type RulePrefixCheck
  = | {
    ok: true
    /** The canonical prefix (`parseShellRule(prefix).canonical`), what the server stores. */
    canonical: string
    /** "This allows every {word} command." for a one-word prefix (not blocking); else null. */
    warning: string | null
  }
  | { ok: false, code: RulePrefixErrorCode, message: string }

/** What the approval card offers for a command: the suggested prefixes, or the note that replaces the option. */
export interface RuleSuggestion {
  /** `suggestShellRules(command)`: one canonical prefix per segment that needs a rule; empty = no option. */
  prefixes: string[]
  /** The muted note shown instead of the checkbox when `prefixes` is empty; null otherwise. */
  note: string | null
}

/** The note of a command the parser refused (redirections, substitutions, ...): it always asks. */
export const ALWAYS_ASK_NOTE = 'Commands with redirections, substitutions or other shell syntax always ask.'
/** The note of a command that parses but has no valid prefix (e.g. `sudo …`). */
export const NO_RULE_NOTE = 'No rule can allow this command, so it always asks.'
/** The card's note when the command has several parts that each need a rule. */
export const SEVERAL_RULES_NOTE = 'This command has several parts: one rule is added for each.'
/** The hint under the card's option. */
export const COMBINED_COMMANDS_HINT = 'Combined commands run only when every part matches a rule.'
/** The editor's text for `409 conflict` (`exists`). */
export const RULE_EXISTS_MESSAGE = 'This rule already exists.'

/** The first word of a typed prefix (for the messages that name it). */
function firstWord(prefix: string): string {
  return prefix.trim().split(/\s+/, 1)[0] ?? ''
}

/** The inline error text of a refused prefix (docs/UI.md 7.23, validation copy); `prefix` names the command word. */
export function ruleErrorMessage(code: RulePrefixErrorCode, prefix: string): string {
  const word = firstWord(prefix)
  switch (code) {
    case 'empty':
      return 'Enter the start of a command.'
    case 'too-long':
      return `Use at most ${LIMITS.shellRulePrefixMaxChars} characters.`
    case 'syntax':
      return 'Use a plain command without |, ;, &&, redirections or substitutions.'
    case 'command-runner':
      return `${word} runs other commands, so it can't be allowed by a rule.`
    case 'shell-builtin':
      return `${word} changes the shell or runs its arguments, so it can't be allowed by a rule.`
    case 'interpreter':
      return `A rule for ${word} alone would allow any code. Add what follows it, such as a script name.`
    case 'cd':
      return 'cd needs no rule: changing into a project folder is always allowed.'
    case 'no-match':
      return 'This doesn\'t match the command.'
  }
}

/**
 * Checks a typed prefix with `parseShellRule`; with `command` (the approval card) the canonical rule must also cover
 * the command (`matchShellRules(command, [canonical]).allowed`), else `no-match`. A one-word prefix passes with the
 * warning "This allows every {word} command."
 */
export function checkRulePrefix(prefix: string, command?: string): RulePrefixCheck {
  const parsed = parseShellRule(prefix)
  if (!parsed.ok)
    return { ok: false, code: parsed.reason, message: ruleErrorMessage(parsed.reason, prefix) }
  if (command !== undefined && !matchShellRules(command, [parsed.canonical]).allowed)
    return { ok: false, code: 'no-match', message: ruleErrorMessage('no-match', prefix) }
  const warning = parsed.tokens.length === 1 ? `This allows every ${parsed.tokens[0]} command.` : null
  return { ok: true, canonical: parsed.canonical, warning }
}

/**
 * The option of a shell approval card (docs/UI.md 7.3, 7.23): the suggested prefixes, or, when there are none, the
 * note "Commands with redirections, substitutions or other shell syntax always ask." (the parser refused the command)
 * or "No rule can allow this command, so it always asks." (it parses, but a part has no valid rule).
 */
export function ruleSuggestion(command: string): RuleSuggestion {
  const prefixes = suggestShellRules(command)
  if (prefixes.length > 0)
    return { prefixes, note: null }
  return { prefixes, note: parseShellCommand(command).ok ? NO_RULE_NOTE : ALWAYS_ASK_NOTE }
}

/** The `projectId` of `POST /shell-rules`: the chat's project for "This project", null for "All projects". */
export function ruleProjectId(scope: ShellRuleScope, projectId: string | null): string | null {
  return scope === 'global' ? null : projectId
}
