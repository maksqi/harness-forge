// Public types of the composer contract (docs/UI.md 10.4), for ChatView (W2.2):
//   import type { ComposerSubmitInput } from '~/components/chat/composer/types'
import type { FileRef } from '@harness-forge/shared'
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
}
