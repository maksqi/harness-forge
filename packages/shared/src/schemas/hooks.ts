// Command hook DTOs (Phase 11, ADR-048; API.md section 4.31): the personal hooks (`/hooks/:id`, table `hooks`), the
// merged hook listing of `GET /hooks` (personal, project and plugin hooks with their state and the kill switches), the
// run log (`GET /hooks/runs`), the `hooks.changed` event and the Claude Code `hooks` configuration format (plugin
// `contributes.hooks`, the import of a Claude Code settings file). The `data-hook` part is `hookDataSchema` in `chat.ts`.
// Hook configurations are read only by `util/hooks.ts`; matchers are checked with its `compileMatcher` (never a
// `RegExp` built from input). Phase 12 (ADR-057): prompt handlers (`type: 'prompt'`), five more events and the command
// handler fields `args` (exec form), `async`, `if` and `statusMessage`.
import type { HookEvent } from '../util/hooks.ts'
import { z } from 'zod'
import {
  hookDiagnosticCodeSchema,
  hookEventSchema,
  hookHandlerTypeSchema,
  hookRecordOutcomeSchema,
  hookSourceSchema,
  hookStateSchema,
} from '../enums.ts'
import {
  chatIdSchema,
  hookIdSchema,
  hookRecordIdSchema,
  modelRefSchema,
  pluginIdSchema,
  projectIdSchema,
  sha256HexSchema,
  timestampSchema,
} from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { claudeModelAlias } from '../util/definitions.ts'
import { checkHookIf, compileMatcher, HOOK_LIMITS, PROMPT_HOOK_EVENTS, TOOL_HOOK_EVENTS } from '../util/hooks.ts'

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

/** A hook timeout in seconds (Claude Code parity), 1..600; the default is 60 s (prompt hooks: 30 s). */
export const hookTimeoutSchema = z.int().min(1).max(HOOK_TIMEOUT_MAX_SEC)

// ---------- Phase 12 handler fields (ADR-057) ----------

const PROMPT_EVENT_SET: ReadonlySet<string> = new Set(PROMPT_HOOK_EVENTS)
const TOOL_EVENT_SET: ReadonlySet<string> = new Set(TOOL_HOOK_EVENTS)

/**
 * True when a prompt handler may be attached to the event (`PROMPT_HOOK_EVENTS` of `util/hooks.ts`: `PreToolUse`,
 * `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `PermissionRequest`; elsewhere
 * `readHooksConfig` reports `unsupported-type`).
 */
export function isPromptHookEvent(event: HookEvent | string): boolean {
  return PROMPT_EVENT_SET.has(event)
}

/** The prompt of a prompt hook (`$ARGUMENTS` = the hook input as JSON), 1..16 384 characters, no NUL. */
export const hookPromptSchema = z
  .string()
  .max(LIMITS.promptHookPromptMaxChars)
  .refine(value => value.trim().length > 0, 'The prompt cannot be empty.')
  .refine(value => !value.includes('\0'), 'The prompt cannot contain NUL characters.')

/**
 * The `model` of a prompt hook: a model ref (`provider:model`) or a Claude model name (`claudeModelAlias` of
 * `util/definitions.ts`: `sonnet`, `opus`, `haiku`, `fable`, `opusplan`, a `claude-…` id) resolved through the setting
 * `modelAliases` (ADR-058). Absent = the setting `hookModelRef`, else the provider's small model, else the run model.
 */
export const hookModelSchema = z
  .string()
  .max(64 + 1 + 256)
  .refine(value => modelRefSchema.safeParse(value).success || claudeModelAlias(value) !== null, 'Expected a model ref "<providerId>:<modelId>" or a Claude model name such as "haiku".')

/** The arguments of an exec-form command handler (`command` is the program; each argument is quoted, never split). */
export const hookArgsSchema = z
  .array(z.string().max(LIMITS.hookCommandMaxChars).refine(value => !value.includes('\0'), 'Arguments cannot contain NUL characters.'))
  .max(HOOK_LIMITS.argsMax)

/**
 * The `if` of a handler on a tool event (ADR-057; `TOOL_HOOK_EVENTS`): a tool name (`Write`, `mcp__github__*`) or a
 * `Bash(…)` rule (`Bash(npm test:*)`, `Bash(npm test *)`, `Bash(npm test)`), checked with `checkHookIf` of
 * `util/hooks.ts`; the handler runs only when it matches. In files, a rule `checkHookIf` refuses is an `invalid-if`
 * diagnostic (and the handler never runs).
 */
export const hookIfSchema = z
  .string()
  .max(HOOK_LIMITS.ifMaxChars)
  .superRefine((value, ctx) => {
    const problem = checkHookIf(value)
    if (problem !== null)
      ctx.addIssue({ code: 'custom', message: `Invalid "if": ${problem}` })
  })

/** The label of the activity indicator while the handler runs (`statusMessage`). */
export const hookStatusMessageSchema = z.string().trim().min(1).max(HOOK_LIMITS.statusMessageMaxChars).regex(/^\P{Cc}*$/u, 'Control characters are not allowed.')

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

/**
 * A command handler of a Claude Code `hooks` configuration: `{ type: 'command', command, timeout? }` (seconds); plugin
 * API 1.6.0 adds `args` (exec form: `command` is the program), `async` (runs detached, no effect), `if` and
 * `statusMessage`.
 */
export const commandHookSpecSchema = z.strictObject({
  type: z.literal('command'),
  command: hookCommandSchema,
  timeout: hookTimeoutSchema.optional(),
  args: hookArgsSchema.optional(),
  async: z.boolean().optional(),
  if: hookIfSchema.optional(),
  statusMessage: hookStatusMessageSchema.optional(),
})
export type CommandHookSpecInput = z.infer<typeof commandHookSpecSchema>

/**
 * A prompt handler (plugin API 1.6.0, ADR-057): `{ type: 'prompt', prompt, model?, timeout?, continueOnBlock? }`; a small
 * model answers `{ ok, reason?, impossible? }` (never a permission grant). Only for `PROMPT_HOOK_EVENTS`.
 */
export const promptHookSpecSchema = z.strictObject({
  type: z.literal('prompt'),
  prompt: hookPromptSchema,
  model: hookModelSchema.optional(),
  timeout: hookTimeoutSchema.optional(),
  /** `PreToolUse` / `PostToolUse`: a block denies or feeds back instead of ending the turn. */
  continueOnBlock: z.boolean().optional(),
  /** Tool events only, as for command handlers. */
  if: hookIfSchema.optional(),
  statusMessage: hookStatusMessageSchema.optional(),
})
export type PromptHookSpecInput = z.infer<typeof promptHookSpecSchema>

/** One handler of a `hooks` configuration, discriminated on `type`. */
export const hookHandlerSpecSchema = z.discriminatedUnion('type', [commandHookSpecSchema, promptHookSpecSchema])
export type HookHandlerSpecInput = z.infer<typeof hookHandlerSpecSchema>

/** A matcher group: `{ matcher?, hooks: [handler, ...] }`. */
export const hookMatcherGroupSchema = z.strictObject({
  matcher: hookMatcherSchema.optional(),
  hooks: z.array(hookHandlerSpecSchema).min(1).max(LIMITS.pluginHooksMax),
})
export type HookMatcherGroupInput = z.infer<typeof hookMatcherGroupSchema>

type HandlerGroups = Partial<Record<string, ReadonlyArray<{ readonly hooks: readonly unknown[] }>>> | undefined

/** Handlers of a `hooks` configuration (every event and group together, command and prompt handlers). */
export function countHookHandlers(config: HandlerGroups): number {
  let count = 0
  for (const groups of Object.values(config ?? {})) {
    for (const group of groups ?? [])
      count += group.hooks.length
  }
  return count
}

/** Command handlers of a `hooks` configuration (a handler without `type: 'prompt'`): the ones that need trust. */
export function countCommandHookHandlers(config: HandlerGroups): number {
  let count = 0
  for (const groups of Object.values(config ?? {})) {
    for (const group of groups ?? []) {
      for (const handler of group.hooks) {
        if (!(typeof handler === 'object' && handler !== null && (handler as { type?: unknown }).type === 'prompt'))
          count++
      }
    }
  }
  return count
}

/**
 * A Claude Code `hooks` object (`{ <Event>: [{ matcher?, hooks: [handler, ...] }] }`) as a plugin declares it
 * (`contributes.hooks`, plugin API 1.5.0): only the known events (13 since plugin API 1.6.0: an unknown event is an
 * error in a harness manifest), `command` handlers and (1.6.0) `prompt` handlers on `PROMPT_HOOK_EVENTS`, at most
 * 50 handlers. Project settings files and Claude Code plugins are not validated with it: `readHooksConfig` turns their
 * problems into diagnostics.
 */
export const hooksConfigSchema = z
  .partialRecord(hookEventSchema, z.array(hookMatcherGroupSchema).max(LIMITS.pluginHooksMax))
  .refine(config => countHookHandlers(config) <= LIMITS.pluginHooksMax, `At most ${LIMITS.pluginHooksMax} hook handlers.`)
  .superRefine((config, ctx) => {
    for (const [event, groups] of Object.entries(config)) {
      if (isPromptHookEvent(event))
        continue
      groups?.forEach((group, groupIndex) => {
        group.hooks.forEach((handler, handlerIndex) => {
          if (handler.type === 'prompt')
            ctx.addIssue({ code: 'custom', path: [event, groupIndex, 'hooks', handlerIndex, 'type'], message: `${event} hooks cannot use prompt handlers.` })
        })
      })
    }
    for (const [event, groups] of Object.entries(config)) {
      if (TOOL_EVENT_SET.has(event))
        continue
      groups?.forEach((group, groupIndex) => {
        group.hooks.forEach((handler, handlerIndex) => {
          if (handler.if !== undefined)
            ctx.addIssue({ code: 'custom', path: [event, groupIndex, 'hooks', handlerIndex, 'if'], message: `"if" applies only to tool events, not ${event}.` })
        })
      })
    }
  })
export type HooksConfigInput = z.infer<typeof hooksConfigSchema>

// ---------- personal hooks (/hooks/:id) ----------

const personalHookBaseShape = {
  id: hookIdSchema,
  event: hookEventSchema,
  /** null = every target (also for events that ignore matchers). */
  matcher: z.string().max(LIMITS.hookMatcherMaxChars).nullable(),
  /** Seconds; null = the default (60 s; prompt hooks 30 s). */
  timeout: hookTimeoutSchema.nullable(),
  /** Phase 12: the label of the activity indicator while the hook runs; absent = none. */
  statusMessage: z.string().max(200).optional(),
  /** Off = listed `state: 'off'`, never run. */
  enabled: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}

/**
 * A personal hook (table `hooks`, `hok_` ids; ADR-048): never in backups. Phase 12 (ADR-057): discriminated on `type`,
 * a command hook (with the optional handler fields `args`, `async`, `if`) or a prompt hook.
 */
export const personalHookSchema = z.discriminatedUnion('type', [
  z.object({
    ...personalHookBaseShape,
    /** Absent in v1.7 answers (= `command`). */
    type: z.literal('command').default('command'),
    command: z.string().max(LIMITS.hookCommandMaxChars),
    /** Phase 12: exec form (`command` is the program, each argument quoted); absent = a shell command line. */
    args: z.array(z.string().max(LIMITS.hookCommandMaxChars)).max(64).optional(),
    /** Phase 12: runs detached (no effect on the run); absent = false. */
    async: z.boolean().optional(),
    /** Phase 12: runs only when the tool call matches (`Write`, `Bash(npm test:*)`); absent = always. */
    if: z.string().max(HOOK_LIMITS.ifMaxChars).optional(),
  }),
  z.object({
    ...personalHookBaseShape,
    type: z.literal('prompt'),
    prompt: z.string().max(LIMITS.promptHookPromptMaxChars),
    /** A model ref or a Claude model name; null = the setting `hookModelRef` (else the small model, else the run model). */
    model: z.string().max(64 + 1 + 256).nullable(),
    /** `PreToolUse` / `PostToolUse`: a block denies or feeds back instead of ending the turn; absent = false. */
    continueOnBlock: z.boolean().optional(),
    /** Tool events: runs only when the tool call matches; absent = always. */
    if: z.string().max(HOOK_LIMITS.ifMaxChars).optional(),
  }),
])
export type PersonalHook = z.infer<typeof personalHookSchema>

/** The command handler fields a client sends (the matcher checked with `compileMatcher`). */
const personalHookFields = {
  event: hookEventSchema,
  matcher: hookMatcherSchema.nullable(),
  command: hookCommandSchema,
  timeout: hookTimeoutSchema.nullable(),
  enabled: z.boolean(),
  args: hookArgsSchema.nullable(),
  async: z.boolean(),
  if: hookIfSchema.nullable(),
  statusMessage: hookStatusMessageSchema.nullable(),
}

/** The prompt handler fields a client sends. */
const personalPromptHookFields = {
  event: hookEventSchema,
  matcher: hookMatcherSchema.nullable(),
  prompt: hookPromptSchema,
  model: hookModelSchema.nullable(),
  timeout: hookTimeoutSchema.nullable(),
  continueOnBlock: z.boolean(),
  enabled: z.boolean(),
  if: hookIfSchema.nullable(),
  statusMessage: hookStatusMessageSchema.nullable(),
}

/** A prompt handler only on `PROMPT_HOOK_EVENTS`, an `if` rule only on `TOOL_HOOK_EVENTS` (the event of the body). */
function checkPromptEvent(value: { type?: string, event?: string, if?: string | null }, ctx: z.RefinementCtx): void {
  if (value.type === 'prompt' && value.event !== undefined && !isPromptHookEvent(value.event))
    ctx.addIssue({ code: 'custom', path: ['event'], message: `${value.event} hooks cannot use prompt handlers.` })
  if (value.event !== undefined && value.if !== undefined && value.if !== null && !TOOL_EVENT_SET.has(value.event))
    ctx.addIssue({ code: 'custom', path: ['if'], message: `"if" applies only to tool events, not ${value.event}.` })
}

/**
 * Body of `POST /hooks` (fresh auth; `201`): an invalid matcher is `400`; more than 100 personal hooks is `409`.
 * `matcher` and `timeout` default to null, `enabled` to true. Phase 12 (ADR-057): `type` (default `command`); a prompt
 * hook takes `prompt`, `model` and `continueOnBlock` (only on `PROMPT_HOOK_EVENTS`), a command hook may take
 * `args`, `async`, `if` and `statusMessage`.
 */
export const hookCreateSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('command').optional(),
      event: personalHookFields.event,
      matcher: personalHookFields.matcher.optional(),
      command: personalHookFields.command,
      timeout: personalHookFields.timeout.optional(),
      enabled: personalHookFields.enabled.optional(),
      args: personalHookFields.args.optional(),
      async: personalHookFields.async.optional(),
      if: personalHookFields.if.optional(),
      statusMessage: personalHookFields.statusMessage.optional(),
    }),
    z.strictObject({
      type: z.literal('prompt'),
      event: personalPromptHookFields.event,
      matcher: personalPromptHookFields.matcher.optional(),
      prompt: personalPromptHookFields.prompt,
      model: personalPromptHookFields.model.optional(),
      timeout: personalPromptHookFields.timeout.optional(),
      continueOnBlock: personalPromptHookFields.continueOnBlock.optional(),
      enabled: personalPromptHookFields.enabled.optional(),
      if: personalPromptHookFields.if.optional(),
      statusMessage: personalPromptHookFields.statusMessage.optional(),
    }),
  ])
  .superRefine(checkPromptEvent)
export type HookCreate = z.infer<typeof hookCreateSchema>

/** Fields only a command hook has, and fields only a prompt hook has (`PATCH /hooks/:id`). */
const COMMAND_ONLY_FIELDS = ['command', 'args', 'async'] as const
const PROMPT_ONLY_FIELDS = ['prompt', 'model', 'continueOnBlock'] as const

/**
 * Body of `PATCH /hooks/:id`: strict, partial, at least one key. Phase 12 (ADR-057): `type` switches a hook between a
 * command and a prompt hook; command fields (`command`, `args`, `async`) and prompt fields (`prompt`, `model`,
 * `continueOnBlock`) never mix, and fields of the other type than the hook's (after the change) are refused by the
 * server with `400`. Fresh auth unless the body only turns the hook off (exactly `{ enabled: false }`, `isHookTurnOff`).
 */
export const hookUpdateSchema = z
  .strictObject({
    type: hookHandlerTypeSchema,
    ...personalHookFields,
    prompt: personalPromptHookFields.prompt,
    model: personalPromptHookFields.model,
    continueOnBlock: personalPromptHookFields.continueOnBlock,
  })
  .partial()
  .refine(value => Object.keys(value).length > 0, 'Send at least one field.')
  .superRefine((value, ctx) => {
    const commandField = COMMAND_ONLY_FIELDS.find(key => value[key] !== undefined)
    const promptField = PROMPT_ONLY_FIELDS.find(key => value[key] !== undefined)
    if (commandField !== undefined && (promptField !== undefined || value.type === 'prompt'))
      ctx.addIssue({ code: 'custom', path: [commandField], message: `"${commandField}" belongs to command hooks.` })
    else if (promptField !== undefined && value.type === 'command')
      ctx.addIssue({ code: 'custom', path: [promptField], message: `"${promptField}" belongs to prompt hooks.` })
    checkPromptEvent(value, ctx)
  })
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
    /**
     * Phase 12 (ADR-057): the handler type; absent = `command`. Plugin hooks of an untrusted plugin are listed with
     * `state: 'pending'` (the web shows "Plugin not trusted").
     */
    type: hookHandlerTypeSchema.optional(),
    event: hookEventSchema,
    /** null = every target. Shown even when invalid (state `invalid`). */
    matcher: z.string().max(LIMITS.hookMatcherMaxChars).nullable(),
    /** The exact command (project items: as the settings file has it); '' for a prompt hook. */
    command: z.string().max(LIMITS.hookCommandMaxChars),
    /** Phase 12: exec-form arguments of a command hook. */
    args: z.array(z.string().max(LIMITS.hookCommandMaxChars)).max(64).optional(),
    /** Phase 12: a detached command hook. */
    async: z.boolean().optional(),
    /** Phase 12: the `if` rule of a hook on a tool event. */
    if: z.string().max(HOOK_LIMITS.ifMaxChars).optional(),
    /** Phase 12: the prompt of a prompt hook. */
    prompt: z.string().max(LIMITS.promptHookPromptMaxChars).optional(),
    /** Phase 12: the model of a prompt hook, as written. */
    model: z.string().max(64 + 1 + 256).optional(),
    /** Phase 12: `continueOnBlock` of a prompt hook. */
    continueOnBlock: z.boolean().optional(),
    /** Phase 12: the activity label. */
    statusMessage: z.string().max(200).optional(),
    /** Seconds; null = the default (60 s). */
    timeout: z.int().min(1).nullable(),
    /** Project hooks: the project-relative settings file (`.claude/settings.json`). */
    path: z.string().min(1).max(LIMITS.workspacePathMaxChars).optional(),
    /** Project hooks: the current trust hash (`POST /projects/:id/trust` approves it). */
    sha256: sha256HexSchema.optional(),
    /**
     * Project hooks (Phase 12, ADR-056): the handler's place in its settings file's `hooks[event]` array: `[group index,
     * handler index]` (`HookSpec.position`), so the editor changes exactly that handler.
     */
    position: z.tuple([z.int().min(0), z.int().min(0)]).optional(),
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
