// Remember (Phase 10, ADR-047; API.md 4.30 / 5.29, ARCHITECTURE.md 6.27). Owner: W10.6. The service behind
// `POST /memory` (`http/routes/memory.ts`): the client command `/remember <text>` saves one line `- <text>` for the agent.
//
// - The text: line breaks become `\n`, every other control character (C0 / C1, DEL, the line / paragraph separators,
//   bidi overrides and isolates) is removed, lone surrogates become U+FFFD; an empty result is `400` on `['text']`.
// - `project-file` / `project-instructions` need the chat of a project (`404` unknown chat, `400` on `['chatId']` without
//   a project); the project is always the chat's.
// - `project-file`: `AGENTS.md` when it exists, else `CLAUDE.md`, else a new `AGENTS.md` (`PROJECT_INSTRUCTIONS_FILES`),
//   in the project root only. A symbolic link (`lstat`, checked again under the file lock right before the write) or
//   anything but a regular text file is `400`; the file after the append must stay within `LIMITS.rememberFileMaxBytes`
//   (`413`). The append (a `\n` first when the file does not end with one, then `- <text>\n`) goes through the chat's
//   change journal: `deps.checkpoints.journal({ chatId, messageId: null, projectId }).write(...)` with the tool call id
//   `remember_<random>` and the tool `remember`, under the per-file lock and the frozen path guard
//   (`resolveWorkspacePath`), so it is listed in `GET /chats/:id/changes`, revertible and rewindable, and the journal
//   emits the coalesced `workspace.changed` (source `tool`).
// - `project-instructions`: `projects.update(id, { instructions })` with the line appended (`project.changed`);
//   `global`: `settings.update({ instructions })`. Both refuse a result over `LIMITS.instructionsMaxChars` (`400` on
//   `['text']`).
// - The text is never logged (the info line carries the target, the ids, the file and the length only).
import type { ProjectInstructionsFile, ProjectSummary, RememberBody, RememberResult } from '@harness-forge/shared'
import type { Stats } from 'node:fs'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { CheckpointBefore } from '../checkpoints/types.ts'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessError, isHarnessError, LIMITS, PROJECT_INSTRUCTIONS_FILES, validationError } from '@harness-forge/shared'
import { resolveWorkspacePath } from '../../workspace/paths.ts'
import { chatNotFound } from '../chats/store.ts'
import { isControlChar, wellFormed } from '../chats/text.ts'

/** The tool name of the journal rows of Remember. */
export const REMEMBER_TOOL = 'remember'

/** Prefix of the tool call id of a Remember journal row (`remember_<16 hex>`). */
export const REMEMBER_CALL_PREFIX = 'remember_'

/** The message of a project target sent with the chat of no project. */
export const REMEMBER_NO_PROJECT_MESSAGE = 'This chat has no project: Remember can save to the project only from a chat of a project.'

/** Bytes inspected for a NUL byte: a project file with one is binary and never appended to. */
const BINARY_PROBE_BYTES = 8192

const NEWLINE = 0x0A

export interface RememberOptions {
  /** The request logger (default: `deps.logger`). */
  readonly logger?: Logger
  /** Aborts a project file write before anything is stored or written (the request's signal). */
  readonly signal?: AbortSignal
  /** The part after `remember_` of the journal row's tool call id (default: 16 random hex characters; tests). */
  readonly callId?: () => string
}

/**
 * The text as saved: `\r\n` / `\r` become `\n`, every other control character is removed, lone surrogates become U+FFFD,
 * then trimmed. May be empty.
 */
export function cleanRememberText(text: string): string {
  let out = ''
  for (const char of wellFormed(text).replace(/\r\n?/g, '\n')) {
    const code = char.codePointAt(0) ?? 0
    if (code === NEWLINE || !isControlChar(code))
      out += char
  }
  return out.trim()
}

/** The saved line: `- <text>`. */
export function rememberLine(text: string): string {
  return `- ${text}`
}

/** Instructions with the line appended: on a line of its own (a `\n` first unless they are empty or end with one). */
export function appendInstructionLine(current: string | null | undefined, line: string): string {
  const base = current ?? ''
  if (base === '')
    return line
  return base.endsWith('\n') ? `${base}${line}` : `${base}\n${line}`
}

function issue(path: Array<string | number>, message: string): HarnessError {
  return validationError([{ path, message, code: 'custom' }], message)
}

function tooLarge(name: string): HarnessError {
  return new HarnessError({
    code: 'payload_too_large',
    message: `${name} would be larger than ${LIMITS.rememberFileMaxBytes / 1_048_576} MiB with this line; shorten the file first.`,
    details: { limitBytes: LIMITS.rememberFileMaxBytes },
  })
}

function linkRefused(name: string): HarnessError {
  return issue([], `${name} is a symbolic link: Remember never writes through a link.`)
}

function notRegular(name: string): HarnessError {
  return issue([], `${name} is not a regular file.`)
}

function instructionsTooLong(where: string): HarnessError {
  return issue(['text'], `${where} would be longer than ${LIMITS.instructionsMaxChars.toLocaleString('en-US')} characters with this line.`)
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  }
  catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return null
    throw error
  }
}

/** Refuses a link or a non-regular entry at `root/name`; true when it is a regular file, false when it is missing. */
async function checkEntry(root: string, name: ProjectInstructionsFile): Promise<boolean> {
  const stats = await lstatOrNull(join(root, name))
  if (stats === null)
    return false
  if (stats.isSymbolicLink())
    throw linkRefused(name)
  if (!stats.isFile())
    throw notRegular(name)
  return true
}

/** `AGENTS.md` when it exists, else `CLAUDE.md`, else `AGENTS.md` (created). A link at the chosen name is refused. */
async function chooseProjectFile(root: string): Promise<ProjectInstructionsFile> {
  for (const name of PROJECT_INSTRUCTIONS_FILES) {
    if (await checkEntry(root, name))
      return name
  }
  return PROJECT_INSTRUCTIONS_FILES[0]
}

/** The new content of the project file: the line appended to the before-state (bytes kept as they are). */
function appendedContent(name: ProjectInstructionsFile, before: CheckpointBefore, line: string): Uint8Array {
  const addition = Buffer.from(`${line}\n`, 'utf8')
  if (before.state === 'missing') {
    if (addition.byteLength > LIMITS.rememberFileMaxBytes)
      throw tooLarge(name)
    return addition
  }
  if (before.state === 'too-large')
    throw tooLarge(name)
  const { bytes } = before
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0))
    throw issue([], `${name} is not a text file.`)
  const separator = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== NEWLINE ? 1 : 0
  if (bytes.byteLength + separator + addition.byteLength > LIMITS.rememberFileMaxBytes)
    throw tooLarge(name)
  return Buffer.concat([bytes, separator === 1 ? Buffer.from('\n') : Buffer.alloc(0), addition])
}

interface ProjectTarget {
  readonly chatId: string
  readonly projectId: string
}

/** The chat's project for a project target: `404` for an unknown chat, `400` on `['chatId']` without a project. */
async function projectTarget(deps: AppDeps, chatId: string | undefined): Promise<ProjectTarget> {
  if (chatId === undefined)
    throw issue(['chatId'], 'Project targets need the chat of a project ("chatId").')
  const chat = await deps.chats.find(chatId)
  if (chat === null)
    throw chatNotFound(chatId)
  if (chat.projectId === null)
    throw issue(['chatId'], REMEMBER_NO_PROJECT_MESSAGE)
  return { chatId, projectId: chat.projectId }
}

/** The project after a change; a project deleted meanwhile is a `400` (the chat no longer has it). */
async function projectSummary(deps: AppDeps, projectId: string): Promise<ProjectSummary> {
  try {
    return await deps.projects.get(projectId)
  }
  catch (error) {
    if (isHarnessError(error) && error.code === 'not_found')
      throw issue(['chatId'], 'The project of this chat no longer exists.')
    throw error
  }
}

interface ProjectFileWrite {
  readonly file: ProjectInstructionsFile
  readonly created: boolean
}

async function appendToProjectFile(deps: AppDeps, target: ProjectTarget, line: string, options: RememberOptions): Promise<ProjectFileWrite> {
  const opened = await deps.projects.openWorkspace(target.projectId)
  if (!opened.ok)
    throw issue(['chatId'], opened.message)
  const { root } = opened.workspace
  const file = await chooseProjectFile(root)
  const resolved = await resolveWorkspacePath(root, file, { allowMissing: true })
  // The root is canonical and the entry is no link, so the path resolves to itself.
  if (resolved.rel !== file)
    throw linkRefused(file)
  const journal = deps.checkpoints.journal({ chatId: target.chatId, messageId: null, projectId: target.projectId })
  const callId = options.callId?.() ?? randomBytes(8).toString('hex')
  const written = await journal.write({
    toolCallId: `${REMEMBER_CALL_PREFIX}${callId}`,
    tool: REMEMBER_TOOL,
    root,
    resolved,
    produce: async (before) => {
      // Under the file lock: a link (or a folder) that replaced the file since it was chosen is refused here.
      await checkEntry(root, file)
      return appendedContent(file, before, line)
    },
    signal: options.signal ?? new AbortController().signal,
  })
  return { file, created: written.before.state === 'missing' }
}

/**
 * `POST /memory` (see the module comment): saves `- <text>` to the target and answers `RememberResult`. Errors are
 * `HarnessError`s the route passes through.
 */
export async function remember(deps: AppDeps, body: RememberBody, options: RememberOptions = {}): Promise<RememberResult> {
  const logger = options.logger ?? deps.logger
  const text = cleanRememberText(body.text)
  if (text === '')
    throw issue(['text'], 'The text is empty.')
  const line = rememberLine(text)

  if (body.target === 'global') {
    const current = await deps.settings.get()
    const instructions = appendInstructionLine(current.instructions, line)
    if (instructions.length > LIMITS.instructionsMaxChars)
      throw instructionsTooLong('The global instructions')
    const settings = await deps.settings.update({ instructions })
    logger.info('remember saved', { target: body.target, chars: text.length })
    return { target: body.target, settings }
  }

  const target = await projectTarget(deps, body.chatId)
  if (body.target === 'project-instructions') {
    const current = await projectSummary(deps, target.projectId)
    const instructions = appendInstructionLine(current.instructions, line)
    if (instructions.length > LIMITS.instructionsMaxChars)
      throw instructionsTooLong('The project instructions')
    const project = await deps.projects.update(target.projectId, { instructions })
    logger.info('remember saved', { target: body.target, chatId: target.chatId, projectId: target.projectId, chars: text.length })
    return { target: body.target, project }
  }

  const { file, created } = await appendToProjectFile(deps, target, line, options)
  const project = await projectSummary(deps, target.projectId)
  logger.info('remember saved', { target: body.target, chatId: target.chatId, projectId: target.projectId, file, created, chars: text.length })
  return { target: body.target, file, created, project }
}
