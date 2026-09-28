// Results and the summary table of the live provider suite (PROVIDERS.md 12): one row per provider with the key
// variable (the name, never the value), the model, PASS / SKIP / FAIL per check and the cost, printed to stdout and
// appended to `$GITHUB_STEP_SUMMARY` in GitHub Actions. Every text is passed through `maskSecrets` once more before it
// is written, as a second line of defense behind the variable-name-only reports.
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
  /** USD spent by this provider's checks. */
  readonly costUsd: number
  /** Part of the cost was estimated with fallback prices (the model has no catalog price). */
  readonly costEstimated: boolean
  /** Why the whole provider was skipped. */
  readonly skipped?: string
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

/** The failed checks of a report, as `label: detail` lines. */
export function failedChecks(report: LiveProviderReport): string[] {
  return LIVE_CHECKS.flatMap(({ id, label }) => {
    const result = report.checks[id]
    return result?.status === 'FAIL' ? [`${label}: ${result.detail ?? 'failed'}`] : []
  })
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
  if (report.skipped !== undefined)
    return '-'
  return `${report.costEstimated ? '~' : ''}${report.costUsd.toFixed(4)}`
}

function countStatuses(reports: readonly LiveProviderReport[]): Record<LiveStatus, number> {
  const counts: Record<LiveStatus, number> = { PASS: 0, SKIP: 0, FAIL: 0 }
  for (const report of reports) {
    if (report.skipped !== undefined)
      continue
    for (const { id } of LIVE_CHECKS)
      counts[checkStatus(report, id)] += 1
  }
  return counts
}

export interface LiveSummaryOptions {
  budget: LiveBudget
  /** Key values to mask (defense in depth: reports carry variable names only). */
  secrets?: readonly (string | null | undefined)[]
}

/** The Markdown summary: totals, the table, then the details of every check. */
export function formatLiveSummary(reports: readonly LiveProviderReport[], options: LiveSummaryOptions): string {
  const { budget } = options
  const ran = reports.filter(report => report.skipped === undefined)
  const counts = countStatuses(reports)
  const header = ['Provider', 'Key variable', 'Model', ...LIVE_CHECKS.map(check => check.label), 'Cost (USD)']
  const lines = [
    '## Live provider suite',
    '',
    `Providers: ${ran.length} run, ${reports.length - ran.length} skipped. Checks: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.SKIP} SKIP. `
    + `Spent ${formatUsd(budget.spentUsd)} of ${formatUsd(budget.limitUsd)} (HF_LIVE_MAX_COST_USD)${budget.estimated ? ', partly estimated (~)' : ''}.`,
    '',
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
  ]
  for (const report of reports) {
    const statuses = LIVE_CHECKS.map(({ id }) => checkStatus(report, id))
    const row = [report.providerId, keyColumn(report), report.modelId === null ? '-' : code(report.modelId), ...statuses, costColumn(report)]
    lines.push(`| ${row.map(cell).join(' | ')} |`)
  }
  lines.push('', '### Details', '')
  for (const report of reports) {
    if (report.skipped !== undefined) {
      lines.push(`- **${report.providerId}**: SKIP (${oneLine(report.skipped)})`)
      continue
    }
    lines.push(`- **${report.providerId}**`)
    for (const { id, label } of LIVE_CHECKS) {
      const result = report.checks[id]
      lines.push(`  - ${label}: ${result?.status ?? 'SKIP'}${result?.detail === undefined ? '' : ` (${oneLine(result.detail)})`}`)
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
