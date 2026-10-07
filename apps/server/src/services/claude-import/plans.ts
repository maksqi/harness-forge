// The import plans the server holds (ADR-055; W12.3-T3): at most `LIMITS.claudeImportPlansMax` plans (the oldest is
// dropped), each for `LIMITS.claudeImportPlanTtlMs` (an `unref()`-ed timer drops it; reads check the time too). A plan
// keeps its DTO (what the browser saw: keys and actions, used to validate an apply body) and the collected files (with
// `.claude.json` already reduced to its MCP server maps), which apply plans again against a fresh baseline. Contents and
// env / header values live only here, in memory: never in a DTO, a log line or an error. Plans are dropped on apply
// (`take`), expiry, `key.rotated` and shutdown (`clear`).
import type { ClaudeHomeFile, ClaudeImportPlan } from '@harness-forge/shared'

export interface StoredPlan {
  /** The answer of the scan or upload (no payloads, no values). */
  readonly dto: ClaudeImportPlan
  /** The collected files the plan was built from. */
  readonly files: readonly ClaudeHomeFile[]
}

export interface PlanStore {
  /** Keeps a plan (dropping the oldest above the limit) until `dto.expiresAt`. */
  readonly put: (plan: StoredPlan) => void
  /** The plan, unless it is unknown or expired. */
  readonly get: (id: string) => StoredPlan | undefined
  /** Removes and returns the plan (apply), unless it is unknown or expired. */
  readonly take: (id: string) => StoredPlan | undefined
  /** Drops every plan. */
  readonly clear: () => void
  readonly size: () => number
}

export interface PlanStoreOptions {
  readonly max: number
  /** Clock of the expiry checks (epoch ms; default `Date.now`). */
  readonly now?: () => number
}

export function createPlanStore(options: PlanStoreOptions): PlanStore {
  const now = options.now ?? Date.now
  const plans = new Map<string, { plan: StoredPlan, timer: ReturnType<typeof setTimeout> }>()

  function drop(id: string): void {
    const held = plans.get(id)
    if (held === undefined)
      return
    clearTimeout(held.timer)
    plans.delete(id)
  }

  function live(id: string): StoredPlan | undefined {
    const held = plans.get(id)
    if (held === undefined)
      return undefined
    if (held.plan.dto.expiresAt <= now()) {
      drop(id)
      return undefined
    }
    return held.plan
  }

  return {
    put: (plan) => {
      drop(plan.dto.id)
      const timer = setTimeout(drop, Math.max(0, plan.dto.expiresAt - now()), plan.dto.id)
      timer.unref?.()
      plans.set(plan.dto.id, { plan, timer })
      while (plans.size > options.max) {
        const oldest = plans.keys().next().value
        if (oldest === undefined)
          break
        drop(oldest)
      }
    },
    get: live,
    take: (id) => {
      const plan = live(id)
      if (plan !== undefined)
        drop(id)
      return plan
    },
    clear: () => {
      for (const id of [...plans.keys()])
        drop(id)
    },
    size: () => plans.size,
  }
}
