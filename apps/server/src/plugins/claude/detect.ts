// Plugin layout detection (Phase 12, ADR-053; ARCHITECTURE.md 6.33 "Detection"): which format a list of paths holds
// and where its root is. Used by the installer for archives and folders (W12.2: the root prefix of a zip, a tarball, a
// GitHub zip, a copied folder) and by the host for folders placed by hand (W12.1, `formats.ts`).
//
// The rule: a `plugin.json` at the root means `harness`; otherwise `.claude-plugin/plugin.json` or any Claude Code
// component (`commands/`, `agents/`, `skills/*/SKILL.md`, a root `SKILL.md`, `output-styles/`, `hooks/hooks.json`,
// `.mcp.json`) means `claude`; both are looked for at the root of the list or inside one top-level folder that holds
// every path (a zipped folder, npm's `package/`, a GitHub zip's `<repo>-<sha>/`). The root of the list wins over the top
// folder, and `harness` wins over `claude` at the same level. A folder counts when it is listed (`commands/`) or when
// a path lies below it (`commands/review.md`).
import type { PluginLayout } from './types.ts'

/** The manifest of a harness plugin. */
const HARNESS_MANIFEST = 'plugin.json'
/** The manifest of a Claude Code plugin. */
const CLAUDE_MANIFEST = '.claude-plugin/plugin.json'
/** Files whose presence makes a folder a Claude Code plugin. */
const CLAUDE_FILES: ReadonlySet<string> = new Set([CLAUDE_MANIFEST, 'SKILL.md', 'hooks/hooks.json', '.mcp.json'])
/** Folders whose presence makes a folder a Claude Code plugin. */
const CLAUDE_FOLDERS: ReadonlySet<string> = new Set(['commands', 'agents', 'output-styles'])

/** A path of the list without a leading `./` and without a trailing `/` (folders may be listed with one). */
function normalized(path: string): string {
  return path.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
}

/** True when the paths (relative to the candidate root) hold a Claude Code plugin. */
function isClaudeLayout(paths: readonly string[]): boolean {
  for (const path of paths) {
    if (CLAUDE_FILES.has(path))
      return true
    const segments = path.split('/')
    if (CLAUDE_FOLDERS.has(segments[0] ?? ''))
      return true
    if (segments.length === 3 && segments[0] === 'skills' && segments[2] === 'SKILL.md')
      return true
  }
  return false
}

/** The layout of the paths seen from one candidate root (`''` or `<top>/`), or null. */
function layoutAt(paths: readonly string[], prefix: string): PluginLayout | null {
  if (paths.includes(HARNESS_MANIFEST))
    return { format: 'harness', prefix }
  if (isClaudeLayout(paths))
    return { format: 'claude', prefix }
  return null
}

/**
 * The layout of the plugin in `paths` (POSIX paths relative to an archive or folder root; folders may be listed, with
 * or without a trailing `/`), or null when no plugin layout is found.
 */
export function detectPluginLayout(paths: readonly string[]): PluginLayout | null {
  const list = paths.filter(path => typeof path === 'string').map(normalized).filter(path => path !== '')
  const atRoot = layoutAt(list, '')
  if (atRoot !== null)
    return atRoot
  const tops = new Set(list.map(path => path.split('/')[0]))
  if (tops.size !== 1)
    return null
  const [top] = [...tops] as [string]
  // Every path is the folder itself or inside it.
  const inner = list.filter(path => path !== top).map(path => path.slice(top.length + 1))
  return layoutAt(inner, `${top}/`)
}
