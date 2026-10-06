// Test double of `ClaudeImportService` (Phase 12, C43-T9), so the import routes and the web contract can be tested
// without a home folder, a zip or the planner:
//
//   const t = await createTestApp({ claudeImport: 'fake' })      // or overrides: { claudeImport: createFakeClaudeImportService() }
//   const fake = t.deps.claudeImport as FakeClaudeImportService
//   fake.items.push(fakeClaudeImportItem('agent', 'reviewer'))
//   const plan = await fake.upload({ label: '.claude', files: [{ path: 'agents/reviewer.md', file: new Blob(['…']) }] })
//   await fake.apply({ planId: plan.id, items: [{ key: plan.items[0].key, action: 'import' }] })
//
// `home()` answers `homeAnswer` (default: available at `/home/test/.claude`); `scan` follows it (`disabled` → 409
// `disabled`, `missing` → 404) and asks for fresh auth; `upload` refuses both or neither of `zip` / `files` (400). A plan
// lists the scripted `items` (their keys must be unique) and is kept in memory like the real service
// (`LIMITS.claudeImportPlanTtlMs`, at most `LIMITS.claudeImportPlansMax`, the oldest dropped); `apply` asks for fresh
// auth, answers 404 for an unknown or expired plan and 400 for an unknown key or an action the item does not offer, then
// reports `skipped` for `skip` and else the scripted `outcomes` (by key; default `created`), drops the plan and emits
// one `customization.changed {}` and one `hooks.changed { projectId: null }` on `options.events`. Every call is counted.
import type {
  ClaudeImportApplyBody,
  ClaudeImportApplyResult,
  ClaudeImportHome,
  ClaudeImportKind,
  ClaudeImportOutcome,
  ClaudeImportPlan,
  ClaudeImportPlanItemDto,
} from '@harness-forge/shared'
import type { ClaudeImportService, ClaudeImportUploadInput } from '../services/claude-import/types.ts'
import type { EventBus } from '../services/events/types.ts'
import { claudeImportItemKey, createImportPlanId, HarnessError, LIMITS } from '@harness-forge/shared'

/** The default `home()` answer of the fake: an available folder (never read). */
export const FAKE_CLAUDE_HOME: ClaudeImportHome = Object.freeze({ available: true, path: '/home/test/.claude' })

/** A new importable item of `kind` and `name` (actions import / skip, default import), then `fields`. */
export function fakeClaudeImportItem(kind: ClaudeImportKind, name: string, fields: Partial<ClaudeImportPlanItemDto> = {}): ClaudeImportPlanItemDto {
  const file = kind === 'skill' ? `skills/${name}/SKILL.md` : kind === 'style' ? `output-styles/${name}.md` : kind === 'agent' || kind === 'command' ? `${kind}s/${name}.md` : 'settings.json'
  return {
    key: claudeImportItemKey(kind, name, file),
    kind,
    name,
    source: { file },
    status: 'new',
    actions: ['import', 'skip'],
    defaultAction: 'import',
    summary: `The ${kind} ${name}.`,
    warnings: [],
    diagnostics: [],
    executable: false,
    ...fields,
  }
}

export interface FakeClaudeImportServiceOptions {
  /** The `home()` answer (default `FAKE_CLAUDE_HOME`). */
  home?: ClaudeImportHome
  /** The items of every new plan. */
  items?: readonly ClaudeImportPlanItemDto[]
  /** Receives `customization.changed` and `hooks.changed` after an apply (default: no events). */
  events?: Pick<EventBus, 'emit'>
  /** Clock (epoch ms; default `Date.now`). */
  now?: () => number
}

export interface FakeClaudeImportService extends ClaudeImportService {
  /** The `home()` answer; tests may replace it. */
  homeAnswer: ClaudeImportHome
  /** The items of every new plan; tests may edit them. */
  readonly items: ClaudeImportPlanItemDto[]
  /** What `apply` reports per item key (default `created`; `skip` is always `skipped`). */
  readonly outcomes: Map<string, ClaudeImportOutcome>
  /** The kept plans by id. */
  readonly plans: Map<string, ClaudeImportPlan>
  /** Every `upload` input, in order. */
  readonly uploads: ClaudeImportUploadInput[]
  /** Every `apply` body, in order. */
  readonly applied: ClaudeImportApplyBody[]
  /** Number of calls of each member. */
  readonly calls: Record<keyof ClaudeImportService, number>
}

function invalid(message: string, path: Array<string | number>): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path, message, code: 'custom' }] } })
}

export function createFakeClaudeImportService(options: FakeClaudeImportServiceOptions = {}): FakeClaudeImportService {
  const now = options.now ?? Date.now
  const items = [...(options.items ?? [])]
  const outcomes = new Map<string, ClaudeImportOutcome>()
  const plans = new Map<string, ClaudeImportPlan>()
  const uploads: ClaudeImportUploadInput[] = []
  const applied: ClaudeImportApplyBody[] = []
  const calls: Record<keyof ClaudeImportService, number> = { home: 0, scan: 0, upload: 0, apply: 0, stop: 0 }

  function dropExpired(): void {
    const at = now()
    for (const [id, plan] of plans) {
      if (plan.expiresAt <= at)
        plans.delete(id)
    }
  }

  function keep(source: ClaudeImportPlan['source'], root: string): ClaudeImportPlan {
    dropExpired()
    const createdAt = now()
    const plan: ClaudeImportPlan = {
      id: createImportPlanId(),
      source,
      root,
      createdAt,
      expiresAt: createdAt + LIMITS.claudeImportPlanTtlMs,
      items: items.map(item => ({ ...item })),
      skipped: [],
      diagnostics: [],
    }
    plans.set(plan.id, plan)
    while (plans.size > LIMITS.claudeImportPlansMax)
      plans.delete(plans.keys().next().value as string)
    return plan
  }

  const service: FakeClaudeImportService = {
    homeAnswer: options.home ?? FAKE_CLAUDE_HOME,
    items,
    outcomes,
    plans,
    uploads,
    applied,
    calls,
    home: async () => {
      calls.home += 1
      return { ...service.homeAnswer }
    },
    scan: async (sensitive) => {
      calls.scan += 1
      sensitive?.requireFreshAuth()
      const home = service.homeAnswer
      if (home.reason === 'disabled')
        throw new HarnessError({ code: 'conflict', message: 'Scanning a Claude Code folder on the server is turned off (HF_CLAUDE_HOME=0).', details: { reason: 'disabled' } })
      if (!home.available || home.path === null)
        throw new HarnessError({ code: 'not_found', message: 'The Claude Code folder was not found on the server.' })
      return keep('scan', home.path)
    },
    upload: async (input) => {
      calls.upload += 1
      uploads.push(input)
      const files = input.files ?? []
      if (input.zip !== undefined && files.length > 0)
        throw invalid('Send either a zip in the part "file" or the folder\'s files in parts named "files", not both.', ['file'])
      if (input.zip === undefined && files.length === 0)
        throw invalid('Send a zip in the part "file" or the folder\'s files in parts named "files".', ['file'])
      return keep('upload', input.label ?? '.claude')
    },
    apply: async (body, sensitive): Promise<ClaudeImportApplyResult> => {
      calls.apply += 1
      sensitive?.requireFreshAuth()
      applied.push(body)
      dropExpired()
      const plan = plans.get(body.planId)
      if (plan === undefined)
        throw new HarnessError({ code: 'not_found', message: 'The import plan expired. Read the folder again.' })
      body.items.forEach((picked, index) => {
        const item = plan.items.find(candidate => candidate.key === picked.key)
        if (item === undefined)
          throw invalid('The plan has no such item.', ['items', index, 'key'])
        if (!item.actions.includes(picked.action))
          throw invalid(`The item cannot be imported with "${picked.action}".`, ['items', index, 'action'])
      })
      const results = body.items.map(picked => ({ key: picked.key, outcome: picked.action === 'skip' ? 'skipped' as const : outcomes.get(picked.key) ?? 'created' as const }))
      const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 }
      for (const result of results)
        counts[result.outcome] += 1
      plans.delete(plan.id)
      options.events?.emit('customization.changed', {})
      options.events?.emit('hooks.changed', { projectId: null })
      return { results, counts, warnings: [] }
    },
    stop: async () => {
      calls.stop += 1
      plans.clear()
    },
  }
  return service
}
