// The Settings side of the shell rules (docs/UI.md 7.23, 9.10, 15; ADR-038): the texts of AllowlistEditor,
// AllowlistDialog and GlobalAllowlistSection, the inline error of a failed add and the "{n} allowed commands" meta of a
// project row. Pure; the prefix checks themselves are `checkRulePrefix` (allow-rule.ts, over the shared parser).
import { toHarnessError } from '~/utils/errors'
import { RULE_EXISTS_MESSAGE } from './allow-rule'

/** The explanation under the title of a rule list: "… in this project." or "… in every project." */
export function allowlistDescription(scope: 'project' | 'global'): string {
  const where = scope === 'global' ? 'in every project' : 'in this project'
  return `Shell commands that start with one of these run without asking ${where}. Combined commands run only when every part matches; redirections and substitutions always ask.`
}

/** The muted risk note of every rule list. */
export const ALLOWLIST_RISK_NOTE = 'A rule for a script runner such as pnpm test or make also lets the agent run any code it writes into the project.'

/** The empty list. */
export const ALLOWLIST_EMPTY = 'No allowed commands yet.'

/** The failed load (with Retry). */
export const ALLOWLIST_LOAD_ERROR = 'Couldn\'t load the allowed commands'

/** The inline error of the add form: `data-code` (a `parseShellRule` reason or the `HarnessError` code) and the text. */
export interface AllowlistError {
  code: string
  message: string
}

/**
 * The inline error of a failed `POST /shell-rules`: `409 conflict` (`exists`) -> "This rule already exists."; anything
 * else (a `400` refused prefix or the 200-rule cap, a `404` unknown project, ...) -> the server message.
 */
export function allowlistError(error: unknown): AllowlistError {
  const failure = toHarnessError(error)
  const reason = (failure.details as { reason?: unknown } | undefined)?.reason
  if (failure.code === 'conflict' && reason === 'exists')
    return { code: failure.code, message: RULE_EXISTS_MESSAGE }
  return { code: failure.code, message: failure.message }
}

/** "3 allowed commands", "1 allowed command"; null at 0 (the project row leaves it out). */
export function allowedCommandsLabel(count: number): string | null {
  if (count <= 0)
    return null
  return count === 1 ? '1 allowed command' : `${count.toLocaleString('en-US')} allowed commands`
}
