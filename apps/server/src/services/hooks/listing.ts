// `GET /hooks?projectId` (Phase 11, ADR-048; API.md 5.31): every hook of the scope in run order (personal rows, plugin
// command hooks, plugin code hooks of the listed events, then with `projectId` the project's settings-file hooks with
// their trust state), the configuration diagnostics and the kill switches. States: `off` (a personal hook turned off,
// a plugin that is not active), `invalid` (an invalid matcher: never runs), `pending` (a project hook whose sha256 is not
// approved, whatever the switches), `blocked` (a kill switch is on; code hooks are never blocked), else `active`.
// Diagnostics of one handler (same file, event and position) go with its entry; the others are the list's.
import type { HookDiagnostic, HookEntry, HookList, HookProjectScan, HooksQuery, HookSwitches } from '@harness-forge/shared'
import type { HookRow } from '../../db/schema.ts'
import type { RegisteredHookCommands } from '../../registry/types.ts'
import type { AppDeps } from '../../types.ts'
import type { ProjectConfigSnapshot } from '../project-config/types.ts'
import { compileMatcher, LIMITS } from '@harness-forge/shared'
import { LISTED_CODE_HOOKS } from './code-hooks.ts'

/** The zod shape of a diagnostic (`hookDiagnosticSchema`: a mutable `position` tuple). */
type DiagnosticDto = HookList['diagnostics'][number]

/** The most diagnostics one entry or the list carries (`hookDiagnosticSchema` arrays). */
const DIAGNOSTICS_MAX = 100

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

/** A personal row as a `GET /hooks` entry: `off` when disabled, `invalid` with a bad matcher, `blocked` by a switch. */
export function personalHookEntry(row: Pick<HookRow, 'id' | 'event' | 'matcher' | 'command' | 'timeout' | 'enabled'>, allowed: boolean): HookEntry {
  const compiled = compileMatcher(row.matcher)
  const state = !row.enabled ? 'off' : !compiled.ok ? 'invalid' : allowed ? 'active' : 'blocked'
  return {
    kind: 'command',
    key: `personal:${row.id}`,
    source: 'personal',
    state,
    id: row.id,
    event: row.event,
    matcher: row.matcher,
    command: row.command,
    timeout: row.timeout,
    diagnostics: compiled.ok
      ? []
      : [{ level: 'error', code: 'invalid-matcher', message: `Invalid matcher: ${compiled.reason}`, event: row.event }],
  }
}

/** The entries of one plugin's command hooks (`plugin:<pluginId>:<n>`) and the diagnostics of no handler. */
export function pluginCommandEntries(registration: RegisteredHookCommands, active: boolean, allowed: boolean): { entries: HookEntry[], rest: HookDiagnostic[] } {
  let rest: readonly HookDiagnostic[] = registration.diagnostics
  const entries = registration.hooks.map((spec, index): HookEntry => {
    const split = partition(rest, diagnostic => diagnostic.event === spec.event && samePosition(diagnostic.position, spec.position))
    rest = split.rest
    const valid = compileMatcher(spec.matcher).ok
    return {
      kind: 'command',
      key: `plugin:${registration.pluginId}:${index}`,
      source: 'plugin',
      state: !active ? 'off' : !valid ? 'invalid' : allowed ? 'active' : 'blocked',
      pluginId: registration.pluginId,
      event: spec.event,
      matcher: spec.matcher,
      command: spec.command,
      timeout: spec.timeoutSec,
      diagnostics: split.own,
    }
  })
  return { entries, rest: [...rest] }
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
export function projectEntries(scan: ProjectConfigSnapshot, approved: ReadonlySet<string>, allowed: boolean): { entries: HookEntry[], rest: HookDiagnostic[], pending: number } {
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
    entries.push({
      kind: 'command',
      key: `project:${item.sha256}`,
      source: 'project',
      state: !valid ? 'invalid' : !isApproved ? 'pending' : allowed ? 'active' : 'blocked',
      event: spec.event,
      matcher: spec.matcher,
      command: spec.command,
      timeout: spec.timeoutSec,
      path: item.path,
      sha256: item.sha256,
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
  /** With `query.projectId`: the scan and the approved hashes. */
  readonly project?: { readonly scan: ProjectConfigSnapshot, readonly approved: ReadonlySet<string> }
}

/** Assembles `HookList` (see the module comment); every list capped. */
export function listHooks(input: HookListInput): HookList {
  const { switches } = input
  const allowed = switches.setting && switches.shell && !switches.safeMode
  const items: HookEntry[] = input.personal.map(row => personalHookEntry(row, allowed))
  const diagnostics: HookDiagnostic[] = []
  for (const registration of input.plugins) {
    const { entries, rest } = pluginCommandEntries(registration, input.isActive(registration.pluginId), allowed)
    items.push(...entries)
    diagnostics.push(...rest)
  }
  items.push(...input.code)
  let project: HookProjectScan | undefined
  if (input.project !== undefined && input.query.projectId !== undefined) {
    const { scan, approved } = input.project
    const { entries, rest, pending } = projectEntries(scan, approved, allowed)
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
