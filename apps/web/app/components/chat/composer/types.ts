// Public types of the composer contract (docs/UI.md 10.4), for ChatView (W2.2):
//   import type { ComposerSubmitInput } from '~/components/chat/composer/types'
import type { FileRef, QueueItem } from '@harness-forge/shared'
import type { ChatStatus } from 'ai'

/** `useChat` status the composer renders (Send in `ready` / `error`, Stop in `submitted` / `streaming`). */
export type ComposerStatus = ChatStatus

/** Payload of `submit`: trimmed text and the already uploaded files. Client commands never emit it. */
export interface ComposerSubmitInput {
  text: string
  files: FileRef[]
}

/** `defineExpose` of ChatComposer. */
export interface ChatComposerExposed {
  /** Focuses the textarea (not on touch devices, where it would open the keyboard). */
  focus: () => void
  /** Replaces the text (caret at the end) and focuses. */
  setText: (text: string) => void
  /** Opens the model picker (e.g. the "Choose model" error action). */
  openModelPicker: () => void
  /**
   * + Phase 9 (ADR-042; C25 declares, W9.8 implements; frozen from Gate P9-0b): puts queued messages back into the
   * composer (the ones a Stop dropped, or an edited one): their texts are appended to the draft with blank lines
   * between them, their files come back as done chips, and a toast says "Queued messages moved back to the composer."
   */
  restoreQueued: (items: readonly QueueItem[]) => void
}
