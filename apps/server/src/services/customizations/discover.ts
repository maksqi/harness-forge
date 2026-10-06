// Discovery of a project's definition files (Phase 10, ADR-044; ARCHITECTURE.md 6.23 "Discovery", 10.11). Owner: W10.1.
//
// For each folder F of `.claude/{agents,commands,skills}` then `.harness/{…}` (lowest precedence first):
// - `resolveWorkspacePath(root, F)` must exist, resolve to exactly F (`resolved.rel === F` proves that no symbolic link
//   sits anywhere on the path) and be a directory; a linked F (or a linked `.harness`) is skipped with `link`;
// - `opendir` with dirent types: only regular files count (a link is never followed, it is skipped with `link`), hidden
//   names are skipped, only `.md`; agents: the folder's own files; commands: `**/*.md` up to 3 folders deep (the folder
//   path is the display-only `namespace`); skills: `<dir>/SKILL.md` one level down (the folder name is the name
//   fallback); every subfolder is checked the same way as F before it is listed;
// - at most `LIMITS.customizationFilesPerFolderMax` (200) definitions per F, the first sorted paths (the rest `limit`);
//   at most `DIRENTS_SCANNED_MAX` entries looked at per folder;
// - each file: the sensitive-path rules (a secret-looking name is never read), `resolveWorkspacePath` again (the same
//   `rel` equality), `openWorkspaceFile` (`O_NOFOLLOW | O_NONBLOCK`, `fstat`: a regular file), at most 64 KiB
//   (`too-large`), only the first `DISCOVERY_READ_BYTES` read (the frontmatter: 8 KiB plus its delimiter lines and the
//   start of the body), the NUL probe of the first 8 KiB (`binary`), UTF-8; parsed with the shared `parseDefinition`
//   (a truncated read whose parse fails is read again whole, so a long file is never judged on a cut);
// - diagnostics carry project-relative paths only and never file contents; nothing outside the project folder (and
//   nothing from the home folder) is ever read.
//
// `readDefinitionFile` is the one reader of definition files: discovery reads the head, `load` and `source` the whole
// file (≤ 64 KiB), through the same guards. Accepted race (ARCHITECTURE.md 10.11): a parent folder swapped for a link
// between its check and the open of a file below it (`O_NOFOLLOW` covers the last segment only).
import type { CustomizationEntry, CustomizationKind, DefinitionDiagnostic, DefinitionFolder, ParseDefinitionOptions } from '@harness-forge/shared'
import type { OpenedWorkspaceFile } from '../../workspace/paths.ts'
import { Buffer } from 'node:buffer'
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { CUSTOMIZATION_KINDS, DEFINITION_FOLDERS, DEFINITION_LIMITS, isHarnessError, LIMITS, parseDefinition } from '@harness-forge/shared'
import { openWorkspaceFile, resolveWorkspacePath } from '../../workspace/paths.ts'
import { isSecretLookingPath } from '../../workspace/sensitive.ts'
import { DIAGNOSTICS_MAX, entryFromParse, pushDiagnostic } from './entries.ts'

/** The folder of each kind below `.claude` / `.harness` (Phase 11: output styles, ADR-051). */
export const DEFINITION_KIND_FOLDERS: Readonly<Record<CustomizationKind, string>> = { agent: 'agents', command: 'commands', skill: 'skills', style: 'output-styles' }

/** One definition folder of a project. */
export interface ProjectDefinitionFolder {
  readonly base: DefinitionFolder
  readonly kind: CustomizationKind
  /** `.claude/agents`, …, `.harness/skills`. */
  readonly folder: string
}

/** The eight definition folders, lowest precedence first (every `.claude` folder before every `.harness` one). */
export const PROJECT_DEFINITION_FOLDERS: readonly ProjectDefinitionFolder[] = Object.freeze(DEFINITION_FOLDERS.flatMap(base =>
  CUSTOMIZATION_KINDS.map(kind => Object.freeze({ base, kind, folder: `${base}/${DEFINITION_KIND_FOLDERS[kind]}` }))))

/** Folder levels below a commands folder that are read (`frontend/forms/a/x.md` is 3 deep; one more is ignored). */
export const COMMAND_FOLDER_DEPTH_MAX = 3
/** Subfolders of one commands folder that are listed (the rest `limit`). */
export const COMMAND_SUBFOLDERS_MAX = 100
/** Directory entries looked at per folder (the rest `limit`): a huge folder never costs more than this. */
export const DIRENTS_SCANNED_MAX = 2000
/** Bytes read per file by discovery: the 8 KiB frontmatter cap plus the delimiter lines and the start of the body. */
export const DISCOVERY_READ_BYTES = DEFINITION_LIMITS.frontmatterBytes + 1024
/** Bytes checked for a NUL byte (a binary file). */
export const BINARY_PROBE_BYTES = 8192
/** Files read at the same time by one discovery. */
export const DISCOVERY_CONCURRENCY = 8

/** The opener of definition files (`openWorkspaceFile`; a test seam). */
export type OpenDefinitionFile = (root: string, rel: string) => Promise<OpenedWorkspaceFile>

/** Why a definition file was not read. */
export type DefinitionReadFailure = 'missing' | 'link' | 'secret' | 'too-large' | 'binary' | 'failed'

export type DefinitionRead
  = | { readonly ok: true, readonly text: string, readonly more: boolean, readonly size: number }
    | { readonly ok: false, readonly reason: DefinitionReadFailure }

export interface ReadDefinitionOptions {
  /** Bytes returned at most (≤ 64 KiB); a longer file returns its head with `more: true`. */
  readonly maxBytes: number
  readonly openFile?: OpenDefinitionFile
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

/**
 * True when an existing segment of `rel` below `root` is a symbolic link (`lstat` never follows one). Classifies a
 * refused path; `rel` is a path discovery built itself.
 */
async function linkOnPath(root: string, rel: string): Promise<boolean> {
  let current = root
  for (const segment of rel.split('/')) {
    current = join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink())
        return true
    }
    catch {
      return false
    }
  }
  return false
}

/** The reason of a refused open: missing, a link somewhere on the path, else a failure (permissions, a race). */
async function failureOf(root: string, rel: string, error: unknown): Promise<DefinitionReadFailure> {
  if (isHarnessError(error) && error.code === 'not_found')
    return 'missing'
  return await linkOnPath(root, rel) ? 'link' : 'failed'
}

/** Drops an incomplete UTF-8 sequence at the end of a cut read (so it never decodes to a replacement character). */
function completeUtf8(bytes: Uint8Array, cut: boolean): Uint8Array {
  if (!cut || bytes.length === 0)
    return bytes
  let lead = bytes.length - 1
  while (lead > 0 && (bytes[lead]! & 0xC0) === 0x80)
    lead -= 1
  const first = bytes[lead]!
  const size = first >= 0xF0 ? 4 : first >= 0xE0 ? 3 : first >= 0xC0 ? 2 : 1
  return lead + size <= bytes.length ? bytes : bytes.subarray(0, lead)
}

/**
 * Reads a definition file of the project folder `root` (a canonical realpath) through the workspace guards: never a
 * secret-looking name, no link anywhere on the path (`resolved.rel === rel`, before and after the open), a regular file
 * of at most 64 KiB, no NUL byte in the first 8 KiB. Never throws.
 */
export async function readDefinitionFile(root: string, rel: string, options: ReadDefinitionOptions): Promise<DefinitionRead> {
  if (isSecretLookingPath(rel))
    return { ok: false, reason: 'secret' }
  try {
    const resolved = await resolveWorkspacePath(root, rel)
    if (resolved.rel !== rel)
      return { ok: false, reason: 'link' }
  }
  catch (error) {
    return { ok: false, reason: await failureOf(root, rel, error) }
  }
  let opened: OpenedWorkspaceFile
  try {
    opened = await (options.openFile ?? openWorkspaceFile)(root, rel)
  }
  catch (error) {
    return { ok: false, reason: await failureOf(root, rel, error) }
  }
  try {
    if (opened.resolved.rel !== rel)
      return { ok: false, reason: 'link' }
    if (!opened.stats.isFile())
      return { ok: false, reason: 'failed' }
    const contentBytes = DEFINITION_LIMITS.contentBytes
    if (opened.stats.size > contentBytes)
      return { ok: false, reason: 'too-large' }
    const cap = Math.max(0, Math.min(Math.floor(options.maxBytes), contentBytes))
    // One byte more than asked tells a file that fits exactly from a longer one.
    const buffer = Buffer.alloc(cap + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await opened.handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0)
        break
      length += bytesRead
    }
    const more = length > cap
    // A whole read that grew past the cap while it was read.
    if (more && cap === contentBytes)
      return { ok: false, reason: 'too-large' }
    const bytes = buffer.subarray(0, Math.min(length, cap))
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0))
      return { ok: false, reason: 'binary' }
    const text = new TextDecoder('utf-8').decode(completeUtf8(bytes, more))
    return { ok: true, text, more, size: opened.stats.size }
  }
  catch {
    return { ok: false, reason: 'failed' }
  }
  finally {
    await opened.handle.close().catch(() => {})
  }
}

// ---------- folders ----------

type FolderCheck
  = | { readonly ok: true, readonly absolute: string }
    | { readonly ok: false, readonly reason: 'missing' | 'link' | 'not-folder' | 'failed' }

/** A definition folder (or a subfolder of one): it exists, resolves to itself (no link on the path) and is a folder. */
async function checkFolder(root: string, rel: string): Promise<FolderCheck> {
  let absolute: string
  try {
    const resolved = await resolveWorkspacePath(root, rel)
    if (resolved.rel !== rel)
      return { ok: false, reason: 'link' }
    absolute = resolved.absolute
  }
  catch (error) {
    const reason = await failureOf(root, rel, error)
    return { ok: false, reason: reason === 'missing' || reason === 'link' ? reason : 'failed' }
  }
  try {
    const stats = await lstat(absolute)
    if (stats.isSymbolicLink())
      return { ok: false, reason: 'link' }
    if (!stats.isDirectory())
      return { ok: false, reason: 'not-folder' }
    return { ok: true, absolute }
  }
  catch (error) {
    return { ok: false, reason: errorCode(error) === 'ENOENT' ? 'missing' : 'failed' }
  }
}

interface FolderItem {
  readonly name: string
  readonly type: 'file' | 'folder' | 'link' | 'other'
}

interface FolderListing {
  readonly items: readonly FolderItem[]
  /** More than `DIRENTS_SCANNED_MAX` entries: the rest was not looked at. */
  readonly truncated: boolean
}

/** The non-hidden entries of a checked folder with their types (links never followed); null when it cannot be read. */
async function listFolder(absolute: string): Promise<FolderListing | null> {
  const items: FolderItem[] = []
  let scanned = 0
  let truncated = false
  try {
    const dir = await opendir(absolute, { bufferSize: 64 })
    // `for await` closes the folder when the loop ends, breaks or throws.
    for await (const dirent of dir) {
      scanned += 1
      if (scanned > DIRENTS_SCANNED_MAX) {
        truncated = true
        break
      }
      if (dirent.name.startsWith('.'))
        continue
      const type = dirent.isSymbolicLink() ? 'link' : dirent.isFile() ? 'file' : dirent.isDirectory() ? 'folder' : 'other'
      items.push({ name: dirent.name, type })
    }
  }
  catch {
    return null
  }
  return { items, truncated }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---------- discovery ----------

/** A definition file found by a folder listing, before it is read. */
interface Candidate {
  readonly kind: CustomizationKind
  /** Project-relative path. */
  readonly path: string
  readonly namespace?: string
  readonly parse: ParseDefinitionOptions
  /** The name of an entry that cannot be read (the file stem or the skill folder). */
  readonly fallbackName: string
}

/** The project part of a catalog: what `discoverProject` found. */
export interface ProjectDiscovery {
  /** Project entries (`source: 'project'`, `state: 'active' | 'invalid'`; the precedence is applied by the catalog). */
  readonly entries: CustomizationEntry[]
  /** Folder-level diagnostics (`link`, `limit`, `read-failed`), at most 100. */
  readonly diagnostics: DefinitionDiagnostic[]
  /** The definition folders that were read, lowest precedence first. */
  readonly folders: string[]
}

export interface DiscoverOptions {
  /** The opener of definition files (default `openWorkspaceFile`; tests spy on it). */
  readonly openFile?: OpenDefinitionFile
}

/** Collects folder-level diagnostics (at most `DIAGNOSTICS_MAX`). */
class FolderDiagnostics {
  readonly list: DefinitionDiagnostic[] = []

  add(code: 'link' | 'limit' | 'read-failed', path: string, message: string, level: 'warning' | 'info' = 'warning'): void {
    pushDiagnostic(this.list, { level, code, message, path })
  }

  link(path: string): void {
    this.add('link', path, `${path} is a symbolic link or goes through one; it was skipped.`)
  }

  unreadable(path: string): void {
    this.add('read-failed', path, `${path} could not be read; it was skipped.`)
  }

  limit(path: string, message: string): void {
    this.add('limit', path, message)
  }
}

function fileStem(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

function isMarkdown(name: string): boolean {
  return name.endsWith('.md') && name.length > 3
}

/** Keeps the first `LIMITS.customizationFilesPerFolderMax` candidates by path (a `limit` diagnostic for the rest). */
function capCandidates(folder: string, candidates: Candidate[], diagnostics: FolderDiagnostics): Candidate[] {
  candidates.sort((a, b) => compareText(a.path, b.path))
  const max = LIMITS.customizationFilesPerFolderMax
  if (candidates.length <= max)
    return candidates
  diagnostics.limit(folder, `${folder} has more than ${max} definitions; only the first ${max} are read.`)
  return candidates.slice(0, max)
}

function scanLimit(folder: string, diagnostics: FolderDiagnostics): void {
  diagnostics.limit(folder, `${folder} has more than ${DIRENTS_SCANNED_MAX} entries; the rest was not read.`)
}

/** The top-level `*.md` files of an agents folder (or, Phase 11, an output styles folder: the same layout). */
async function agentCandidates(folder: string, absolute: string, diagnostics: FolderDiagnostics, kind: 'agent' | 'style' = 'agent'): Promise<Candidate[]> {
  const listing = await listFolder(absolute)
  if (listing === null) {
    diagnostics.unreadable(folder)
    return []
  }
  if (listing.truncated)
    scanLimit(folder, diagnostics)
  const candidates: Candidate[] = []
  for (const item of listing.items) {
    if (!isMarkdown(item.name))
      continue
    const path = `${folder}/${item.name}`
    if (item.type === 'link')
      diagnostics.link(path)
    else if (item.type === 'file')
      candidates.push({ kind, path, parse: { fileName: item.name }, fallbackName: fileStem(item.name) })
  }
  return capCandidates(folder, candidates, diagnostics)
}

async function commandCandidates(root: string, folder: string, absolute: string, diagnostics: FolderDiagnostics): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  const queue: Array<{ rel: string, absolute: string | null, depth: number }> = [{ rel: folder, absolute, depth: 0 }]
  let subfolders = 0
  let subfoldersCut = false
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    let folderAbsolute = next.absolute
    if (folderAbsolute === null) {
      // A subfolder found by a listing: checked like the definition folder itself before it is read.
      const check = await checkFolder(root, next.rel)
      if (!check.ok) {
        if (check.reason === 'link')
          diagnostics.link(next.rel)
        else if (check.reason === 'failed')
          diagnostics.unreadable(next.rel)
        continue
      }
      folderAbsolute = check.absolute
    }
    const listing = await listFolder(folderAbsolute)
    if (listing === null) {
      diagnostics.unreadable(next.rel)
      continue
    }
    if (listing.truncated)
      scanLimit(next.rel, diagnostics)
    const namespace = next.depth === 0 ? undefined : next.rel.slice(folder.length + 1)
    for (const item of listing.items) {
      const path = `${next.rel}/${item.name}`
      if (item.type === 'link') {
        diagnostics.link(path)
      }
      else if (item.type === 'folder') {
        if (next.depth >= COMMAND_FOLDER_DEPTH_MAX)
          continue
        subfolders += 1
        if (subfolders > COMMAND_SUBFOLDERS_MAX) {
          if (!subfoldersCut)
            diagnostics.limit(folder, `${folder} has more than ${COMMAND_SUBFOLDERS_MAX} subfolders; the rest was not read.`)
          subfoldersCut = true
          continue
        }
        queue.push({ rel: path, absolute: null, depth: next.depth + 1 })
      }
      else if (item.type === 'file' && isMarkdown(item.name)) {
        candidates.push({
          kind: 'command',
          path,
          ...(namespace === undefined ? {} : { namespace }),
          parse: { fileName: item.name },
          fallbackName: fileStem(item.name),
        })
      }
    }
  }
  return capCandidates(folder, candidates, diagnostics)
}

async function skillCandidates(root: string, folder: string, absolute: string, diagnostics: FolderDiagnostics): Promise<Candidate[]> {
  const listing = await listFolder(absolute)
  if (listing === null) {
    diagnostics.unreadable(folder)
    return []
  }
  if (listing.truncated)
    scanLimit(folder, diagnostics)
  const names: string[] = []
  for (const item of listing.items) {
    if (item.type === 'link')
      diagnostics.link(`${folder}/${item.name}`)
    else if (item.type === 'folder')
      names.push(item.name)
  }
  names.sort(compareText)
  const max = LIMITS.customizationFilesPerFolderMax
  if (names.length > max) {
    diagnostics.limit(folder, `${folder} has more than ${max} skills; only the first ${max} are read.`)
    names.length = max
  }
  const candidates: Candidate[] = []
  for (const name of names) {
    const rel = `${folder}/${name}`
    const check = await checkFolder(root, rel)
    if (!check.ok) {
      if (check.reason === 'link')
        diagnostics.link(rel)
      else if (check.reason === 'failed')
        diagnostics.unreadable(rel)
      continue
    }
    const inner = await listFolder(check.absolute)
    if (inner === null) {
      diagnostics.unreadable(rel)
      continue
    }
    const skillFile = inner.items.find(item => item.name === 'SKILL.md')
    if (skillFile === undefined)
      continue
    const path = `${rel}/SKILL.md`
    if (skillFile.type === 'link')
      diagnostics.link(path)
    else if (skillFile.type === 'file')
      candidates.push({ kind: 'skill', path, parse: { folderName: name }, fallbackName: name })
  }
  return candidates
}

/** True when a parse of a cut head may differ from the parse of the whole file (read it whole). */
function needsWholeRead(result: ReturnType<typeof parseDefinition>): boolean {
  return result.definition === null || result.diagnostics.some(entry => entry.level === 'error' || entry.code === 'missing-field')
}

/** The diagnostic of an unreadable definition file (an `invalid` entry). */
export function readFailureDiagnostic(reason: 'too-large' | 'binary' | 'failed' | 'link', path: string): DefinitionDiagnostic {
  switch (reason) {
    case 'too-large':
      return { level: 'error', code: 'too-large', message: `The file is larger than ${DEFINITION_LIMITS.contentBytes / 1024} KiB.`, path }
    case 'binary':
      return { level: 'error', code: 'binary', message: 'The file is binary (it contains a NUL byte).', path }
    case 'link':
      return { level: 'error', code: 'link', message: 'The file is a symbolic link or goes through one.', path }
    case 'failed':
      return { level: 'error', code: 'read-failed', message: 'The file could not be read.', path }
  }
}

/** Reads and parses one candidate: an entry, a folder-level diagnostic, or nothing (the file disappeared). */
async function readCandidate(root: string, candidate: Candidate, options: DiscoverOptions, diagnostics: FolderDiagnostics): Promise<CustomizationEntry | null> {
  const { kind, path } = candidate
  const extra = { path, ...(candidate.namespace === undefined ? {} : { namespace: candidate.namespace }), fallbackName: candidate.fallbackName }
  let read = await readDefinitionFile(root, path, { maxBytes: DISCOVERY_READ_BYTES, openFile: options.openFile })
  let result = read.ok ? parseDefinition(kind, read.text, candidate.parse) : null
  if (read.ok && read.more && result !== null && needsWholeRead(result)) {
    read = await readDefinitionFile(root, path, { maxBytes: DEFINITION_LIMITS.contentBytes, openFile: options.openFile })
    result = read.ok ? parseDefinition(kind, read.text, candidate.parse) : null
  }
  if (!read.ok) {
    switch (read.reason) {
      case 'missing':
        return null
      case 'link':
        diagnostics.link(path)
        return null
      case 'secret':
        diagnostics.add('read-failed', path, `${path} has a secret-looking name; it was not read.`, 'info')
        return null
      default:
        return entryFromParse(kind, 'project', { definition: null, diagnostics: [readFailureDiagnostic(read.reason, path)] }, extra)
    }
  }
  return entryFromParse(kind, 'project', result ?? { definition: null, diagnostics: [] }, extra)
}

/** Runs `fn` over `items` with at most `limit` calls at a time; results keep the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  async function worker(): Promise<void> {
    for (let index = next++; index < items.length; index = next++)
      results[index] = await fn(items[index]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Discovers the definition files of the project folder `root` (a canonical realpath from `projects.openWorkspace`).
 * Never throws for a file or a folder; see the module comment for the rules.
 */
export async function discoverProject(root: string, options: DiscoverOptions = {}): Promise<ProjectDiscovery> {
  const diagnostics = new FolderDiagnostics()
  const folders: string[] = []
  const candidates: Candidate[] = []
  for (const { kind, folder } of PROJECT_DEFINITION_FOLDERS) {
    const check = await checkFolder(root, folder)
    if (!check.ok) {
      if (check.reason === 'link')
        diagnostics.link(folder)
      else if (check.reason !== 'missing')
        diagnostics.unreadable(folder)
      continue
    }
    folders.push(folder)
    switch (kind) {
      case 'agent':
        candidates.push(...await agentCandidates(folder, check.absolute, diagnostics))
        break
      case 'command':
        candidates.push(...await commandCandidates(root, folder, check.absolute, diagnostics))
        break
      case 'skill':
        candidates.push(...await skillCandidates(root, folder, check.absolute, diagnostics))
        break
      case 'style':
        candidates.push(...await agentCandidates(folder, check.absolute, diagnostics, 'style'))
        break
    }
  }
  const read = await mapLimit(candidates, DISCOVERY_CONCURRENCY, async candidate => readCandidate(root, candidate, options, diagnostics))
  const entries = read.filter((entry): entry is CustomizationEntry => entry !== null)
  return { entries, diagnostics: diagnostics.list.slice(0, DIAGNOSTICS_MAX), folders }
}

/** The parse options of a project entry's file (`fileName`, or `folderName` for a skill). */
export function parseOptionsOf(kind: CustomizationKind, path: string): ParseDefinitionOptions {
  const segments = path.split('/')
  return kind === 'skill' ? { folderName: segments.at(-2) ?? '' } : { fileName: segments.at(-1) ?? '' }
}
