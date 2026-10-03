// Shell rules (API.md section 4.24, ADR-038): an allowlist of command prefixes, per project and global. A `shell`
// command runs without asking in the `ask` and `edits` modes when every segment (`&&`, `||`, `;`, `|`, newline)
// matches a rule (the parser and matcher are `util/shell-command.ts`). Routes `/shell-rules` (module `shellRules`).
// Rules are not settings and are not part of backups (a backup never grants shell rights).
import { z } from 'zod'
import { projectIdSchema, shellRuleIdSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { listResponseSchema } from './common.ts'

/** A stored rule. */
export const shellRuleSchema = z.object({
  id: shellRuleIdSchema,
  /** The project the rule applies to; null = every project (the global list). */
  projectId: projectIdSchema.nullable(),
  /**
   * The canonical prefix (`parseShellRule(prefix).canonical`: words separated by one space, a word with special
   * characters single-quoted).
   */
  prefix: z.string().min(1).max(LIMITS.shellRulePrefixMaxChars),
  createdAt: timestampSchema,
})
export type ShellRule = z.infer<typeof shellRuleSchema>

/** `GET /shell-rules`: every rule (global and of every project), the global ones first, then by project and prefix. */
export const shellRuleListSchema = listResponseSchema(shellRuleSchema)
export type ShellRuleList = z.infer<typeof shellRuleListSchema>

/**
 * Body of `POST /shell-rules`; strict. Shape only: the server validates the prefix with the shared rule parser (a
 * refused prefix is `400 validation_error` on `['prefix']` with the parser's message), stores its canonical form and
 * checks duplicates (`409 conflict`, `reason: 'exists'`) and the cap of `LIMITS.shellRulesPerScopeMax` rules per scope.
 */
export const shellRuleCreateSchema = z.strictObject({
  /** The project of the rule; null = a global rule. */
  projectId: projectIdSchema.nullable(),
  /** Trimmed, 1..200 characters (`LIMITS.shellRulePrefixMaxChars`). */
  prefix: z.string().trim().min(1).max(LIMITS.shellRulePrefixMaxChars),
})
export type ShellRuleCreate = z.infer<typeof shellRuleCreateSchema>
