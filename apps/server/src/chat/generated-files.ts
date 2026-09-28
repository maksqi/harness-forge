// Generated files of chat runs (ADR-028, ARCHITECTURE.md 6.1 / 6.11, API.md 6.8). `streamText` turns every file a model
// returns into a `data:` URL, and the end callback of a UI message stream saves the chunks it sees. Every chat run is
// therefore streamed as `createUIMessageStream` + `writer.merge(ui.pipeThrough(storeGeneratedFiles(...)))`, so this
// transform runs before the saved message is built and what is saved equals what is streamed:
// - `file` / `reasoning-file` chunks with a `data:` URL: raster images (`GENERATED_IMAGE_MIME_TYPES`, at most
//   `LIMITS.generatedImageBytes`) are stored with `files.saveGenerated` and re-sent with their `/api/files/<id>` URL,
//   keeping `providerMetadata` (Gemini thought signatures); anything else is dropped and replaced by an inline
//   `data-notice` (`generated-file-dropped`). No `data:` URL is ever streamed or saved.
// - the final `tool-output-available` of the builtin `generate_image` tool of `core-tools` (output parsed with
//   `generateImageToolOutputSchema`, every URL equal to `/api/files/<fileId>` of a stored image) is followed by one
//   `file` chunk per image, and the tool's `costUsd` goes to the message cost. A `toolCallId -> toolName` map, seeded
//   from the continued message, covers approval continuations; a tool of that name from another plugin never adds
//   files.
// A UI `file` chunk cannot carry a file name: `GeneratedFiles` remembers the name of every stored file, and
// `finalizeParts` adds it to the saved parts (and drops any leftover `data:` part).
import type { HarnessUIMessage, HarnessUIMessagePart, MessageMetadata } from '@harness-forge/shared'
import type { InferUIMessageChunk } from 'ai'
import type { Logger } from '../logger.ts'
import type { FilesService, StoredFile } from '../services/files/types.ts'
import { Buffer } from 'node:buffer'
import { GENERATE_IMAGE_TOOL_NAME, GENERATED_IMAGE_MIME_TYPES, generateImageToolOutputSchema, LIMITS } from '@harness-forge/shared'
import { fileUrl } from '../services/files/index.ts'
import { NOTICES } from './notices.ts'

/** A UI message chunk of this app. */
export type HarnessUIMessageChunk = InferUIMessageChunk<HarnessUIMessage>

/** The plugin whose `generate_image` tool adds its images to the message (a tool of that name elsewhere never does). */
export const IMAGE_TOOL_PLUGIN_ID = 'core-tools'

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** A media type without parameters, lowercase (`image/jpg` is read as `image/jpeg`). */
export function canonicalMediaType(mediaType: string): string {
  const type = (mediaType.split(';')[0] ?? '').trim().toLowerCase()
  return type === 'image/jpg' ? 'image/jpeg' : type
}

/** True for the raster types a generated image is stored as (`GENERATED_IMAGE_MIME_TYPES`). */
export function isGeneratedImageType(mediaType: string): boolean {
  return (GENERATED_IMAGE_MIME_TYPES as readonly string[]).includes(canonicalMediaType(mediaType))
}

/** True for a `data:` URL (case-insensitive scheme). */
export function isDataUrl(url: unknown): boolean {
  return typeof url === 'string' && /^data:/i.test(url)
}

/** The header of a base64 `data:` URL and its payload, or null (not a data URL, or not base64). */
export function parseDataUrl(url: string): { mediaType: string, base64: string } | null {
  if (!isDataUrl(url))
    return null
  const comma = url.indexOf(',')
  if (comma < 0)
    return null
  const [type = '', ...params] = url.slice('data:'.length, comma).split(';')
  if (!params.some(param => param.trim().toLowerCase() === 'base64'))
    return null
  return { mediaType: canonicalMediaType(type), base64: url.slice(comma + 1) }
}

/** Decoded size of a base64 payload (without decoding it). */
export function base64ByteLength(base64: string): number {
  const trimmed = base64.trim()
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

/**
 * The files one run stored (a UI `file` chunk cannot carry a name: `finalMessage` adds it) and the names of new
 * generated images (`image-1.png`, `image-2.jpg`, ...).
 */
export class GeneratedFiles {
  readonly #names = new Map<string, string>()
  #next: number

  /** `existing`: the files the message already holds (an approval continuation), so new names continue after them. */
  constructor(existing = 0) {
    this.#next = existing + 1
  }

  /** The name of the next image the run stores, e.g. `image-3.png`. */
  nextName(mediaType: string): string {
    const name = `image-${this.#next}.${EXTENSIONS[canonicalMediaType(mediaType)] ?? 'bin'}`
    this.#next += 1
    return name
  }

  /** Remembers a stored file; returns its `/api/files/<id>` URL. */
  add(file: Pick<StoredFile, 'id' | 'name'>): string {
    const url = fileUrl(file.id)
    this.#names.set(url, file.name)
    return url
  }

  /** The name of a file this run stored, by URL. */
  nameOf(url: string): string | undefined {
    return this.#names.get(url)
  }

  /**
   * Parts as saved: `file` parts of files this run stored get their `filename`; every `file` / `reasoning-file` part
   * that still holds a `data:` URL is dropped, so no base64 reaches the `messages` table.
   */
  finalizeParts(parts: readonly HarnessUIMessagePart[]): HarnessUIMessagePart[] {
    const result: HarnessUIMessagePart[] = []
    for (const part of parts) {
      if (part.type !== 'file' && part.type !== 'reasoning-file') {
        result.push(part)
        continue
      }
      if (isDataUrl(part.url))
        continue
      const name = part.type === 'file' && part.filename === undefined ? this.#names.get(part.url) : undefined
      result.push(part.type === 'file' && name !== undefined ? { ...part, filename: name } : part)
    }
    return result
  }
}

/** The tool names of the tool parts of a message, by tool call id (a continued message's calls). */
export function toolNamesOf(message: HarnessUIMessage | null | undefined): Map<string, string> {
  const names = new Map<string, string>()
  for (const part of message?.parts ?? []) {
    const value = part as { type: string, toolCallId?: unknown, toolName?: unknown }
    if (typeof value.toolCallId !== 'string')
      continue
    if (value.type === 'dynamic-tool' && typeof value.toolName === 'string')
      names.set(value.toolCallId, value.toolName)
    else if (value.type.startsWith('tool-'))
      names.set(value.toolCallId, value.type.slice('tool-'.length))
  }
  return names
}

export interface StoreGeneratedFilesOptions {
  files: Pick<FilesService, 'saveGenerated' | 'get'>
  /** Names of the stored files (read by `finalMessage`). */
  generated: GeneratedFiles
  logger: Logger
  /** The plugin that owns the tool of this name in the run (`undefined`: not a tool of this run). */
  toolOwner: (toolName: string) => string | undefined
  /** The continued message of an approval continuation: its tool parts seed the `toolCallId -> toolName` map. */
  continued?: HarnessUIMessage | null
  /** The cost of a `generate_image` output whose images were appended (added to the message cost). */
  onToolCost?: (usd: number) => void
  /**
   * Rewrites the metadata of the `finish` chunk; called after every earlier chunk was handled (so every tool cost is
   * known).
   */
  finishMetadata?: (metadata: MessageMetadata | undefined) => MessageMetadata | undefined
}

type FileChunk = Extract<HarnessUIMessageChunk, { type: 'file' | 'reasoning-file' }>
type ToolOutputChunk = Extract<HarnessUIMessageChunk, { type: 'tool-output-available' }>

/** The transform of every chat run (see the header comment). Never throws: a failure drops the file with a notice. */
export function storeGeneratedFiles(options: StoreGeneratedFilesOptions): TransformStream<HarnessUIMessageChunk, HarnessUIMessageChunk> {
  const { files, generated, logger } = options
  const toolNames = toolNamesOf(options.continued)

  function dropped(): HarnessUIMessageChunk {
    return { type: 'data-notice', data: NOTICES.generatedFileDropped() }
  }

  /** The chunk of a generated file with its stored URL, or the notice when it is not kept. */
  async function storeFile(chunk: FileChunk): Promise<HarnessUIMessageChunk> {
    const parsed = parseDataUrl(chunk.url)
    if (parsed === null) {
      // Models only produce `data:` URLs; any other URL is never followed.
      logger.warn('a generated file without a data URL was dropped', { mediaType: chunk.mediaType })
      return dropped()
    }
    const mediaType = canonicalMediaType(chunk.mediaType || parsed.mediaType)
    const bytes = base64ByteLength(parsed.base64)
    if (!isGeneratedImageType(mediaType) || bytes > LIMITS.generatedImageBytes) {
      logger.info('a generated file was dropped', { mediaType, bytes })
      return dropped()
    }
    const buffer = Buffer.from(parsed.base64, 'base64')
    let file: StoredFile
    try {
      file = await files.saveGenerated({
        data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
        mediaType,
        name: generated.nextName(mediaType),
      })
    }
    catch (error) {
      logger.warn('a generated file was refused', { mediaType, bytes: buffer.byteLength, err: error })
      return dropped()
    }
    return {
      type: chunk.type,
      url: generated.add(file),
      mediaType: file.mime,
      ...(chunk.providerMetadata === undefined ? {} : { providerMetadata: chunk.providerMetadata }),
    }
  }

  /** The `file` chunks of a final `generate_image` output of `core-tools` (none for anything else). */
  async function toolImages(chunk: ToolOutputChunk): Promise<HarnessUIMessageChunk[]> {
    if (chunk.preliminary === true || chunk.dynamic === true)
      return []
    if (toolNames.get(chunk.toolCallId) !== GENERATE_IMAGE_TOOL_NAME || options.toolOwner(GENERATE_IMAGE_TOOL_NAME) !== IMAGE_TOOL_PLUGIN_ID)
      return []
    const output = generateImageToolOutputSchema.safeParse(chunk.output)
    if (!output.success)
      return []
    const chunks: HarnessUIMessageChunk[] = []
    for (const image of output.data.images) {
      // The schema checks only the URL prefix: the URL must name the file id, and the file must be a stored image.
      if (image.url !== fileUrl(image.fileId))
        continue
      const file = await files.get(image.fileId)
      if (file === null || !isGeneratedImageType(file.mime))
        continue
      chunks.push({ type: 'file', url: generated.add(file), mediaType: file.mime })
    }
    if (output.data.costUsd !== undefined)
      options.onToolCost?.(output.data.costUsd)
    return chunks
  }

  async function handle(chunk: HarnessUIMessageChunk): Promise<HarnessUIMessageChunk[]> {
    switch (chunk.type) {
      case 'tool-input-start':
      case 'tool-input-available':
      case 'tool-input-error':
        toolNames.set(chunk.toolCallId, chunk.toolName)
        return [chunk]
      case 'file':
      case 'reasoning-file':
        return [await storeFile(chunk)]
      case 'tool-output-available':
        return [chunk, ...await toolImages(chunk)]
      case 'finish': {
        if (options.finishMetadata === undefined)
          return [chunk]
        const metadata = options.finishMetadata(chunk.messageMetadata)
        return [metadata === undefined ? chunk : { ...chunk, messageMetadata: metadata }]
      }
      default:
        return [chunk]
    }
  }

  return new TransformStream<HarnessUIMessageChunk, HarnessUIMessageChunk>({
    async transform(chunk, controller) {
      let out: HarnessUIMessageChunk[]
      try {
        out = await handle(chunk)
      }
      catch (error) {
        logger.warn('cannot process a generated file', { err: error })
        const holdsData = (chunk.type === 'file' || chunk.type === 'reasoning-file') && isDataUrl(chunk.url)
        out = [holdsData ? dropped() : chunk]
      }
      for (const value of out)
        controller.enqueue(value)
    },
  })
}
