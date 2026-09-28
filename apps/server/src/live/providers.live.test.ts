// Live provider suite (ADR-027, PROVIDERS.md 12): real, PAID requests against every builtin provider that has a key in
// the environment or the repository `.env` (Ollama: a local server on :11434). Run it only on purpose:
//   ANTHROPIC_API_KEY=... pnpm test:live
//   HF_LIVE_PROVIDERS=anthropic,openai HF_LIVE_MAX_COST_USD=0.20 pnpm test:live
// `pnpm test` never runs it: the server Vitest config excludes `*.live.test.ts`, and the guard below skips the suite
// unless `HF_LIVE=1` (set by `vitest.live.config.ts`). Providers run one after another, each on its own in-process app
// with only its own key; the summary table (variable names, never values) goes to stdout and `$GITHUB_STEP_SUMMARY`.
import type { LiveMatrixEntry } from './matrix.ts'
import type { LiveBudget, LiveProviderReport } from './summary.ts'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runLiveProvider } from './checks.ts'
import { liveEnvironment, liveProviderSpecs, parseLiveBudget, resolveLiveMatrix } from './matrix.ts'
import { createLiveBudget, failedChecks, formatLiveSummary, skippedReport, writeLiveSummary } from './summary.ts'

/** Every builtin provider gets a test, known at collection time; the matrix decides at run time which ones run. */
const PROVIDER_IDS = liveProviderSpecs().map(spec => spec.providerId)
/** One provider: up to three model calls of at most two minutes each, plus the free checks. */
const PROVIDER_TIMEOUT_MS = 8 * 60_000

describe.runIf(process.env.HF_LIVE === '1')('live providers', () => {
  let matrix: LiveMatrixEntry[] | undefined
  let budget: LiveBudget | undefined
  const reports: LiveProviderReport[] = []

  beforeAll(async () => {
    const env = liveEnvironment()
    budget = createLiveBudget(parseLiveBudget(env.HF_LIVE_MAX_COST_USD))
    matrix = await resolveLiveMatrix(env)
  })

  afterAll(() => {
    if (matrix === undefined || budget === undefined)
      return
    const secrets = matrix.flatMap(entry => (entry.status === 'run' && entry.key !== null ? [entry.key] : []))
    writeLiveSummary(formatLiveSummary(reports, { budget, secrets }))
  })

  for (const providerId of PROVIDER_IDS) {
    it(providerId, async (ctx) => {
      const entry = matrix?.find(candidate => candidate.providerId === providerId)
      if (entry === undefined || budget === undefined)
        throw new Error('The live matrix was not built (see the beforeAll error).')
      if (entry.status === 'skip') {
        reports.push(skippedReport(entry))
        ctx.skip(entry.reason)
        return
      }
      const report = await runLiveProvider(entry, budget)
      reports.push(report)
      expect(failedChecks(report), `${providerId}: failed checks (details in the summary table)`).toEqual([])
    }, PROVIDER_TIMEOUT_MS)
  }
})
