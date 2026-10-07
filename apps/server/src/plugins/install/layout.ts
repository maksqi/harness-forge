// Where the plugin is inside a staged archive or folder and which format it has (Phase 12, ADR-053; ARCHITECTURE.md
// 6.33 "Detection"). Owner: W12.2.
//
// `detectPluginLayout` (`plugins/claude/detect.ts`, W12.1) decides: a root `plugin.json` is a harness plugin; otherwise
// `.claude-plugin/plugin.json` or any Claude Code component is a Claude Code plugin; both at the root of the list or
// inside one top-level folder that holds everything (a zipped folder, npm's `package/`). A requested `format` (inspect /
// install `format?`) overrides the detection: `harness` still needs its `plugin.json` (`pluginRootPrefix`), `claude`
// takes the detected root, else the one top-level folder, else the root. `base` limits the search to a subtree (the
// plugin folder of a GitHub repository zip, `<repo>-<sha>/<path>/`).
import type { PluginFormat } from '@harness-forge/shared'
import type { ArchiveEntry } from './archive.ts'
import type { IssuePath } from './errors.ts'
import { detectPluginLayout } from '../claude/detect.ts'
import { MANIFEST_NAME, pluginRootPrefix } from './archive.ts'
import { invalid } from './errors.ts'

/** The plugin found in staged entries: its format and the archive prefix of its root (`''` or `<folder>/…/`). */
export interface StagedLayout {
  readonly format: PluginFormat
  /** The archive path prefix of the plugin root, with its trailing slash (`''` = the archive root). */
  readonly prefix: string
}

export interface LayoutOptions {
  /** The format the request asked for (`format?` of inspect / install); absent = detected. */
  readonly format?: PluginFormat
  /** Only the entries below this prefix (with its trailing slash) are looked at; default `''` (everything). */
  readonly base?: string
  readonly issuePath?: IssuePath
}

/** The message of an archive or folder that holds no plugin of either format. */
export const NO_PLUGIN_MESSAGE = `No plugin found: expected a ${MANIFEST_NAME} (harness-forge plugin) or a Claude Code plugin (.claude-plugin/plugin.json, commands/, agents/, skills/, output-styles/, hooks/hooks.json or .mcp.json) at the top level or inside a single top-level folder.`

/** The paths below `base`, relative to it (folders with a trailing slash). */
function relativePaths(entries: readonly ArchiveEntry[], base: string): string[] {
  const paths: string[] = []
  for (const entry of entries) {
    if (base !== '' && !entry.path.startsWith(base))
      continue
    const relative = entry.path.slice(base.length)
    if (relative !== '')
      paths.push(entry.type === 'dir' ? `${relative}/` : relative)
  }
  return paths
}

/** The one top-level folder that holds every path (`<top>/`), or `''`. */
function singleTopFolder(paths: readonly string[]): string {
  const tops = new Set(paths.map(path => path.split('/')[0]))
  if (tops.size !== 1)
    return ''
  const [top] = [...tops] as [string]
  return paths.every(path => path.startsWith(`${top}/`)) ? `${top}/` : ''
}

/** The format and root prefix of the plugin in `entries` (see the module comment); `validation_error` without one. */
export function layoutOf(entries: readonly ArchiveEntry[], options: LayoutOptions = {}): StagedLayout {
  const base = options.base ?? ''
  const issuePath = options.issuePath ?? []
  const paths = relativePaths(entries, base)
  if (paths.length === 0)
    throw invalid('The plugin folder is empty.', issuePath)
  const detected = detectPluginLayout(paths)
  if (options.format === undefined) {
    if (detected === null)
      throw invalid(NO_PLUGIN_MESSAGE, issuePath)
    return { format: detected.format, prefix: `${base}${detected.prefix}` }
  }
  if (detected !== null && detected.format === options.format)
    return { format: detected.format, prefix: `${base}${detected.prefix}` }
  if (options.format === 'harness') {
    const below = entries.filter(entry => entry.path.startsWith(base) && entry.path.length > base.length)
      .map(entry => ({ ...entry, path: entry.path.slice(base.length) }))
    return { format: 'harness', prefix: `${base}${pluginRootPrefix(below, issuePath)}` }
  }
  const prefix = detected?.prefix ?? (paths.includes('.claude-plugin/plugin.json') ? '' : singleTopFolder(paths))
  return { format: 'claude', prefix: `${base}${prefix}` }
}
