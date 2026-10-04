// Frozen interface of background sub-agents (Phase 10, ADR-046; API.md 4.29 / 5.30, ARCHITECTURE.md 6.26): a `task`
// call with `background: true` returns at once and its child runs detached from the tool call. Implementation:
// `createBackgroundTasks(deps, host)` in `chat/background/index.ts` (C30 stub: every launch fails with
// `BACKGROUND_UNAVAILABLE_TEXT`, the reads answer empty; W10.4 implements the manager). The chat runner creates one
// manager (`chat/index.ts`, C31) and delegates to it: `ChatRunner.taskList` / `stopTask` / `stopTasks` / `hasTasks`,
// `ChatRunner.boot()` (the boot sweep, `startDeps` right after `checkpoints.start()`), `stopAll` (after the queues are
// cleared, before the runs are aborted) and `onRunReleased` (`onChatIdle`). Consumers: the sub-agent runner (`launch`,
// W10.3), the steer step (`takeResults`, W10.4), the `chatTasks` routes and the project-busy guards (W10.4). Test
// double: `createFakeBackgroundTasks` (`testing/fake-background-tasks.ts`), installed with
// `createTestApp({ backgroundTasks: 'fake' })`.
//
// Rules (ADR-046): tasks are rows of `background_tasks` (`bgt_` ids, a cascade from `chats`), written at start and at
// finish; at most `LIMITS.backgroundTasksPerChatMax` running per chat and `LIMITS.backgroundTasksMax` per server, each
// with `LIMITS.backgroundTaskTimeoutMs` and `subagentMaxSteps`; a background child never asks for approval; its writes
// are journaled under the launching message (the copied run scope); the chat's own Stop never stops a task (its Stop
// route, chat and project delete, delete-all, key rotation and shutdown do); every change emits `task.changed` (at most
// one per second per task, plus every status change); a finished task's result is delivered exactly once
// (`delivered_at`). Prompts and reports are never logged at info.
import type {
  BackgroundTask,
  ChatRequestBody,
  ReasoningEffort,
  RunOrigin,
  Settings,
  TaskInput,
  TaskOutput,
  TaskResultData,
  ToolMode,
} from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { ResolvedModel } from '../../providers/types.ts'
import type { CustomizationCatalog } from '../../services/customizations/types.ts'
import type { OpenWorkspace } from '../../services/projects/types.ts'
import type { AppDeps } from '../../types.ts'
import type { WorkspaceRunScopeInit } from '../../workspace/run-scope.ts'
import type { ChatRunOptions } from '../types.ts'

/** The error of a background launch before W10.4 (the C30 stub). */
export const BACKGROUND_UNAVAILABLE_TEXT = 'Background agents are not available yet.'

/** The error of a task its Stop (or a chat / project delete, delete-all, key rotation, shutdown) aborted. */
export const BACKGROUND_STOPPED_TEXT = 'The background task was stopped.'

/** The error of a task the boot sweep found still `running` (API.md 4.29). */
export const BACKGROUND_RESTARTED_TEXT = 'The server restarted before the task finished.'

/**
 * What `launch` needs: the launching run's call ids and everything a detached child needs to run on its own after the
 * launching run ended (the sub-agent runner passes its parent's values, W10.3).
 */
export interface BackgroundLaunchInput {
  readonly chatId: string
  /** The assistant message whose `task` call launches the task (its writes are journaled under this message). */
  readonly messageId: string
  /** The `task` call that launches it. */
  readonly toolCallId: string
  /** The validated `task` input (`background: true`). */
  readonly task: TaskInput
  /** The origin of the launching run (a task launched from an `origin: 'task'` turn never starts a turn). */
  readonly origin: RunOrigin
  /** The launching run's model (the child's model when no other applies, as for foreground children). */
  readonly model: ResolvedModel
  /** The launching run's permission mode (the child's tools and approvals follow it, `childTools`). */
  readonly toolMode: ToolMode
  /** The launching run's open project folder, or null. */
  readonly workspace: OpenWorkspace | null
  /** The launching run's scope (journal, shell rules, shell folder), copied for the child; null without a workspace. */
  readonly scope: WorkspaceRunScopeInit | null
  /** The settings of the launching run (`subagentModelRef`, `subagentMaxSteps`, `instructions`). */
  readonly settings: Settings
  readonly reasoningEffort: ReasoningEffort
  /** The chat's own instructions, if any. */
  readonly chatInstructions: string | undefined
  /** The launching run's catalog snapshot (the agent type and its body are resolved against it). */
  readonly catalog: CustomizationCatalog
  /** The launching run's logger (the task logs with its own child logger). */
  readonly logger: Logger
}

/**
 * What the manager needs from the chat runner that creates it (`chat/index.ts`). Read lazily: the manager never calls
 * them while it is constructed.
 */
export interface BackgroundTasksHost {
  /** The runs registry holds the chat in any phase (`ChatRunner.hasRun`). */
  readonly hasRun: (chatId: string) => boolean
  /**
   * Starts a server turn of the chat with `origin: 'task'` (`run.started.origin`) whose user-role carrier message
   * (`body.message`) holds only `data-task-result` parts (`prepareRun(…, { serverMessage: true })`). Rejects like
   * `ChatRunner.start` (`conflict` `run-active` when the chat is taken: the results go back to the head of the inbox).
   */
  readonly startTaskTurn: (body: ChatRequestBody, options: ChatRunOptions) => Promise<Response>
}

/**
 * The background tasks of every chat. Frozen after P10-0b. Errors of a launch never throw: they are a `failed` output.
 */
export interface BackgroundTasks {
  /**
   * Launches a background child (the caps first: past one, a `failed` output naming it); inserts its row, starts the
   * detached child under its own abort signal (its Stop, the deadline) and answers at once with `{ status:
   * 'background', taskId, … }`. Never throws.
   */
  readonly launch: (input: BackgroundLaunchInput) => Promise<TaskOutput>
  /**
   * Synchronous (the steer step, one take per step boundary): removes every undelivered result of the chat from the
   * in-memory inbox, oldest first, stamps `deliveredAt` and records `messageId` (the reply or carrier message that will
   * hold the `data-task-result` parts) as `delivered_message_id` (the row write runs in the background; a failure is
   * logged). Empty when nothing waits.
   */
  readonly takeResults: (chatId: string, messageId: string) => TaskResultData[]
  /**
   * The chat became idle after a natural ending without a pending approval and no queued message started
   * (`onRunReleased`): delivers the waiting results through `host.startTaskTurn` when the rules allow it (no
   * maintenance, a chat-model chat, results of tasks whose origin is not `task`). Never throws.
   */
  readonly onChatIdle: (chatId: string) => void
  /** `GET /chat/:id/tasks`: the chat's tasks, newest first (running ones with their latest snapshot). */
  readonly list: (chatId: string) => Promise<BackgroundTask[]>
  /**
   * `POST /chat/:id/tasks/:taskId/stop`: aborts a running task (`aborted`, "The background task was stopped.") and
   * answers once its row is saved; a task that already ended is answered as it is; null when the chat has no such task
   * (route: 404). The stopped task's result is still delivered (at the chat's next run; a stop never starts a turn).
   */
  readonly stop: (chatId: string, taskId: string) => Promise<BackgroundTask | null>
  /**
   * Aborts every running task of the chat (chat or project delete, delete-all, key rotation) and waits until their rows
   * are saved; drops the chat's inbox. Returns how many were running.
   */
  readonly stopChat: (chatId: string) => Promise<number>
  /** A task of the chat is running (`ChatRunner.hasTasks`: the project-busy guards). */
  readonly hasRunning: (chatId: string) => boolean
  /**
   * Boot sweep (`ChatRunner.boot()`, once, right after `checkpoints.start()`): rows still `running` become `aborted`
   * ("The server restarted before the task finished."); undelivered finished rows fill the in-memory inboxes (delivered
   * at each chat's next run; no turn is started at boot).
   */
  readonly start: () => Promise<void>
  /**
   * Shutdown (`ChatRunner.stopAll`, after the queues were cleared and before the runs are aborted): aborts every running
   * task, waits at most 5 s for their rows to be saved, clears the inboxes and the timers. Idempotent; never throws.
   */
  readonly stopAll: () => Promise<void>
}

/**
 * How the chat runner creates its manager: `createBackgroundTasks` (./index.ts) by default; tests pass another one
 * through `ChatRunnerOptions.backgroundTasks` (`createTestApp({ backgroundTasks })`).
 */
export type BackgroundTasksFactory = (deps: AppDeps, host: BackgroundTasksHost) => BackgroundTasks
