// The media checks of the live provider suite (`HF_LIVE_MEDIA=1`, PROVIDERS.md 12 "Media checks"). Each check runs on
// its own in-process app with only its provider's key (`createTestApp`: in-memory database, temp data directory, never
// `data/`) and goes through the HTTP API, like the chat checks:
//   image          an image turn (`POST /api/chat` with the image model and `imageOptions: { n: 1, aspectRatio: '1:1' }`,
//                  which OpenAI's `imageParams` maps to `size: '1024x1024'`); Google and OpenRouter use a chat model with
//                  image output instead (after a free model refresh, `imageOptions: { aspectRatio: '1:1' }`). The reply
//                  holds exactly one (image model) or at least one (image output) `file` part with an `/api/files/`
//                  URL, every file is a stored raster image (of the size `imageParams` asked for, when it asked for
//                  one) and no part carries a `data:` URL;
//   speech         `POST /api/audio/speech` with a short sentence and the provider's default voice: an allowlisted audio
//                  type that matches the bytes, `Cache-Control: no-store`, `nosniff`, the `Content-Length` of a
//                  non-trivial body. The audio becomes a clip for the transcription checks;
//   transcription  every transcription model of the provider transcribes one clip (the provider's own speech when it
//                  has one, else the first clip of the run) with the language hint `en`: `Cache-Control: no-store` and
//                  a transcript that contains "quick brown fox" (case-insensitive, punctuation ignored).
// Cost and safety: every request counts against `HF_LIVE_MAX_COST_USD` at its recorded cost, else at the fixed estimate
// of `LIVE_MEDIA_ESTIMATES_USD` (marked `~`); a check is SKIP once the budget is spent or on a rate limit (HTTP 429);
// a chat model with image output is capped at 4096 output tokens and one step; a log record that contains the key
// fails the check; details are masked like every other report text.
import type { HookMap, ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { AudioSpeechBody, CatalogModel, HarnessUIMessage, ImageOptions } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { ChatStreamResult } from './checks.ts'
import type { LiveImageSource, LiveMediaCheckRef, LiveMediaRunEntry } from './matrix.ts'
import type { LiveBudget, LiveCheckResult, LiveMediaCheckId, LiveMediaReport, LiveStatus } from './summary.ts'
import { audioTranscriptionSchema, createChatId, formatModelRef, GENERATED_IMAGE_MIME_TYPES } from '@harness-forge/shared'
import { checkAudioType, mediaTypeOf } from '../services/audio/sniff.ts'
import { AUDIO_UPLOAD_TYPES, SPEECH_AUDIO_MIME_TYPES } from '../services/audio/types.ts'
import { sniffBinaryType } from '../services/files/sniff.ts'
import { sanitizeImageParams } from '../services/images/generation.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import {
  assistantOf,
  budgetSpentResult,
  CAPS_PRIORITY,
  errorEnvelope,
  errorResult,
  LIVE_PLUGIN_ID,
  sendChat,
  streamProblem,
  thrownResult,
} from './checks.ts'
import { budgetExhausted, formatUsd, LIVE_MEDIA_ESTIMATES_USD, maskSecrets, oneLine } from './summary.ts'

export const LIVE_MEDIA_PROMPTS = {
  image: 'Generate one image: a single flat red circle centered on a plain white background, with no text.',
  speech: 'The quick brown fox jumps over the lazy dog.',
} as const

/** What every transcript must contain (compared case-insensitively, punctuation ignored). */
export const LIVE_TRANSCRIPT_PHRASE = 'quick brown fox'

/** The language hint of the transcription checks: it goes through the provider's `transcriptionOptions`. */
export const LIVE_TRANSCRIPTION_LANGUAGE = 'en'

/** Limits of the media checks. */
export const LIVE_MEDIA_CAPS = {
  /** Images per image check (`imageOptions.n` of an image turn). */
  images: 1,
  /** Aspect ratio of every image check: square, `size: '1024x1024'` at OpenAI. */
  aspectRatio: '1:1',
  /** Output tokens of a chat model with image output (one Gemini image is about 1,300 tokens). */
  imageOutputTokens: 4096,
  /** Steps of a chat model with image output (no tools are sent). */
  imageOutputSteps: 1,
  /** A speech body below this is no speech. */
  speechMinBytes: 1024,
} as const

/** `/api/files/<id>`: where every generated image must live (never a `data:` URL). */
const FILE_URL = /^\/api\/files\/[\w-]+$/

/** File extensions of the speech types, for the name of the uploaded clip. */
const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
}

// ---------- results and cost ----------

/** What a media check spent: USD, and whether part of it is a fixed estimate. */
export interface LiveMediaCost {
  usd: number
  estimated: boolean
}

/** The audio of a passed speech check: what the transcription checks transcribe. */
export interface LiveSpeechClip {
  readonly providerId: string
  readonly modelRef: string
  /** The response `Content-Type` (an allowlisted audio type). */
  readonly mediaType: string
  readonly bytes: Uint8Array<ArrayBuffer>
}

export interface LiveMediaOutcome {
  readonly result: LiveCheckResult
  readonly cost: LiveMediaCost
  /** Speech checks that passed. */
  readonly clip?: LiveSpeechClip
}

/** What a media check runs against. `key` is only used to assert that no log record contains it. */
export type LiveMediaTarget = Omit<LiveMediaRunEntry, 'status'>

/**
 * The cost of one media request: the recorded cost when the provider reported one (above 0), else the fixed estimate
 * of its kind (marked `~`). The audio routes never report a cost; image models without a catalog price or token usage
 * neither.
 */
export function mediaCost(kind: LiveMediaCheckId, recordedUsd: number | null): LiveMediaCost {
  if (recordedUsd !== null && recordedUsd > 0)
    return { usd: recordedUsd, estimated: false }
  return { usd: LIVE_MEDIA_ESTIMATES_USD[kind], estimated: true }
}

function formatCost(cost: LiveMediaCost): string {
  return `${cost.estimated ? '~' : ''}${formatUsd(cost.usd)}`
}

function withCost(result: LiveCheckResult, cost: LiveMediaCost): LiveCheckResult {
  return { ...result, detail: result.detail === undefined ? formatCost(cost) : `${result.detail}; ${formatCost(cost)}` }
}

/** `1234` -> `1.2 KB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The results of every media check of a run, by provider, and the clips of the passed speech checks. */
export interface LiveMediaResults {
  readonly clips: LiveSpeechClip[]
  readonly providers: Map<string, { checks: Partial<Record<LiveMediaCheckId, LiveCheckResult>>, costUsd: number, costEstimated: boolean }>
}

export function createLiveMediaResults(): LiveMediaResults {
  return { clips: [], providers: new Map() }
}

/** Records the outcome of one media check (a skipped check: its result only). */
export function recordMediaOutcome(results: LiveMediaResults, check: LiveMediaCheckRef, outcome: { result: LiveCheckResult, cost?: LiveMediaCost, clip?: LiveSpeechClip }): void {
  const entry = results.providers.get(check.providerId) ?? { checks: {}, costUsd: 0, costEstimated: false }
  entry.checks[check.kind] = outcome.result
  entry.costUsd += outcome.cost?.usd ?? 0
  entry.costEstimated ||= outcome.cost?.estimated ?? false
  results.providers.set(check.providerId, entry)
  if (outcome.clip !== undefined)
    results.clips.push(outcome.clip)
}

/** The media report of a provider (for `withMediaResults`), undefined when none of its media checks was recorded. */
export function mediaReportOf(results: LiveMediaResults, providerId: string): LiveMediaReport | undefined {
  return results.providers.get(providerId)
}

// ---------- caps and requests ----------

/** The `chat.params` handler of an image-output check: at most 4096 output tokens and one step. */
export function capImageOutputParams(_input: HookMap['chat.params'][0], output: HookMap['chat.params'][1]): void {
  output.maxOutputTokens = Math.min(output.maxOutputTokens ?? LIVE_MEDIA_CAPS.imageOutputTokens, LIVE_MEDIA_CAPS.imageOutputTokens)
  output.maxSteps = Math.min(output.maxSteps, LIVE_MEDIA_CAPS.imageOutputSteps)
}

/** `imageOptions` of an image check: `n` is for image models only (a chat model with image output takes the ratio). */
export function liveImageOptions(source: LiveImageSource): ImageOptions {
  return source === 'image-model'
    ? { n: LIVE_MEDIA_CAPS.images, aspectRatio: LIVE_MEDIA_CAPS.aspectRatio }
    : { aspectRatio: LIVE_MEDIA_CAPS.aspectRatio }
}

/**
 * The pixel size the provider's `imageParams` asks for with the request of an image check (OpenAI: `1024x1024`), as
 * the image service sends it; undefined when the provider asks for none (it gets the aspect ratio instead).
 */
export function requestedImageSize(definition: ProviderDefinition | undefined, modelId: string): string | undefined {
  if (definition?.imageParams === undefined)
    return undefined
  try {
    const request = { n: LIVE_MEDIA_CAPS.images, aspectRatio: LIVE_MEDIA_CAPS.aspectRatio, inputs: 0 }
    return sanitizeImageParams(definition.imageParams(request, { id: modelId, kind: 'image' })).size
  }
  catch {
    return undefined
  }
}

/** The multipart body of a transcription check: the clip, the model and the language hint. */
export function transcriptionForm(clip: LiveSpeechClip, modelRef: string): FormData {
  const form = new FormData()
  form.append('file', new File([clip.bytes], `speech${AUDIO_EXTENSIONS[clip.mediaType] ?? ''}`, { type: clip.mediaType }))
  form.append('modelRef', modelRef)
  form.append('language', LIVE_TRANSCRIPTION_LANGUAGE)
  return form
}

// ---------- evaluation ----------

/** Width and height of a PNG, GIF or JPEG image; null for any other content (WebP is not measured). */
export function imageDimensions(bytes: Uint8Array): { width: number, height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (start: number, length: number): string => String.fromCharCode(...bytes.subarray(start, start + length))
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR')
    return { width: view.getUint32(16), height: view.getUint32(20) }
  if (bytes.length >= 10 && ascii(0, 4) === 'GIF8')
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8)
    return null
  let offset = 2
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xFF)
      return null
    const marker = bytes[offset + 1]!
    if (marker === 0xFF) {
      offset += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) {
      offset += 2
      continue
    }
    if (marker === 0xD9 || marker === 0xDA)
      return null
    // SOF0-SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) are other segments.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC)
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
    offset += 2 + view.getUint16(offset + 2)
  }
  return null
}

/** Lowercase words of a text (letters and digits; everything else separates words). */
export function transcriptWords(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word !== '')
}

/** True when the transcript contains `LIVE_TRANSCRIPT_PHRASE` (case-insensitive, punctuation ignored). */
export function transcriptMatches(text: string): boolean {
  return ` ${transcriptWords(text).join(' ')} `.includes(` ${LIVE_TRANSCRIPT_PHRASE} `)
}

/** How many distinct words of the spoken sentence a transcript contains. */
export function recognizedWords(text: string): { found: number, total: number } {
  const spoken = new Set(transcriptWords(LIVE_MEDIA_PROMPTS.speech))
  const heard = new Set(transcriptWords(text))
  return { found: [...spoken].filter(word => heard.has(word)).length, total: spoken.size }
}

/** A clip the transcription route accepts: an allowed recording type that matches its bytes. */
export function isTranscribable(clip: LiveSpeechClip): boolean {
  return checkAudioType(clip.mediaType, clip.bytes).ok
}

/** The clip a provider's transcription models transcribe: its own speech when it has one, else the run's first clip. */
export function pickSpeechClip(clips: readonly LiveSpeechClip[], providerId: string): LiveSpeechClip | null {
  const usable = clips.filter(isTranscribable)
  return usable.find(clip => clip.providerId === providerId) ?? usable[0] ?? null
}

const KIND_NAMES: Readonly<Record<LiveMediaCheckId, string>> = { image: 'an image', speech: 'a speech', transcription: 'a transcription' }

/** Why a catalog entry cannot serve a media check (not listed, the wrong kind, no image output), else null. */
export function modelProblem(entry: CatalogModel | null, kind: LiveMediaCheckId, modelId: string, source: LiveImageSource | null): LiveCheckResult | null {
  if (entry === null)
    return { status: 'FAIL', detail: `"${modelId}" is not in the catalog${source === 'image-output' ? ' after a model refresh' : ''}` }
  if (kind === 'image' && source === 'image-output') {
    if (entry.kind !== 'chat' || !entry.capabilities.imageOutput)
      return { status: 'FAIL', detail: `"${modelId}" is not listed as a chat model with image output (kind ${entry.kind})` }
    return null
  }
  if (entry.kind !== kind)
    return { status: 'FAIL', detail: `"${modelId}" is listed as a ${entry.kind} model, not as ${KIND_NAMES[kind]} model` }
  return null
}

/** A generated image as fetched from `GET /api/files/:id`. */
export interface LiveImageFile {
  readonly url: string
  /** The `mediaType` of the saved `file` part. */
  readonly partMediaType: string
  readonly status: number
  readonly bytes: number
  /** The type of the file's magic bytes, null when unknown. */
  readonly sniffed: string | null
  readonly width?: number
  readonly height?: number
}

export interface ImageReplyInput {
  readonly modelId: string
  readonly source: LiveImageSource
  readonly stream: ChatStreamResult
  /** The saved reply. */
  readonly stored: HarnessUIMessage | undefined
  /** The files of the saved `file` parts. */
  readonly files: readonly LiveImageFile[]
  /** The size `imageParams` asked for (OpenAI: `1024x1024`); undefined when it asked for none. */
  readonly requestedSize?: string
}

/** The `file` parts of a message. */
export function fileParts(message: HarnessUIMessage | undefined): { url: string, mediaType: string }[] {
  return (message?.parts ?? []).flatMap(part => (part.type === 'file' ? [{ url: part.url, mediaType: part.mediaType }] : []))
}

/** Parts of a message that carry a `data:` URL (must stay 0: ADR-028). */
function dataUrlParts(message: HarnessUIMessage): number {
  return message.parts.filter((part) => {
    const url = (part as { url?: unknown }).url
    return typeof url === 'string' && url.trim().toLowerCase().startsWith('data:')
  }).length
}

/** The image check: the stream, the saved reply and the stored files (see the header). */
export function evaluateImageReply(input: ImageReplyInput): LiveCheckResult {
  const problem = streamProblem(input.stream)
  if (problem !== null)
    return problem
  const exact = input.source === 'image-model'
  const expected = exact ? `exactly ${LIVE_MEDIA_CAPS.images}` : 'at least 1'
  const countOk = (count: number): boolean => (exact ? count === LIVE_MEDIA_CAPS.images : count >= 1)
  const streamed = input.stream.files.length
  if (!countOk(streamed)) {
    const dropped = input.stream.notices.filter(code => code === 'generated-file-dropped').length
    const reason = dropped > 0 ? `; the server dropped ${dropped} generated file(s)` : ''
    return { status: 'FAIL', detail: `${streamed} image(s) streamed, expected ${expected}${reason} (finish reason: ${input.stream.metadata?.finishReason ?? 'unknown'})` }
  }
  if (input.stream.files.some(file => !FILE_URL.test(file.url)))
    return { status: 'FAIL', detail: 'a streamed image is not an /api/files/ URL' }
  if (input.stored === undefined)
    return { status: 'FAIL', detail: 'the reply was not persisted' }
  if (dataUrlParts(input.stored) > 0)
    return { status: 'FAIL', detail: 'the saved reply holds a data: URL' }
  const parts = fileParts(input.stored)
  if (!countOk(parts.length))
    return { status: 'FAIL', detail: `the saved reply has ${parts.length} file part(s), expected ${expected}` }
  if (parts.some(part => !FILE_URL.test(part.url)) || input.files.length !== parts.length)
    return { status: 'FAIL', detail: 'a saved file part is not an /api/files/ URL' }
  for (const file of input.files) {
    if (file.status !== 200)
      return { status: 'FAIL', detail: `GET ${file.url} answered HTTP ${file.status}` }
    if (file.sniffed === null || !(GENERATED_IMAGE_MIME_TYPES as readonly string[]).includes(file.sniffed))
      return { status: 'FAIL', detail: `${file.url} is not a raster image (${file.sniffed ?? 'unknown content'})` }
    if (file.sniffed !== file.partMediaType)
      return { status: 'FAIL', detail: `${file.url} holds ${file.sniffed}, the saved part says ${file.partMediaType}` }
    const size = file.width === undefined ? undefined : `${file.width}x${file.height}`
    if (input.requestedSize !== undefined && size !== undefined && size !== input.requestedSize)
      return { status: 'FAIL', detail: `the image is ${size}, imageParams asked for ${input.requestedSize}` }
  }
  const [first] = input.files
  const size = first?.width === undefined ? '' : ` ${first.width}x${first.height}`
  const total = input.files.reduce((sum, file) => sum + file.bytes, 0)
  const text = input.source === 'image-output' ? `, ${input.stream.text.trim() === '' ? 'no' : 'with'} text` : ''
  const requested = input.requestedSize === undefined ? '' : `, size ${input.requestedSize} requested`
  return { status: 'PASS', detail: `${input.modelId}: ${input.files.length} ${first?.sniffed ?? 'image'}${size} (${formatBytes(total)})${text}${requested}` }
}

export interface SpeechResponseInput {
  readonly modelId: string
  readonly status: number
  readonly headers: Headers
  readonly bytes: Uint8Array
}

/** The speech check: an allowlisted audio type matching the bytes, no-store, nosniff, the length, a real body. */
export function evaluateSpeech(input: SpeechResponseInput): LiveCheckResult {
  if (input.status !== 200)
    return errorResult(errorEnvelope(new TextDecoder().decode(input.bytes), input.status))
  const type = mediaTypeOf(input.headers.get('content-type') ?? undefined)
  if (!(SPEECH_AUDIO_MIME_TYPES as readonly string[]).includes(type))
    return { status: 'FAIL', detail: `Content-Type ${type || 'missing'} is not an allowlisted audio type` }
  if (!/\bno-store\b/i.test(input.headers.get('cache-control') ?? ''))
    return { status: 'FAIL', detail: 'the answer lacks Cache-Control: no-store' }
  if ((input.headers.get('x-content-type-options') ?? '').trim().toLowerCase() !== 'nosniff')
    return { status: 'FAIL', detail: 'the answer lacks X-Content-Type-Options: nosniff' }
  const length = input.bytes.byteLength
  if (input.headers.get('content-length') !== String(length))
    return { status: 'FAIL', detail: `Content-Length ${input.headers.get('content-length') ?? 'missing'} does not match the ${length} bytes of the body` }
  if (length < LIVE_MEDIA_CAPS.speechMinBytes)
    return { status: 'FAIL', detail: `only ${length} bytes of audio` }
  if (Object.hasOwn(AUDIO_UPLOAD_TYPES, type) && !checkAudioType(type, input.bytes).ok)
    return { status: 'FAIL', detail: `the audio does not match its type (${type})` }
  return { status: 'PASS', detail: `${input.modelId}: ${type}, ${formatBytes(length)}, the provider's default voice` }
}

export interface TranscriptionResponseInput {
  readonly modelRef: string
  readonly status: number
  readonly headers: Headers
  readonly text: string
}

/** One transcription: no-store, an `AudioTranscription` of the requested model whose text holds the phrase. */
export function evaluateTranscription(input: TranscriptionResponseInput): LiveCheckResult {
  if (input.status !== 200)
    return errorResult(errorEnvelope(input.text, input.status))
  if (!/\bno-store\b/i.test(input.headers.get('cache-control') ?? ''))
    return { status: 'FAIL', detail: 'the answer lacks Cache-Control: no-store' }
  let body: unknown
  try {
    body = JSON.parse(input.text)
  }
  catch {
    return { status: 'FAIL', detail: 'the answer is not JSON' }
  }
  const parsed = audioTranscriptionSchema.safeParse(body)
  if (!parsed.success)
    return { status: 'FAIL', detail: 'the answer is not an AudioTranscription' }
  const { text, language, modelRef } = parsed.data
  if (modelRef !== input.modelRef)
    return { status: 'FAIL', detail: `answered by ${modelRef}, not ${input.modelRef}` }
  if (!transcriptMatches(text))
    return { status: 'FAIL', detail: `the transcript "${oneLine(text, 80)}" lacks "${LIVE_TRANSCRIPT_PHRASE}"` }
  const words = recognizedWords(text)
  return { status: 'PASS', detail: `${words.found}/${words.total} words${language === null ? '' : `, language ${oneLine(language, 16)}`}` }
}

/** The results of several models as one: FAIL when any failed, else PASS when any passed, else SKIP. */
export function combineResults(results: readonly { modelId: string, result: LiveCheckResult }[], prefix: string): LiveCheckResult {
  const has = (status: LiveStatus): boolean => results.some(({ result }) => result.status === status)
  const status: LiveStatus = has('FAIL') ? 'FAIL' : has('PASS') ? 'PASS' : 'SKIP'
  const parts = results.map(({ modelId, result }) => `${modelId} ${result.status}${result.detail === undefined ? '' : ` (${result.detail})`}`)
  return { status, detail: [prefix, ...parts].join('; ') }
}

// ---------- the checks ----------

/** One media check in progress: its app and target, the run's budget and the spending of the check. */
interface MediaRun {
  readonly t: TestApp
  readonly target: LiveMediaTarget
  readonly budget: LiveBudget
  /** Adds the cost of one request to the budget and to the check's spending. */
  readonly spend: (cost: LiveMediaCost) => void
}

interface CheckedMedia {
  result: LiveCheckResult
  clip?: LiveSpeechClip
}

async function findModel(t: TestApp, providerId: string, modelId: string): Promise<CatalogModel | null> {
  const { items } = await t.client.models.list({ query: { providerId, includeHidden: true } })
  return items.find(model => model.id === modelId) ?? null
}

/** The stored files of the saved `file` parts (`/api/files/` URLs only). */
async function fetchImageFiles(t: TestApp, parts: readonly { url: string, mediaType: string }[]): Promise<LiveImageFile[]> {
  const files: LiveImageFile[] = []
  for (const part of parts) {
    if (!FILE_URL.test(part.url))
      continue
    const response = await t.request(part.url)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const size = imageDimensions(bytes)
    files.push({ url: part.url, partMediaType: part.mediaType, status: response.status, bytes: bytes.byteLength, sniffed: sniffBinaryType(bytes), ...size })
  }
  return files
}

async function checkImage({ t, target, budget, spend }: MediaRun): Promise<CheckedMedia> {
  const modelId = target.modelIds[0] ?? ''
  const source = target.imageSource ?? 'image-model'
  if (source === 'image-output') {
    // Chat models with image output come from the live listing: a model refresh first (free).
    try {
      await t.client.models.refresh({ params: { id: target.providerId } })
    }
    catch (error) {
      const failure = thrownResult(error)
      return { result: { ...failure, detail: `model refresh: ${failure.detail ?? 'failed'}` } }
    }
  }
  const problem = modelProblem(await findModel(t, target.providerId, modelId), 'image', modelId, source)
  if (problem !== null)
    return { result: problem }
  if (budgetExhausted(budget))
    return { result: budgetSpentResult(budget) }
  const caps = source === 'image-output' ? t.deps.registry.hooks.on(LIVE_PLUGIN_ID, 'chat.params', capImageOutputParams, { priority: CAPS_PRIORITY }) : null
  try {
    const chatId = createChatId()
    await t.client.chats.create({ body: { id: chatId, title: `Live image check (${target.providerId})` } })
    let stream: ChatStreamResult
    try {
      stream = await sendChat(t, {
        chatId,
        text: LIVE_MEDIA_PROMPTS.image,
        modelRef: formatModelRef(target.providerId, modelId),
        reasoningEffort: 'auto',
        toolMode: 'off',
        imageOptions: liveImageOptions(source),
      })
    }
    catch (error) {
      spend(mediaCost('image', null))
      throw error
    }
    const detail = await t.client.chats.get({ params: { id: chatId } }).catch(() => null)
    const cost = mediaCost('image', detail?.totals.costUsd ?? null)
    spend(cost)
    if (detail === null)
      return { result: withCost({ status: 'FAIL', detail: 'the chat cannot be read back' }, cost) }
    const stored = assistantOf(detail, stream.messageId)
    const files = await fetchImageFiles(t, fileParts(stored))
    const requestedSize = source === 'image-model' ? requestedImageSize(t.deps.registry.providers.get(target.providerId)?.definition, modelId) : undefined
    const result = evaluateImageReply({ modelId, source, stream, stored, files, ...(requestedSize === undefined ? {} : { requestedSize }) })
    return { result: withCost(result, cost) }
  }
  finally {
    caps?.dispose()
  }
}

async function checkSpeech({ t, target, budget, spend }: MediaRun): Promise<CheckedMedia> {
  const modelId = target.modelIds[0] ?? ''
  const problem = modelProblem(await findModel(t, target.providerId, modelId), 'speech', modelId, null)
  if (problem !== null)
    return { result: problem }
  if (budgetExhausted(budget))
    return { result: budgetSpentResult(budget) }
  const modelRef = formatModelRef(target.providerId, modelId)
  // No voice: the provider default, as with `speechVoice` null in Settings.
  const body = { text: LIVE_MEDIA_PROMPTS.speech, modelRef } satisfies AudioSpeechBody
  const cost = mediaCost('speech', null)
  spend(cost)
  const response = await t.request('/api/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const bytes = new Uint8Array(await response.arrayBuffer())
  const result = evaluateSpeech({ modelId, status: response.status, headers: response.headers, bytes })
  if (result.status !== 'PASS')
    return { result: withCost(result, cost) }
  const clip: LiveSpeechClip = { providerId: target.providerId, modelRef, mediaType: mediaTypeOf(response.headers.get('content-type') ?? undefined), bytes }
  return { result: withCost(result, cost), clip }
}

async function checkTranscription({ t, target, budget, spend }: MediaRun, clips: readonly LiveSpeechClip[]): Promise<CheckedMedia> {
  const clip = pickSpeechClip(clips, target.providerId)
  if (clip === null)
    return { result: { status: 'SKIP', detail: 'no speech clip to transcribe: no speech check of this run passed (a provider with a speech model needs a key too)' } }
  const results: { modelId: string, result: LiveCheckResult }[] = []
  const spent: LiveMediaCost = { usd: 0, estimated: false }
  for (const modelId of target.modelIds) {
    const problem = modelProblem(await findModel(t, target.providerId, modelId), 'transcription', modelId, null)
    if (problem !== null) {
      results.push({ modelId, result: problem })
      continue
    }
    if (budgetExhausted(budget)) {
      results.push({ modelId, result: budgetSpentResult(budget) })
      continue
    }
    const modelRef = formatModelRef(target.providerId, modelId)
    const cost = mediaCost('transcription', null)
    spend(cost)
    spent.usd += cost.usd
    spent.estimated ||= cost.estimated
    const response = await t.request('/api/audio/transcriptions', { method: 'POST', body: transcriptionForm(clip, modelRef) })
    results.push({ modelId, result: evaluateTranscription({ modelRef, status: response.status, headers: response.headers, text: await response.text() }) })
  }
  const combined = combineResults(results, `clip from ${clip.modelRef} (${clip.mediaType}, ${formatBytes(clip.bytes.byteLength)})`)
  return { result: spent.usd > 0 ? withCost(combined, spent) : combined }
}

/**
 * Runs one media check on an app that has the provider's key (and only that key). Adds the spending to `budget`;
 * never throws (a thrown error becomes the check's FAIL). A log record that contains the key fails the check.
 */
export async function runMediaCheck(t: TestApp, target: LiveMediaTarget, budget: LiveBudget, clips: readonly LiveSpeechClip[] = []): Promise<LiveMediaOutcome> {
  const spent: LiveMediaCost = { usd: 0, estimated: false }
  const spend = (cost: LiveMediaCost): void => {
    spent.usd += cost.usd
    spent.estimated ||= cost.estimated
    budget.spentUsd += cost.usd
    budget.estimated ||= cost.estimated
  }
  const run: MediaRun = { t, target, budget, spend }
  let checked: CheckedMedia
  try {
    if (target.kind === 'image')
      checked = await checkImage(run)
    else if (target.kind === 'speech')
      checked = await checkSpeech(run)
    else
      checked = await checkTranscription(run, clips)
  }
  catch (error) {
    checked = { result: thrownResult(error) }
  }
  if (t.logs.text().includes(target.key))
    checked = { result: { status: 'FAIL', detail: 'a log record contains the key' } }
  const { status, detail } = checked.result
  const result: LiveCheckResult = detail === undefined ? { status } : { status, detail: maskSecrets(detail, [target.key]) }
  return { result, cost: { ...spent }, ...(checked.clip === undefined ? {} : { clip: checked.clip }) }
}

/**
 * One media check end to end: an app with only the provider's key (`HF_OFFLINE=1`, in-memory database), the check,
 * then close. An app that cannot start is the check's FAIL.
 */
export async function runLiveMediaCheck(entry: LiveMediaRunEntry, budget: LiveBudget, clips: readonly LiveSpeechClip[] = []): Promise<LiveMediaOutcome> {
  let t: TestApp
  try {
    t = await createTestApp({ env: { HF_OFFLINE: '1', [entry.envVar]: entry.key } })
  }
  catch (error) {
    const failure = thrownResult(error)
    return { result: { status: 'FAIL', detail: `the test app did not start: ${maskSecrets(failure.detail ?? '', [entry.key])}` }, cost: { usd: 0, estimated: false } }
  }
  try {
    return await runMediaCheck(t, entry, budget, clips)
  }
  finally {
    await t.close()
  }
}
