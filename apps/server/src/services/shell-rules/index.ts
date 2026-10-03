// Shell rules (Phase 8, ADR-038, API.md 5.25, ARCHITECTURE.md 6.13 "Shell rules"). Owner: W8.6 (C19 stub). Implements
// `ShellRuleService` (./types.ts) behind `createShellRuleService(deps)`.
//
// Stub: `list`, `create` and `remove` reject with `not_implemented` (501) until W8.6 lands the storage over
// `shell_rules`; `forRun` resolves an empty set, so every `shell` call keeps asking (the v1.3 behavior) and chat runs
// work meanwhile.
import type { AppDeps } from '../../types.ts'
import type { ShellRuleService, ShellRuleSet } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

/** The rule set of a run without rules (frozen). */
export function emptyShellRuleSet(projectId: string | null): ShellRuleSet {
  return Object.freeze({ projectId, prefixes: Object.freeze([]) })
}

export function createShellRuleService(_deps: AppDeps): ShellRuleService {
  return {
    list: rejectsNotImplemented('The shell rule list'),
    create: rejectsNotImplemented('Adding a shell rule'),
    remove: rejectsNotImplemented('Removing a shell rule'),
    forRun: async projectId => emptyShellRuleSet(projectId),
  }
}
