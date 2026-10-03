// Frozen interface of the shell rules (Phase 8, ADR-038, API.md 4.24 / 5.25, ARCHITECTURE.md 6.13 "Shell rules").
// Implementation: `createShellRuleService(deps)` in `services/shell-rules/index.ts` (C19 stub; W8.6). Consumers: the
// shell rule routes (`http/routes/shell-rules.ts`, W8.6) and the chat pipeline (`forRun` once per run, W8.5), whose run
// scope (`workspace/run-scope.ts`) hands the set to the `shell` tool's policy (`shellPolicy`, W8.4). Test double:
// `createFakeShellRuleService` (`testing/fake-shell-rules.ts`).
//
// A rule is a canonical command prefix (`parseShellRule(prefix).canonical` of the shared parser
// `packages/shared/src/util/shell-command.ts`): a `shell` command runs without asking in the `ask` and `edits` modes
// when every segment matches a rule (`matchShellRules(command, set.prefixes)`). Rules live in `shell_rules` (`srl_`
// ids; `project_id` null = a global rule; deleted with their project by the foreign key). They are not settings and are
// never exported, backed up or imported (a crafted backup must never grant shell rights).
import type { ShellRule, ShellRuleCreate } from '@harness-forge/shared'

/**
 * The rules one run matches against: read once per run by `forRun(projectId)` (a rule added during a run applies from
 * the next run; the web adds the rules of an approval card before it sends the approval, whose continuation is a new
 * run). Frozen.
 */
export interface ShellRuleSet {
  /** The project the set was read for; null for a chat without a project (the set is then empty). */
  readonly projectId: string | null
  /**
   * The canonical prefixes of the global rules, then the project's, deduplicated (first wins), each list sorted by
   * prefix: the `rules` argument of `matchShellRules(command, rules)`. Empty for a null project.
   */
  readonly prefixes: readonly string[]
}

/**
 * Rule storage and the per-run set. Every member is async; errors are `HarnessError`s the routes pass through. Rule
 * prefixes are logged only at `debug` (`shell rule added` / `shell rule removed` at `info` carry the id and the scope).
 */
export interface ShellRuleService {
  /**
   * `GET /shell-rules`: every rule, the global ones first (sorted by prefix), then by project id and prefix.
   */
  readonly list: () => Promise<ShellRule[]>
  /**
   * `POST /shell-rules` (body validated by the route with `shellRuleCreateSchema`): `parseShellRule(input.prefix)`;
   * a refused prefix is `400 validation_error` on `['prefix']` with the parser's message; an unknown project is
   * `404 not_found`; the same canonical prefix in the same scope is `409 conflict` (`reason: 'exists'`); more than
   * `LIMITS.shellRulesPerScopeMax` rules in the scope is `400 validation_error`. Stores the canonical prefix with a new
   * `srl_` id and returns the rule (the route answers 201).
   */
  readonly create: (input: ShellRuleCreate) => Promise<ShellRule>
  /** `DELETE /shell-rules/:id`: removes the rule (the route answers 204); `404 not_found` when unknown. */
  readonly remove: (id: string) => Promise<void>
  /**
   * The rule set of one run (one query): the global rules and the rules of `projectId`; an empty set for a null
   * project. Never throws for an unknown project (its set holds only the global rules).
   */
  readonly forRun: (projectId: string | null) => Promise<ShellRuleSet>
}
