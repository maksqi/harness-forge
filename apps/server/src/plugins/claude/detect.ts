// Plugin layout detection (Phase 12, ADR-053; ARCHITECTURE.md 6.33 "Detection"): which format a list of paths holds
// and where its root is. Used by the installer for archives and folders (W12.2: the root prefix of a zip, a tarball, a
// GitHub zip, a copied folder) and by the host for folders placed by hand (W12.1, `formats.ts`).
//
// The rule: a `plugin.json` at the root means `harness`; otherwise `.claude-plugin/plugin.json` or any Claude Code
// component (`commands/`, `agents/`, `skills/*/SKILL.md`, a root `SKILL.md`, `output-styles/`, `hooks/hooks.json`,
// `.mcp.json`) means `claude`; both are looked for at the root of the list or inside one top-level folder that holds
// every path. C43 stub with the final signature (P12-0b): the `harness` half (a `plugin.json` at the root, or in the one
// top folder); a list without one is null. W12.1 adds the `claude` half.
import type { PluginLayout } from './types.ts'

/** The manifest of a harness plugin. */
const HARNESS_MANIFEST = 'plugin.json'

/** A path of the list without a leading `./` and without a trailing `/` (folders may be listed with one). */
function normalized(path: string): string {
  return path.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
}

/**
 * The layout of the plugin in `paths` (POSIX paths relative to an archive or folder root; folders may be listed, with
 * or without a trailing `/`), or null when no plugin layout is found.
 */
export function detectPluginLayout(paths: readonly string[]): PluginLayout | null {
  const list = paths.map(normalized).filter(path => path !== '')
  if (list.includes(HARNESS_MANIFEST))
    return { format: 'harness', prefix: '' }
  const tops = new Set(list.map(path => path.split('/')[0]))
  if (tops.size !== 1)
    return null
  const [top] = [...tops] as [string]
  // Every path is the folder itself or inside it.
  if (list.includes(`${top}/${HARNESS_MANIFEST}`))
    return { format: 'harness', prefix: `${top}/` }
  return null
}
