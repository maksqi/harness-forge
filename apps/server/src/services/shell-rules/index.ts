// Shell rules (Phase 8, ADR-038, API.md 4.24 / 5.25, ARCHITECTURE.md 6.13 "Shell rules"). Owner: W8.6. Implements
// `ShellRuleService` (./types.ts) behind `createShellRuleService(deps)` over the `shell_rules` table.
//
// - A rule is stored in its canonical form (`parseShellRule(prefix).canonical` of the shared parser); a refused prefix
//   is `400 validation_error` on `['prefix']` with the parser's message, so the web editors and the server agree.
// - Scope = the project (`project_id`) or the global list (`project_id` null). Per scope: one row per canonical prefix
//   (`409 conflict`, `reason: 'exists'`) and at most `LIMITS.shellRulesPerScopeMax` rules (`400`). The table has no
//   unique index, so `create` runs its checks and the insert one at a time (an in-process queue; one server process).
// - The rules of a project go with it (`ON DELETE CASCADE`); nothing here reacts to a project delete. Rules are not
//   settings and are never exported, backed up or imported (the data service never reads this table).
// - `forRun(projectId)` reads the global rules and the project's in one query, once per run; a null project gets the
//   frozen empty set without a query.
// - Logging: `shell rule added` / `shell rule removed` at `info` carry the rule id and the scope only; the prefix is
//   logged only at `debug` (`shell rule prefix`). No event is emitted (API.md 5.25).
import type { ShellRule, ShellRuleCreate } from '@harness-forge/shared'
import type { ShellRuleRow } from '../../db/schema.ts'
import type { AppDeps } from '../../types.ts'
import type { ShellRuleService, ShellRuleSet } from './types.ts'
import { createShellRuleId, HarnessError, LIMITS, parseShellRule, validationError } from '@harness-forge/shared'
import { and, count, eq, isNull, or } from 'drizzle-orm'
import { projects, shellRules } from '../../db/schema.ts'
import { databaseError, guardDb, isConstraintError } from '../chats/db-errors.ts'

// ---------- messages (user-facing, API.md 5.25) ----------

export const SHELL_RULE_EXISTS_MESSAGE = 'This rule already exists.'

/** The `400` of a full scope (`LIMITS.shellRulesPerScopeMax`). */
export function shellRulesFullMessage(projectId: string | null): string {
  const max = LIMITS.shellRulesPerScopeMax
  return projectId === null
    ? `The global list already has ${max} shell rules. Remove one first.`
    : `This project already has ${max} shell rules. Remove one first.`
}

function projectNotFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Project ${id} not found.` })
}

function ruleNotFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Shell rule ${id} not found.` })
}

function prefixIssue(message: string): HarnessError {
  return validationError([{ path: ['prefix'], message, code: 'custom' }], message)
}

// ---------- ordering ----------

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** `GET /shell-rules` order: global rules first, then by project id; each scope by prefix (unique per scope). */
export function compareShellRules(a: Pick<ShellRule, 'projectId' | 'prefix' | 'id'>, b: Pick<ShellRule, 'projectId' | 'prefix' | 'id'>): number {
  if (a.projectId !== b.projectId) {
    if (a.projectId === null)
      return -1
    if (b.projectId === null)
      return 1
    return compareText(a.projectId, b.projectId)
  }
  return compareText(a.prefix, b.prefix) || compareText(a.id, b.id)
}

/** The rule set of a run without rules (frozen). */
export function emptyShellRuleSet(projectId: string | null): ShellRuleSet {
  return Object.freeze({ projectId, prefixes: Object.freeze([]) })
}

/**
 * The prefixes of a run: the global rules (by prefix), then the project's (by prefix), deduplicated (first wins).
 * `rows` holds the global rules and the rules of `projectId` (rows of other projects are ignored).
 */
export function shellRuleSetOf(projectId: string, rows: ReadonlyArray<Pick<ShellRule, 'projectId' | 'prefix'>>): ShellRuleSet {
  const prefixes: string[] = []
  const seen = new Set<string>()
  for (const scope of [null, projectId]) {
    const inScope = rows.filter(row => row.projectId === scope).map(row => row.prefix).sort(compareText)
    for (const prefix of inScope) {
      if (seen.has(prefix))
        continue
      seen.add(prefix)
      prefixes.push(prefix)
    }
  }
  return Object.freeze({ projectId, prefixes: Object.freeze(prefixes) })
}

function toRule(row: ShellRuleRow): ShellRule {
  return { id: row.id, projectId: row.projectId ?? null, prefix: row.prefix, createdAt: row.createdAt }
}

function scopeOf(projectId: string | null): { scope: 'global' | 'project', projectId: string | null } {
  return { scope: projectId === null ? 'global' : 'project', projectId }
}

export function createShellRuleService(deps: AppDeps): ShellRuleService {
  const { db } = deps

  /** `create` calls, one at a time (the duplicate and cap checks and the insert must not interleave). */
  let queue: Promise<unknown> = Promise.resolve()
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation)
    queue = result.catch(() => {})
    return result
  }

  function scopeCondition(projectId: string | null) {
    return projectId === null ? isNull(shellRules.projectId) : eq(shellRules.projectId, projectId)
  }

  async function requireProject(projectId: string): Promise<void> {
    const rows = await guardDb(async () => db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1))
    if (rows.length === 0)
      throw projectNotFound(projectId)
  }

  async function insert(input: ShellRuleCreate, canonical: string): Promise<ShellRule> {
    const { projectId } = input
    if (projectId !== null)
      await requireProject(projectId)
    const [existing] = await guardDb(async () => db
      .select({ id: shellRules.id })
      .from(shellRules)
      .where(and(scopeCondition(projectId), eq(shellRules.prefix, canonical)))
      .limit(1))
    if (existing !== undefined)
      throw new HarnessError({ code: 'conflict', message: SHELL_RULE_EXISTS_MESSAGE, details: { reason: 'exists' } })
    const [{ n } = { n: 0 }] = await guardDb(async () => db.select({ n: count() }).from(shellRules).where(scopeCondition(projectId)))
    if (n >= LIMITS.shellRulesPerScopeMax)
      throw prefixIssue(shellRulesFullMessage(projectId))
    let row: ShellRuleRow | undefined
    try {
      [row] = await db
        .insert(shellRules)
        .values({ id: createShellRuleId(), projectId, prefix: canonical, createdAt: Date.now() })
        .returning()
    }
    catch (error) {
      // The project was deleted between the check and the insert (the foreign key refuses the row).
      if (projectId !== null && isConstraintError(error))
        throw projectNotFound(projectId)
      throw databaseError(error)
    }
    if (row === undefined)
      throw new HarnessError({ code: 'internal_error', message: 'The shell rule was not stored.' })
    return toRule(row)
  }

  return {
    list: async () => {
      const rows = await guardDb(async () => db.select().from(shellRules))
      return rows.map(toRule).sort(compareShellRules)
    },

    create: async (input) => {
      const parsed = parseShellRule(input.prefix)
      if (!parsed.ok)
        throw prefixIssue(parsed.message)
      const rule = await serialized(async () => insert(input, parsed.canonical))
      deps.logger.info('shell rule added', { ruleId: rule.id, ...scopeOf(rule.projectId) })
      deps.logger.debug('shell rule prefix', { ruleId: rule.id, prefix: rule.prefix })
      return rule
    },

    remove: async (id) => {
      const [row] = await guardDb(async () => db.delete(shellRules).where(eq(shellRules.id, id)).returning())
      if (row === undefined)
        throw ruleNotFound(id)
      deps.logger.info('shell rule removed', { ruleId: row.id, ...scopeOf(row.projectId ?? null) })
      deps.logger.debug('shell rule prefix', { ruleId: row.id, prefix: row.prefix })
    },

    forRun: async (projectId) => {
      if (projectId === null)
        return emptyShellRuleSet(null)
      const rows = await guardDb(async () => db
        .select({ projectId: shellRules.projectId, prefix: shellRules.prefix })
        .from(shellRules)
        .where(or(isNull(shellRules.projectId), eq(shellRules.projectId, projectId))))
      return shellRuleSetOf(projectId, rows.map(row => ({ projectId: row.projectId ?? null, prefix: row.prefix })))
    },
  }
}
