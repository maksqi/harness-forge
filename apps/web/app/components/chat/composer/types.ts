// Public types of the composer contract (docs/UI.md 10.4), for ChatView (W2.2):
//   import type { ComposerSubmitInput } from '~/components/chat/composer/types'
import type { FileRef, QueueItem } from '@harness-forge/shared'
import type { ChatStatus } from 'ai'
import type { ComposerRefusalData } from './output-style'

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
  /**
   * + Phase 11 (ADR-048; C39 declares, W11.10 implements; frozen from Gate P11-0b): shows the refusal of a submit above
   * the text (ComposerRefusal: a hook blocked it, or it runs unapproved shell lines); null clears it. It also clears when
   * the text changes, on the next send and with its ×; Esc never dismisses it.
   */
  showRefusal: (refusal: ComposerRefusalData | null) => void
  /**
   * + Phase 11: puts a refused submit back into the composer: the text replaces the draft and the files come back as
   * done chips (the composer cleared itself on submit).
   */
  restoreInput: (input: ComposerSubmitInput) => void
}
