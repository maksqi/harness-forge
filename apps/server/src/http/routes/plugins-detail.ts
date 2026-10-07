// The Phase 12 fields of plugin DTOs as the plugin routes answer them (ADR-053 / ADR-054; API.md 4.10). Owner: W12.2.
// The host builds `PluginDetail` / `PluginSummary`; the routes make sure that, whatever the host fills in:
// - `format` is the row's format (`plugins.format`);
// - `origin` is the row's origin without the server-side entry overlay (`pluginOriginSchema`), null for other sources;
// - `claude` is the Claude Code plugin info of a `format: 'claude'` plugin (read through `inspectDirectory` with the
//   stored overlay when the host left it empty; null when it cannot be read);
// - `editable` is false for a Claude Code plugin (its files are not editable in v1.8).
import type { PluginDetail, PluginOrigin, PluginSummary } from '@harness-forge/shared'
import type { PluginRecord, StoredPluginOrigin } from '../../plugins/types.ts'
import type { AppDeps } from '../../types.ts'
import { pluginOriginSchema } from '@harness-forge/shared'
import { createPluginRecordStore } from '../../plugins/state.ts'

/** The DTO origin of a stored origin (the entry overlay dropped); null when absent or not a valid origin. */
export function originDto(origin: StoredPluginOrigin | null): PluginOrigin | null {
  if (origin === null)
    return null
  const { overlay: _overlay, ...rest } = origin as StoredPluginOrigin & { overlay?: unknown }
  const parsed = pluginOriginSchema.safeParse(rest)
  return parsed.success ? parsed.data : null
}

/** A plugin detail with the Phase 12 fields of its row (see the module comment). Never throws. */
export async function completeDetail(deps: AppDeps, detail: PluginDetail): Promise<PluginDetail> {
  if (detail.builtin)
    return detail
  let record: PluginRecord | null = null
  try {
    record = await deps.plugins.record(detail.id)
  }
  catch {
    record = null
  }
  const format = record?.format ?? detail.format
  const origin = detail.origin ?? originDto(record?.origin ?? null)
  let claude = format === 'claude' ? detail.claude : null
  if (format === 'claude' && claude === null) {
    try {
      const dir = await deps.plugins.directory(detail.id)
      const overlay = record?.origin?.kind === 'marketplace' ? record.origin.overlay : undefined
      if (dir !== null)
        claude = (await deps.plugins.inspectDirectory(dir, { format: 'claude', ...(overlay === undefined ? {} : { overlay }) })).claude
    }
    catch {
      claude = null
    }
  }
  return { ...detail, format, origin, claude, editable: detail.editable && format !== 'claude' }
}

/** Plugin summaries with the format of their rows. Never throws. */
export async function completeSummaries(deps: AppDeps, summaries: readonly PluginSummary[]): Promise<PluginSummary[]> {
  let formats: Map<string, PluginRecord['format']>
  try {
    formats = new Map((await createPluginRecordStore(deps.db).list()).map(record => [record.id, record.format]))
  }
  catch {
    return [...summaries]
  }
  return summaries.map(summary => (summary.builtin ? summary : { ...summary, format: formats.get(summary.id) ?? summary.format }))
}
