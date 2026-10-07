// The plugin formats of the host (Phase 12, ADR-053; W12.1-T1 / T6): `harness` (a `plugin.json` plugin, read by
// `loader.ts`) and `claude` (a Claude Code plugin read in place by `plugins/claude/reader.ts`). The host reads every user
// plugin through `readPluginDirectoryFor(format, dir, options)` (the format of its `plugins` row; a folder placed by hand
// is detected with `detectFolderFormat`, the folder variant of `detectPluginLayout`), and `inspectDirectoryFor` answers
// `PluginHost.inspectDirectory` (installs, drafts, scaffolds, the editor) for both formats.
import type { PluginFormat } from '@harness-forge/shared'
import type { ClaudePluginRead } from './claude/types.ts'
import type { PluginDirectoryRead } from './loader.ts'
import type { ClaudeEntryOverlay, InspectDirectoryOptions, PluginDirectoryInspection } from './types.ts'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessError, isReservedPluginId } from '@harness-forge/shared'
import { detectPluginLayout } from './claude/detect.ts'
import { readClaudePluginDirectory } from './claude/reader.ts'
import { countFiles, inspectPluginDirectory, readPluginDirectory } from './loader.ts'

/** A plugin folder as the host sees it: the common read and, for `claude`, the Claude Code part. */
export interface FormatRead {
  readonly format: PluginFormat
  readonly directory: PluginDirectoryRead
  readonly claude: ClaudePluginRead | null
}

export interface FormatReadOptions {
  /** The plugin id the folder must read as (its directory name). */
  readonly expectedId?: string
  /** Harness plugins: fail reserved ids (default true). */
  readonly rejectReserved?: boolean
  /** Claude Code plugins: the marketplace entry overlay of the plugin's origin. */
  readonly overlay?: ClaudeEntryOverlay
  readonly nameHint?: string
  readonly versionHint?: string
  /** Claude Code plugins: a linked folder (`source: 'link'`). */
  readonly linked?: boolean
  readonly signal?: AbortSignal
}

/** Reads a plugin folder with the reader of `format`. Never throws for problems of the folder. */
export async function readPluginDirectoryFor(format: PluginFormat, dir: string, options: FormatReadOptions = {}): Promise<FormatRead> {
  if (format === 'claude') {
    const read = await readClaudePluginDirectory(dir, {
      ...(options.expectedId === undefined ? {} : { expectedId: options.expectedId }),
      ...(options.overlay === undefined ? {} : { overlay: options.overlay }),
      ...(options.nameHint === undefined ? {} : { nameHint: options.nameHint }),
      ...(options.versionHint === undefined ? {} : { versionHint: options.versionHint }),
      ...(options.linked === undefined ? {} : { linked: options.linked }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    return { format, directory: read.directory, claude: read.claude }
  }
  const directory = await readPluginDirectory(dir, {
    ...(options.expectedId === undefined ? {} : { expectedId: options.expectedId }),
    ...(options.rejectReserved === undefined ? {} : { rejectReserved: options.rejectReserved }),
  })
  return { format: 'harness', directory, claude: null }
}

/**
 * The format of a folder placed by hand: the top-level names of the folder (folders with a trailing `/`), plus
 * `.claude-plugin/plugin.json`, `hooks/hooks.json` and `skills/<name>/SKILL.md` when present, through
 * `detectPluginLayout`. Null when neither layout is found (or the folder cannot be read).
 */
export async function detectFolderFormat(dir: string): Promise<PluginFormat | null> {
  const paths: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  }
  catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isDirectory())
      paths.push(`${entry.name}/`)
    else if (entry.isFile())
      paths.push(entry.name)
  }
  const listSub = async (folder: string, nested: boolean): Promise<void> => {
    let children
    try {
      children = await readdir(join(dir, folder), { withFileTypes: true })
    }
    catch {
      return
    }
    for (const child of children) {
      if (!nested && child.isFile())
        paths.push(`${folder}/${child.name}`)
      if (nested && child.isDirectory()) {
        try {
          const inner = await readdir(join(dir, folder, child.name), { withFileTypes: true })
          if (inner.some(item => item.isFile() && item.name === 'SKILL.md'))
            paths.push(`${folder}/${child.name}/SKILL.md`)
        }
        catch {}
      }
    }
  }
  if (paths.includes('.claude-plugin/'))
    await listSub('.claude-plugin', false)
  if (paths.includes('hooks/'))
    await listSub('hooks', false)
  if (paths.includes('skills/'))
    await listSub('skills', true)
  return detectPluginLayout(paths)?.format ?? null
}

/** The contributions a Claude Code plugin declares (its read components; nothing registered yet). */
export function claudeContributions(read: ClaudePluginRead): PluginDirectoryInspection['contributions'] {
  const byName = (names: string[]): string[] => names.sort()
  return {
    providers: [],
    models: 0,
    tools: [],
    mcpServers: read.mcpServers.map(server => server.id),
    commands: byName(read.commands.map(command => command.name)),
    hooks: [],
    agents: byName(read.agents.map(agent => agent.name)),
    skills: byName(read.skills.map(skill => skill.name)),
    commandHooks: read.hooks.commands.length,
    outputStyles: byName(read.styles.map(style => style.name)),
  }
}

/**
 * `PluginHost.inspectDirectory`: a harness plugin (`loader.ts`) or, with `format: 'claude'`, a Claude Code plugin with
 * the entry `overlay` and the `nameHint` / `versionHint` fallbacks: its synthesized manifest, the whole-tree hash, the
 * trust requirement, the declared contributions, the file count and the Claude Code info. Throws `validation_error` for
 * an unusable `plugin.json`, a path outside the folder, a link or a special file (the first problem of the read).
 */
export async function inspectDirectoryFor(dir: string, options: InspectDirectoryOptions = {}): Promise<PluginDirectoryInspection> {
  if (options.format !== 'claude')
    return inspectPluginDirectory(dir)
  const read = await readClaudePluginDirectory(dir, {
    ...(options.overlay === undefined ? {} : { overlay: options.overlay }),
    ...(options.nameHint === undefined ? {} : { nameHint: options.nameHint }),
    ...(options.versionHint === undefined ? {} : { versionHint: options.versionHint }),
  })
  const { directory, claude } = read
  const manifest = directory.manifest
  if (claude === null || manifest === null || directory.dir === null || directory.hash === null || directory.firstError !== null) {
    const message = (directory.firstError ?? directory.problem)?.error.message ?? 'The folder is not a valid Claude Code plugin.'
    throw new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: [], message, code: 'custom' }] } })
  }
  return {
    manifest,
    kind: 'declarative',
    sha256: directory.hash,
    requiresTrust: directory.requiresTrust,
    compatible: true,
    reserved: isReservedPluginId(manifest.id),
    contributions: claudeContributions(claude),
    files: await countFiles(directory.dir),
    format: 'claude',
    claude: claude.info,
  }
}
