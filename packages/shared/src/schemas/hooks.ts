// Command hook DTOs (Phase 11, ADR-048; API.md section 4.31): the personal hooks (`/hooks/:id`, table `hooks`), the
// merged hook listing of `GET /hooks` (personal, project and plugin hooks with their state and the kill switches), the
// run log (`GET /hooks/runs`), the `hooks.changed` event and the Claude Code `hooks` configuration format (plugin
// `contributes.hooks`, the import of a Claude Code settings file). The `data-hook` part is `hookDataSchema` in `chat.ts`.
// Hook configurations are read only by `util/hooks.ts`; matchers are checked with its `compileMatcher` (never a
// `RegExp` built from input).
import { z } from 'zod'
import {
  hookDiagnosticCodeSchema,
  hookEventSchema,
  hookRecordOutcomeSchema,
  hookSourceSchema,
  hookStateSchema,
} from '../enums.ts'
import {
  chatIdSchema,
  hookIdSchema,
  hookRecordIdSchema,
  pluginIdSchema,
  projectIdSchema,
  sha256HexSchema,
  timestampSchema,
} from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { compileMatcher } from '../util/hooks.ts'

const HOOK_TIMEOUT_MAX_SEC = LIMITS.hookTimeoutMaxMs / 1000

/**
 * A hook matcher (Claude Code `matcher`): the safe subset of `util/hooks.ts` (names, `|` alternatives, `*` / `.*`
 * wildcards; `^ $ [ ( + ? \ {` are refused), at most 200 characters. Checked with `compileMatcher` at validation time.
 */
export const hookMatcherSchema = z
  .string()
  .max(LIMITS.hookMatcherMaxChars)
  .superRefine((value, ctx) => {
    const compiled = compileMatcher(value)
    if (!compiled.ok)
      ctx.addIssue({ code: 'custom', message: `Invalid matcher: ${compiled.reason}` })
  })

/** A hook command: a shell command line (run by the workspace shell runner), 1..4096 characters, no NUL. */
export const hookCommandSchema = z
  .string()
  .max(LIMITS.hookCommandMaxChars)
  .refine(value => value.trim().length > 0, 'The command cannot be empty.')
  .refine(value => !value.includes('\0'), 'The command cannot contain NUL characters.')

/** A hook timeout in seconds (Claude Code parity), 1..600; the default is 60 s. */
export const hookTimeoutSchema = z.int().min(1).max(HOOK_TIMEOUT_MAX_SEC)

/** The zod mirror of the `HookDiagnostic` interface of `util/hooks.ts` (its type): never an error of the request. */
export const hookDiagnosticSchema = z.object({
  level: z.enum(['error', 'warning', 'info']),
  code: hookDiagnosticCodeSchema,
  /** One English sentence; never quotes a command, a payload or an output. */
  message: z.string().max(1000),
  /** Project-relative settings file, when the hook came from one. */
  file: z.string().max(LIMITS.workspacePathMaxChars).optional(),
  event: hookEventSchema.optional(),
  /** `[group index, handler index]` inside the event's list. */
  position: z.tuple([z.int().min(0), z.int().min(0)]).optional(),
})

// ---------- Claude Code `hooks` configuration (plugin `contributes.hooks`, imports) ----------

/** One handler of a Claude Code `hooks` configuration: `{ type: 'command', command, timeout? }` (seconds). */
export const commandHookSpecSchema = z.strictObject({
  type: z.literal('command'),
  command: hookCommandSchema,
  timeout: hookTimeoutSchema.optional(),
})
export type CommandHookSpecInput = z.infer<typeof commandHookSpecSchema>

/** A matcher group: `{ matcher?, hooks: [handler, ...] }`. */
export const hookMatcherGroupSchema = z.strictObject({
  matcher: hookMatcherSchema.optional(),
  hooks: z.array(commandHookSpecSchema).min(1).max(LIMITS.pluginHooksMax),
})
export type HookMatcherGroupInput = z.infer<typeof hookMatcherGroupSchema>

/** Handlers of a `hooks` configuration (every event and group together). */
export function countHookHandlers(config: Partial<Record<string, ReadonlyArray<{ readonly hooks: readonly unknown[] }>>> | undefined): number {
  let count = 0
  for (const groups of Object.values(config ?? {})) {
    for (const group of groups ?? [])
      count += group.hooks.length
  }
  return count
}

/**
 * A Claude Code `hooks` object (`{ <Event>: [{ matcher?, hooks: [{ type: 'command', command, timeout? }] }] }`) as a
 * plugin declares it (`contributes.hooks`, plugin API 1.5.0): only the eight events, only `command` handlers, at most
 * 50 handlers. Project settings files are not validated with it: `readHooksConfig` turns their problems into
 * diagnostics.
 */
export const hooksConfigSchema = z
  .partialRecord(hookEventSchema, z.array(hookMatcherGroupSchema).max(LIMITS.pluginHooksMax))
  .refine(config => countHookHandlers(config) <= LIMITS.pluginHooksMax, `At most ${LIMITS.pluginHooksMax} hook handlers.`)
export type HooksConfigInput = z.infer<typeof hooksConfigSchema>

// ---------- personal hooks (/hooks/:id) ----------

/** A personal hook (table `hooks`, `hok_` ids; ADR-048): never in backups. */
export const personalHookSchema = z.object({
  id: hookIdSchema,
  event: hookEventSchema,
  /** null = every target (also for events that ignore matchers). */
  matcher: z.string().max(LIMITS.hookMatcherMaxChars).nullable(),
  command: z.string().max(LIMITS.hookCommandMaxChars),
  /** Seconds; null = the default (60 s). */
  timeout: hookTimeoutSchema.nullable(),
  /** Off = listed `state: 'off'`, never run. */
  enabled: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type PersonalHook = z.infer<typeof personalHookSchema>

/** The fields a client sends (the matcher checked with `compileMatcher`). */
const personalHookFields = {
  event: hookEventSchema,
  matcher: hookMatcherSchema.nullable(),
  command: hookCommandSchema,
  timeout: hookTimeoutSchema.nullable(),
  enabled: z.boolean(),
}

/**
 * Body of `POST /hooks` (fresh auth; `201`): an invalid matcher is `400`; more than 100 personal hooks is `409`.
 * `matcher` and `timeout` default to null, `enabled` to true.
 */
export const hookCreateSchema = z.strictObject({
  event: personalHookFields.event,
  matcher: personalHookFields.matcher.optional(),
  command: personalHookFields.command,
  timeout: personalHookFields.timeout.optional(),
  enabled: personalHookFields.enabled.optional(),
})
export type HookCreate = z.infer<typeof hookCreateSchema>

/**
 * Body of `PATCH /hooks/:id`: strict, partial, at least one key. Fresh auth unless the body only turns the hook off
 * (exactly `{ enabled: false }`, `isHookTurnOff`).
 */
export const hookUpdateSchema = z
  .strictObject(personalHookFields)
  .partial()
  .refine(value => Object.keys(value).length > 0, 'Send at least one field.')
export type HookUpdate = z.infer<typeof hookUpdateSchema>

/** True for the one `PATCH /hooks/:id` body that needs no fresh auth: `{ enabled: false }` and nothing else. */
export function isHookTurnOff(update: HookUpdate): boolean {
  const keys = Object.keys(update)
  return keys.length === 1 && keys[0] === 'enabled' && update.enabled === false
}

/** `/hooks/:id`. */
export const hookParamsSchema = z.object({ id: hookIdSchema })
export type HookParams = z.infer<typeof hookParamsSchema>

// ---------- the listing (GET /hooks) ----------

/** Query of `GET /hooks`: include the hooks of this project's settings files (an unknown project is `404`). */
export const hooksQuerySchema = z.object({
  projectId: projectIdSchema.optional(),
})
export type HooksQuery = z.infer<typeof hooksQuerySchema>

const hookEntryBaseShape = {
  /** A stable key for the UI (`personal:<id>`, `project:<sha256>`, `plugin:<pluginId>:<n>`). */
  key: z.string().min(1).max(512),
  source: hookSourceSchema,
  state: hookStateSchema,
  /** Personal hooks: the row id. */
  id: hookIdSchema.optional(),
  /** Plugin hooks: the plugin. */
  pluginId: pluginIdSchema.optional(),
  diagnostics: z.array(hookDiagnosticSchema).max(100),
}

/**
 * One hook of `GET /hooks`, discriminated on `kind`: a command hook (personal, project or plugin), or a plugin code hook
 * (`ctx.hooks.on`; its `event` is the `HookMap` key, never stopped by the kill switches).
 */
export const hookEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    ...hookEntryBaseShape,
    kind: z.literal('command'),
    event: hookEventSchema,
    /** null = every target. Shown even when invalid (state `invalid`). */
    matcher: z.string().max(LIMITS.hookMatcherMaxChars).nullable(),
    /** The exact command (project items: as the settings file has it). */
    command: z.string().max(LIMITS.hookCommandMaxChars),
    /** Seconds; null = the default (60 s). */
    timeout: z.int().min(1).nullable(),
    /** Project hooks: the project-relative settings file (`.claude/settings.json`). */
    path: z.string().min(1).max(LIMITS.workspacePathMaxChars).optional(),
    /** Project hooks: the current trust hash (`POST /projects/:id/trust` approves it). */
    sha256: sha256HexSchema.optional(),
  }),
  z.object({
    ...hookEntryBaseShape,
    kind: z.literal('code'),
    /** The `HookMap` key (`tool.before`, `prompt.submit`, ...). */
    event: z.string().min(1).max(64),
  }),
])
export type HookEntry = z.infer<typeof hookEntrySchema>

/**
 * The kill switches of command hooks (ADR-048), as `GET /hooks` reports them: `setting` = the setting `hooksEnabled`
 * (true = on), `shell` = the shell is on (false when `HF_WORKSPACE_SHELL=0`), `safeMode` = `HF_SAFE_MODE` is on (no
 * command hooks). Command hooks run only when `setting && shell && !safeMode`; plugin code hooks always run.
 */
export const hookSwitchesSchema = z.object({
  setting: z.boolean(),
  shell: z.boolean(),
  safeMode: z.boolean(),
})
export type HookSwitches = z.infer<typeof hookSwitchesSchema>

/** What `GET /hooks?projectId` read from the project folder. */
export const hookProjectScanSchema = z.object({
  id: projectIdSchema,
  /** The folder opened; false = no project hooks (`issue` says why). */
  available: z.boolean(),
  issue: z.string().max(500).optional(),
  /** The settings files that exist and were read, project-relative, lowest precedence first. */
  files: z.array(z.string().min(1).max(64)).max(4),
  /** Project hooks whose hash is not approved. */
  pending: z.int().min(0),
  scannedAt: timestampSchema,
})
export type HookProjectScan = z.infer<typeof hookProjectScanSchema>

/** `GET /hooks`: every hook that would run for the scope (personal, the project's when asked, plugins), in run order. */
export const hookListSchema = z.object({
  items: z.array(hookEntrySchema).max(LIMITS.hookListItemsMax),
  /** Configuration diagnostics that belong to no single hook (an unreadable or too large settings file, ...). */
  diagnostics: z.array(hookDiagnosticSchema).max(100),
  switches: hookSwitchesSchema,
  /** Absent without `projectId`. */
  project: hookProjectScanSchema.optional(),
})
export type HookList = z.infer<typeof hookListSchema>

// ---------- the run log (GET /hooks/runs) ----------

/**
 * One entry of the in-memory run log (the last 200 hook runs, newest first; lost on restart). Never holds commands,
 * payloads or outputs beyond the label and a short error.
 */
export const hookRunSchema = z.object({
  /** The `hev_` id of the event's record (a `data-hook` part when the run had an effect). */
  id: hookRecordIdSchema,
  at: timestampSchema,
  event: hookEventSchema,
  source: hookSourceSchema,
  label: z.string().max(LIMITS.hookLabelMaxChars),
  pluginId: pluginIdSchema.optional(),
  chatId: chatIdSchema.optional(),
  /** null when the process did not exit normally. */
  exitCode: z.int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().min(0),
  /** null = a silent success (no effect, no record part). */
  outcome: hookRecordOutcomeSchema.nullable(),
  error: z.string().max(LIMITS.hookRunErrorMaxChars).optional(),
})
export type HookRun = z.infer<typeof hookRunSchema>

/** `GET /hooks/runs`. */
export const hookRunListSchema = z.object({
  items: z.array(hookRunSchema).max(LIMITS.hookRunsKept),
})
export type HookRunList = z.infer<typeof hookRunListSchema>

// ---------- event ----------

/**
 * Data of `hooks.changed` (ADR-048): the hooks of a scope changed (a personal hook was created, updated or deleted, the
 * setting `hooksEnabled` changed, a plugin with hooks changed: `projectId: null`; a project's settings files or
 * approvals changed: `projectId`). Refetch `GET /hooks`.
 */
export const hooksChangedDataSchema = z.object({
  projectId: projectIdSchema.nullable(),
})
export type HooksChangedData = z.infer<typeof hooksChangedDataSchema>
