// Read aloud (docs/UI.md 7.18, 11.3; ADR-029): one app-wide player, a module singleton shared by every ReadAloudButton
// and Settings -> Media's Test voice (id 'voice-test'). It reads the text of a reply (speech-text.ts) in sentence
// chunks, one POST /api/audio/speech per chunk (the next one fetched while the current one plays), through one reused
// HTMLAudioElement unlocked inside the click, with object URLs revoked after use, one AbortController per chunk and
// playbackRate = the speechSpeed setting. Starting another reply stops the first; a chat switch, hiding the page,
// starting a dictation and Esc outside inputs stop it; the natural end returns to idle.
// Stub (C12, P6-0b): implemented by W6.8 in P6-A; the signature of useSpeechPlayer is frozen. This stub stays idle:
// play / stop / toggle do nothing yet.
import type { Ref } from 'vue'
import { readonly, ref } from 'vue'

export type SpeechPlayerState = 'idle' | 'loading' | 'playing'

/** Overrides of the Settings -> Media choices for one read (Test voice passes the chosen model and voice). */
export interface SpeechPlayOptions {
  modelRef?: string
  voice?: string
}

export interface SpeechPlayer {
  state: Readonly<Ref<SpeechPlayerState>>
  /** The message being read ('voice-test' for Settings -> Media), or null. */
  activeId: Readonly<Ref<string | null>>
  /** Stops whatever plays, then reads `markdown` in chunks (speech-text.ts). */
  play: (id: string, markdown: string, opts?: SpeechPlayOptions) => Promise<void>
  stop: () => void
  /** Stops when `id` is active, else plays. */
  toggle: (id: string, markdown: string, opts?: SpeechPlayOptions) => Promise<void>
}

const state = ref<SpeechPlayerState>('idle')
const activeId = ref<string | null>(null)

const player: SpeechPlayer = {
  state: readonly(state),
  activeId: readonly(activeId),
  play: () => Promise.resolve(),
  stop: () => {},
  toggle: () => Promise.resolve(),
}

/** The app-wide player (the same object on every call). */
export function useSpeechPlayer(): SpeechPlayer {
  return player
}
