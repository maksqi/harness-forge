// Attachments of the chat pipeline (API.md 6.2). User messages carry `file` parts whose `url` is `/api/files/<id>`
// (uploaded through `POST /files`); the server validates them before the history changes and rewrites `mediaType` and
// `filename` from the stored row. For the model, the bytes are loaded only when the model can read them: images need
// `vision`, PDFs need `pdf`; text files are inlined as text for every model. Other parts stay in the transcript for
// display (a notice says they were not sent). Only stored files are ever read: no URL is fetched.
//
// Generated files in the history (ADR-028, ARCHITECTURE.md 6.1): most provider converters (Anthropic, OpenAI Responses,
// OpenRouter) drop images in assistant messages, and an assistant message that held only images would reach them
// empty. So every `file` part of an assistant message becomes the text `[Generated image: <name>]` in place, and for a
// model with `vision` the images of the most recent assistant message that has any are carried into the next user
// message (after the text part "(Images generated earlier in this chat:)", at most `LIMITS.imageInputsMax`, as data
// URLs). `reasoning-file` parts (draft images of a reasoning model) never go back to a model.
import type { HarnessUIMessage, HarnessUIMessagePart, ModelCapabilities } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { FilesService } from '../services/files/types.ts'
import { Buffer } from 'node:buffer'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { fileUrl } from '../services/files/index.ts'

/** Characters of an inlined text file. */
export const INLINE_TEXT_MAX_CHARS = 200_000
/** Sent instead of a user message whose only parts are attachments the model cannot read. */
export const UNREADABLE_ATTACHMENTS_TEXT = '(The user attached files that this model cannot read.)'
/** Precedes the generated images carried into the next user message (vision models). */
export const CARRIED_IMAGES_TEXT = '(Images generated earlier in this chat:)'

/** The text that replaces a generated file of an assistant message in the history sent to a model. */
export function generatedFileText(part: { mediaType: string, filename?: string }): string {
  const image = part.mediaType.trim().toLowerCase().startsWith('image/')
  const name = part.filename?.trim() || (image ? 'image' : 'file')
  return image ? `[Generated image: ${name}]` : `[Generated file: ${name}]`
}

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

type StoredContent = { mime: string, name: string, data: Uint8Array } | null
type FilePart = Extract<HarnessUIMessagePart, { type: 'file' }>

/**
 * The generated images carried into the next user message: those of the most recent assistant message that has any
 * (at most `LIMITS.imageInputsMax`, the latest ones), and the index of the first user message after it. Null when no
 * user message follows.
 */
export function carriedImages(history: readonly HarnessUIMessage[]): { parts: FilePart[], toIndex: number } | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]
    if (message?.role !== 'assistant')
      continue
    const images = message.parts.filter((part): part is FilePart => part.type === 'file' && part.mediaType.trim().toLowerCase().startsWith('image/'))
    if (images.length === 0)
      continue
    const toIndex = history.findIndex((later, laterIndex) => laterIndex > index && later.role === 'user')
    return toIndex < 0 ? null : { parts: images.slice(-LIMITS.imageInputsMax), toIndex }
  }
  return null
}

/** An assistant message as the model sees it: generated files as text in place, no `reasoning-file` parts. */
export function assistantForModel(message: HarnessUIMessage): HarnessUIMessage {
  if (!message.parts.some(part => part.type === 'file' || part.type === 'reasoning-file'))
    return message
  const parts = message.parts.flatMap((part): HarnessUIMessagePart[] => {
    if (part.type === 'reasoning-file')
      return []
    if (part.type === 'file')
      return [{ type: 'text', text: generatedFileText(part) }]
    return [part]
  })
  return { ...message, parts }
}

/**
 * The history as the model sees it: user file parts become data URLs (readable files), inline text (text files) or are
 * left out; assistant file parts become text and, for vision models, the latest generated images are carried into the
 * next user message (see the header comment). Messages are copied, the input is not changed.
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
  const cache = new Map<string, StoredContent>()

  async function load(id: string): Promise<StoredContent> {
    if (cache.has(id))
      return cache.get(id) ?? null
    let value: StoredContent = null
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

  function dataUrl(mime: string, data: Uint8Array): string {
    return `data:${mime};base64,${Buffer.from(data).toString('base64')}`
  }

  /** The carried images as data URL file parts (unreadable ones left out). */
  async function carriedParts(parts: readonly FilePart[]): Promise<HarnessUIMessagePart[]> {
    const loaded: HarnessUIMessagePart[] = []
    for (const part of parts) {
      if (part.url.startsWith('data:')) {
        loaded.push({ type: 'file', mediaType: part.mediaType, url: part.url })
        continue
      }
      const id = options.files.idFromUrl(part.url)
      const stored = id === null ? null : await load(id)
      if (stored !== null && stored.mime.startsWith('image/'))
        loaded.push({ type: 'file', mediaType: stored.mime, url: dataUrl(stored.mime, stored.data) })
    }
    return loaded.length === 0 ? [] : [{ type: 'text', text: CARRIED_IMAGES_TEXT }, ...loaded]
  }

  const carry = options.capabilities.vision ? carriedImages(history) : null
  const messages: HarnessUIMessage[] = []
  for (const [index, message] of history.entries()) {
    if (message.role === 'assistant') {
      messages.push(assistantForModel(message))
      continue
    }
    const carried = carry?.toIndex === index ? await carriedParts(carry.parts) : []
    if (!message.parts.some(part => part.type === 'file' || part.type === 'reasoning-file')) {
      messages.push(carried.length === 0 ? message : { ...message, parts: [...carried, ...message.parts] })
      continue
    }
    const parts: HarnessUIMessagePart[] = [...carried]
    for (const part of message.parts) {
      if (part.type !== 'file' && part.type !== 'reasoning-file') {
        parts.push(part)
        continue
      }
      if (part.url.startsWith('data:')) {
        if (fileTreatment(part.mediaType, options.capabilities) === 'bytes')
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
        parts.push({ ...part, mediaType: stored.mime, url: dataUrl(stored.mime, stored.data) })
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
