// Frozen interface of the hook service (Phase 11, ADR-048; API.md 4.31 / 5.31, ARCHITECTURE.md 6.28): command hooks in
// Claude Code's format from three sources (personal rows of the `hooks` table, the approved hooks of a project's
// `.harness` / `.claude` `settings{,.local}.json`, plugin `contributes.hooks`) plus the plugin code hooks of the Phase 11
// `HookMap` events, merged additively into one snapshot per run and per prepare. Implementation:
// `createHookService(deps)` in `services/hooks/index.ts` (C36 stub: nothing runs; W11.1 implements the sources, the
// runner, the personal CRUD and the run log). Consumers: the `hooks` routes (W11.1), the chat pipeline (`RunHooks` of
// `chat/hooks.ts` over one `HookSnapshot` per run, C37; `chat/hooks-prompt.ts` at submit and at enqueue, W11.2) and
// shutdown (`stopDeps`: `stop()` right after the runs, before the project MCP runtimes). Test doubles:
// `createFakeHookService` / `createFakeHookSnapshot` (`testing/fake-hooks.ts`), installed with `createTestApp({ hooks:
// 'fake' })`.
//
// Hook configurations are read only by the shared `util/hooks.ts` (`readHooksConfig`, `readSettingsHooks`,
// `compileMatcher`, `buildHookPayload`, `readHookOutput`, `combineHookOutcomes`); no `RegExp` is ever built from input.
// Command hooks run only through `runShellCommand` (`workspace/shell.ts`, `input` = the payload, `env` = the minimal
// shell environment + `HARNESS_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` (+ `HARNESS_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`)),
// each in its own process group, killed on timeout, abort and shutdown. Project items run only while their sha256 is
// approved (`ProjectTrustService.approved`) and still verifies right before the spawn (`ProjectConfigService.verify`).
// Kill switches (command hooks only; plugin code hooks still run): the setting `hooksEnabled`, `HF_WORKSPACE_SHELL=0`,
// `HF_SAFE_MODE`. Logging: `info` = event, source, a hash prefix of the label, exit code, duration, outcome; commands,
// payloads, stdout and stderr only at `debug`, redacted.
import type {
  HookCreate,
  HookData,
  HookEvent,
  HookList,
  HookPayloadInput,
  HookPermissionDecision,
  HookRun,
  HooksQuery,
  HookUpdate,
  PersonalHook,
  RunOrigin,
  ToolMode,
} from '@harness-forge/shared'
import type { SensitiveOperationOptions } from '../../types.ts'
import type { OpenWorkspace } from '../projects/types.ts'

/**
 * What a snapshot is taken for: one run (`RunHooks`, `chat/hooks.ts`) or one prepare (`UserPromptSubmit` /
 * `SessionStart` at submit and at enqueue). The snapshot fills the payload fields `chatId`, `projectId`, `cwd`,
 * `toolMode`, `origin`, `modelRef` and `source` from it.
 */
export interface HookScope {
  readonly chatId: string
  /** The chat's project; null = a chat without a project (no project hooks). */
  readonly projectId: string | null
  /**
   * The project folder opened for the run (`openWorkspace`); null = no project or the folder did not open: project
   * hooks never run then and the working folder of every hook is `<dataDir>/hooks` (created 0700 on first use).
   */
  readonly workspace: OpenWorkspace | null
  /** The chat's tool mode (`permission_mode` through `hookPermissionMode`). */
  readonly toolMode: ToolMode
  /** The run's origin (`harness.origin`; `hook` = a Stop continuation). */
  readonly origin: RunOrigin
  /** The run's model (`harness.modelRef`). */
  readonly modelRef: string
}

/**
 * The event fields of one `run` (the shared `HookPayloadInput` minus what the snapshot fills from its scope and per
 * hook): `tool` for `PreToolUse` / `PostToolUse` (`output` = the tool's output for `PostToolUse`) and, for
 * `SubagentStop`, the `task` call of the child (`name` `task`, `callId`, `input` = the task input with its `type`,
 * `output` = the child's report; read only by the plugin code hooks `subagent.stop`, never put into the command payload);
 * `prompt` for `UserPromptSubmit`; `stopHookActive` for `Stop` / `SubagentStop`; `trigger` / `customInstructions` for
 * `PreCompact`; `sessionSource` for `SessionStart`; `message` / `notificationType` for `Notification`.
 */
export type HookRunInput = Pick<
  HookPayloadInput,
  'messageId' | 'tool' | 'prompt' | 'stopHookActive' | 'trigger' | 'customInstructions' | 'sessionSource' | 'message' | 'notificationType'
> & {
  /**
   * `UserPromptSubmit` of a slash command: the command's name without the `/` (the plugin code hook `prompt.submit`
   * receives it as `command`; `prompt` stays the typed text). Absent for plain prompts.
   */
  readonly command?: string
}

/** Options of one `HookSnapshot.run`. */
export interface HookRunOptions {
  /** The run's signal (a child's for sub-agents): an abort kills the running hook processes and rejects `run`. */
  readonly signal: AbortSignal
  /**
   * The harness name the matchers are tested against: the tool for `PreToolUse` / `PostToolUse` (default
   * `input.tool.name`); ignored by the events whose matcher has another subject (`HOOK_MATCHER_SUBJECTS`).
   */
  readonly target?: string
  /**
   * Every name a tool matcher is tested against (default `hookTargetNames(target)`: the harness name and its Claude
   * Code aliases); a project MCP tool adds `mcp__<name as written in .mcp.json>__<tool>`.
   */
  readonly aliases?: readonly string[]
}

/**
 * What the hooks of one event decided, combined over every matching hook of every source (`combineHookOutcomes`, plus
 * the plugin code hooks of the matching `HookMap` event). Nothing ran: `ran: false`, no decision, no block, `continue:
 * true`, `record: null`.
 */
export interface HookEventResult {
  /** At least one hook (a command or a plugin code hook) ran for the event. */
  readonly ran: boolean
  /** `PreToolUse` only: deny > ask > allow; null = no hook decided. */
  readonly decision: HookPermissionDecision | null
  /** The block or decision reason (joined, at most `LIMITS.hookReasonMaxChars`); null = none. */
  readonly reason: string | null
  /** Model-visible context (joined, at most `LIMITS.hookContextMaxChars`); null = none. */
  readonly context: string | null
  /** `PreToolUse` only: the first `updatedInput` in source order (personal, plugin, project); absent = unchanged. */
  readonly updatedInput?: unknown
  /** A hook blocked (exit 2, `decision: block`, `permissionDecision: deny`). */
  readonly block: boolean
  /** The AND of every hook's `continue` (false = stop the agent). */
  readonly continue: boolean
  /** The first `stopReason` of a hook that stopped; null = none. */
  readonly stopReason: string | null
  /**
   * The `data-hook` record to store where the event ran (its outcome chosen by the service: `context`, `denied`,
   * `asked`, `allowed`, `rewritten`, `blocked`, `continued`, `stopped` or `error`); null = a silent success or nothing ran.
   */
  readonly record: HookData | null
}

/**
 * The hooks of one scope, merged once (personal rows, the approved project items, plugin command hooks of active
 * plugins, plugin code hooks). Immutable: a later change of a source does not change a snapshot already taken.
 */
export interface HookSnapshot {
  /** The scope the snapshot was taken for. */
  readonly scope: HookScope
  /**
   * True when at least one hook (command or code) of any source may run for `event` (matchers not applied); false makes
   * an event free (no payload, no process). Synchronous.
   */
  readonly has: (event: HookEvent) => boolean
  /**
   * Runs every matching hook of `event` in parallel (at most `LIMITS.hooksPerEventMax`, the server-wide semaphore
   * `LIMITS.hookProcessesMax`, each with its own timeout) and combines the outcomes; every run is added to the run log.
   * Never rejects for a failing hook (a non-blocking `error` record instead); rejects only when `options.signal` aborts.
   */
  readonly run: (event: HookEvent, input: HookRunInput, options: HookRunOptions) => Promise<HookEventResult>
}

/**
 * Hooks, the personal hooks and the run log. Errors are `HarnessError`s the routes pass through (API.md 2). Every change
 * of a personal hook emits `hooks.changed { projectId: null }`. Frozen after P11-0b.
 */
export interface HookService {
  /**
   * The hooks of `scope`, merged once: personal rows (`enabled`), the project's items whose sha256 is approved (only
   * when `scope.workspace` is set; identical hashes run once), plugin command hooks (`registry.hookCommands`, active
   * plugins) and plugin code hooks (`registry.hooks`). The kill switches leave only the code hooks. Never rejects for a
   * source that cannot be read (that source is left out); rejects only when `options.signal` aborts.
   */
  readonly snapshot: (scope: HookScope, options?: { readonly signal?: AbortSignal }) => Promise<HookSnapshot>
  /**
   * `GET /hooks` (query validated by the route with `hooksQuerySchema`): every hook of the scope in run order (personal
   * rows; with `query.projectId` the project's settings-file hooks with their trust state and `project`; plugin command
   * and code hooks), the configuration diagnostics and `switches`. Throws `not_found` for an unknown project; an
   * unavailable folder lists no project hooks (`project.available: false`).
   */
  readonly list: (query: HooksQuery) => Promise<HookList>
  /**
   * `POST /hooks`: calls `options.requireFreshAuth()` first when given (the route table marks the route fresh too),
   * validates the matcher (`compileMatcher`; `validation_error` on `['matcher']`), stores the row (`hok_` id). Throws
   * `conflict` when `LIMITS.personalHooksMax` rows exist.
   */
  readonly create: (body: HookCreate, options?: SensitiveOperationOptions) => Promise<PersonalHook>
  /**
   * `PATCH /hooks/:id`: the route calls `requireFreshAuth` unless the body only turns the hook off (`isHookTurnOff`);
   * `options.requireFreshAuth()` is called the same way when given. Throws `not_found`.
   */
  readonly update: (id: string, body: HookUpdate, options?: SensitiveOperationOptions) => Promise<PersonalHook>
  /** `DELETE /hooks/:id` (no fresh auth: removing a hook only takes power away). Throws `not_found`. */
  readonly remove: (id: string) => Promise<void>
  /**
   * `GET /hooks/runs`: the in-memory run log, newest first, at most `limit` entries (default and maximum
   * `LIMITS.hookRunsKept`); never a command, payload or output. Lost on restart. Synchronous.
   */
  readonly runs: (limit?: number) => HookRun[]
  /**
   * Drops the cached snapshot inputs of a project (its settings items and approvals); null drops every cache (personal
   * rows, plugin hooks, every project). Called by the service itself on personal CRUD, `project-trust.changed`,
   * `project.changed`, `workspace.changed` and registry changes of plugin hooks (the setting `hooksEnabled` is read
   * for every snapshot). Never throws.
   */
  readonly invalidate: (projectId: string | null) => void
  /**
   * Shutdown (`stopDeps`, right after the runs and before the project MCP runtimes): kills every running hook process
   * group, drops the caches and the subscriptions. Idempotent; never rejects.
   */
  readonly stop: () => Promise<void>
}
