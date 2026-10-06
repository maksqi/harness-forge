// Share snapshots (ADR-025, API.md 4.17, ARCHITECTURE.md 6.10). Owner: W5.4 (W5.4-T2, W5.4-T4).
//
// `sanitizeSnapshot` is the allowlist sanitizer: it copies only the fields listed in `sharePartSchema` /
// `shareMessageSchema` from a chat's active path, so anything unknown (a new AI SDK part type, a new metadata field)
// is dropped rather than published. Kept: `user` and `assistant` messages, text, `file` parts (an app file
// `/api/files/<id>`, whose id joins the share's `file_ids`, or a raster image data URL), http(s) `source-url` and
// `source-document` parts, reasoning text, tool parts (name, status, input / output / error text, each value capped),
// the model ref of a reply, the command name (and kind) of a user message and a `failed` / `stopped` status. Dropped:
// system messages, `metadata.error` (only `status: 'failed'` remains), usage and cost, `command.expansion` and `input`,
// provider metadata, approvals, `data-*`, `step-start`, `reasoning-file`, `custom` and unknown parts, other URLs.
// Reasoning and tool details are always stored, so the share's options can change what the page shows at once.
//
// Phase 9 (ADR-040 / ADR-042, UI.md 7.15 "Agent 2.0 parity", W9.7; no `sharePartSchema` change): an assistant message
// is split at its steers (`data-steer`, the shared `splitSteers`) into assistant / user / assistant share messages, so
// a message the user queued during the run reads as an ordinary user message (its text and file parts, the files
// following the attachments option); the reply's `failed` / `stopped` status stays on its last assistant part.
// Compaction markers (`data-compaction`, summaries are never shared) and activity parts (`data-activity`) are dropped
// like every other `data-*` part. `shareableMessageCount` counts the messages after the split, like the snapshot.
//
// Phase 10 (ADR-046, W10.6; no `sharePartSchema` change): background task results (`data-task-result`) are dropped like
// every other `data-*` part (a reply is not split at them), and the user-role carrier message of a turn the server
// started (only results, besides parts that are no content) is left out of the snapshot and of the count.
//
// Phase 11 (ADR-048, W11.7; no `sharePartSchema` change): hook records (`data-hook`) are dropped like every other
// `data-*` part (their context, reason, commands and outputs are never published), and the user-role carrier message of
// a Stop continuation (only hook records, besides parts that are no content) is left out of the snapshot and of the
// count. A tool call a hook denied is stored by the SDK as a denied approval, so it reads "denied" like any other
// denial (the hook's reason is not copied). The command of a user message keeps its name (a slash name: a command of up
// to 32 or a user-invocable skill of up to 64 characters, ADR-052) and its `kind` (`command` / `skill`, so the page can
// say "Skill"); never its input, expansion or what its `!` / `@` lines inlined.
//
// `renderShareMessages` applies the options when the view is served: reasoning parts, tool inputs / outputs / error
// texts and file parts are left out when disabled, and app file URLs become `/api/share/<token>/files/<id>` (only for
// ids of the share's `file_ids`).
import type { HarnessUIMessage, ShareMessage, ShareOptions, SharePart, ShareSnapshot, ShareToolStatus } from '@harness-forge/shared'
import { Buffer } from 'node:buffer'
import {
  HOOK_PART_TYPE,
  invocationKindSchema,
  isContentPart,
  LIMITS,
  safeParseModelRef,
  SLASH_NAME_PATTERN,
  splitSteers,
  TASK_RESULT_PART_TYPE,
  TOOL_NAME_PATTERN,
} from '@harness-forge/shared'

/** The file id of an app file URL (`/api/files/<id>`), else null: `FilesService.idFromUrl`. */
export type FileIdOf = (url: string) => string | null

type ToolSharePart = Extract<SharePart, { type: 'tool' }>
type FileSharePart = Extract<SharePart, { type: 'file' }>
type UnknownRecord = Record<string, unknown>

/** Field caps of `sharePartSchema`. */
export const SHARE_FIELD_LIMITS = Object.freeze({
  mediaType: 255,
  filename: 255,
  sourceId: 64,
  sourceUrl: 2048,
  sourceTitle: 500,
  toolErrorText: 4096,
})

/** Appended to a tool value cut at `LIMITS.shareToolValueChars` (the web recognizes the trailing marker). */
export const SHARE_TRUNCATION_MARKER = '\n[truncated]'

/** Data URL types a share may carry: raster images only (never SVG, which can hold scripts). */
const RASTER_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

/** C0 / C1 control characters and bidi overrides / isolates (they could disguise a file name). */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as UnknownRecord : null
}

/** The first `max` UTF-16 code units of `text`, never ending inside a surrogate pair. */
export function clipText(text: string, max: number): string {
  if (text.length <= max)
    return text
  let end = Math.max(0, max)
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xD800 && last <= 0xDBFF)
    end -= 1
  return text.slice(0, end)
}

/** A display string (file name): unsafe characters removed, trimmed, clipped; '' when nothing is left. */
function cleanName(value: unknown, max: number): string {
  return typeof value === 'string' ? clipText(value.replace(UNSAFE_NAME_CHARS, '').trim(), max).trim() : ''
}

/**
 * A tool input or output as stored in a snapshot: a JSON copy when its serialization fits in `maxChars` (a string: its
 * length), else the first characters of that serialization (or of the string) + `SHARE_TRUNCATION_MARKER`, at most
 * `maxChars` in total. `undefined` (and values that are not JSON) stay absent.
 */
export function capToolValue(value: unknown, maxChars: number = LIMITS.shareToolValueChars): unknown {
  if (value === undefined)
    return undefined
  let text: string | undefined
  if (typeof value === 'string') {
    text = value
  }
  else {
    try {
      text = JSON.stringify(value)
    }
    catch {
      return undefined
    }
    if (text === undefined)
      return undefined
    if (text.length <= maxChars)
      return JSON.parse(text) as unknown
  }
  if (text.length <= maxChars)
    return text
  return `${clipText(text, maxChars - SHARE_TRUNCATION_MARKER.length)}${SHARE_TRUNCATION_MARKER}`
}

/** The lowercase type of a raster image data URL (`data:image/png;base64,...`), else null. */
export function rasterDataUrlType(url: string): string | null {
  if (!/^data:/i.test(url))
    return null
  const comma = url.indexOf(',')
  if (comma < 0)
    return null
  const type = (url.slice('data:'.length, comma).split(';')[0] ?? '').trim().toLowerCase()
  return RASTER_IMAGE_TYPES.has(type) ? type : null
}

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

/** Share status of a tool call; `superseded`: a later message exists (a pending approval was never granted). */
function toolStatus(state: unknown, approval: unknown, superseded: boolean): ShareToolStatus {
  switch (state) {
    case 'output-available':
      return 'done'
    case 'output-error':
      return 'error'
    case 'output-denied':
      return 'denied'
    case 'approval-responded':
      return asRecord(approval)?.approved === false ? 'denied' : 'stopped'
    case 'approval-requested':
      return superseded ? 'denied' : 'stopped'
    default:
      // `input-streaming` / `input-available` of a stored message: the call never finished.
      return 'stopped'
  }
}

interface SanitizeContext {
  fileIdOf: FileIdOf
  /** Collected file ids, in first-use order. */
  fileIds: Set<string>
  /** A later message exists in the path. */
  superseded: boolean
}

function sanitizeFile(part: UnknownRecord, context: SanitizeContext): FileSharePart | null {
  if (typeof part.url !== 'string' || typeof part.mediaType !== 'string')
    return null
  let mediaType = cleanName(part.mediaType, SHARE_FIELD_LIMITS.mediaType)
  const fileId = context.fileIdOf(part.url)
  if (fileId !== null) {
    context.fileIds.add(fileId)
  }
  else {
    const raster = rasterDataUrlType(part.url)
    if (raster === null)
      return null
    mediaType = raster
  }
  if (mediaType === '')
    return null
  const filename = cleanName(part.filename, SHARE_FIELD_LIMITS.filename)
  return { type: 'file', mediaType, ...(filename === '' ? {} : { filename }), url: part.url }
}

function sanitizeTool(part: UnknownRecord, toolName: unknown, context: SanitizeContext): ToolSharePart | null {
  if (typeof toolName !== 'string' || !TOOL_NAME_PATTERN.test(toolName))
    return null
  const tool: ToolSharePart = { type: 'tool', toolName, status: toolStatus(part.state, part.approval, context.superseded) }
  const input = capToolValue(part.input)
  if (input !== undefined)
    tool.input = input
  if (part.state === 'output-available') {
    const output = capToolValue(part.output)
    if (output !== undefined)
      tool.output = output
  }
  if (part.state === 'output-error' && typeof part.errorText === 'string')
    tool.errorText = clipText(part.errorText, SHARE_FIELD_LIMITS.toolErrorText)
  return tool
}

function sanitizePart(value: unknown, context: SanitizeContext): SharePart | null {
  const part = asRecord(value)
  const type = part?.type
  if (part === null || typeof type !== 'string')
    return null
  switch (type) {
    case 'text':
    case 'reasoning':
      return typeof part.text === 'string' && part.text !== '' ? { type, text: part.text } : null
    case 'file':
      return sanitizeFile(part, context)
    case 'source-url': {
      const { sourceId, url, title } = part
      if (typeof sourceId !== 'string' || typeof url !== 'string' || url.length > SHARE_FIELD_LIMITS.sourceUrl || !isHttpUrl(url))
        return null
      const kept = typeof title === 'string' ? clipText(title, SHARE_FIELD_LIMITS.sourceTitle) : ''
      return { type, sourceId: clipText(sourceId, SHARE_FIELD_LIMITS.sourceId), url, ...(kept === '' ? {} : { title: kept }) }
    }
    case 'source-document': {
      const { sourceId, title, mediaType } = part
      if (typeof sourceId !== 'string' || typeof title !== 'string' || typeof mediaType !== 'string')
        return null
      const filename = cleanName(part.filename, SHARE_FIELD_LIMITS.filename)
      return {
        type,
        sourceId: clipText(sourceId, SHARE_FIELD_LIMITS.sourceId),
        title: clipText(title, SHARE_FIELD_LIMITS.sourceTitle),
        mediaType: cleanName(mediaType, SHARE_FIELD_LIMITS.mediaType),
        ...(filename === '' ? {} : { filename }),
      }
    }
    case 'dynamic-tool':
      return sanitizeTool(part, part.toolName, context)
    default:
      return type.startsWith('tool-') ? sanitizeTool(part, type.slice('tool-'.length), context) : null
  }
}

/**
 * One share message. `withStatus`: the reply's `failed` / `stopped` status applies (false for the assistant parts of a
 * split reply before its last one).
 */
function sanitizeMessage(message: HarnessUIMessage, context: SanitizeContext, withStatus = true): ShareMessage {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const metadata = asRecord(message.metadata)
  const shared: ShareMessage = { role, parts: [] }
  if (role === 'assistant') {
    const modelRef = metadata?.modelRef
    if (typeof modelRef === 'string' && safeParseModelRef(modelRef) !== null)
      shared.modelRef = modelRef
    // An earlier part of a reply split at a steer has no status: the reply went on after it.
    if (withStatus && metadata?.error !== undefined && metadata.error !== null)
      shared.status = 'failed'
    else if (withStatus && metadata?.aborted === true)
      shared.status = 'stopped'
  }
  else {
    const command = asRecord(metadata?.command)
    const name = command?.name
    if (typeof name === 'string' && SLASH_NAME_PATTERN.test(name)) {
      const kind = invocationKindSchema.safeParse(command?.kind)
      shared.command = kind.success ? { name, kind: kind.data } : { name }
    }
  }
  const parts: unknown[] = Array.isArray(message.parts) ? message.parts : []
  for (const part of parts) {
    if (shared.parts.length >= LIMITS.messagePartsMax)
      break
    const kept = sanitizePart(part, context)
    if (kept !== null)
      shared.parts.push(kept)
  }
  return shared
}

export interface SanitizedSnapshot {
  snapshot: ShareSnapshot
  /** The only files the share may serve (ids of the app file URLs of its file parts), without duplicates. */
  fileIds: string[]
}

/** The parts of a message that have a string `type`. */
function typedParts(message: HarnessUIMessage): { type: string }[] {
  return (Array.isArray(message.parts) ? message.parts as unknown[] : [])
    .filter((part): part is { type: string } => typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string')
}

/** True when `parts` hold a part of `type` and every other part is no content (`isContentPart`). */
function holdsOnly(parts: readonly { type: string }[], type: string): boolean {
  return parts.some(part => part.type === type) && parts.every(part => !isContentPart(part) || part.type === type)
}

function isShareable(message: HarnessUIMessage): boolean {
  if (message.role === 'user') {
    // The carrier of a turn the server started holds only background task results or (Phase 11) only hook records
    // (both dropped from shares).
    const parts = typedParts(message)
    return message.metadata?.command?.type !== 'compact' && !holdsOnly(parts, TASK_RESULT_PART_TYPE) && !holdsOnly(parts, HOOK_PART_TYPE)
  }
  if (message.role !== 'assistant')
    return false
  // A `/compact` reply holds only its marker (dropped from shares), so the whole exchange is left out.
  return !holdsOnly(typedParts(message), 'data-compaction')
}

/**
 * The snapshot of an active path (`ChatDetail.messages`). `title` is the chat title at snapshot time (the page shows
 * the share's custom title instead when it has one). Only `user` and `assistant` messages are kept (a `/compact`
 * exchange and the carriers of background task results and of hook continuations are left out), each assistant message
 * split at its steers
 * (`splitSteers`), so `snapshot.messages.length` is the share's `message_count`. A tool waiting for an approval counts
 * as denied when a later share message exists (the steer after it included).
 */
export function sanitizeSnapshot(title: string | null, path: readonly HarnessUIMessage[], fileIdOf: FileIdOf): SanitizedSnapshot {
  const fileIds = new Set<string>()
  const pieces = path.filter(isShareable).map(message => splitSteers([message]))
  const total = pieces.reduce((sum, list) => sum + list.length, 0)
  const messages: ShareMessage[] = []
  for (const list of pieces) {
    const lastAssistant = list.findLastIndex(piece => piece.role === 'assistant')
    list.forEach((piece, index) => {
      const context = { fileIdOf, fileIds, superseded: messages.length < total - 1 }
      messages.push(sanitizeMessage(piece, context, index === lastAssistant))
    })
  }
  return { snapshot: { title, messages }, fileIds: [...fileIds] }
}

/**
 * Messages of a path that a snapshot keeps (`user` and `assistant`, assistant messages split at their steers): compared
 * with `message_count` for `outdated`.
 */
export function shareableMessageCount(path: readonly HarnessUIMessage[]): number {
  return splitSteers(path.filter(isShareable)).length
}

/** Serialized UTF-8 size of a snapshot (checked against `LIMITS.shareSnapshotBytes`). */
export function snapshotBytes(snapshot: ShareSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
}

export interface RenderContext {
  options: ShareOptions
  fileIdOf: FileIdOf
  /** The share's `file_ids`. */
  fileIds: ReadonlySet<string>
  /** Public URL of a file of the share (`/api/share/<token>/files/<id>`). */
  fileUrl: (fileId: string) => string
}

function renderFile(part: FileSharePart, context: RenderContext): FileSharePart | null {
  if (!context.options.attachments)
    return null
  const fileId = context.fileIdOf(part.url)
  let url: string
  if (fileId !== null && context.fileIds.has(fileId))
    url = context.fileUrl(fileId)
  else if (fileId === null && rasterDataUrlType(part.url) !== null)
    url = part.url
  else
    return null
  return { type: 'file', mediaType: part.mediaType, ...(part.filename === undefined ? {} : { filename: part.filename }), url }
}

function renderTool(part: ToolSharePart, details: boolean): ToolSharePart {
  const tool: ToolSharePart = { type: 'tool', toolName: part.toolName, status: part.status }
  if (!details)
    return tool
  if (part.input !== undefined)
    tool.input = part.input
  if (part.output !== undefined)
    tool.output = part.output
  if (part.errorText !== undefined)
    tool.errorText = part.errorText
  return tool
}

/** One stored part as the view shows it (copied field by field), or null when the options leave it out. */
function renderPart(part: SharePart, context: RenderContext): SharePart | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'reasoning':
      return context.options.reasoning ? { type: 'reasoning', text: part.text } : null
    case 'file':
      return renderFile(part, context)
    case 'source-url':
      return { type: 'source-url', sourceId: part.sourceId, url: part.url, ...(part.title === undefined ? {} : { title: part.title }) }
    case 'source-document':
      return {
        type: 'source-document',
        sourceId: part.sourceId,
        title: part.title,
        mediaType: part.mediaType,
        ...(part.filename === undefined ? {} : { filename: part.filename }),
      }
    case 'tool':
      return renderTool(part, context.options.toolDetails)
    default:
      return null
  }
}

/** The command of a stored user message, copied field by field (`kind` only when it is a known invocation kind). */
function renderCommand(command: NonNullable<ShareMessage['command']>): NonNullable<ShareMessage['command']> {
  const kind = invocationKindSchema.safeParse(command.kind)
  return kind.success ? { name: command.name, kind: kind.data } : { name: command.name }
}

/** The messages of a stored snapshot with the share's options applied and file URLs rewritten (see the module comment). */
export function renderShareMessages(snapshot: ShareSnapshot | null | undefined, context: RenderContext): ShareMessage[] {
  const messages: unknown[] = Array.isArray(snapshot?.messages) ? snapshot.messages : []
  const rendered: ShareMessage[] = []
  for (const value of messages) {
    const message = asRecord(value)
    if (message === null || (message.role !== 'user' && message.role !== 'assistant'))
      continue
    const stored = message as unknown as ShareMessage
    const parts: unknown[] = Array.isArray(stored.parts) ? stored.parts : []
    rendered.push({
      role: stored.role,
      ...(typeof stored.modelRef === 'string' ? { modelRef: stored.modelRef } : {}),
      ...(typeof stored.command?.name === 'string' ? { command: renderCommand(stored.command) } : {}),
      ...(stored.status === 'failed' || stored.status === 'stopped' ? { status: stored.status } : {}),
      parts: parts.flatMap((part) => {
        const shown = asRecord(part) === null ? null : renderPart(part as SharePart, context)
        return shown === null ? [] : [shown]
      }),
    })
  }
  return rendered
}

/** The title stored in a snapshot (the chat title at snapshot time). */
export function snapshotTitle(snapshot: ShareSnapshot | null | undefined): string | null {
  return typeof snapshot?.title === 'string' ? snapshot.title : null
}
