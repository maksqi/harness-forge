// Chat-wide actions offered by ChatView to deeply nested transcript pieces (e.g. the "Choose model" error action),
// so the message contract stays small.
import type { BackgroundTask, TaskResultData } from '@harness-forge/shared'
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

/**
 * What a background `task` block needs from its chat (Phase 10, ADR-046; docs/UI.md 7.27, 7.29, 11.7): ChatView provides
 * it, TaskBlock injects it (absent on share pages, where blocks stay static).
 */
export interface AgentTaskContext {
  /** The chat's project, or null. */
  projectId: () => string | null
  /** The live background task from the background-tasks store, or null. */
  task: (taskId: string) => BackgroundTask | null
  /** The chat's background tasks were fetched at least once. */
  tasksLoaded: () => boolean
  /** The delivered result on the shown path (`taskResultsOf`), or null. */
  result: (taskId: string) => TaskResultData | null
  /** Opens the dock list and expands the task's row ("Show in background agents"). */
  reveal: (taskId: string) => void
  /** Scrolls to the result note and opens its report ("Go to the result"); false when the path holds none. */
  showResult: (taskId: string) => boolean
}

export const AGENT_TASK_CONTEXT: InjectionKey<AgentTaskContext> = Symbol('hf-agent-task-context')
