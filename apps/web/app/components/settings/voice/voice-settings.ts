// Settings -> Media "Voice" rules (docs/UI.md 9.9, docs/API.md 4.3 `Settings`, 4.19): the dictation languages, the
// read-aloud speeds, the voice field (validated like `speechVoiceSchema`, empty = the provider default), the voice
// suggestions and the Test voice text (read with the player id `VOICE_TEST_ID` of useSpeechPlayer). Everything here is
// pure except `isSecureOrigin()`.
import { settingsSchema, speechVoiceSchema, transcriptionLanguageSchema } from '@harness-forge/shared'

/** What Test voice reads. */
export const TEST_VOICE_TEXT = 'This is how replies sound when they are read aloud.'

/** The `transcriptionLanguage` of automatic detection (nothing is sent to the provider). */
export const AUTO_LANGUAGE = 'auto'

export interface LanguageOption {
  /** `auto` or an ISO 639-1 code. */
  value: string
  /** English name. */
  label: string
}

/** "Detect automatically", then common languages by English name (docs/UI.md 9.9). */
export const TRANSCRIPTION_LANGUAGES: readonly LanguageOption[] = [
  { value: AUTO_LANGUAGE, label: 'Detect automatically' },
  { value: 'ar', label: 'Arabic' },
  { value: 'zh', label: 'Chinese' },
  { value: 'cs', label: 'Czech' },
  { value: 'da', label: 'Danish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'en', label: 'English' },
  { value: 'fi', label: 'Finnish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'el', label: 'Greek' },
  { value: 'hi', label: 'Hindi' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'no', label: 'Norwegian' },
  { value: 'pl', label: 'Polish' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ru', label: 'Russian' },
  { value: 'es', label: 'Spanish' },
  { value: 'sv', label: 'Swedish' },
  { value: 'tr', label: 'Turkish' },
  { value: 'uk', label: 'Ukrainian' },
]

/** The label of a stored language: its English name, else the code itself (a code set through the API, e.g. `yue`). */
export function languageLabel(value: string): string {
  return TRANSCRIPTION_LANGUAGES.find(option => option.value === value)?.label ?? value
}

/** A select value that is a valid `transcriptionLanguage` (`auto` or an ISO 639 code), else null. */
export function parseLanguage(value: unknown): string | null {
  const parsed = transcriptionLanguageSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Read-aloud speeds of the "Speed" select (docs/UI.md 9.9); 1 is the default. */
export const SPEECH_SPEEDS: readonly number[] = [0.75, 1, 1.25, 1.5, 1.75, 2]

/** "0.75×", "1×", "1.5×" (a stored speed outside the list keeps its own label, e.g. "0.5×"). */
export function speedLabel(speed: number): string {
  return `${speed}×`
}

/** A select value ("1.25") as a valid `speechSpeed` (0.5 to 2), else null. */
export function parseSpeed(value: unknown): number | null {
  const speed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(speed))
    return null
  return settingsSchema.shape.speechSpeed.safeParse(speed).success ? speed : null
}

/** Longest voice name (`speechVoiceSchema`). */
export const VOICE_MAX_LENGTH = 64

/**
 * The typed voice: `{ value: null }` when empty (the provider default), `{ value }` trimmed when it passes
 * `speechVoiceSchema`, else `{ error }` with the inline message.
 */
export function parseVoice(text: string): { value: string | null } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '')
    return { value: null }
  if (trimmed.length > VOICE_MAX_LENGTH)
    return { error: `Use at most ${VOICE_MAX_LENGTH} characters.` }
  const parsed = speechVoiceSchema.safeParse(trimmed)
  if (parsed.success)
    return { value: parsed.data }
  return { error: 'Voices use letters, digits, spaces and "_", ".", ":", "-".' }
}

/** Suggestions of the voice field: every voice containing the typed text (case-insensitive); all when it is empty. */
export function filterVoices(voices: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase()
  const unique = [...new Set(voices)]
  if (needle === '')
    return unique
  return unique.filter(voice => voice.toLowerCase().includes(needle))
}

/**
 * The page runs in a secure context (HTTPS or localhost), which the microphone needs. Same test as the composer's
 * dictation (`useVoiceInput().secure`).
 */
export function isSecureOrigin(): boolean {
  return globalThis.isSecureContext === true
}
