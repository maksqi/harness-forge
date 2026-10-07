// The reader of a Claude Code plugin folder (Phase 12, ADR-053; W12.1-T1; ARCHITECTURE.md 6.33): what the host, the
// installer (through `PluginHost.inspectDirectory`) and the registration see of a plugin in Claude Code's own layout.
//
// `readClaudePluginDirectory(dir, options)` never throws: it scans the tree (links and special files are problems,
// `tree-hash.ts`), reads `.claude-plugin/plugin.json` with the shared parser (≤ 256 KiB before `JSON.parse`), applies the
// marketplace entry overlay (`mergeEntryOverlay`), derives the id (`claudePluginId`: `plugin.json` name → entry →
// `nameHint`), plans the layout (`layout.ts`), reads every definition file through `readDefinitionFile` with the plugin
// root (no links, regular files, ≤ 64 KiB, NUL probe) and parses it with the shared `parseDefinition` (the new keys are
// kept), reads the MCP servers (`mcp.ts`) and the hooks (`hooks.ts`), maps `userConfig` to settings (`user-config.ts`),
// lists the executables (every command hook handler, stdio server and `!` span: `requiresTrust`), computes the
// whole-tree hash (overlay included) and synthesizes the DTO manifest (id, name = `displayName ?? name` ≤ 64, the
// version (valid semver as is, else `0.0.0+<sanitized>`), `engines.harness: '^1.6.0'`, description ≤ 280,
// `author.name`, an http(s) homepage and the `settings`; no `contributes`).
//
// Names: every entry is qualified `<pluginId>:<seg>…:<name>` (≤ 3 segments, ≤ 128 characters): command subfolders and
// agent subfolders add segments, a skill is named by its folder (its frontmatter `name` replaces only the last
// segment), an agent by its frontmatter `name` (else its file), a style by the slug of its `name` label (else its
// file); every segment is slugified (`clean_gone` → `clean-gone`, an info diagnostic). A command's frontmatter `name`
// is ignored (Claude Code names commands by their path). A name a file gives that the parser refuses (reserved, invalid)
// falls back to the file's own name. Bodies keep their variables: `register.ts` substitutes them when the plugin loads.
//
// Problems that make the plugin `error` (the `directory.problem`): an unusable `plugin.json`, a `plugin.json` path
// outside the folder, a `strict: false` entry next to a `plugin.json` with components, a link or a special file in the
// tree, the tree caps, an id that is not the folder name the host expects. Everything else is a diagnostic (warnings
// and infos, also on the plugin page). File contents, prompts and commands are never logged.
import type { AgentDefinition, CommandDefinition, OutputStyleDefinition, PluginManifest, SkillDefinition } from '@harness-forge/plugin-sdk'
import type {
  ClaudeDiagnostic,
  ClaudeMarketplaceEntry,
  ClaudePluginExecutable,
  ClaudePluginManifest,
  CustomizationKind,
  DefinitionDiagnostic,
  ParsedDefinition,
} from '@harness-forge/shared'
import type { LoadProblem, PluginDirectoryRead } from '../loader.ts'
import type { ClaudeEntryOverlay } from '../types.ts'
import type { ComponentFile, SkillFolder } from './layout.ts'
import type { PluginTree } from './tree-hash.ts'
import type {
  ClaudeAgentComponent,
  ClaudeCommandComponent,
  ClaudePluginDirectoryRead,
  ClaudePluginRead,
  ClaudePluginReadOptions,
  ClaudeSkillComponent,
  ClaudeStyleComponent,
} from './types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  claudePluginId,
  httpUrlSchema,
  isReservedPluginId,
  LIMITS,
  mergeEntryOverlay,
  normalizeToolList,
  parseClaudePluginManifest,
  parseDefinition,
  planCommandExpansion,
  pluginManifestBaseSchema,
  qualifiedName,
  semverSchema,
  setDefinitionName,
} from '@harness-forge/shared'
import { loadProblem } from '../loader.ts'
import { readFailureMessage, readPluginDefinitionFile, readPluginTextFile } from './files.ts'
import { readClaudeHooks } from './hooks.ts'
import { cappedDiagnostics, claudePluginInfo } from './info.ts'
import { CLAUDE_MANIFEST_FILE, planLayout } from './layout.ts'
import { readClaudeMcpServers } from './mcp.ts'
import { hashPluginTree, scanPluginTree } from './tree-hash.ts'
import { claudeSettingsSchema } from './user-config.ts'
import { userConfigReferences } from './variables.ts'

/** The plugin API range of every Claude Code plugin's synthesized manifest. */
export const CLAUDE_ENGINES_RANGE = '^1.6.0'
/** Description length of the synthesized manifest (`plugin.json` of a harness plugin allows 280). */
const MANIFEST_DESCRIPTION_MAX = 280
/** Command descriptions the registry accepts (`COMMAND_DESCRIPTION_MAX_CHARS`). */
const COMMAND_DESCRIPTION_MAX = 120
/** The name the parser sees in place of the file's own (a valid name of every kind). */
const NAME_STAND_IN = 'plugin-entry'
/** Files read at the same time. */
const READ_CONCURRENCY = 8
/** One segment of a qualified name. */
const SEGMENT_PATTERN = /^[a-z][\da-z-]{0,63}$/
const NAME_CODES: ReadonlySet<string> = new Set(['invalid-name', 'reserved-name'])

/** `readClaudePluginDirectory` options: the frozen reader options plus the host's linked-folder flag. */
export interface ReadClaudePluginOptions extends ClaudePluginReadOptions {
  /** A linked folder (`source: 'link'`): `.git` / `node_modules` skipped, links ignored (it is pinned by path). */
  readonly linked?: boolean
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A name segment: lowercase, every run of other characters → `-`, the ends trimmed; null when it is no segment. */
export function slugSegment(raw: string): string | null {
  const slug = raw.toLowerCase().replace(/[^\da-z-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  return SEGMENT_PATTERN.test(slug) ? slug : null
}

/** The DTO version: the raw version when it is valid semver, else `0.0.0+<sanitized>` (or `0.0.0`). */
export function manifestVersionOf(raw: string): string {
  if (semverSchema.safeParse(raw).success)
    return raw
  const build = raw.replace(/[^\dA-Z.-]+/gi, '-').split('.').map(part => part.replace(/^-+|-+$/g, '')).filter(part => part !== '').join('.').slice(0, 100).replace(/\.+$/, '')
  const candidate = build === '' ? '0.0.0' : `0.0.0+${build}`
  return semverSchema.safeParse(candidate).success ? candidate : '0.0.0'
}

/** A marketplace entry built from a stored overlay, for `mergeEntryOverlay`. */
function overlayEntry(overlay: ClaudeEntryOverlay): ClaudeMarketplaceEntry {
  return {
    name: overlay.name,
    source: { kind: 'unknown' },
    supported: true,
    tags: [],
    strict: overlay.strict,
    overlay: overlay.overlay,
    ...(overlay.version === undefined ? {} : { version: overlay.version }),
    ...(overlay.description === undefined ? {} : { description: overlay.description }),
  }
}

/** Runs `fn` over `items` with at most `limit` at a time, keeping the order of the results. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length
}

interface ParsedFile {
  readonly definition: ParsedDefinition | null
  readonly diagnostics: readonly DefinitionDiagnostic[]
  /** The file's own name could not be used: the stand-in was parsed instead. */
  readonly standIn: boolean
}

/**
 * Parses a definition text. `alwaysStandIn` (commands, named by their path) or a name the parser refuses parses the
 * text again with the stand-in name (`setDefinitionName`), the line numbers moved back to the file's.
 */
function parseFile(kind: CustomizationKind, text: string, options: { fileName?: string, folderName?: string }, alwaysStandIn: boolean): ParsedFile {
  if (!alwaysStandIn) {
    const first = parseDefinition(kind, text, options)
    if (!first.diagnostics.some(item => item.level === 'error' && NAME_CODES.has(item.code)))
      return { definition: first.definition, diagnostics: first.diagnostics, standIn: false }
  }
  const named = setDefinitionName(text, NAME_STAND_IN)
  const offset = lineCount(named) - lineCount(text)
  const second = parseDefinition(kind, named, options)
  const diagnostics = second.diagnostics.map(item => item.line === undefined || item.line <= 1 || offset === 0 ? item : { ...item, line: Math.max(1, item.line - offset) })
  return { definition: second.definition, diagnostics, standIn: true }
}

/** The plugin diagnostics of a definition file's parse. */
function definitionDiagnostics(list: readonly DefinitionDiagnostic[], component: string, path: string): ClaudeDiagnostic[] {
  return list.map(item => ({
    level: item.level,
    code: item.code,
    message: item.message,
    component,
    path: item.line === undefined ? path : `${path}:${item.line}`,
  }))
}

/** Rewrites the Claude Code names of the plugin's MCP tools (`mcp__plugin_<name>_<server>__*`) to the harness names. */
function rewriteTools(tools: readonly string[] | null | undefined, aliases: ReadonlyMap<string, string>): string[] | undefined {
  if (tools === null || tools === undefined)
    return undefined
  return [...new Set(tools.map((tool) => {
    for (const [alias, real] of aliases) {
      if (tool.startsWith(alias))
        return `${real}${tool.slice(alias.length)}`
    }
    return tool
  }))]
}

function cutText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd()
}

interface ReadContext {
  readonly root: string
  readonly id: string
  readonly aliases: ReadonlyMap<string, string>
  readonly diagnostics: ClaudeDiagnostic[]
  readonly names: Map<string, Set<string>>
}

/** The qualified name of `segments` (each slugified), unique within its kind; null after a diagnostic. */
function entryName(context: ReadContext, kind: string, segments: readonly string[], path: string): string | null {
  const slugs: string[] = []
  for (const segment of segments) {
    const slug = slugSegment(segment)
    if (slug === null) {
      context.diagnostics.push({ level: 'warning', code: 'invalid-name', message: `${path} gives no usable name (names start with a letter); it is skipped.`, component: kind, path })
      return null
    }
    slugs.push(slug)
  }
  let name: string
  try {
    name = qualifiedName(context.id, ...slugs)
  }
  catch {
    context.diagnostics.push({ level: 'warning', code: 'invalid-name', message: `The name of ${path} is longer than ${LIMITS.qualifiedNameMaxChars} characters; it is skipped.`, component: kind, path })
    return null
  }
  if (slugs.some((slug, index) => slug !== segments[index]))
    context.diagnostics.push({ level: 'info', code: 'renamed', message: `${path} is named ${name}.`, component: kind, path })
  let taken = context.names.get(kind)
  if (taken === undefined) {
    taken = new Set()
    context.names.set(kind, taken)
  }
  if (taken.has(name)) {
    context.diagnostics.push({ level: 'warning', code: 'duplicate-name', message: `Another file of the plugin is already named ${name}; ${path} is skipped.`, component: kind, path })
    return null
  }
  taken.add(name)
  return name
}

/** Reads a definition file; null after a diagnostic. */
async function readText(context: ReadContext, kind: string, path: string): Promise<string | null> {
  const read = await readPluginDefinitionFile(context.root, path)
  if (!read.ok) {
    context.diagnostics.push({ level: 'warning', code: 'read-failed', message: readFailureMessage(path, read.reason), component: kind, path })
    return null
  }
  return read.text
}

interface CommandSource {
  readonly path: string | null
  readonly segments: readonly string[]
  readonly text: string | null
  readonly inline?: { readonly description?: string, readonly argumentHint?: string, readonly model?: string, readonly allowedTools?: readonly string[] }
}

function commandOf(context: ReadContext, source: CommandSource): ClaudeCommandComponent | null {
  const where = source.path ?? `plugin.json commands.${source.segments.join('/')}`
  if (source.text === null)
    return null
  const parsed = parseFile('command', source.text, { fileName: `${NAME_STAND_IN}.md` }, true)
  context.diagnostics.push(...definitionDiagnostics(parsed.diagnostics, 'commands', where))
  if (parsed.definition === null || parsed.definition.kind !== 'command')
    return null
  const name = entryName(context, 'commands', source.segments, where)
  if (name === null)
    return null
  const fields = parsed.definition.fields
  const inlineTools = source.inline?.allowedTools === undefined ? null : normalizeToolList([...source.inline.allowedTools]).tools
  const description = cutText(source.inline?.description ?? fields.description, COMMAND_DESCRIPTION_MAX)
  const argumentHint = source.inline?.argumentHint ?? fields.argumentHint ?? undefined
  const model = source.inline?.model ?? fields.model ?? fields.modelAlias
  const allowedTools = rewriteTools(inlineTools ?? fields.allowedTools, context.aliases)
  const disallowedTools = rewriteTools(fields.disallowedTools, context.aliases)
  const definition: CommandDefinition = {
    name,
    description: description === '' ? name : description,
    template: fields.body,
    syntax: 'markdown',
    ...(argumentHint === undefined || argumentHint === '' ? {} : { argumentHint: cutText(argumentHint, 100) }),
    ...(model === undefined || model === null ? {} : { model }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    // ADR-058: the newer keys of the file, applied by the command code (W12.7).
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
    ...(fields.arguments === undefined ? {} : { arguments: [...fields.arguments] }),
    ...(fields.whenToUse === undefined ? {} : { whenToUse: fields.whenToUse }),
    ...(fields.context === undefined ? {} : { context: fields.context }),
    ...(fields.agent === undefined ? {} : { agent: fields.agent }),
  }
  return { name, path: source.path, definition, shellCommands: [...planCommandExpansion(fields.body).shellCommands] }
}

async function readCommands(context: ReadContext, files: readonly ComponentFile[], manifest: ClaudePluginManifest | null): Promise<ClaudeCommandComponent[]> {
  const sources: CommandSource[] = await mapLimited(files, READ_CONCURRENCY, async file => ({ path: file.path, segments: file.segments, text: await readText(context, 'commands', file.path) }))
  for (const inline of manifest?.commands?.inline ?? []) {
    const extra = {
      ...(inline.description === undefined ? {} : { description: inline.description }),
      ...(inline.argumentHint === undefined ? {} : { argumentHint: inline.argumentHint }),
      ...(inline.model === undefined ? {} : { model: inline.model }),
      ...(inline.allowedTools === undefined ? {} : { allowedTools: inline.allowedTools }),
    }
    if (inline.source !== undefined)
      sources.push({ path: inline.source, segments: [inline.name], text: await readText(context, 'commands', inline.source), inline: extra })
    else
      sources.push({ path: null, segments: [inline.name], text: inline.content ?? null, inline: extra })
  }
  const commands: ClaudeCommandComponent[] = []
  for (const source of sources) {
    const command = commandOf(context, source)
    if (command !== null)
      commands.push(command)
  }
  return commands
}

async function readAgents(context: ReadContext, files: readonly ComponentFile[]): Promise<ClaudeAgentComponent[]> {
  const texts = await mapLimited(files, READ_CONCURRENCY, async file => readText(context, 'agents', file.path))
  const agents: ClaudeAgentComponent[] = []
  files.forEach((file, index) => {
    const text = texts[index]
    if (text === null || text === undefined)
      return
    const stem = file.segments.at(-1) ?? ''
    const parsed = parseFile('agent', text, { fileName: `${slugSegment(stem) ?? NAME_STAND_IN}.md` }, false)
    context.diagnostics.push(...definitionDiagnostics(parsed.diagnostics, 'agents', file.path))
    if (parsed.definition === null || parsed.definition.kind !== 'agent')
      return
    const fields = parsed.definition.fields
    const own = parsed.standIn ? stem : fields.name
    const name = entryName(context, 'agents', [...file.segments.slice(0, -1), own], file.path)
    if (name === null)
      return
    const tools = rewriteTools(fields.tools, context.aliases)
    const disallowedTools = rewriteTools(fields.disallowedTools, context.aliases)
    const model = fields.model ?? fields.modelAlias
    const definition: AgentDefinition = {
      name,
      description: fields.description,
      instructions: fields.instructions === '' ? fields.description : fields.instructions,
      ...(tools === undefined ? {} : { tools }),
      ...(model === null || model === undefined ? {} : { model }),
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
      ...(fields.maxTurns === undefined ? {} : { maxTurns: fields.maxTurns }),
      ...(fields.color === undefined ? {} : { color: fields.color }),
      ...(fields.skills === undefined ? {} : { skills: [...fields.skills] }),
    }
    agents.push({ name, path: file.path, definition, ...(fields.modelAlias === undefined ? {} : { modelAlias: fields.modelAlias }) })
  })
  return agents
}

async function readSkills(context: ReadContext, folders: readonly SkillFolder[]): Promise<ClaudeSkillComponent[]> {
  const texts = await mapLimited(folders, READ_CONCURRENCY, async folder => readText(context, 'skills', folder.path))
  const skills: ClaudeSkillComponent[] = []
  folders.forEach((folder, index) => {
    const text = texts[index]
    if (text === null || text === undefined)
      return
    const parsed = parseFile('skill', text, { folderName: slugSegment(folder.folderName) ?? NAME_STAND_IN }, false)
    context.diagnostics.push(...definitionDiagnostics(parsed.diagnostics, 'skills', folder.path))
    if (parsed.definition === null || parsed.definition.kind !== 'skill')
      return
    const fields = parsed.definition.fields
    const name = entryName(context, 'skills', [parsed.standIn ? folder.folderName : fields.name], folder.path)
    if (name === null)
      return
    const allowedTools = rewriteTools(fields.allowedTools, context.aliases)
    const disallowedTools = rewriteTools(fields.disallowedTools, context.aliases)
    const model = fields.model ?? fields.modelAlias
    const definition: SkillDefinition = {
      name,
      description: fields.description,
      content: fields.content === '' ? fields.description : fields.content,
      baseDir: folder.baseDir,
      ...(fields.argumentHint === undefined ? {} : { argumentHint: fields.argumentHint }),
      ...(fields.userInvocable === undefined ? {} : { userInvocable: fields.userInvocable }),
      ...(fields.modelInvocable === undefined ? {} : { modelInvocable: fields.modelInvocable }),
      // ADR-058: the newer keys of the file, applied by the skill and command code (W12.7).
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
      ...(model === undefined ? {} : { model }),
      ...(fields.arguments === undefined ? {} : { arguments: [...fields.arguments] }),
      ...(fields.whenToUse === undefined ? {} : { whenToUse: fields.whenToUse }),
      ...(fields.context === undefined ? {} : { context: fields.context }),
      ...(fields.agent === undefined ? {} : { agent: fields.agent }),
    }
    skills.push({ name, path: folder.path, baseDir: folder.baseDir, definition })
  })
  return skills
}

async function readStyles(context: ReadContext, files: readonly ComponentFile[]): Promise<ClaudeStyleComponent[]> {
  const texts = await mapLimited(files, READ_CONCURRENCY, async file => readText(context, 'output styles', file.path))
  const styles: ClaudeStyleComponent[] = []
  files.forEach((file, index) => {
    const text = texts[index]
    if (text === null || text === undefined)
      return
    const stem = file.segments.at(-1) ?? ''
    const parsed = parseFile('style', text, { fileName: `${slugSegment(stem) ?? NAME_STAND_IN}.md` }, false)
    context.diagnostics.push(...definitionDiagnostics(parsed.diagnostics, 'outputStyles', file.path))
    if (parsed.definition === null || parsed.definition.kind !== 'style')
      return
    const fields = parsed.definition.fields
    const name = entryName(context, 'outputStyles', [parsed.standIn ? stem : fields.name], file.path)
    if (name === null)
      return
    const definition: OutputStyleDefinition = {
      name,
      description: fields.description,
      content: fields.content === '' ? fields.description : fields.content,
      keepCodingInstructions: fields.keepCodingInstructions,
    }
    styles.push({ name, path: file.path, definition })
  })
  return styles
}

/** Warnings for `${user_config.KEY}` references of markdown bodies: secret options stay empty, unknown ones literal. */
function bodyReferenceDiagnostics(read: Pick<ClaudePluginRead, 'commands' | 'agents' | 'skills' | 'styles' | 'userConfig'>): ClaudeDiagnostic[] {
  const options = new Map(read.userConfig.map(option => [option.key, option]))
  const diagnostics: ClaudeDiagnostic[] = []
  const check = (component: string, path: string | null, text: string): void => {
    for (const key of userConfigReferences(text)) {
      const option = options.get(key)
      const where = path ?? component
      if (option === undefined)
        diagnostics.push({ level: 'info', code: 'unknown-option', message: `${where} uses the option ${key}, which the plugin does not declare; it stays as written.`, component, ...(path === null ? {} : { path }) })
      else if (option.sensitive)
        diagnostics.push({ level: 'warning', code: 'secret-in-body', message: `${where} uses the secret option ${key}; secrets are never put into prompts, so it stays empty.`, component, ...(path === null ? {} : { path }) })
    }
  }
  for (const command of read.commands)
    check('commands', command.path, command.definition.template ?? '')
  for (const agent of read.agents)
    check('agents', agent.path, agent.definition.instructions)
  for (const skill of read.skills)
    check('skills', skill.path, skill.definition.content)
  for (const style of read.styles)
    check('outputStyles', style.path, style.definition.content)
  return diagnostics
}

/** The DTO manifest of a Claude Code plugin (validated with `pluginManifestBaseSchema`; optional fields dropped on failure). */
function synthesizedManifest(id: string, manifest: ClaudePluginManifest | null, name: string, version: string, settings: PluginManifest['settings'] | null): PluginManifest {
  const display = cutText((manifest?.displayName ?? name).trim(), 64) || id
  const base: PluginManifest = { manifestVersion: 1, id, name: display, version: manifestVersionOf(version), engines: { harness: CLAUDE_ENGINES_RANGE } }
  const description = manifest?.description === undefined ? undefined : cutText(manifest.description, MANIFEST_DESCRIPTION_MAX)
  const author = manifest?.author?.name === undefined ? undefined : cutText(manifest.author.name, 100)
  const homepage = manifest?.homepage !== undefined && httpUrlSchema.safeParse(manifest.homepage).success ? manifest.homepage : undefined
  const full: PluginManifest = {
    ...base,
    ...(description === undefined || description === '' ? {} : { description }),
    ...(author === undefined || author === '' ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(settings === null || settings === undefined ? {} : { settings }),
  }
  for (const candidate of [full, { ...full, settings: undefined }, base]) {
    const clean = Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined))
    const parsed = pluginManifestBaseSchema.safeParse(clean)
    if (parsed.success)
      return parsed.data
  }
  return base
}

/** Reads a Claude Code plugin folder (see the module comment). Never throws (an abort of `options.signal` rejects). */
export async function readClaudePluginDirectory(dir: string, options: ReadClaudePluginOptions = {}): Promise<ClaudePluginDirectoryRead> {
  const directory: PluginDirectoryRead = {
    dir: null,
    manifestBytes: null,
    manifest: null,
    lenient: {},
    compatible: true,
    problem: null,
    firstError: null,
    entryPath: null,
    entryBytes: null,
    iconPath: null,
    iconVersion: null,
    hash: null,
    requiresTrust: false,
  }
  let pluginId: string | undefined = options.expectedId
  const fail = (message: string): void => {
    const problem: LoadProblem = loadProblem(pluginId, message)
    directory.problem ??= problem
    directory.firstError ??= problem
  }
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) {
      fail('The plugin path is not a directory.')
      return { directory, claude: null }
    }
    directory.dir = await realpath(dir)
  }
  catch {
    fail('The plugin directory is missing.')
    return { directory, claude: null }
  }
  const root = directory.dir
  options.signal?.throwIfAborted()

  const diagnostics: ClaudeDiagnostic[] = []
  const tree: PluginTree = await scanPluginTree(root, { ...(options.linked === undefined ? {} : { linked: options.linked }), ...(options.signal === undefined ? {} : { signal: options.signal }) })
  const fatal: string[] = []
  if (tree.problem !== null)
    fatal.push(tree.problem)
  const files = new Set(tree.files.map(file => file.path))
  const folders = new Set(tree.folders)

  // plugin.json and the marketplace entry.
  let own: ClaudePluginManifest | null = null
  if (files.has(CLAUDE_MANIFEST_FILE)) {
    const read = await readPluginTextFile(root, CLAUDE_MANIFEST_FILE, LIMITS.claudePluginManifestBytes)
    if (!read.ok) {
      fatal.push(readFailureMessage(CLAUDE_MANIFEST_FILE, read.reason, LIMITS.claudePluginManifestBytes))
    }
    else {
      directory.manifestBytes = Buffer.from(read.bytes)
      const parsed = parseClaudePluginManifest(read.text)
      for (const item of parsed.diagnostics)
        diagnostics.push({ level: item.level, code: item.code, message: item.message, component: item.field === undefined ? 'plugin.json' : `plugin.json ${item.field}`, path: CLAUDE_MANIFEST_FILE })
      own = parsed.manifest
      const error = parsed.diagnostics.find(item => item.level === 'error')
      if (error !== undefined)
        fatal.push(`${CLAUDE_MANIFEST_FILE}: ${error.message}`)
    }
  }
  else if (folders.has('.claude-plugin') && !files.has(CLAUDE_MANIFEST_FILE)) {
    diagnostics.push({ level: 'info', code: 'missing-manifest', message: 'The .claude-plugin folder has no plugin.json; the plugin is read from its folders.', component: 'plugin.json' })
  }
  let manifest = own
  if (options.overlay !== undefined) {
    const merged = mergeEntryOverlay(own, overlayEntry(options.overlay))
    for (const item of merged.diagnostics)
      diagnostics.push({ level: item.level, code: item.code, message: item.message, component: item.field === undefined ? 'marketplace entry' : `marketplace entry ${item.field}` })
    const error = merged.diagnostics.find(item => item.level === 'error')
    if (error !== undefined)
      fatal.push(error.message)
    manifest = merged.manifest ?? own
  }

  // Identity.
  const name = manifest?.name ?? options.nameHint ?? basename(root)
  const id = claudePluginId(name, { digest: options.digest ?? sha256Text, isReserved: isReservedPluginId })
  pluginId = options.expectedId ?? id
  if (options.expectedId !== undefined && id !== options.expectedId)
    fatal.push(`The plugin id "${id}" (from its name "${name.slice(0, 128)}") does not match its folder name "${options.expectedId}".`)
  const knownVersion = manifest?.version ?? options.versionHint ?? null
  const version = knownVersion ?? '0.0.0'

  // Components.
  const layout = planLayout(manifest, { files, folders }, id)
  diagnostics.push(...layout.diagnostics)
  const userConfig = manifest?.userConfig ?? []
  const mcp = await readClaudeMcpServers({ root, pluginId: id, pluginName: name, files: layout.mcpFiles, inline: manifest?.mcpServers?.inline ?? [], userConfig })
  diagnostics.push(...mcp.diagnostics)
  const aliases = new Map(mcp.servers.filter(server => server.claudeName !== '').map(server => [`mcp__${server.claudeName}__`, `mcp__${server.id}__`]))
  const context: ReadContext = { root, id, aliases, diagnostics, names: new Map() }
  const commands = await readCommands(context, layout.commands, manifest)
  const agents = await readAgents(context, layout.agents)
  const skills = await readSkills(context, layout.skills)
  const styles = await readStyles(context, layout.styles)
  const hooks = await readClaudeHooks({ root, files: layout.hookFiles, inline: manifest?.hooks?.inline ?? [] })
  diagnostics.push(...hooks.diagnostics)
  const settings = claudeSettingsSchema(userConfig, mcp.variables)
  diagnostics.push(...settings.diagnostics)
  diagnostics.push(...bodyReferenceDiagnostics({ commands, agents, skills, styles, userConfig }))

  // What the plugin can run: the trust consent.
  const executables: ClaudePluginExecutable[] = [
    ...hooks.executables,
    ...mcp.executables,
    ...commands.flatMap(command => command.shellCommands.map(span => ({ kind: 'span' as const, label: `/${command.name}`, command: span }))),
  ]
  const requiresTrust = executables.length > 0

  // The whole-tree hash.
  let treeHash: string | null = null
  if (tree.problem === null) {
    try {
      treeHash = await hashPluginTree(tree, options.overlay ?? null, options.signal)
    }
    catch (error) {
      options.signal?.throwIfAborted()
      fatal.push(`The plugin files could not be read for their hash (${error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'changed while read'}).`)
    }
  }
  for (const message of fatal)
    diagnostics.unshift({ level: 'error', code: 'plugin-error', message, component: 'plugin' })
  if (fatal.length > 0)
    fail(fatal[0] as string)

  const synthesized = synthesizedManifest(id, manifest, name, version, settings.schema)
  directory.manifest = synthesized
  directory.lenient = { id, name: synthesized.name, version: synthesized.version, ...(synthesized.description === undefined ? {} : { description: synthesized.description }), harness: CLAUDE_ENGINES_RANGE }
  directory.hash = treeHash
  directory.requiresTrust = requiresTrust

  const capped = cappedDiagnostics(diagnostics)
  const info = claudePluginInfo({
    name,
    ...(manifest?.displayName === undefined ? {} : { displayName: manifest.displayName }),
    version: knownVersion,
    namespace: id,
    counts: {
      commands: commands.length,
      agents: agents.length,
      skills: skills.length,
      outputStyles: styles.length,
      hooks: hooks.component.commands.length + hooks.component.prompts.length,
      mcpServers: mcp.servers.length,
    },
    executables,
    hosts: [...mcp.hosts, ...hooks.hosts],
    userConfig,
    unsupported: [...layout.unsupported, ...hooks.unsupported],
    diagnostics: capped,
  })
  const claude: ClaudePluginRead = {
    manifest,
    name,
    id,
    version,
    commands,
    agents,
    skills,
    styles,
    hooks: hooks.component,
    mcpServers: mcp.servers,
    userConfig,
    settings: settings.schema,
    executables,
    requiresTrust,
    treeHash: treeHash ?? '',
    info,
    diagnostics: capped,
  }
  return { directory, claude }
}
