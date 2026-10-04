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
import type { CustomizationEntry, SkillOutput } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { CustomizationCatalog } from '../services/customizations/types.ts'
import type { OpenWorkspace } from '../services/projects/types.ts'
import type { AppDeps } from '../types.ts'
import { Buffer } from 'node:buffer'
import { posix, resolve } from 'node:path'
import { HarnessError, isHarnessError, LIMITS } from '@harness-forge/shared'
import { resolveWorkspacePath, toWorkspaceRel } from '../workspace/paths.ts'
import { isHiddenWorkspacePath, isSecretLookingPath } from '../workspace/sensitive.ts'
import { walkWorkspace } from '../workspace/walk.ts'
import { isAbortError } from './errors.ts'

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

/** " Available skills: a, b." (at most `LIMITS.skillsListedMax` names), or "" when the catalog has none. */
function availableSuffix(catalog: CustomizationCatalog): string {
  const names = catalog.skills().map(entry => entry.name)
  if (names.length === 0)
    return ''
  const listed = names.slice(0, LIMITS.skillsListedMax)
  const more = names.length > listed.length ? `, … (${names.length - listed.length} more)` : ''
  return ` Available skills: ${listed.join(', ')}${more}.`
}

/** The error of a name the catalog has no active skill for (unknown, turned off, invalid or shadowed by nothing). */
function unavailableSkill(catalog: CustomizationCatalog, name: string): HarnessError {
  if (catalog.skills().length === 0)
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

/** Loads one skill of the run's catalog (see the module comment). */
export async function loadSkill(context: SkillLoadContext, name: string, signal: AbortSignal): Promise<SkillOutput> {
  const { catalog, logger } = context
  signal.throwIfAborted()
  const wanted = typeof name === 'string' ? name.trim().toLowerCase() : ''
  const entry = catalog.skill(wanted)
  if (entry === null) {
    logger.debug('skill not available', { name: wanted.slice(0, QUOTED_NAME_MAX_CHARS) })
    throw unavailableSkill(catalog, wanted)
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

  const body = capUtf8(definition.fields.content, LIMITS.customizationContentBytes)
  const description = (definition.fields.description || entry.description).slice(0, LIMITS.customizationDescriptionMaxChars)
  const output: SkillOutput = { name: entry.name, description, source: entry.source, content: body.text, truncated: body.truncated }

  const workspace = context.workspace
  const baseDir = skillBaseDir(entry)
  if (baseDir !== null && workspace !== null && catalog.projectId === workspace.projectId) {
    let files: string[] = []
    try {
      files = await listSkillFiles(workspace.root, baseDir, posix.basename(entry.path!.replaceAll('\\', '/')), signal)
    }
    catch (error) {
      signal.throwIfAborted()
      logger.debug('skill files not listed', { name: entry.name, code: isHarnessError(error) ? error.code : undefined })
    }
    output.baseDir = baseDir
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
