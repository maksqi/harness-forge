// Project definition files (Phase 12, ADR-056; API.md 4.35 / 5.36, ARCHITECTURE.md 6.36) behind
// `ProjectDefinitionsService` (./types.ts). Owner: W12.4 (C43 landed the stub with the final factory signature).
//
// - Paths (`paths.ts`): only the editable paths of `projectDefinitionPathKind`, no `.git` or secret-looking segment, and
//   the path must resolve to itself (`rel === path`: no link anywhere on it), checked again inside the file lock.
// - The project folder: `projects.get` (an unknown project and an unavailable folder are `404`); every file access then
//   goes through the workspace guard, which re-checks the folder.
// - `read`: through `openWorkspaceFile` (a regular file, never a link), at most 64 KiB for a definition and 256 KiB for a
//   settings file or `.mcp.json` (a bigger or binary file answers `content: null` with its sha256 and an `error`
//   diagnostic); the diagnostics of the parser of its kind (`parseDefinition`, `readSettingsHooks(…, { prompts: true })`,
//   `parseMcpJson`). A missing file is `exists: false`.
// - `write`: the value is validated first (`parseDefinition(kind, text, { fileName | folderName })`, `readHooksConfig(…,
//   { prompts: true })`, `parseMcpJson`; an `error` is a `400` with `details.diagnostics`, warnings are kept), then
//   written with `writeWithoutRecording` (the per-file lock and the atomic write; **not journaled**): inside the lock the
//   path is resolved again, the current sha256 is compared with `expectedSha256` (null = the file must not exist; else
//   `409` `stale`), a settings file or `.mcp.json` gets only its key replaced (`settings-file.ts`) and the whole new file
//   is checked again. Afterwards `workspace.changed { projectId, chatId: null, batchId: null, source: 'user', paths }`
//   (the catalog, the project config and the hooks drop their caches as for an agent edit), `projectConfig
//   .invalidate(projectId)`, and the answer carries `trust.pending` (`projectTrust.pending`). No fresh auth and no idle
//   rule: a save is allowed while a chat of the project runs.
// - `remove`: markdown definitions only, under the same lock with the same stale check (`removeWorkspaceFile`: a regular
//   file, never a link); a skill folder left empty is removed (`rmdir`, never recursive); the same event.
// - Saving never approves anything: no `project_trust` row is written here, so a saved hook, `.mcp.json` server or
//   command with `!` spans stays pending until the fresh-auth approval (`POST /projects/:id/trust`).
// - Logging: the project id, the kind, `created` and the byte count at `info`; the path at `debug`; never contents.
import type { ProjectDefinitionDiagnostic, ProjectDefinitionFile, ProjectDefinitionWriteBody, ProjectDefinitionWriteResult } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { ResolvedWorkspacePath } from '../../workspace/paths.ts'
import type { CheckpointBefore } from '../checkpoints/types.ts'
import type { MarkdownDefinitionKind, ProjectDefinitionTarget } from './paths.ts'
import type { JsonDefinitionFile } from './settings-file.ts'
import type { ProjectDefinitionsService } from './types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { rmdir } from 'node:fs/promises'
import { HarnessError, isHarnessError, isMarkdownDefinitionKind, LIMITS, parseDefinition, parseMcpJson, readHooksConfig } from '@harness-forge/shared'
import { withFileLock } from '../../workspace/file-lock.ts'
import { openWorkspaceFile, resolveWorkspacePath, workspacePathError } from '../../workspace/paths.ts'
import { removeWorkspaceFile } from '../../workspace/remove.ts'
import { diskSha, readCheckpointBefore, sha256Hex, writeWithoutRecording } from '../checkpoints/disk.ts'
import { folderUnavailableMessage } from '../projects/index.ts'
import {
  capDiagnostics,
  diagnostic,
  fromDefinitionDiagnostics,
  fromHookDiagnostics,
  fromMcpDiagnostics,
  hasErrorDiagnostic,
  invalidContent,
} from './diagnostics.ts'
import {
  definitionParseOptions,
  definitionTarget,
  linkedPathError,
  markdownDefinitionTarget,
  resolveDefinitionPath,
  resolveDefinitionPathAgain,
  skillFolderOf,
} from './paths.ts'
import { JSON_FILE_KEY, JSON_FILE_MAX_BYTES, jsonFileDiagnostics, spliceJsonKey } from './settings-file.ts'

export {
  definitionParseOptions,
  definitionTarget,
  markdownDefinitionTarget,
  NOT_EDITABLE_MESSAGE,
  resolveDefinitionPath,
  resolveDefinitionPathAgain,
} from './paths.ts'
export type { MarkdownDefinitionKind, ProjectDefinitionTarget } from './paths.ts'
export { JSON_FILE_KEY, JSON_FILE_MAX_BYTES, jsonFileDiagnostics, readJsonObject, spliceJsonKey } from './settings-file.ts'
export type { JsonDefinitionFile } from './settings-file.ts'

/** `CheckpointWriteInput.toolCallId` / `tool` of an editor write (`writeWithoutRecording` records nothing). */
const EDITOR_CALL_ID = 'project-definitions'
const EDITOR_TOOL = 'project-definitions'
/** Bytes read per chunk while hashing a file over the read cap. */
const HASH_CHUNK_BYTES = 1_048_576
/** The NUL probe of a text file covers its first 8 KiB (like the definition discovery). */
const BINARY_PROBE_BYTES = 8192

const STALE_MESSAGE = 'The file changed on disk. Load it again or overwrite it.'

function staleError(): HarnessError {
  return new HarnessError({ code: 'conflict', message: STALE_MESSAGE, details: { reason: 'stale' } })
}

function fileNotFound(path: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `"${path}" does not exist in the project folder.` })
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

function kib(bytes: number): string {
  return `${Math.floor(bytes / 1024)} KiB`
}

/** The read cap of a kind: 64 KiB for a definition, 256 KiB for a settings file or `.mcp.json`. */
export function readCapOf(target: ProjectDefinitionTarget): number {
  return isMarkdownDefinitionKind(target.kind) ? LIMITS.customizationContentBytes : JSON_FILE_MAX_BYTES[target.kind as JsonDefinitionFile]
}

/** The parser diagnostics of a file's text, by kind (what the catalog and the project config reader would report). */
export function fileDiagnostics(target: ProjectDefinitionTarget, text: string): ProjectDefinitionDiagnostic[] {
  if (isMarkdownDefinitionKind(target.kind))
    return fromDefinitionDiagnostics(parseDefinition(target.kind, text, definitionParseOptions(target)).diagnostics)
  return jsonFileDiagnostics(target.kind as JsonDefinitionFile, text, target.path)
}

/** True when the first bytes hold a NUL byte (a binary file). */
function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)
}

/** A file as read for `read`: missing, its bytes (at most the cap), or only its sha256 (larger than the cap). */
type ReadState
  = | { readonly state: 'missing' }
    | { readonly state: 'present', readonly bytes: Buffer, readonly sha256: string }
    | { readonly state: 'too-large', readonly size: number, readonly sha256: string }

/**
 * Reads an editable file through `openWorkspaceFile` (a regular file, the last component never followed): at most
 * `cap` bytes kept, a bigger file is only hashed (streamed). The opened file must still be the requested path.
 */
async function readEditableFile(root: string, path: string, cap: number, signal?: AbortSignal): Promise<ReadState> {
  let opened
  try {
    opened = await openWorkspaceFile(root, path)
  }
  catch (error) {
    if (isHarnessError(error) && error.code === 'not_found')
      return { state: 'missing' }
    throw error
  }
  const { handle, stats, resolved } = opened
  try {
    if (resolved.rel !== path)
      throw linkedPathError(path)
    const hash = createHash('sha256')
    const kept: Buffer[] = []
    let size = 0
    const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(stats.size, cap) + 1))
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0)
        break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (size <= cap)
        kept.push(Buffer.from(chunk))
      size += bytesRead
    }
    const sha256 = hash.digest('hex')
    if (size > cap)
      return { state: 'too-large', size, sha256 }
    return { state: 'present', bytes: Buffer.concat(kept, size), sha256 }
  }
  finally {
    await handle.close()
  }
}

/** The sha256 of a before-state read under the lock (a file over the checkpoint cap is hashed streamed). */
async function shaOfBefore(root: string, path: string, before: CheckpointBefore): Promise<string | null> {
  if (before.state === 'missing')
    return null
  if (before.state === 'present')
    return before.sha
  const sha = await diskSha(root, path)
  if (sha === 'unreadable')
    throw workspacePathError(`"${path}" is not a regular file; it cannot be edited here.`)
  return sha
}

/** The value of a write body, checked against the kind of its path (the route's schema does the same). */
type WriteValue
  = | { readonly kind: MarkdownDefinitionKind, readonly content: string }
    | { readonly kind: JsonDefinitionFile, readonly value: Record<string, unknown> | null }

function writeValueOf(target: ProjectDefinitionTarget, body: ProjectDefinitionWriteBody): WriteValue {
  const wrong = (field: string): never => {
    throw workspacePathError(`This file takes "${field}".`)
  }
  if (isMarkdownDefinitionKind(target.kind)) {
    if (!('content' in body) || typeof body.content !== 'string')
      return wrong('content')
    return { kind: target.kind, content: body.content }
  }
  if (target.kind === 'settings') {
    if (!('hooks' in body))
      return wrong('hooks')
    return { kind: 'settings', value: body.hooks }
  }
  if (!('mcpServers' in body))
    return wrong('mcpServers')
  return { kind: 'mcp', value: body.mcpServers }
}

/** Validates the value before anything is touched: the diagnostics to answer, or the `400`. */
function validateValue(target: ProjectDefinitionTarget, value: WriteValue): ProjectDefinitionDiagnostic[] {
  if ('content' in value) {
    if (value.content.length === 0)
      throw invalidContent([diagnostic('error', 'missing-field', 'The file is empty.')], 'content')
    if (Buffer.byteLength(value.content, 'utf8') > LIMITS.customizationContentBytes)
      throw invalidContent([diagnostic('error', 'too-large', `Definitions are limited to ${kib(LIMITS.customizationContentBytes)}.`)], 'content')
    const parsed = parseDefinition(value.kind, value.content, definitionParseOptions(target))
    const diagnostics = fromDefinitionDiagnostics(parsed.diagnostics)
    if (parsed.definition === null || parsed.definition.kind !== value.kind || hasErrorDiagnostic(diagnostics))
      throw invalidContent(diagnostics.length > 0 ? diagnostics : [diagnostic('error', 'invalid-frontmatter', 'The definition is not valid.')], 'content')
    return diagnostics
  }
  if (value.kind === 'settings') {
    const diagnostics = fromHookDiagnostics(readHooksConfig(value.value, { source: 'project', file: target.path, prompts: true }).diagnostics)
    if (hasErrorDiagnostic(diagnostics))
      throw invalidContent(diagnostics, 'hooks')
    return diagnostics
  }
  if (value.value === null)
    return []
  const diagnostics = fromMcpDiagnostics(parseMcpJson(JSON.stringify({ mcpServers: value.value }), { maxBytes: LIMITS.projectMcpFileBytes }).diagnostics)
  if (hasErrorDiagnostic(diagnostics))
    throw invalidContent(diagnostics, 'mcpServers')
  return diagnostics
}

export function createProjectDefinitionsService(deps: AppDeps): ProjectDefinitionsService {
  let logger: Logger | undefined
  const log = (): Logger => (logger ??= deps.logger.child({ component: 'project-definitions' }))

  /** The canonical folder of the project: `404` for an unknown project or an unavailable folder. */
  async function projectRoot(projectId: string): Promise<string> {
    const project = await deps.projects.get(projectId)
    if (!project.available)
      throw new HarnessError({ code: 'not_found', message: folderUnavailableMessage(project.path, project.issue ?? 'it cannot be opened.') })
    return project.path
  }

  /** `workspace.changed` of a user edit (never fails the edit). */
  function changed(projectId: string, paths: readonly string[]): void {
    try {
      deps.events.emit('workspace.changed', { projectId, chatId: null, batchId: null, source: 'user', paths: [...paths] })
    }
    catch (error) {
      log().warn('workspace.changed not sent', { projectId, err: error })
    }
    try {
      deps.projectConfig.invalidate(projectId)
    }
    catch (error) {
      log().warn('project config not dropped', { projectId, err: error })
    }
  }

  /** The project's items that wait for an approval after a save (never fails the save). */
  async function pendingCount(projectId: string): Promise<number> {
    try {
      return await deps.projectTrust.pending(projectId)
    }
    catch (error) {
      log().warn('project definitions: pending count failed', { projectId, err: error })
      return 0
    }
  }

  /** Removes the skill folder `folder` when it is empty (never recursive; a folder with other files stays). */
  async function removeEmptyFolder(root: string, folder: string): Promise<void> {
    try {
      const resolved = await resolveWorkspacePath(root, folder)
      if (resolved.rel !== folder)
        return
      await rmdir(resolved.absolute)
    }
    catch (error) {
      const code = errorCode(error)
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT' && !(isHarnessError(error) && error.code === 'not_found'))
        log().debug('project definitions: skill folder not removed', { err: error })
    }
  }

  return Object.freeze({
    read: async (projectId: string, path: string, signal?: AbortSignal): Promise<ProjectDefinitionFile> => {
      signal?.throwIfAborted()
      const target = definitionTarget(path)
      const root = await projectRoot(projectId)
      const resolved = await resolveDefinitionPath(root, target.path)
      const missing: ProjectDefinitionFile = { path: target.path, kind: target.kind, exists: false, content: null, sha256: null, diagnostics: [] }
      if (!resolved.exists)
        return missing
      const cap = readCapOf(target)
      const read = await readEditableFile(root, target.path, cap, signal)
      log().debug('project definition read', { projectId, kind: target.kind, path: target.path, state: read.state })
      if (read.state === 'missing')
        return missing
      const unreadable = (code: string, message: string): ProjectDefinitionFile => ({
        path: target.path,
        kind: target.kind,
        exists: true,
        content: null,
        sha256: read.sha256,
        diagnostics: [diagnostic('error', code, message)],
      })
      if (read.state === 'too-large')
        return unreadable('too-large', `The file is larger than ${kib(cap)}; it cannot be edited here.`)
      if (isBinary(read.bytes))
        return unreadable('binary', 'The file is binary (it contains a NUL byte); it cannot be edited here.')
      // `ignoreBOM`: a byte order mark stays in the text, so a save writes the same bytes back.
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(read.bytes)
      return { path: target.path, kind: target.kind, exists: true, content: text, sha256: read.sha256, diagnostics: capDiagnostics(fileDiagnostics(target, text)) }
    },

    write: async (projectId: string, body: ProjectDefinitionWriteBody): Promise<ProjectDefinitionWriteResult> => {
      const target = definitionTarget(body.path)
      const value = writeValueOf(target, body)
      const validated = validateValue(target, value)
      const root = await projectRoot(projectId)
      const resolved = await resolveDefinitionPath(root, target.path)
      let diagnostics: ProjectDefinitionDiagnostic[] = validated
      let output: Buffer | null = null
      const result = await writeWithoutRecording({
        toolCallId: EDITOR_CALL_ID,
        tool: EDITOR_TOOL,
        root,
        resolved,
        signal: new AbortController().signal,
        produce: async (before) => {
          // Under the file lock: the path still resolves to itself, and the stale check sees the file as it is now
          // (created meanwhile: the before-state of a missing first resolution is read again).
          const again: ResolvedWorkspacePath = await resolveDefinitionPathAgain(root, target.path, resolved)
          const current = !resolved.exists && again.exists ? await readCheckpointBefore(root, again) : before
          const currentSha = await shaOfBefore(root, target.path, current)
          if (currentSha !== body.expectedSha256)
            throw staleError()
          if ('content' in value) {
            output = Buffer.from(value.content, 'utf8')
            return output
          }
          if (current.state === 'too-large')
            throw invalidContent([diagnostic('error', 'too-large', `The file on disk is larger than ${kib(JSON_FILE_MAX_BYTES[value.kind])}; edit it in another editor.`)], JSON_FILE_KEY[value.kind])
          const text = spliceJsonKey(value.kind, current.state === 'present' ? current.bytes : null, value.value)
          const final = jsonFileDiagnostics(value.kind, text, target.path, value.value === null)
          if (hasErrorDiagnostic(final))
            throw invalidContent(final, JSON_FILE_KEY[value.kind])
          diagnostics = final
          output = Buffer.from(text, 'utf8')
          return output
        },
      })
      const bytes: Buffer = output ?? Buffer.alloc(0)
      changed(projectId, [target.path])
      const pending = await pendingCount(projectId)
      log().info('project definition saved', { projectId, kind: target.kind, created: result.written.created, bytes: bytes.byteLength, pending })
      log().debug('project definition saved: path', { projectId, path: target.path })
      return {
        path: target.path,
        sha256: sha256Hex(bytes),
        created: result.written.created,
        diagnostics: capDiagnostics(diagnostics.filter(item => item.level !== 'error')),
        trust: { pending },
      }
    },

    remove: async (projectId: string, path: string, expectedSha256: string): Promise<void> => {
      const target = markdownDefinitionTarget(path)
      const root = await projectRoot(projectId)
      const resolved = await resolveDefinitionPath(root, target.path)
      if (!resolved.exists)
        throw fileNotFound(target.path)
      await withFileLock(resolved.absolute, async () => {
        const again = await resolveDefinitionPathAgain(root, target.path, resolved)
        if (!again.exists)
          throw fileNotFound(target.path)
        const sha = await diskSha(root, target.path)
        if (sha === null)
          throw fileNotFound(target.path)
        if (sha === 'unreadable')
          throw workspacePathError(`"${target.path}" is not a regular file; it cannot be deleted here.`)
        if (sha !== expectedSha256)
          throw staleError()
        await removeWorkspaceFile(root, target.path)
        // Inside the lock of SKILL.md: a writer of the same file waits, so it never sees its folder vanish.
        const folder = skillFolderOf(target)
        if (folder !== null)
          await removeEmptyFolder(root, folder)
      })
      changed(projectId, [target.path])
      log().info('project definition deleted', { projectId, kind: target.kind })
      log().debug('project definition deleted: path', { projectId, path: target.path })
    },
  })
}
