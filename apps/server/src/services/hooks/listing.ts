// `GET /hooks?projectId` (Phase 11, ADR-048; API.md 5.31): every hook of the scope in run order (personal rows, plugin
// command hooks, plugin code hooks of the listed events, then with `projectId` the project's settings-file hooks with
// their trust state), the configuration diagnostics and the kill switches. States: `off` (a personal hook turned off,
// a plugin that is not active), `invalid` (an invalid matcher: never runs), `pending` (a project hook whose sha256 is not
// approved, whatever the switches), `blocked` (a kill switch is on; code hooks are never blocked), else `active`.
// Diagnostics of one handler (same file, event and position) go with its entry; the others are the list's.
//
// Phase 12 (ADR-057, W12.5): prompt hooks are listed as `kind: 'command'` entries with `type: 'prompt'`, `command: ''`,
// their prompt, model and `continueOnBlock`; every entry shows the handler fields it has (`args`, `async`, `if`,
// `statusMessage`); a project entry carries its place in its settings file (`position`). The kill switches of prompt
// hooks are `hooksEnabled` and `HF_SAFE_MODE` only (`HF_WORKSPACE_SHELL=0` runs no shell, so it does not block them).
// The `contributes.hooks` of a harness plugin in state `untrusted` (which registers nothing) are listed from its
// manifest as `source: 'plugin'`, `state: 'pending'` entries (open point 14; the web labels them "Plugin not trusted");
// an untrusted Claude Code plugin's hooks show on its plugin page only. W12.16: a Claude Code plugin's exec-form
// `command` / `args` are listed as registered: the plugin folders substituted, every `${user_config.KEY}` as written
// (the runner substitutes the option values at spawn), so no option value, a sensitive one above all, is ever listed.
import type { HookDiagnostic, HookEntry, HookList, HookProjectScan, HookSpec, HooksQuery, HookState, HookSwitches, PromptHookSpec } from '@harness-forge/shared'
import type { HookRow } from '../../db/schema.ts'
import type { RegisteredHookCommands } from '../../registry/types.ts'
import type { AppDeps } from '../../types.ts'
import type { ProjectConfigSnapshot } from '../project-config/types.ts'
import { compileMatcher, LIMITS, readHooksConfig } from '@harness-forge/shared'
import { projectPromptSpec } from '../project-config/hook-items.ts'
import { LISTED_CODE_HOOKS } from './code-hooks.ts'
import { rowOptions } from './personal.ts'

/** The zod shape of a diagnostic (`hookDiagnosticSchema`: a mutable `position` tuple). */
type DiagnosticDto = HookList['diagnostics'][number]
type CommandEntry = Extract<HookEntry, { kind: 'command' }>

/** The most diagnostics one entry or the list carries (`hookDiagnosticSchema` arrays). */
const DIAGNOSTICS_MAX = 100
/** `hookEntrySchema` caps of the Phase 12 fields. */
const ARGS_MAX = 64
const IF_MAX_CHARS = 512
const MODEL_MAX_CHARS = 64 + 1 + 256
const STATUS_MAX_CHARS = 200

export function diagnosticDto(diagnostic: HookDiagnostic): DiagnosticDto {
  const { position, ...rest } = diagnostic
  return position === undefined ? { ...rest } : { ...rest, position: [position[0], position[1]] }
}

function samePosition(a: readonly [number, number] | undefined, b: readonly [number, number]): boolean {
  return a !== undefined && a[0] === b[0] && a[1] === b[1]
}

/** Splits `diagnostics` into the ones of a handler (`belongs`) and the rest; every list capped. */
function partition(diagnostics: readonly HookDiagnostic[], belongs: (diagnostic: HookDiagnostic) => boolean): { own: DiagnosticDto[], rest: HookDiagnostic[] } {
  const own: DiagnosticDto[] = []
  const rest: HookDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    if (belongs(diagnostic)) {
      if (own.length < DIAGNOSTICS_MAX)
        own.push(diagnosticDto(diagnostic))
    }
    else {
      rest.push(diagnostic)
    }
  }
  return { own, rest }
}

/** The kill switches of prompt hooks: the setting and `HF_SAFE_MODE` (never `HF_WORKSPACE_SHELL`). */
export function promptHooksAllowed(switches: HookSwitches): boolean {
  return switches.setting && !switches.safeMode
}

/** The Phase 12 handler fields of a command entry (only the ones that are set). */
function commandFields(fields: { readonly args?: readonly string[], readonly async?: boolean, readonly if?: string, readonly statusMessage?: string }): Partial<CommandEntry> {
  return {
    ...(fields.args === undefined ? {} : { args: fields.args.slice(0, ARGS_MAX) }),
    ...(fields.async === true ? { async: true } : {}),
    ...(fields.if === undefined || fields.if === '' ? {} : { if: fields.if.slice(0, IF_MAX_CHARS) }),
    ...(fields.statusMessage === undefined || fields.statusMessage === '' ? {} : { statusMessage: fields.statusMessage.slice(0, STATUS_MAX_CHARS) }),
  }
}

/** The fields of a prompt entry (`type: 'prompt'`, `command: ''`). */
function promptFields(spec: { readonly prompt: string, readonly model: string | null, readonly continueOnBlock: boolean, readonly if?: string, readonly statusMessage?: string }): Partial<CommandEntry> & { command: string } {
  return {
    type: 'prompt',
    command: '',
    prompt: spec.prompt.slice(0, LIMITS.promptHookPromptMaxChars),
    ...(spec.model === null || spec.model === '' ? {} : { model: spec.model.slice(0, MODEL_MAX_CHARS) }),
    ...(spec.continueOnBlock ? { continueOnBlock: true } : {}),
    ...commandFields({ ...(spec.if === undefined ? {} : { if: spec.if }), ...(spec.statusMessage === undefined ? {} : { statusMessage: spec.statusMessage }) }),
  }
}

/** A personal row (or a hook of the same shape) as it is stored or answered. */
export type PersonalEntryRow = Pick<HookRow, 'id' | 'event' | 'matcher' | 'command' | 'timeout' | 'enabled'> & Partial<Pick<HookRow, 'type' | 'prompt' | 'model' | 'options'>>

/**
 * A personal row as a `GET /hooks` entry: `off` when disabled, `invalid` with a bad matcher, `blocked` by a switch
 * (`allowed` = command hooks may run; `promptAllowed` = prompt hooks may run, default `allowed`).
 */
export function personalHookEntry(row: PersonalEntryRow, allowed: boolean, promptAllowed: boolean = allowed): HookEntry {
  const compiled = compileMatcher(row.matcher)
  const prompt = row.type === 'prompt'
  const runs = prompt ? promptAllowed : allowed
  const state = !row.enabled ? 'off' : !compiled.ok ? 'invalid' : runs ? 'active' : 'blocked'
  const options = rowOptions({ options: row.options ?? null })
  const fields = prompt
    ? promptFields({
        prompt: row.prompt ?? '',
        model: row.model ?? null,
        continueOnBlock: options.continueOnBlock === true,
        ...(options.if === undefined ? {} : { if: options.if }),
        ...(options.statusMessage === undefined ? {} : { statusMessage: options.statusMessage }),
      })
    : { command: row.command, ...commandFields(options) }
  return {
    kind: 'command',
    key: `personal:${row.id}`,
    source: 'personal',
    state,
    id: row.id,
    event: row.event,
    matcher: row.matcher,
    ...fields,
    timeout: row.timeout,
    diagnostics: compiled.ok
      ? []
      : [{ level: 'error', code: 'invalid-matcher', message: `Invalid matcher: ${compiled.reason}`, event: row.event }],
  }
}

/** The command handlers of one plugin, then its prompt handlers, each in declaration order (the keys count each kind). */
function pluginHandlers(hooks: readonly HookSpec[], prompts: readonly PromptHookSpec[]): Array<{ readonly kind: 'command', readonly spec: HookSpec, readonly index: number } | { readonly kind: 'prompt', readonly spec: PromptHookSpec, readonly index: number }> {
  return [
    ...hooks.map((spec, index) => ({ kind: 'command' as const, spec, index })),
    ...prompts.map((spec, index) => ({ kind: 'prompt' as const, spec, index })),
  ]
}

/** The entries of one plugin's handlers and the diagnostics of no handler (`state` decided by the caller). */
function pluginEntries(input: {
  readonly pluginId: string
  readonly hooks: readonly HookSpec[]
  readonly prompts: readonly PromptHookSpec[]
  readonly diagnostics: readonly HookDiagnostic[]
  readonly state: (kind: 'command' | 'prompt', valid: boolean) => HookState
}): { entries: HookEntry[], rest: HookDiagnostic[] } {
  let rest: readonly HookDiagnostic[] = input.diagnostics
  const entries = pluginHandlers(input.hooks, input.prompts).map((handler): HookEntry => {
    const { spec } = handler
    const split = partition(rest, diagnostic => diagnostic.event === spec.event && samePosition(diagnostic.position, spec.position))
    rest = split.rest
    const valid = compileMatcher(spec.matcher).ok
    const fields = handler.kind === 'prompt' ? promptFields(handler.spec) : { command: handler.spec.command, ...commandFields(handler.spec) }
    return {
      kind: 'command',
      key: handler.kind === 'prompt' ? `plugin:${input.pluginId}:prompt:${handler.index}` : `plugin:${input.pluginId}:${handler.index}`,
      source: 'plugin',
      state: input.state(handler.kind, valid),
      pluginId: input.pluginId,
      event: spec.event,
      matcher: spec.matcher,
      ...fields,
      timeout: spec.timeoutSec,
      diagnostics: split.own,
    }
  })
  return { entries, rest: [...rest] }
}

/**
 * The entries of one plugin's registered hooks (`plugin:<pluginId>:<n>`, prompt handlers `plugin:<pluginId>:prompt:<n>`)
 * and the diagnostics of no handler.
 */
export function pluginCommandEntries(registration: RegisteredHookCommands, active: boolean, allowed: boolean, promptAllowed: boolean = allowed): { entries: HookEntry[], rest: HookDiagnostic[] } {
  return pluginEntries({
    pluginId: registration.pluginId,
    hooks: registration.hooks,
    prompts: registration.prompts ?? [],
    diagnostics: registration.diagnostics,
    state: (kind, valid) => !active ? 'off' : !valid ? 'invalid' : (kind === 'prompt' ? promptAllowed : allowed) ? 'active' : 'blocked',
  })
}

/** A harness plugin in state `untrusted` and its manifest's `contributes.hooks` (open point 14). */
export interface UntrustedPluginHooks {
  readonly pluginId: string
  readonly hooks: unknown
}

/** The entries of an untrusted plugin's declared hooks: every valid handler `pending` (an invalid matcher `invalid`). */
export function untrustedPluginEntries(plugin: UntrustedPluginHooks): { entries: HookEntry[], rest: HookDiagnostic[] } {
  const read = readHooksConfig(plugin.hooks, { source: 'plugin', prompts: true })
  return pluginEntries({
    pluginId: plugin.pluginId,
    hooks: read.items,
    prompts: read.prompts,
    diagnostics: read.diagnostics,
    state: (_kind, valid) => valid ? 'pending' : 'invalid',
  })
}

/** The entries of the plugin code hooks of the listed events (`plugin:<pluginId>:code:<event>:<n>`). */
export function pluginCodeEntries(deps: Pick<AppDeps, 'registry' | 'plugins'>): HookEntry[] {
  const entries: HookEntry[] = []
  for (const name of LISTED_CODE_HOOKS) {
    deps.registry.hooks.list(name).forEach((hook, index) => {
      entries.push({
        kind: 'code',
        key: `plugin:${hook.pluginId}:code:${name}:${index}`,
        source: 'plugin',
        state: deps.plugins.isActive(hook.pluginId) ? 'active' : 'off',
        pluginId: hook.pluginId,
        event: name,
        diagnostics: [],
      })
    })
  }
  return entries
}

/** The entries of a project's settings-file hooks (`project:<sha256>`) and the diagnostics of no handler. */
export function projectEntries(scan: ProjectConfigSnapshot, approved: ReadonlySet<string>, allowed: boolean, promptAllowed: boolean = allowed): { entries: HookEntry[], rest: HookDiagnostic[], pending: number } {
  let rest: readonly HookDiagnostic[] = scan.hookDiagnostics
  let pending = 0
  const seen = new Set<string>()
  const entries: HookEntry[] = []
  for (const item of scan.hooks) {
    if (seen.has(item.sha256))
      continue
    seen.add(item.sha256)
    const { spec } = item
    const split = partition(rest, diagnostic => diagnostic.file === item.path && diagnostic.event === spec.event && samePosition(diagnostic.position, spec.position))
    rest = split.rest
    const isApproved = approved.has(item.sha256)
    const valid = compileMatcher(spec.matcher).ok
    if (valid && !isApproved)
      pending += 1
    const prompt = projectPromptSpec(item)
    const fields = prompt === null ? { command: spec.command, ...commandFields(spec) } : promptFields(prompt)
    const runs = prompt === null ? allowed : promptAllowed
    entries.push({
      kind: 'command',
      key: `project:${item.sha256}`,
      source: 'project',
      state: !valid ? 'invalid' : !isApproved ? 'pending' : runs ? 'active' : 'blocked',
      event: spec.event,
      matcher: spec.matcher,
      ...fields,
      timeout: spec.timeoutSec,
      path: item.path,
      sha256: item.sha256,
      position: [spec.position[0], spec.position[1]],
      diagnostics: split.own,
    })
  }
  return { entries, rest: [...rest], pending }
}

/** What `listHooks` reads (gathered by the service). */
export interface HookListInput {
  readonly query: HooksQuery
  readonly switches: HookSwitches
  readonly personal: readonly HookRow[]
  readonly plugins: readonly RegisteredHookCommands[]
  readonly isActive: (pluginId: string) => boolean
  readonly code: readonly HookEntry[]
  /** Phase 12: the harness plugins in state `untrusted` with their declared hooks (listed `pending`). */
  readonly untrusted?: readonly UntrustedPluginHooks[]
  /** With `query.projectId`: the scan and the approved hashes. */
  readonly project?: { readonly scan: ProjectConfigSnapshot, readonly approved: ReadonlySet<string> }
}

/** Assembles `HookList` (see the module comment); every list capped. */
export function listHooks(input: HookListInput): HookList {
  const { switches } = input
  const allowed = switches.setting && switches.shell && !switches.safeMode
  const promptAllowed = promptHooksAllowed(switches)
  const items: HookEntry[] = input.personal.map(row => personalHookEntry(row, allowed, promptAllowed))
  const diagnostics: HookDiagnostic[] = []
  for (const registration of input.plugins) {
    const { entries, rest } = pluginCommandEntries(registration, input.isActive(registration.pluginId), allowed, promptAllowed)
    items.push(...entries)
    diagnostics.push(...rest)
  }
  for (const plugin of input.untrusted ?? []) {
    const { entries, rest } = untrustedPluginEntries(plugin)
    items.push(...entries)
    diagnostics.push(...rest)
  }
  items.push(...input.code)
  let project: HookProjectScan | undefined
  if (input.project !== undefined && input.query.projectId !== undefined) {
    const { scan, approved } = input.project
    const { entries, rest, pending } = projectEntries(scan, approved, allowed, promptAllowed)
    items.push(...entries)
    diagnostics.push(...rest)
    project = {
      id: input.query.projectId,
      available: scan.available,
      ...(scan.issue === null ? {} : { issue: scan.issue }),
      files: scan.settingsFiles.slice(0, 4),
      pending,
      scannedAt: scan.scannedAt,
    }
  }
  return {
    items: items.slice(0, LIMITS.hookListItemsMax),
    diagnostics: diagnostics.slice(0, DIAGNOSTICS_MAX).map(diagnosticDto),
    switches,
    ...(project === undefined ? {} : { project }),
  }
}
