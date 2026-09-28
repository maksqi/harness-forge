// Live provider suite (ADR-027, PROVIDERS.md 12): real, PAID requests against every builtin provider that has a key in
// the environment or the repository `.env` (Ollama: a local server on :11434). Run it only on purpose:
//   ANTHROPIC_API_KEY=... pnpm test:live
//   HF_LIVE_PROVIDERS=anthropic,openai HF_LIVE_MAX_COST_USD=0.20 pnpm test:live
//   HF_LIVE_MEDIA=1 pnpm test:live            (adds the image, speech and transcription checks)
// `pnpm test` never runs it: the server Vitest config excludes `*.live.test.ts`, and the guard below skips the suite
// unless `HF_LIVE=1` (set by `vitest.live.config.ts`). Providers run one after another, each on its own in-process app
// with only its own key; then the media checks (`HF_LIVE_MEDIA=1`: speech, transcription, image; one test and one app
// each). The summary table (variable names, never values) goes to stdout and `$GITHUB_STEP_SUMMARY`.
import type { LiveMatrixEntry, LiveMediaEntry } from './matrix.ts'
import type { LiveBudget, LiveMediaCheckId, LiveProviderReport } from './summary.ts'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runLiveProvider } from './checks.ts'
import { liveEnvironment, liveMediaChecks, liveProviderSpecs, parseLiveBudget, parseLiveMediaFlag, resolveLiveMatrix, resolveLiveMediaMatrix } from './matrix.ts'
import { createLiveMediaResults, mediaReportOf, recordMediaOutcome, runLiveMediaCheck } from './media.ts'
import { createLiveBudget, failedChecks, formatLiveSummary, skippedReport, withMediaResults, writeLiveSummary } from './summary.ts'

/** Every builtin provider gets a test, known at collection time; the matrix decides at run time which ones run. */
const PROVIDER_IDS = liveProviderSpecs().map(spec => spec.providerId)
/** One provider: up to three model calls of at most two minutes each, plus the free checks. */
const PROVIDER_TIMEOUT_MS = 8 * 60_000
/** Every media check of the builtin providers gets a test too; the media matrix decides which ones run. */
const MEDIA_CHECKS = liveMediaChecks()
/** An image turn of up to two minutes (plus a model refresh), one speech call, up to three transcriptions. */
const MEDIA_TIMEOUT_MS: Readonly<Record<LiveMediaCheckId, number>> = {
  image: 4 * 60_000,
  speech: 3 * 60_000,
  transcription: 8 * 60_000,
}

describe.runIf(process.env.HF_LIVE === '1')('live providers', () => {
  let matrix: LiveMatrixEntry[] | undefined
  let media: LiveMediaEntry[] | undefined
  let mediaEnabled = false
  let budget: LiveBudget | undefined
  const reports: LiveProviderReport[] = []
  const mediaResults = createLiveMediaResults()

  beforeAll(async () => {
    const env = liveEnvironment()
    budget = createLiveBudget(parseLiveBudget(env.HF_LIVE_MAX_COST_USD))
    mediaEnabled = parseLiveMediaFlag(env.HF_LIVE_MEDIA)
    matrix = await resolveLiveMatrix(env)
    media = resolveLiveMediaMatrix(env)
  })

  afterAll(() => {
    if (matrix === undefined || budget === undefined)
      return
    const keys = [...matrix, ...(media ?? [])].flatMap(entry => (entry.status === 'run' && entry.key !== null ? [entry.key] : []))
    const merged = reports.map(report => withMediaResults(report, mediaReportOf(mediaResults, report.providerId)))
    writeLiveSummary(formatLiveSummary(merged, { budget, secrets: keys, media: mediaEnabled }))
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

  // After every chat check (the budget serves them first); speech before transcription (its clips are transcribed).
  describe('media', () => {
    for (const check of MEDIA_CHECKS) {
      it(`${check.kind}: ${check.providerId}`, async (ctx) => {
        const entry = media?.find(candidate => candidate.kind === check.kind && candidate.providerId === check.providerId)
        if (entry === undefined || budget === undefined)
          throw new Error('The live media matrix was not built (see the beforeAll error).')
        if (entry.status === 'skip') {
          recordMediaOutcome(mediaResults, check, { result: { status: 'SKIP', detail: entry.reason } })
          ctx.skip(entry.reason)
          return
        }
        const outcome = await runLiveMediaCheck(entry, budget, mediaResults.clips)
        recordMediaOutcome(mediaResults, check, outcome)
        expect(outcome.result.status, `${check.kind} ${check.providerId}: ${outcome.result.detail ?? 'failed'}`).not.toBe('FAIL')
        if (outcome.result.status === 'SKIP')
          ctx.skip(outcome.result.detail)
      }, MEDIA_TIMEOUT_MS[check.kind])
    }
  })
})
