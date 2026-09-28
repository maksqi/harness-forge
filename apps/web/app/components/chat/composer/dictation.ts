// Dictation helpers of the composer (docs/UI.md 7.17; ADR-029): where a transcript goes into the text
// (`insertDictation`), which recorder type the browser records (`pickRecorderMimeType`), the name of the uploaded clip
// (`recordingFileName`) and the toast of a failed dictation (`dictationErrorToast`). Pure functions, shared by
// useVoiceInput and ChatComposer.
import { errorTitle, toHarnessErrorView } from '~/components/common/harness-error'

/** Recorder types in order of preference: Opus in WebM (Chrome, Edge, Firefox), WebM, Opus in Ogg, MP4 (Safari). */
export const RECORDER_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'] as const

/** Bit rate of a dictation: plenty for speech, 2.4 MB for the 10-minute maximum. */
export const RECORDER_BITS_PER_SECOND = 32_000

/** Clips shorter than this are discarded without a request. */
export const MIN_DICTATION_MS = 500

/** Alt+V (docs/UI.md 12), matched by `event.code` like every Alt shortcut; off with the `altShortcuts` setting. */
export const DICTATION_SHORTCUT = 'alt+code:KeyV'

/**
 * The first recorder type of `RECORDER_MIME_TYPES` the browser supports, or undefined to record the browser's default
 * (also when `MediaRecorder.isTypeSupported` is missing).
 */
export function pickRecorderMimeType(recorder: { isTypeSupported?: (type: string) => boolean } | null | undefined): string | undefined {
  if (typeof recorder?.isTypeSupported !== 'function')
    return undefined
  for (const type of RECORDER_MIME_TYPES) {
    try {
      if (recorder.isTypeSupported(type))
        return type
    }
    catch {
      // A browser that throws for a type: try the next one.
    }
  }
  return undefined
}

const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
}

/** File name of the multipart part `file`: `dictation.webm`, `dictation.m4a`, ... (parameters such as codecs ignored). */
export function recordingFileName(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return `dictation.${FILE_EXTENSIONS[base] ?? 'webm'}`
}

// ---------- inserting a transcript ----------

/** A caret (start = end) or a selection in the text, as `selectionStart` / `selectionEnd`. */
export interface DictationRange {
  start: number
  end: number
}

export interface DictationResult {
  text: string
  /** The caret after the insertion: the end of the transcript. */
  caret: number
}

/** Characters after which the next word needs no space: opening brackets and typographic opening quotes. */
const OPENERS = new Set(['(', '[', '{', '“', '‘', '«', '¿', '¡'])

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char)
}

/** A space goes between the text before the caret and the transcript unless a space or an opener ends it. */
function needsSpaceBefore(before: string): boolean {
  const last = before.at(-1)
  if (last === undefined || isSpace(last) || OPENERS.has(last))
    return false
  if (last === '"' || last === '\'') {
    // A straight quote after a space (or at the start) opens a quotation: `said "` + transcript.
    const previous = before.at(-2)
    return !(previous === undefined || isSpace(previous) || OPENERS.has(previous))
  }
  return true
}

/** A space goes after the transcript when a word, a number or an opening bracket follows. */
function needsSpaceAfter(after: string): boolean {
  return /^[\p{L}\p{N}([{“‘«¿¡]/u.test(after)
}

function clamp(value: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 0), max) : max
}

/**
 * Inserts a transcript at the caret (or over the selection) saved when the recording started, with a space before and
 * after when needed; the caret ends after the transcript (docs/UI.md 7.17, 14.1). An empty transcript changes nothing.
 */
export function insertDictation(text: string, transcript: string, at: DictationRange | number = text.length): DictationResult {
  const range = typeof at === 'number' ? { start: at, end: at } : at
  const start = clamp(range.start, text.length)
  const end = Math.max(start, clamp(range.end, text.length))
  const spoken = transcript.trim()
  if (!spoken)
    return { text, caret: end }
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = needsSpaceBefore(before) ? ' ' : ''
  const trail = needsSpaceAfter(after) ? ' ' : ''
  return {
    text: `${before}${lead}${spoken}${trail}${after}`,
    caret: before.length + lead.length + spoken.length,
  }
}

// ---------- errors ----------

export interface DictationToast {
  title: string
  description?: string
}

/** The name of a DOMException-like error (getUserMedia and MediaRecorder reject with DOMExceptions). */
function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null)
    return undefined
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}

const MICROPHONE_ERRORS: Readonly<Record<string, string>> = {
  NotAllowedError: 'Microphone access is blocked. Allow it in the browser\'s site settings.',
  PermissionDeniedError: 'Microphone access is blocked. Allow it in the browser\'s site settings.',
  NotFoundError: 'No microphone was found.',
  DevicesNotFoundError: 'No microphone was found.',
  OverconstrainedError: 'No microphone was found.',
  NotReadableError: 'The microphone is in use by another app.',
  TrackStartError: 'The microphone is in use by another app.',
  AbortError: 'The microphone is in use by another app.',
  SecurityError: 'Voice input needs HTTPS or localhost',
  NotSupportedError: 'This browser can\'t record audio.',
}

/**
 * The toast of a failed dictation (docs/UI.md 7.17): the microphone errors of getUserMedia, "The recording is too long."
 * for 413, else the 7.4 title of the error (`{provider}` named by `providerName`) with the server message.
 */
export function dictationErrorToast(error: unknown, providerName?: (providerId: string) => string | undefined): DictationToast {
  const name = errorName(error)
  const microphone = name ? MICROPHONE_ERRORS[name] : undefined
  // A DOMException's `code` is a number; an API error (HarnessError, envelope) has a string `code`.
  if (microphone && typeof (error as { code?: unknown }).code !== 'string')
    return { title: microphone }
  const view = toHarnessErrorView(error)
  if (view.code === 'payload_too_large')
    return { title: 'The recording is too long.' }
  const provider = view.providerId ? providerName?.(view.providerId) : undefined
  return { title: errorTitle(view, provider), description: view.message }
}
