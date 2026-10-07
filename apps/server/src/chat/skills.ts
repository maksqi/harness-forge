// Skills (Phase 10, ADR-045; ARCHITECTURE.md 6.25, API.md 4.25). Signature FROZEN after P10-0b (C31 stub); W10.5
// implements it.
//
// `loadSkill(context, name, signal)` is what the run binds as `AgentRunScope.loadSkill` (`pipeline.ts`), for
// `core-agent`'s `skill` tool: the active skill `name` of the run's catalog snapshot (`context.catalog.skill(name)`),
// its body read and validated again (`deps.customizations.load(entry, signal)`), as a `SkillOutput` (`content` at most
// `LIMITS.customizationContentBytes` UTF-8 bytes, cut at a character boundary, `truncated`); a project skill in a run
// whose project folder is open also gets its folder (`baseDir`, project-relative: the folder of its `SKILL.md`) and its
// supporting files (`files`, relative to `baseDir`, in walk order: `walkWorkspace` from the skill folder, 3 folder levels
// deep, at most `LIMITS.skillFilesListedMax`; links, hidden names, secret-looking names, the `SKILL.md` itself and
// gitignored paths left out). The skill folder must resolve to exactly its own path through the frozen guard
// (`resolveWorkspacePath`; a link anywhere on the path gives no files); a listing that fails leaves `files` empty and
// never fails the load.
//
// Without an open project folder of the catalog's project (a folder that could not be opened) a project skill loads
// without `baseDir` / `files`: `read_file` is not offered then.
//
// An unknown, turned-off, invalid or unreadable skill rejects with a `HarnessError` (`not_found`, or the load's own
// code) whose message names the problem and lists the available skills (the tool error the model reads); a catalog
// without skills rejects with `SKILLS_UNAVAILABLE_TEXT`. An abort of `signal` rejects with its reason. Skill bodies are
// never logged (names, sizes and counts at debug only).
//
// Phase 11 (ADR-052; W11.6): a skill with `disable-model-invocation: true` (`entry.modelInvocable === false`, checked
// again on the loaded fields) is only for the user (`/name`): `loadSkill` refuses it (`forbidden`, "only the user can
// run it"), and the available skills an error lists, like the skills block of the instructions, are the model-invocable
// ones only (`modelInvocableSkills`); a catalog without any rejects with `SKILLS_UNAVAILABLE_TEXT`.
//
// Phase 12 (ADR-053 / ADR-058, open point 10; W12.7 behind the C44 seams): `loadSkill(context, name, signal, options?)`
// takes the `skill` call's options (`LoadSkillOptions` of `agent-scope.ts`) and its call scope (`skills-call.ts`: the
// chat id, the run's sub-agent runner):
// - names: `catalog.skill(name)` resolves a qualified name, a unique bare alias and a harness plugin's
//   `<pluginId>:<name>` (`services/customizations/qualified.ts`);
// - the body goes through `argumentOptions` with no input (`$ARGUMENTS` empty) and the variables `CLAUDE_SESSION_ID`,
//   `CLAUDE_PROJECT_DIR` (the open project folder) and `CLAUDE_SKILL_DIR` (a project skill's project-relative folder, a
//   plugin skill's absolute folder; a personal skill's stays as written);
// - a plugin skill lists its supporting files through the skill-files helper (`plugins/claude/skill-files.ts`, W12.1;
//   `fileAccess: 'skill'`, no `baseDir`); `file` reads one of them (`file: { path, content, truncated }`, `content` empty)
//   through the same helper with the plugin's realpath as the root, and a project skill's file with the project root
//   (its listing keeps `baseDir` and `read_file`); a refused path (`../x`, a link, a hidden or secret-looking file) is a
//   tool error; `read_file` is not widened;
// - a fork skill (`context: fork`) with the call's `toolCallId` and a call scope runs ONE child of its `agent` type
//   (default `general`) through `runSubagent` with the expanded body as the prompt (≤ `LIMITS.taskPromptMaxChars`) and
//   answers the child's report as `content` (a stopped or failed child is a tool error; a child at its limit returns
//   its partial report with a note).
import type { CustomizationEntry, SkillOutput, TaskInput, TaskOutput } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { PluginSkillFile } from '../plugins/claude/types.ts'
import type { CustomizationCatalog } from '../services/customizations/types.ts'
import type { OpenWorkspace } from '../services/projects/types.ts'
import type { AppDeps } from '../types.ts'
import type { LoadSkillOptions } from './agent-scope.ts'
import type { SkillCallScope } from './skills-call.ts'
import { Buffer } from 'node:buffer'
import { join, posix, resolve } from 'node:path'
import { expandArguments, HarnessError, isHarnessError, LIMITS, skillInvocation } from '@harness-forge/shared'
import { listPluginSkillFiles, readPluginSkillFile } from '../plugins/claude/skill-files.ts'
import { resolveWorkspacePath, toWorkspaceRel } from '../workspace/paths.ts'
import { isHiddenWorkspacePath, isSecretLookingPath } from '../workspace/sensitive.ts'
import { walkWorkspace } from '../workspace/walk.ts'
import { argumentOptions, FORK_DEFAULT_AGENT } from './commands.ts'
import { isAbortError } from './errors.ts'
import { skillCallScopeOf } from './skills-call.ts'

/** The error of a run whose catalog has no active skill (the `skill` tool is not offered then). */
export const SKILLS_UNAVAILABLE_TEXT = 'No skills are available in this chat.'

/** Folder levels below a skill folder that the supporting-file listing enters. */
export const SKILL_FILES_MAX_DEPTH = 3
/** Directory entries the supporting-file listing looks at before it stops. */
export const SKILL_FILES_MAX_ENTRIES = 2000
/** The supporting-file listing stops after this long. */
export const SKILL_FILES_TIMEOUT_MS = 2000

/** Characters of a skill name quoted in an error (a name the model sent can be anything). */
const QUOTED_NAME_MAX_CHARS = 64

/** What `loadSkill` reads (bound once per run by the pipeline). */
export interface SkillLoadContext {
  /** The services (`customizations.load`, the redactor). */
  readonly deps: AppDeps
  /** The run's catalog snapshot (`PreparedRun.catalog`). */
  readonly catalog: CustomizationCatalog
  /** The run's open project folder (the root of a project skill's folder), or null. */
  readonly workspace: OpenWorkspace | null
  readonly logger: Logger
  /** Phase 12: the supporting-file helpers (default `plugins/claude/skill-files.ts`); tests inject fakes. */
  readonly skillFiles?: SkillFileHelpers
}

/** `text` cut to at most `maxBytes` UTF-8 bytes at a character boundary. */
export function capUtf8(text: string, maxBytes: number): { text: string, truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes)
    return { text, truncated: false }
  let end = Math.max(0, maxBytes)
  // A continuation byte (10xxxxxx) at the cut belongs to a character that does not fit: drop the whole character.
  while (end > 0 && (bytes[end]! & 0xC0) === 0x80)
    end -= 1
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

function quoted(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim()
  const cut = flat.length > QUOTED_NAME_MAX_CHARS ? `${flat.slice(0, QUOTED_NAME_MAX_CHARS)}…` : flat
  return `"${cut}"`
}

/**
 * The skills the model may load (Phase 11, ADR-052): the entries without `modelInvocable: false`
 * (`disable-model-invocation: true`), in their order. What the skills block lists and what decides whether the `skill`
 * tool is offered.
 */
export function modelInvocableSkills<T extends Pick<CustomizationEntry, 'modelInvocable'>>(skills: readonly T[]): T[] {
  return skills.filter(entry => entry.modelInvocable !== false)
}

/** " Available skills: a, b." (at most `LIMITS.skillsListedMax` names), or "" when the model may load none. */
function availableSuffix(catalog: CustomizationCatalog): string {
  const names = modelInvocableSkills(catalog.skills()).map(entry => entry.name)
  if (names.length === 0)
    return ''
  const listed = names.slice(0, LIMITS.skillsListedMax)
  const more = names.length > listed.length ? `, … (${names.length - listed.length} more)` : ''
  return ` Available skills: ${listed.join(', ')}${more}.`
}

/** The error of a skill only the user may run (`disable-model-invocation: true`, Phase 11). */
function userOnlySkill(catalog: CustomizationCatalog, name: string): HarnessError {
  const message = `The skill ${quoted(name)} can only be run by the user (as /${name}); you cannot load it.${availableSuffix(catalog)}`
  return new HarnessError({ code: 'forbidden', message, details: { name } })
}

/** The error of a name the catalog has no active skill for (unknown, turned off, invalid or shadowed by nothing). */
function unavailableSkill(catalog: CustomizationCatalog, name: string): HarnessError {
  if (modelInvocableSkills(catalog.skills()).length === 0)
    return new HarnessError({ code: 'not_found', message: SKILLS_UNAVAILABLE_TEXT, details: { name } })
  const listed = catalog.entries.filter(entry => entry.kind === 'skill' && entry.name === name)
  const reason = listed.some(entry => entry.state === 'off')
    ? `The skill ${quoted(name)} is turned off.`
    : listed.some(entry => entry.state === 'invalid')
      ? `The skill ${quoted(name)} is not valid.`
      : `Unknown skill ${quoted(name)}.`
  return new HarnessError({ code: 'not_found', message: `${reason}${availableSuffix(catalog)}`, details: { name } })
}

/** The error of an active skill whose body could not be read again (gone, renamed, invalid, unreadable). */
function unreadableSkill(catalog: CustomizationCatalog, entry: CustomizationEntry, error: unknown): HarnessError {
  const code = isHarnessError(error) ? error.code : 'internal_error'
  const detail = isHarnessError(error) && error.message.trim() !== '' ? ` ${error.message.trim().replace(/\.*$/, '.')}` : ''
  return new HarnessError({
    code,
    message: `The skill ${quoted(entry.name)} could not be loaded.${detail}${availableSuffix(catalog)}`,
    details: { name: entry.name },
  })
}

/** The project-relative folder of a project skill (`.harness/skills/pdf` of `.harness/skills/pdf/SKILL.md`), or null. */
export function skillBaseDir(entry: Pick<CustomizationEntry, 'source' | 'path'>): string | null {
  if (entry.source !== 'project' || entry.path === undefined)
    return null
  const dir = posix.dirname(entry.path.replaceAll('\\', '/'))
  return dir === '.' || dir === '' || dir.startsWith('..') || dir.startsWith('/') ? null : dir
}

/**
 * The supporting files of a skill folder (`baseDir`, project-relative), relative to it: see the module comment. Throws
 * when the folder is refused by the guard or goes through a link; aborts with `signal`.
 */
export async function listSkillFiles(root: string, baseDir: string, skillFile: string, signal: AbortSignal): Promise<string[]> {
  const lexical = toWorkspaceRel(root, resolve(root, baseDir))
  const folder = await resolveWorkspacePath(root, baseDir)
  // A link anywhere on the path (even one into the project) makes the resolved path differ from the spelled one.
  if (folder.rel !== lexical)
    throw new HarnessError({ code: 'validation_error', message: `The skill folder "${lexical}" goes through a symbolic link.` })
  const walk = await walkWorkspace({
    root,
    start: folder.absolute,
    signal,
    maxDepth: SKILL_FILES_MAX_DEPTH,
    maxEntries: SKILL_FILES_MAX_ENTRIES,
    timeoutMs: SKILL_FILES_TIMEOUT_MS,
  })
  const files: string[] = []
  for (const file of walk.files) {
    if (file.link || file.fromStart === skillFile)
      continue
    if (isHiddenWorkspacePath(file.fromStart) || isSecretLookingPath(file.fromStart))
      continue
    if (file.fromStart.length > LIMITS.workspacePathMaxChars || `${lexical}/${file.fromStart}`.length > LIMITS.workspacePathMaxChars)
      continue
    files.push(file.fromStart)
    if (files.length >= LIMITS.skillFilesListedMax)
      break
  }
  return files
}

/**
 * The body of a loaded skill as the model reads it (Phase 12): expanded with `argumentOptions` and no input (the model
 * loads a skill without arguments: `$ARGUMENTS` is empty), the `${CLAUDE_…}` variables of `vars` substituted; an
 * unknown variable (a personal skill's `${CLAUDE_SKILL_DIR}`) stays as written.
 */
export function skillBody(content: string, names: readonly string[] | null | undefined, vars: Readonly<Record<string, string>>): string {
  return expandArguments(content, '', argumentOptions({ body: content, names: names ?? null, vars })).text
}

/** The supporting-file helpers of plugin skills (`plugins/claude/skill-files.ts`, W12.1); tests inject fakes. */
export interface SkillFileHelpers {
  readonly list: (root: string, baseDir: string, signal?: AbortSignal) => Promise<string[]>
  readonly read: (root: string, baseDir: string, file: string, signal?: AbortSignal) => Promise<PluginSkillFile>
}

const DEFAULT_SKILL_FILES: SkillFileHelpers = { list: listPluginSkillFiles, read: readPluginSkillFile }

/** The folder of a skill's supporting files: a project skill's (in the open project) or a plugin skill's. */
interface SkillFolder {
  /** `workspace`: a project skill (the model reads files with `read_file`); `skill`: a plugin skill (`skill { file }`). */
  readonly access: 'workspace' | 'skill'
  /** The canonical root the folder is resolved in (the project root, the plugin's realpath). */
  readonly root: string
  /** The folder, relative to `root` (`.harness/skills/pdf`, `skills/pdf`, `.` for a plugin's root `SKILL.md`). */
  readonly baseDir: string
  /** `${CLAUDE_SKILL_DIR}`: the project-relative folder of a project skill, the absolute folder of a plugin skill. */
  readonly variable: string
}

/** The plugin-relative folder of an active plugin skill (`SkillDefinition.baseDir` of the registry), or null. */
function registeredBaseDir(context: SkillLoadContext, entry: CustomizationEntry): string | null {
  if (entry.source !== 'plugin' || entry.pluginId === undefined)
    return null
  let baseDir: unknown
  try {
    const registered = context.deps.registry.skills.get(entry.name)
    baseDir = registered?.pluginId === entry.pluginId ? registered.definition.baseDir : undefined
  }
  catch {
    return null
  }
  if (typeof baseDir !== 'string' || baseDir === '' || baseDir.startsWith('/') || baseDir.includes('\\') || baseDir.split('/').includes('..'))
    return null
  return baseDir
}

/** The supporting-file folder of a skill (see `SkillFolder`), or null (a personal or builtin skill, no open folder). */
async function skillFolder(context: SkillLoadContext, entry: CustomizationEntry): Promise<SkillFolder | null> {
  if (entry.source === 'project') {
    const workspace = context.workspace
    const baseDir = skillBaseDir(entry)
    if (baseDir === null || workspace === null || context.catalog.projectId !== workspace.projectId)
      return null
    return { access: 'workspace', root: workspace.root, baseDir, variable: baseDir }
  }
  const baseDir = registeredBaseDir(context, entry)
  if (baseDir === null || entry.pluginId === undefined)
    return null
  let root: string | null
  try {
    root = await context.deps.plugins.directory(entry.pluginId)
  }
  catch {
    return null
  }
  if (root === null)
    return null
  return { access: 'skill', root, baseDir, variable: baseDir === '.' ? root : join(root, baseDir) }
}

/** The `${…}` variables of a skill body loaded by the model (Phase 12, ADR-058). */
function skillVars(context: SkillLoadContext, folder: SkillFolder | null, chatId: string | null): Record<string, string> {
  const vars: Record<string, string> = {}
  if (chatId !== null)
    vars.CLAUDE_SESSION_ID = chatId
  const workspace = context.workspace
  if (workspace !== null && context.catalog.projectId === workspace.projectId)
    vars.CLAUDE_PROJECT_DIR = workspace.root
  if (folder !== null)
    vars.CLAUDE_SKILL_DIR = folder.variable
  return vars
}

/** The error of a `file` read of a skill without a folder of supporting files. */
function noSkillFiles(entry: CustomizationEntry): HarnessError {
  return new HarnessError({ code: 'not_found', message: `The skill ${quoted(entry.name)} has no supporting files to read.`, details: { name: entry.name } })
}

/** One supporting file of a skill (`skill { name, file }`, Phase 12): read through the skill-files helper. */
async function readSkillFile(context: SkillLoadContext, entry: CustomizationEntry, description: string, file: string, signal: AbortSignal): Promise<SkillOutput> {
  const folder = await skillFolder(context, entry)
  signal.throwIfAborted()
  if (folder === null)
    throw noSkillFiles(entry)
  const helpers = context.skillFiles ?? DEFAULT_SKILL_FILES
  let read: PluginSkillFile
  try {
    read = await helpers.read(folder.root, folder.baseDir, file, signal)
  }
  catch (error) {
    signal.throwIfAborted()
    if (isHarnessError(error)) {
      context.logger.debug('skill file not read', { name: entry.name, source: entry.source, code: error.code })
      throw new HarnessError({ code: error.code, message: `The skill ${quoted(entry.name)} has no readable file ${quoted(file)}. ${error.message}`.slice(0, 1000), details: { name: entry.name } })
    }
    context.logger.warn('skill file not read', { name: entry.name, source: entry.source, err: error })
    throw new HarnessError({ code: 'internal_error', message: `The file ${quoted(file)} of the skill ${quoted(entry.name)} could not be read.`, details: { name: entry.name } })
  }
  signal.throwIfAborted()
  const content = capUtf8(read.content, LIMITS.skillFileReadBytes)
  context.logger.debug('skill file read', { name: entry.name, source: entry.source, bytes: Buffer.byteLength(content.text, 'utf8'), truncated: read.truncated || content.truncated })
  return {
    name: entry.name,
    description,
    source: entry.source,
    content: '',
    truncated: false,
    fileAccess: folder.access,
    file: { path: read.path, content: content.text, truncated: read.truncated || content.truncated },
  }
}

/** The task description of a fork skill's child (3..80 characters). */
function forkDescription(name: string): string {
  const text = `Skill ${name}`
  return text.length <= 80 ? text : `${text.slice(0, 79)}…`
}

/** The text a fork skill returns when its child stopped at its limit (the partial report first). */
export const FORK_LIMIT_NOTE = '(The sub-agent stopped at its limit; this report may be incomplete.)'

/**
 * A fork skill loaded through `skill` (Phase 12, ADR-058: `context: fork`): runs one child of the skill's `agent` type
 * (default `general`) with the expanded body as its prompt through the run's sub-agent runner (`runSubagent`, under the
 * `skill` call's id) and returns its report as `content`. A child that failed or was stopped is a tool error.
 */
async function runForkSkill(entry: CustomizationEntry, base: SkillOutput, agent: string, prompt: string, runner: NonNullable<SkillCallScope['runSubagent']>, toolCallId: string, signal: AbortSignal, logger: Logger): Promise<SkillOutput> {
  const input: TaskInput = { description: forkDescription(entry.name), prompt: prompt.slice(0, LIMITS.taskPromptMaxChars), type: agent }
  let last: TaskOutput | null = null
  for await (const output of runner(input, { toolCallId, signal }))
    last = output
  signal.throwIfAborted()
  logger.debug('fork skill finished', { name: entry.name, agent, status: last?.status ?? null })
  if (last === null || last.status === 'failed' || last.status === 'aborted' || last.status === 'queued' || last.status === 'running' || last.status === 'background') {
    const reason = last?.error?.trim() ?? ''
    throw new HarnessError({
      code: 'internal_error',
      message: `The skill ${quoted(entry.name)} runs in a sub-agent, which did not finish.${reason === '' ? '' : ` ${reason}`}`.slice(0, 2000),
      details: { name: entry.name },
    })
  }
  const report = last.status === 'limit' ? [last.report.trim(), FORK_LIMIT_NOTE].filter(part => part !== '').join('\n\n') : last.report
  const content = capUtf8(report, LIMITS.customizationContentBytes)
  return { ...base, content: content.text, truncated: content.truncated }
}

/**
 * Loads one skill of the run's catalog (see the module comment). Phase 12 (`LoadSkillOptions`): `file` reads one
 * supporting file of a plugin or project skill; a fork skill (`context: fork`) with the call's `toolCallId` and a call
 * scope (`skillCallScopeOf`) runs as a sub-agent and answers its report; the body gets its `${CLAUDE_…}` variables.
 */
export async function loadSkill(context: SkillLoadContext, name: string, signal: AbortSignal, options?: LoadSkillOptions): Promise<SkillOutput> {
  const { catalog, logger } = context
  signal.throwIfAborted()
  const wanted = typeof name === 'string' ? name.trim().toLowerCase() : ''
  const entry = catalog.skill(wanted)
  if (entry === null) {
    logger.debug('skill not available', { name: wanted.slice(0, QUOTED_NAME_MAX_CHARS) })
    throw unavailableSkill(catalog, wanted)
  }
  if (entry.modelInvocable === false) {
    logger.debug('skill not model-invocable', { name: entry.name, source: entry.source })
    throw userOnlySkill(catalog, entry.name)
  }

  let loaded
  try {
    loaded = await context.deps.customizations.load(entry, signal)
  }
  catch (error) {
    if (signal.aborted && isAbortError(error))
      throw error
    signal.throwIfAborted()
    if (isHarnessError(error))
      logger.debug('skill could not be loaded', { name: entry.name, source: entry.source, code: error.code })
    else
      logger.warn('skill could not be loaded', { name: entry.name, source: entry.source, err: error })
    throw unreadableSkill(catalog, entry, error)
  }
  signal.throwIfAborted()
  const definition = loaded.definition
  if (definition.kind !== 'skill')
    throw unreadableSkill(catalog, entry, new HarnessError({ code: 'not_found', message: 'It is not a skill.' }))
  // The file may have changed since the catalog listed it.
  if (!skillInvocation(definition.fields).modelInvocable) {
    logger.debug('skill not model-invocable', { name: entry.name, source: entry.source })
    throw userOnlySkill(catalog, entry.name)
  }

  const description = (definition.fields.description || entry.description).slice(0, LIMITS.customizationDescriptionMaxChars)
  const file = typeof options?.file === 'string' && options.file !== '' ? options.file : undefined
  if (file !== undefined)
    return readSkillFile(context, entry, description, file, signal)

  const call = skillCallScopeOf(options)
  const folder = await skillFolder(context, entry)
  signal.throwIfAborted()
  const expanded = skillBody(definition.fields.content, definition.fields.arguments, skillVars(context, folder, call?.chatId ?? null))
  const body = capUtf8(expanded, LIMITS.customizationContentBytes)
  const output: SkillOutput = { name: entry.name, description, source: entry.source, content: body.text, truncated: body.truncated }

  const toolCallId = typeof options?.toolCallId === 'string' && options.toolCallId !== '' ? options.toolCallId : undefined
  if (definition.fields.context === 'fork' && toolCallId !== undefined && call?.runSubagent !== undefined)
    return runForkSkill(entry, output, definition.fields.agent ?? FORK_DEFAULT_AGENT, expanded, call.runSubagent, toolCallId, signal, logger)

  if (folder !== null && folder.access === 'workspace') {
    let files: string[] = []
    try {
      files = await listSkillFiles(folder.root, folder.baseDir, posix.basename(entry.path!.replaceAll('\\', '/')), signal)
    }
    catch (error) {
      signal.throwIfAborted()
      logger.debug('skill files not listed', { name: entry.name, code: isHarnessError(error) ? error.code : undefined })
    }
    output.baseDir = folder.baseDir
    output.files = files
  }
  else if (folder !== null) {
    let files: string[] = []
    try {
      files = (await (context.skillFiles ?? DEFAULT_SKILL_FILES).list(folder.root, folder.baseDir, signal)).slice(0, LIMITS.skillFilesListedMax)
    }
    catch (error) {
      signal.throwIfAborted()
      logger.debug('skill files not listed', { name: entry.name, code: isHarnessError(error) ? error.code : undefined })
    }
    output.fileAccess = 'skill'
    output.files = files
  }
  logger.debug('skill loaded', {
    name: entry.name,
    source: entry.source,
    bytes: Buffer.byteLength(output.content, 'utf8'),
    truncated: output.truncated,
    files: output.files?.length ?? 0,
  })
  return output
}
