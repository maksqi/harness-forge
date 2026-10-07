// The component path rules of a Claude Code plugin (Phase 12, ADR-053; W12.1-T1; claude-formats.md 1): which files of
// the plugin tree are commands, agents, skills, output styles, hook files and MCP files, from the folder layout and the
// effective `plugin.json` (paths are stored without the leading `./`; `.` is the root).
//
// - `commands`: the `commands/` scan (`**/*.md`; subfolders become name segments). `plugin.json` `commands` paths
//   **replace** the scan (a file is one command named by its stem, a folder is scanned like `commands/`), unless a
//   marketplace entry added them (`appendToDefault`); its object form adds inline commands (read by the reader). A field
//   whose every path was refused (and without inline commands) falls back to the scan.
// - `agents`: the `agents/` scan (`**/*.md`, subfolders become segments); `plugin.json` `agents` (`.md` files) replace it.
// - `skills`: `skills/<name>/SKILL.md`, and a root `SKILL.md` when there is no `skills/` folder; `plugin.json` `skills`
//   paths **add** to that (`.` = the root `SKILL.md`; a folder holding a `SKILL.md` is one skill, else its
//   `<name>/SKILL.md` subfolders are).
// - `outputStyles`: the `output-styles/` scan (`*.md`); `plugin.json` paths replace it (files or folders).
// - hooks: `hooks/hooks.json` plus the `plugin.json` hook files (merged by `hooks.ts`); MCP: `.mcp.json` plus the
//   `plugin.json` MCP files (merged by `mcp.ts`).
// A path that does not exist is a warning; names start after the plugin id with at most `QUALIFIED_NAME_SEGMENTS_MAX`
// segments (deeper files are skipped with a warning); hidden names are skipped; at most
// `CLAUDE_PLUGIN_LIMITS.componentsPerKindMax` components of a kind (`outputStylesMax` styles). The parts Claude Code
// knows and this harness never runs (`.lsp.json`, `bin/`, `themes/`, `monitors/`, `workflows/`, the plugin's
// `settings.json`, the `unsupported` fields of `plugin.json`) are listed for the inspection.
import type { ClaudeDiagnostic, ClaudePluginManifest, ClaudeReplacingComponent } from '@harness-forge/shared'
import { CLAUDE_PLUGIN_LIMITS, QUALIFIED_NAME_SEGMENTS_MAX } from '@harness-forge/shared'

/** A definition file of the plugin and the name segments its path gives (before the plugin id is put in front). */
export interface ComponentFile {
  /** Plugin-relative POSIX path. */
  readonly path: string
  /** Name segments from the path: subfolders below the scanned folder, then the file stem. */
  readonly segments: readonly string[]
}

/** A skill folder of the plugin. */
export interface SkillFolder {
  /** Plugin-relative `SKILL.md`. */
  readonly path: string
  /** Plugin-relative folder (`.` for the root). */
  readonly baseDir: string
  /** The folder name (the plugin's name for the root `SKILL.md`). */
  readonly folderName: string
}

/** A part of the plugin that is never used, for the inspection. */
export interface UnsupportedPart {
  readonly component: string
  readonly reason: string
}

export interface ClaudeLayout {
  readonly commands: readonly ComponentFile[]
  readonly agents: readonly ComponentFile[]
  readonly skills: readonly SkillFolder[]
  readonly styles: readonly ComponentFile[]
  readonly hookFiles: readonly string[]
  readonly mcpFiles: readonly string[]
  readonly unsupported: readonly UnsupportedPart[]
  readonly diagnostics: readonly ClaudeDiagnostic[]
}

/** The tree as the layout rules see it. */
export interface LayoutTree {
  /** Regular files (POSIX paths relative to the plugin folder). */
  readonly files: ReadonlySet<string>
  /** Folders (POSIX paths relative to the plugin folder). */
  readonly folders: ReadonlySet<string>
}

/** The default hooks file, MCP file and manifest. */
export const HOOKS_FILE = 'hooks/hooks.json'
export const MCP_FILE = '.mcp.json'
export const CLAUDE_MANIFEST_FILE = '.claude-plugin/plugin.json'

/** Parts Claude Code knows that are never run here (files and folders at the plugin root). */
const UNSUPPORTED_ROOT_FILES: Readonly<Record<string, string>> = {
  '.lsp.json': 'LSP servers are not supported; they are never started.',
  'settings.json': 'Plugin settings files are not supported.',
  'CLAUDE.md': 'A plugin CLAUDE.md is not loaded (Claude Code does not load it either).',
}
const UNSUPPORTED_ROOT_FOLDERS: Readonly<Record<string, string>> = {
  bin: 'Plugin programs (bin/) are never put on the PATH or run.',
  themes: 'Themes are not supported.',
  monitors: 'Monitors are not supported; they are never run.',
  workflows: 'Workflows are not supported; they are never run.',
}
/** Reasons of the `unsupported` fields of `plugin.json` (`ClaudePluginManifest.unsupported`). */
const UNSUPPORTED_FIELDS: Readonly<Record<string, string>> = {
  lspServers: 'LSP servers are not supported; they are never started.',
  channels: 'Channels are not supported.',
  themes: 'Themes are not supported.',
  monitors: 'Monitors are not supported; they are never run.',
  workflows: 'Workflows are not supported; they are never run.',
  settings: 'Plugin settings are not supported.',
  dependencies: 'Plugin dependencies are not installed automatically.',
  experimental: 'Experimental components are not supported.',
  types: 'The types field is not supported.',
}

function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

function stemOf(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name
}

/** The markdown files below `folder` (any depth; hidden names skipped), with their segments relative to `folder`. */
function markdownBelow(tree: LayoutTree, folder: string, options: { readonly recursive: boolean }): ComponentFile[] {
  const prefix = folder === '.' ? '' : `${folder}/`
  const found: ComponentFile[] = []
  for (const path of tree.files) {
    if (!path.startsWith(prefix) || !path.toLowerCase().endsWith('.md'))
      continue
    const rest = path.slice(prefix.length).split('/')
    if (rest.some(isHiddenName))
      continue
    if (!options.recursive && rest.length > 1)
      continue
    found.push({ path, segments: [...rest.slice(0, -1), stemOf(rest.at(-1) ?? '')] })
  }
  return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

interface Collected {
  readonly diagnostics: ClaudeDiagnostic[]
}

function warn(collected: Collected, component: string, message: string, path?: string): void {
  collected.diagnostics.push({ level: 'warning', code: 'invalid-path', message, component, ...(path === undefined ? {} : { path }) })
}

/** Keeps at most `max` entries of `list` (a warning beyond it) and drops entries deeper than the segment limit. */
function capped<T extends { path: string, segments?: readonly string[] }>(collected: Collected, component: string, list: T[], max: number): T[] {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const entry of list) {
    if (seen.has(entry.path))
      continue
    seen.add(entry.path)
    if (entry.segments !== undefined && entry.segments.length > QUALIFIED_NAME_SEGMENTS_MAX) {
      warn(collected, component, `${entry.path} is nested more than ${QUALIFIED_NAME_SEGMENTS_MAX - 1} folders deep; it is skipped.`, entry.path)
      continue
    }
    kept.push(entry)
  }
  if (kept.length > max) {
    collected.diagnostics.push({ level: 'warning', code: 'too-many', message: `Only the first ${max} ${component} are used.`, component })
    kept.length = max
  }
  return kept
}

/** True when the effective manifest replaces the default scan of `field` with its own paths. */
function replaces(manifest: ClaudePluginManifest | null, field: ClaudeReplacingComponent, declared: number): boolean {
  if (manifest === null || declared === 0)
    return false
  return !(manifest.appendToDefault ?? []).includes(field)
}

/** The command or agent files of declared paths (files, or folders scanned like the default folder). */
function declaredFiles(collected: Collected, tree: LayoutTree, component: string, paths: readonly string[], options: { readonly folders: boolean }): ComponentFile[] {
  const found: ComponentFile[] = []
  for (const path of paths) {
    if (tree.files.has(path)) {
      if (!path.toLowerCase().endsWith('.md')) {
        warn(collected, component, `${path} is not a .md file; it is skipped.`, path)
        continue
      }
      found.push({ path, segments: [stemOf(path.split('/').at(-1) ?? '')] })
      continue
    }
    if (options.folders && tree.folders.has(path)) {
      found.push(...markdownBelow(tree, path, { recursive: true }))
      continue
    }
    if (options.folders && path === '.') {
      found.push(...markdownBelow(tree, '.', { recursive: false }))
      continue
    }
    warn(collected, component, `The path ${path} of plugin.json does not exist in the plugin.`, path)
  }
  return found
}

function skillAt(tree: LayoutTree, folder: string, pluginName: string): SkillFolder | null {
  const path = folder === '.' ? 'SKILL.md' : `${folder}/SKILL.md`
  if (!tree.files.has(path))
    return null
  return { path, baseDir: folder, folderName: folder === '.' ? pluginName : folder.split('/').at(-1) ?? folder }
}

/** Every `<folder>/<name>/SKILL.md` one level below `folder` (hidden names skipped). */
function skillsBelow(tree: LayoutTree, folder: string, pluginName: string): SkillFolder[] {
  const prefix = folder === '.' ? '' : `${folder}/`
  const found: SkillFolder[] = []
  for (const candidate of tree.folders) {
    if (!candidate.startsWith(prefix))
      continue
    const rest = candidate.slice(prefix.length)
    if (rest === '' || rest.includes('/') || isHiddenName(rest))
      continue
    const skill = skillAt(tree, candidate, pluginName)
    if (skill !== null)
      found.push(skill)
  }
  return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/** The layout of a plugin tree under its effective manifest (null: no `plugin.json`). */
export function planLayout(manifest: ClaudePluginManifest | null, tree: LayoutTree, pluginName: string): ClaudeLayout {
  const collected: Collected = { diagnostics: [] }
  const max = CLAUDE_PLUGIN_LIMITS.componentsPerKindMax

  // Commands.
  const commandPaths = manifest?.commands?.paths ?? []
  const inlineCommands = manifest?.commands?.inline.length ?? 0
  const commandsReplace = replaces(manifest, 'commands', commandPaths.length + inlineCommands)
  const commandFiles = [
    ...(commandsReplace ? [] : markdownBelow(tree, 'commands', { recursive: true })),
    ...declaredFiles(collected, tree, 'commands', commandPaths, { folders: true }),
  ]

  // Agents.
  const agentPaths = manifest?.agents ?? []
  const agentFiles = [
    ...(replaces(manifest, 'agents', agentPaths.length) ? [] : markdownBelow(tree, 'agents', { recursive: true })),
    ...declaredFiles(collected, tree, 'agents', agentPaths, { folders: false }),
  ]

  // Skills: always the default scan, plus the declared paths.
  const skills: SkillFolder[] = [...skillsBelow(tree, 'skills', pluginName)]
  if (!tree.folders.has('skills')) {
    const root = skillAt(tree, '.', pluginName)
    if (root !== null)
      skills.push(root)
  }
  for (const path of manifest?.skills ?? []) {
    const own = skillAt(tree, path, pluginName)
    if (own !== null) {
      skills.push(own)
      continue
    }
    if (path !== '.' && tree.folders.has(path)) {
      skills.push(...skillsBelow(tree, path, pluginName))
      continue
    }
    warn(collected, 'skills', path === '.' ? 'plugin.json names the plugin root as a skill, but there is no SKILL.md at the root.' : `The skill path ${path} of plugin.json does not exist in the plugin.`, path)
  }

  // Output styles.
  const stylePaths = manifest?.outputStyles ?? []
  const styleFiles = [
    ...(replaces(manifest, 'outputStyles', stylePaths.length) ? [] : markdownBelow(tree, 'output-styles', { recursive: false })),
    ...declaredFiles(collected, tree, 'output styles', stylePaths, { folders: true }),
  ]

  // Hook and MCP files.
  const hookFiles: string[] = tree.files.has(HOOKS_FILE) ? [HOOKS_FILE] : []
  for (const path of manifest?.hooks?.files ?? []) {
    if (!tree.files.has(path))
      warn(collected, 'hooks', `The hooks file ${path} of plugin.json does not exist in the plugin.`, path)
    else if (!hookFiles.includes(path))
      hookFiles.push(path)
  }
  const mcpFiles: string[] = tree.files.has(MCP_FILE) ? [MCP_FILE] : []
  for (const path of manifest?.mcpServers?.files ?? []) {
    if (!tree.files.has(path))
      warn(collected, 'mcpServers', `The MCP file ${path} of plugin.json does not exist in the plugin.`, path)
    else if (!mcpFiles.includes(path))
      mcpFiles.push(path)
  }

  // Parts that never run.
  const unsupported: UnsupportedPart[] = []
  const note = (component: string, reason: string): void => {
    if (unsupported.some(part => part.component === component))
      return
    unsupported.push({ component, reason })
    collected.diagnostics.push({ level: 'info', code: 'unsupported-component', message: reason, component })
  }
  for (const [file, reason] of Object.entries(UNSUPPORTED_ROOT_FILES)) {
    if (tree.files.has(file))
      note(file, reason)
  }
  for (const [folder, reason] of Object.entries(UNSUPPORTED_ROOT_FOLDERS)) {
    if (tree.folders.has(folder))
      note(`${folder}/`, reason)
  }
  for (const field of manifest?.unsupported ?? [])
    note(field, UNSUPPORTED_FIELDS[field] ?? 'The field is not supported.')

  return {
    commands: capped(collected, 'commands', commandFiles, max),
    agents: capped(collected, 'agents', agentFiles, max),
    skills: capped(collected, 'skills', skills, max),
    styles: capped(collected, 'output styles', styleFiles, CLAUDE_PLUGIN_LIMITS.outputStylesMax),
    hookFiles,
    mcpFiles,
    unsupported,
    diagnostics: collected.diagnostics,
  }
}
