// Attachments of the chat pipeline (API.md 6.2). User messages carry `file` parts whose `url` is `/api/files/<id>`
// (uploaded through `POST /files`); the server validates them before the history changes and rewrites `mediaType` and
// `filename` from the stored row. For the model, the bytes are loaded only when the model can read them: images need
// `vision`, PDFs need `pdf`; text files are inlined as text for every model. Other parts stay in the transcript for
// display (a notice says they were not sent). Only stored files are ever read: no URL is fetched.
import type { HarnessUIMessage, HarnessUIMessagePart, ModelCapabilities } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { FilesService } from '../services/files/types.ts'
import { Buffer } from 'node:buffer'
import { HarnessError } from '@harness-forge/shared'
import { fileUrl } from '../services/files/index.ts'

/** Characters of an inlined text file. */
export const INLINE_TEXT_MAX_CHARS = 200_000
/** Sent instead of a user message whose only parts are attachments the model cannot read. */
export const UNREADABLE_ATTACHMENTS_TEXT = '(The user attached files that this model cannot read.)'

function invalidPart(message: string, index: number): HarnessError {
  const path = ['message', 'parts', index]
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path, message, code: 'custom' }] } })
}

/**
 * The parts of a user message as stored: text parts as `{ type, text }`, file parts rewritten from their `files` row.
 * `validation_error` for any other part type, a file URL that is not `/api/files/<id>` or an unknown file.
 */
export async function normalizeUserParts(parts: readonly unknown[], files: Pick<FilesService, 'idFromUrl' | 'get'>): Promise<HarnessUIMessagePart[]> {
  const result: HarnessUIMessagePart[] = []
  for (const [index, raw] of parts.entries()) {
    const part = raw as Record<string, unknown>
    if (part.type === 'text') {
      if (typeof part.text !== 'string')
        throw invalidPart('Text parts need a text.', index)
      result.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'file') {
      const id = typeof part.url === 'string' ? files.idFromUrl(part.url) : null
      if (id === null)
        throw invalidPart('File parts must reference an uploaded file (/api/files/<id>).', index)
      const stored = await files.get(id)
      if (stored === null)
        throw invalidPart(`The file ${id} does not exist.`, index)
      result.push({ type: 'file', mediaType: stored.mime, filename: stored.name, url: fileUrl(stored.id) })
      continue
    }
    throw invalidPart('User messages can only contain text and file parts.', index)
  }
  if (result.length === 0)
    throw invalidPart('The message is empty.', 0)
  return result
}

/** What a model can read of a file with this MIME type. */
export function fileTreatment(mime: string, capabilities: Pick<ModelCapabilities, 'vision' | 'pdf'>): 'bytes' | 'text' | 'drop' {
  const type = (mime.split(';')[0] ?? '').trim().toLowerCase()
  if (type.startsWith('image/'))
    return capabilities.vision ? 'bytes' : 'drop'
  if (type === 'application/pdf')
    return capabilities.pdf ? 'bytes' : 'drop'
  if (type.startsWith('text/'))
    return 'text'
  return 'drop'
}

export interface ModelFilesResult {
  messages: HarnessUIMessage[]
  /** File parts of `noticeMessageId` that were not sent to the model. */
  dropped: number
}

/** Decodes UTF-8 (invalid sequences replaced) and caps the length. */
function inlineText(name: string, data: Uint8Array): string {
  let text = Buffer.from(data).toString('utf8')
  if (text.length > INLINE_TEXT_MAX_CHARS)
    text = `${text.slice(0, INLINE_TEXT_MAX_CHARS)}\n[truncated]`
  return `Attached file "${name}":\n\n${text}`
}

/**
 * The history as the model sees it: user file parts become data URLs (readable files), inline text (text files) or are
 * left out; assistant file parts are kept only as data URLs. Messages are copied, the input is not changed.
 */
export async function prepareModelFiles(
  history: readonly HarnessUIMessage[],
  options: {
    capabilities: Pick<ModelCapabilities, 'vision' | 'pdf'>
    files: Pick<FilesService, 'idFromUrl' | 'read'>
    logger: Logger
    /** The message whose dropped files are counted for the notice (the new user message). */
    noticeMessageId?: string
  },
): Promise<ModelFilesResult> {
  let dropped = 0
  const cache = new Map<string, { mime: string, name: string, data: Uint8Array } | null>()

  async function load(id: string): Promise<{ mime: string, name: string, data: Uint8Array } | null> {
    if (cache.has(id))
      return cache.get(id) ?? null
    let value: { mime: string, name: string, data: Uint8Array } | null = null
    try {
      const { file, data } = await options.files.read(id)
      value = { mime: file.mime, name: file.name, data }
    }
    catch (error) {
      options.logger.warn('cannot read an attached file', { fileId: id, err: error })
    }
    cache.set(id, value)
    return value
  }

  const messages: HarnessUIMessage[] = []
  for (const message of history) {
    if (!message.parts.some(part => part.type === 'file' || part.type === 'reasoning-file')) {
      messages.push(message)
      continue
    }
    const parts: HarnessUIMessagePart[] = []
    for (const part of message.parts) {
      if (part.type !== 'file' && part.type !== 'reasoning-file') {
        parts.push(part)
        continue
      }
      if (part.url.startsWith('data:')) {
        if (message.role === 'assistant' || fileTreatment(part.mediaType, options.capabilities) === 'bytes')
          parts.push(part)
        else if (message.id === options.noticeMessageId)
          dropped += 1
        continue
      }
      const id = message.role === 'user' && part.type === 'file' ? options.files.idFromUrl(part.url) : null
      const stored = id === null ? null : await load(id)
      if (stored === null) {
        if (message.id === options.noticeMessageId)
          dropped += 1
        continue
      }
      const treatment = fileTreatment(stored.mime, options.capabilities)
      if (treatment === 'bytes')
        parts.push({ ...part, mediaType: stored.mime, url: `data:${stored.mime};base64,${Buffer.from(stored.data).toString('base64')}` })
      else if (treatment === 'text')
        parts.push({ type: 'text', text: inlineText(stored.name, stored.data) })
      else if (message.id === options.noticeMessageId)
        dropped += 1
    }
    // A user message must keep some content: say what was attached instead of sending an empty message.
    if (message.role === 'user' && parts.length === 0)
      parts.push({ type: 'text', text: UNREADABLE_ATTACHMENTS_TEXT })
    messages.push({ ...message, parts })
  }
  return { messages, dropped }
}
