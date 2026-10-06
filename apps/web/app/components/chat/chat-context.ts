// Chat-wide actions offered by ChatView to deeply nested transcript pieces (e.g. the "Choose model" error action),
// so the message contract stays small.
import type { BackgroundTask, HookEvent, TaskInput, TaskResultData } from '@harness-forge/shared'
import type { InjectionKey, Ref } from 'vue'

export interface ChatViewActions {
  /** Opens the composer's model picker. */
  openModelPicker: () => void
  /**
   * Opens the project trust dialog of the chat's project (Phase 11, ADR-049; docs/UI.md 7.33), focused on the item
   * whose sha256 is `focusKey` when given (the trust chip, the chat-chip menu, the composer refusal's Review…).
   */
  openProjectTrust: (focusKey?: string) => void
  /** Opens the project MCP dialog of the chat's project, focused on `serverId` when given (docs/UI.md 7.33). */
  openProjectMcp: (serverId?: string) => void
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

/**
 * The input of the `task` call that launched a background agent (W10.10; docs/UI.md 7.29): ChatView provides it from the
 * shown path (the launching message's `tool-task` part, parsed), the dock's rows read it for `TaskBody`. Null when the
 * path does not show that call (the details toggle is then left out).
 */
export type BackgroundTaskInput = (task: BackgroundTask) => TaskInput | null

export const BACKGROUND_TASK_INPUT: InjectionKey<BackgroundTaskInput> = Symbol('hf-background-task-input')

/**
 * The hooks running right now in the chat's stream (Phase 11, ADR-048; docs/UI.md 7.31, 11.8): the session's
 * `hookActivity` (`{ event, toolCallId }` from the transient `data-activity { kind: 'hooks' }`, null otherwise). ChatView
 * provides it; ToolPart injects it for its "Running hook…" status (the transcript rows are `v-memo`ed, so per-tool
 * activity cannot come through props). Absent on share pages (inject with a null default).
 */
export const HOOK_ACTIVITY: InjectionKey<Readonly<Ref<{ event: HookEvent, toolCallId: string | null } | null>>> = Symbol('hf-hook-activity')
