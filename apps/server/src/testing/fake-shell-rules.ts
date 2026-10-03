// Test double of `ShellRuleService` (Phase 8, C19-T9), so the chat pipeline (W8.5), the shell policy (W8.4) and the web
// contract tests can use rules while W8.6 implements the real service:
//
//   const t = await createTestApp({ shellRules: 'fake' })          // or factories: { shellRules: createFakeShellRuleService }
//   const rules = t.deps.shellRules as FakeShellRuleService
//   await rules.create({ projectId: project.id, prefix: 'pnpm test' })
//   await rules.forRun(project.id)                                 // { projectId, prefixes: ['pnpm test'] }
//
// Rules live in memory. Follows the contract where callers can see it (W8.6: the messages, the order and the set come
// from the real service's helpers): `parseShellRule` (a refused prefix is
// `validation_error` on `['prefix']` with the parser's message; the canonical prefix is stored), `409 conflict`
// (`exists`) for the same canonical prefix in the same scope, `400` above `LIMITS.shellRulesPerScopeMax` rules in a
// scope, `404` for an unknown rule id, the list order (global first, then by project id and prefix) and the `forRun`
// set (global, then the project's; empty for a null project). With `deps` (as a factory) an unknown project is `404`
// and the rules of a deleted project disappear (the foreign key cascade of the real table).
import type { ShellRule, ShellRuleCreate } from '@harness-forge/shared'
import type { ShellRuleService, ShellRuleSet } from '../services/shell-rules/types.ts'
import type { AppDeps } from '../types.ts'
import { createShellRuleId, HarnessError, LIMITS, parseShellRule, validationError } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { projects } from '../db/schema.ts'
import {
  compareShellRules,
  emptyShellRuleSet,
  SHELL_RULE_EXISTS_MESSAGE,
  shellRuleSetOf,
  shellRulesFullMessage,
} from '../services/shell-rules/index.ts'

export interface FakeShellRuleServiceOptions {
  /** Clock of `createdAt` (default `Date.now`). */
  now?: () => number
}

export interface FakeShellRuleService extends ShellRuleService {
  /** Every stored rule, in creation order (tests may edit it). */
  readonly rules: ShellRule[]
  /** Every `forRun` call (the project id), in order. */
  readonly forRunCalls: Array<string | null>
}

/** An in-memory `ShellRuleService` (see the module comment). `deps` is optional: pass it to check project ids. */
export function createFakeShellRuleService(deps?: Pick<AppDeps, 'db'>, options: FakeShellRuleServiceOptions = {}): FakeShellRuleService {
  const now = options.now ?? Date.now
  const rules: ShellRule[] = []
  const forRunCalls: Array<string | null> = []

  const projectExists = async (projectId: string): Promise<boolean> => {
    if (deps === undefined)
      return true
    const rows = await deps.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1)
    return rows.length > 0
  }

  /** The rules whose project still exists (the cascade of the real table). */
  const live = async (): Promise<ShellRule[]> => {
    const kept: ShellRule[] = []
    for (const rule of rules) {
      if (rule.projectId === null || await projectExists(rule.projectId))
        kept.push(rule)
    }
    if (kept.length !== rules.length)
      rules.splice(0, rules.length, ...kept)
    return [...rules]
  }

  return {
    rules,
    forRunCalls,
    list: async () => (await live()).sort(compareShellRules),
    create: async (input: ShellRuleCreate) => {
      const parsed = parseShellRule(input.prefix)
      if (!parsed.ok)
        throw validationError([{ path: ['prefix'], message: parsed.message, code: 'custom' }], parsed.message)
      if (input.projectId !== null && !(await projectExists(input.projectId)))
        throw new HarnessError({ code: 'not_found', message: `Project ${input.projectId} not found.` })
      const scope = (await live()).filter(rule => rule.projectId === input.projectId)
      if (scope.some(rule => rule.prefix === parsed.canonical))
        throw new HarnessError({ code: 'conflict', message: SHELL_RULE_EXISTS_MESSAGE, details: { reason: 'exists' } })
      if (scope.length >= LIMITS.shellRulesPerScopeMax) {
        const message = shellRulesFullMessage(input.projectId)
        throw validationError([{ path: ['prefix'], message, code: 'custom' }], message)
      }
      const rule: ShellRule = { id: createShellRuleId(), projectId: input.projectId, prefix: parsed.canonical, createdAt: now() }
      rules.push(rule)
      return { ...rule }
    },
    remove: async (id: string) => {
      const index = rules.findIndex(rule => rule.id === id)
      if (index < 0)
        throw new HarnessError({ code: 'not_found', message: `Shell rule ${id} not found.` })
      rules.splice(index, 1)
    },
    forRun: async (projectId): Promise<ShellRuleSet> => {
      forRunCalls.push(projectId)
      if (projectId === null)
        return emptyShellRuleSet(null)
      return shellRuleSetOf(projectId, await live())
    },
  }
}
