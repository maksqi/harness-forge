// Results and the summary table of the live provider suite (PROVIDERS.md 12): one row per provider with the key
// variable (the name, never the value), the model, PASS / SKIP / FAIL per check and the cost, printed to stdout and
// appended to `$GITHUB_STEP_SUMMARY` in GitHub Actions. With `HF_LIVE_MEDIA=1` the table gains the media columns Image,
// Speech and Transcription ("-" where the provider has no such model). Every text is passed through `maskSecrets` once
// more before it is written, as a second line of defense behind the variable-name-only reports.
import type { LiveEnv } from './matrix.ts'
import { appendFileSync } from 'node:fs'
import process from 'node:process'

/** The checks of PROVIDERS.md 12 in table order, plus the log check. */
export const LIVE_CHECKS = [
  { id: 'test', label: 'Test' },
  { id: 'models', label: 'Models' },
  { id: 'chat', label: 'Chat' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'tools', label: 'Tools' },
  { id: 'badKey', label: 'Bad key' },
  { id: 'logs', label: 'Key not logged' },
] as const

export type LiveCheckId = (typeof LIVE_CHECKS)[number]['id']
export type LiveStatus = 'PASS' | 'SKIP' | 'FAIL'

/** The media checks of PROVIDERS.md 12 (`HF_LIVE_MEDIA=1`) in table order. */
export const LIVE_MEDIA_CHECKS = [
  { id: 'image', label: 'Image' },
  { id: 'speech', label: 'Speech' },
  { id: 'transcription', label: 'Transcription' },
] as const

export type LiveMediaCheckId = (typeof LIVE_MEDIA_CHECKS)[number]['id']

/**
 * What one media request counts toward `HF_LIVE_MAX_COST_USD` when its cost is unknown: the audio routes never report
 * one, nor do image models without a catalog price or token usage (the unpriced OpenAI image seeds, xAI). Such costs
 * are marked `~`.
 */
export const LIVE_MEDIA_ESTIMATES_USD: Readonly<Record<LiveMediaCheckId, number>> = {
  image: 0.05,
  speech: 0.01,
  transcription: 0.01,
}

export interface LiveCheckResult {
  readonly status: LiveStatus
  /** One line: counts, the effort used, or why the check failed or was skipped. */
  readonly detail?: string
}

export interface LiveProviderReport {
  readonly providerId: string
  /** Accepted key variables, in resolution order (empty for a keyless provider). */
  readonly envVars: readonly string[]
  /** The variable that supplied the key; null when keyless or skipped. */
  readonly envVar: string | null
  readonly modelId: string | null
  /** Results by check; a missing check counts as SKIP. */
  readonly checks: Partial<Record<LiveCheckId, LiveCheckResult>>
  /**
   * Results of the media checks (`HF_LIVE_MEDIA=1`, merged by `withMediaResults`); a media check the provider has no
   * model for is absent (shown as "-").
   */
  readonly media?: Partial<Record<LiveMediaCheckId, LiveCheckResult>>
  /** USD spent by this provider's checks. */
  readonly costUsd: number
  /** Part of the cost was estimated (fallback prices, or the fixed media estimates). */
  readonly costEstimated: boolean
  /** Why the whole provider was skipped. */
  readonly skipped?: string
}

/** The media checks of one provider: their results and what they spent. */
export interface LiveMediaReport {
  readonly checks: Partial<Record<LiveMediaCheckId, LiveCheckResult>>
  readonly costUsd: number
  readonly costEstimated: boolean
}

/** The report with the provider's media results merged in (their cost added to the provider's cost). */
export function withMediaResults(report: LiveProviderReport, media: LiveMediaReport | undefined): LiveProviderReport {
  if (media === undefined)
    return report
  return {
    ...report,
    media: { ...report.media, ...media.checks },
    costUsd: report.costUsd + media.costUsd,
    costEstimated: report.costEstimated || media.costEstimated,
  }
}

/** The spending of one run against `HF_LIVE_MAX_COST_USD`. */
export interface LiveBudget {
  readonly limitUsd: number
  spentUsd: number
  /** Some of the spending was estimated. */
  estimated: boolean
}

export function createLiveBudget(limitUsd: number): LiveBudget {
  return { limitUsd, spentUsd: 0, estimated: false }
}

export function budgetExhausted(budget: LiveBudget): boolean {
  return budget.spentUsd >= budget.limitUsd
}

/** The report of a provider that did not run: every check SKIP. */
export function skippedReport(entry: { providerId: string, envVars: readonly string[], modelId: string | null, reason: string }): LiveProviderReport {
  return { providerId: entry.providerId, envVars: entry.envVars, envVar: null, modelId: entry.modelId, checks: {}, costUsd: 0, costEstimated: false, skipped: entry.reason }
}

export function checkStatus(report: LiveProviderReport, id: LiveCheckId): LiveStatus {
  return report.checks[id]?.status ?? 'SKIP'
}

/** A media cell: the status, or "-" when the provider has no model for the check. */
export function mediaStatus(report: LiveProviderReport, id: LiveMediaCheckId): LiveStatus | '-' {
  return report.media?.[id]?.status ?? '-'
}

/** The failed checks of a report (media checks included), as `label: detail` lines. */
export function failedChecks(report: LiveProviderReport): string[] {
  const results = [
    ...LIVE_CHECKS.map(({ id, label }) => ({ label, result: report.checks[id] })),
    ...LIVE_MEDIA_CHECKS.map(({ id, label }) => ({ label, result: report.media?.[id] })),
  ]
  return results.flatMap(({ label, result }) => (result?.status === 'FAIL' ? [`${label}: ${result.detail ?? 'failed'}`] : []))
}

/** Replaces every occurrence of a secret (6+ characters) with `[redacted]`. */
export function maskSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let masked = text
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.trim().length >= 6)
      masked = masked.split(secret.trim()).join('[redacted]')
  }
  return masked
}

/** A single line of at most `max` characters. */
export function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 3)}...` : line
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

function code(text: string): string {
  return `\`${text.replace(/`/g, '\'')}\``
}

function keyColumn(report: LiveProviderReport): string {
  if (report.envVar !== null)
    return code(report.envVar)
  if (report.envVars.length === 0)
    return 'none (local)'
  return report.envVars.map(code).join(' / ')
}

function costColumn(report: LiveProviderReport): string {
  if (report.skipped !== undefined && report.costUsd === 0)
    return '-'
  return `${report.costEstimated ? '~' : ''}${report.costUsd.toFixed(4)}`
}

function countStatuses(reports: readonly LiveProviderReport[], media: boolean): Record<LiveStatus, number> {
  const counts: Record<LiveStatus, number> = { PASS: 0, SKIP: 0, FAIL: 0 }
  for (const report of reports) {
    if (report.skipped !== undefined)
      continue
    for (const { id } of LIVE_CHECKS)
      counts[checkStatus(report, id)] += 1
    if (!media)
      continue
    for (const { id } of LIVE_MEDIA_CHECKS) {
      const result = report.media?.[id]
      if (result !== undefined)
        counts[result.status] += 1
    }
  }
  return counts
}

/** Details of a media check can list several models (transcription): they may be longer than other details. */
const MEDIA_DETAIL_MAX_CHARS = 400

function detailLine(label: string, result: LiveCheckResult | undefined, max?: number): string {
  return `  - ${label}: ${result?.status ?? 'SKIP'}${result?.detail === undefined ? '' : ` (${oneLine(result.detail, max)})`}`
}

export interface LiveSummaryOptions {
  budget: LiveBudget
  /** Key values to mask (defense in depth: reports carry variable names only). */
  secrets?: readonly (string | null | undefined)[]
  /** `HF_LIVE_MEDIA=1`: adds the columns Image, Speech and Transcription and the media details. */
  media?: boolean
}

/** The Markdown summary: totals, the table, then the details of every check. */
export function formatLiveSummary(reports: readonly LiveProviderReport[], options: LiveSummaryOptions): string {
  const { budget } = options
  const media = options.media === true
  const ran = reports.filter(report => report.skipped === undefined)
  const counts = countStatuses(reports, media)
  const mediaLabels = media ? LIVE_MEDIA_CHECKS.map(check => check.label) : []
  const header = ['Provider', 'Key variable', 'Model', ...LIVE_CHECKS.map(check => check.label), ...mediaLabels, 'Cost (USD)']
  const lines = [
    '## Live provider suite',
    '',
    `Providers: ${ran.length} run, ${reports.length - ran.length} skipped. Checks: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.SKIP} SKIP. `
    + `Spent ${formatUsd(budget.spentUsd)} of ${formatUsd(budget.limitUsd)} (HF_LIVE_MAX_COST_USD)${budget.estimated ? ', partly estimated (~)' : ''}.`,
  ]
  if (media) {
    lines.push(
      '',
      `Media checks on (HF_LIVE_MEDIA=1). A media cost the provider does not report counts at a fixed estimate (~): `
      + `${formatUsd(LIVE_MEDIA_ESTIMATES_USD.image)} per image, ${formatUsd(LIVE_MEDIA_ESTIMATES_USD.speech)} per speech call, `
      + `${formatUsd(LIVE_MEDIA_ESTIMATES_USD.transcription)} per transcription call.`,
    )
  }
  lines.push('', `| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`)
  for (const report of reports) {
    const statuses = LIVE_CHECKS.map(({ id }) => checkStatus(report, id))
    const mediaStatuses = media ? LIVE_MEDIA_CHECKS.map(({ id }) => mediaStatus(report, id)) : []
    const row = [report.providerId, keyColumn(report), report.modelId === null ? '-' : code(report.modelId), ...statuses, ...mediaStatuses, costColumn(report)]
    lines.push(`| ${row.map(cell).join(' | ')} |`)
  }
  lines.push('', '### Details', '')
  for (const report of reports) {
    if (report.skipped !== undefined) {
      lines.push(`- **${report.providerId}**: SKIP (${oneLine(report.skipped)})`)
      continue
    }
    lines.push(`- **${report.providerId}**`)
    for (const { id, label } of LIVE_CHECKS)
      lines.push(detailLine(label, report.checks[id]))
    for (const { id, label } of media ? LIVE_MEDIA_CHECKS : []) {
      const result = report.media?.[id]
      if (result !== undefined)
        lines.push(detailLine(label, result, MEDIA_DETAIL_MAX_CHARS))
    }
  }
  return maskSecrets(`${lines.join('\n')}\n`, options.secrets ?? [])
}

function printToStdout(text: string): void {
  process.stdout.write(`\n${text}\n`)
}

/** Prints the summary and, in GitHub Actions, appends it to the job summary file (`GITHUB_STEP_SUMMARY`). */
export function writeLiveSummary(markdown: string, env: LiveEnv = process.env, print: (text: string) => void = printToStdout): void {
  print(markdown)
  const file = env.GITHUB_STEP_SUMMARY?.trim()
  if (file)
    appendFileSync(file, `${markdown}\n`)
}
