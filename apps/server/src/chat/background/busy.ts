// The conflict of a chat whose background agent runs (Phase 10, ADR-046): a running background task makes the chat (and
// its project) busy, so moving the chat or deleting a message version answers `409 conflict` (`reason: 'run-active'`)
// with this message (project-level checks use `PROJECT_TASKS_MESSAGE` of `services/projects/index.ts`). A tiny module on
// purpose: the chats service imports it without pulling in the chat runner.
import { HarnessError } from '@harness-forge/shared'

export const BACKGROUND_BUSY_MESSAGE = 'A background agent of this chat is running. Stop it or wait until it finishes, then try again.'

/** `409 conflict` (`run-active`, `details.chatId`) while a background task of the chat runs. */
export function backgroundConflict(chatId: string): HarnessError {
  return new HarnessError({ code: 'conflict', message: BACKGROUND_BUSY_MESSAGE, details: { reason: 'run-active', chatId } })
}
