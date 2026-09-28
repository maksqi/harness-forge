// Chat-wide actions offered by ChatView to deeply nested transcript pieces (e.g. the "Choose model" error action),
// so the message contract stays small.
import type { InjectionKey } from 'vue'

export interface ChatViewActions {
  /** Opens the composer's model picker. */
  openModelPicker: () => void
}

export const CHAT_VIEW_ACTIONS: InjectionKey<ChatViewActions> = Symbol('hf-chat-view-actions')

/** Transcript scrolling, offered by ChatTranscript to the rows inside it. */
export interface TranscriptScrollControls {
  /**
   * Stops following the bottom so content the user just expanded grows downward instead of scrolling the view
   * (docs/UI.md 5.9); following resumes when the reader scrolls back down or sends.
   */
  holdPosition: () => void
}

export const TRANSCRIPT_SCROLL: InjectionKey<TranscriptScrollControls> = Symbol('hf-transcript-scroll')
