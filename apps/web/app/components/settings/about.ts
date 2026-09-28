// Settings -> About (docs/UI.md 9.6): version rows from `GET /api/health` and the "Copy diagnostics" report.
// The report carries versions, provider statuses and plugin states; never credentials (not even masked hints), and
// never chat content.
import type { HarnessErrorInit, Health, PluginSummary, ProviderSummary } from '@harness-forge/shared'

export const REPOSITORY_URL = 'https://github.com/maksqi/harness-forge'
export const LICENSE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`

export interface VersionRow {
  label: string
  value: string
}

/** "45s", "12m 5s", "3h 4m", "2d 5h". */
export function formatUptime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0)
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0)
    return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

/** App, runtime and key library versions, in display order (Nuxt only when the server knows it). */
export function versionRows(health: Health): VersionRow[] {
  const rows: VersionRow[] = [
    { label: 'Version', value: health.version },
    { label: 'Node.js', value: health.node },
    { label: 'Plugin API', value: health.pluginApiVersion },
    { label: 'AI SDK', value: health.versions.ai },
    { label: 'Hono', value: health.versions.hono },
  ]
  if (health.versions.nuxt)
    rows.push({ label: 'Nuxt', value: health.versions.nuxt })
  return rows
}

function errorSummary(error: HarnessErrorInit | null): { code: string, message: string, status?: number } | null {
  if (!error)
    return null
  return { code: error.code, message: error.message, ...(error.status ? { status: error.status } : {}) }
}

export interface DiagnosticsInput {
  health: Health | null
  /** Why the health request failed, when it did. */
  healthError?: string | null
  userAgent: string
  providers: readonly ProviderSummary[]
  plugins: readonly PluginSummary[]
  /** Epoch ms. */
  generatedAt: number
}

/** The report behind "Copy diagnostics": an allow-list of fields, so new DTO fields never leak into it. */
export function buildDiagnostics(input: DiagnosticsInput): Record<string, unknown> {
  const { health } = input
  return {
    generatedAt: new Date(input.generatedAt).toISOString(),
    app: health
      ? {
          version: health.version,
          node: health.node,
          uptimeSec: health.uptimeSec,
          safeMode: health.safeMode,
          pluginApiVersion: health.pluginApiVersion,
          versions: { ...health.versions },
        }
      : { error: input.healthError ?? 'unavailable' },
    browser: { userAgent: input.userAgent },
    providers: input.providers.map(provider => ({
      id: provider.id,
      pluginId: provider.pluginId,
      enabled: provider.enabled,
      status: provider.status,
      local: provider.local,
      modelCount: provider.modelCount,
      lastError: errorSummary(provider.lastError),
    })),
    plugins: input.plugins.map(plugin => ({
      id: plugin.id,
      version: plugin.version,
      kind: plugin.kind,
      source: plugin.source,
      builtin: plugin.builtin,
      enabled: plugin.enabled,
      state: plugin.state,
      lastError: errorSummary(plugin.lastError),
    })),
  }
}

/** Pretty JSON of `buildDiagnostics()`. */
export function diagnosticsText(input: DiagnosticsInput): string {
  return JSON.stringify(buildDiagnostics(input), null, 2)
}
