// The hook items of a project's settings files (Phase 11, ADR-049; Phase 12, ADR-057: trust item v2). Owner: W12.5.
//
// - Reading: `readSettingsHooks(…, { prompts: true })` gives the command handlers (`items`) and the prompt handlers
//   (`prompts`); `mergeHookSpecs` puts each prompt handler at its declaration place among the command handlers of its
//   event, so the command items keep exactly their v1.7 order.
// - Hash input (`trustHashInput`, `util/trust.ts`): a command handler without Phase 12 fields keeps the v1 layout (every
//   v1.7 approval still matches); a command handler with `args`, `async` or `if` carries `extra: { args?, async?, if? }`
//   and a prompt handler `extra: { type: 'prompt', prompt, model, continueOnBlock, if? }` with `command: null` (the v2
//   layout). `statusMessage` changes nothing that runs and is never hashed.
// - Referenced files: the script files the command names (`extractCommandFileRefs`) and, for the exec form, the ones
//   its arguments name (`extractArgsFileRefs`, each argument one literal word), at most `TRUST_LIMITS.refFilesMax`; so
//   editing the script of `{ command: 'sh', args: ['.claude/hooks/x.sh'] }` makes the item pending again. `verify`
//   re-derives the same paths from the hash item (`hookItemRefPaths`).
// - A prompt item's `spec` is a `HookSpec` with `command: ''` plus the prompt fields (`ProjectPromptHookSpec`); read it
//   back with `projectPromptSpec(item)`.
import type { HookSpec, PromptHookSpec, TrustHashItem } from '@harness-forge/shared'
import type { ProjectHookItem } from './types.ts'
import { execFormCommand, extractArgsFileRefs, extractCommandFileRefs, TRUST_LIMITS } from '@harness-forge/shared'

/** The `spec` of a project prompt hook item: the `HookSpec` shape (`command: ''`) plus the prompt fields. */
export type ProjectPromptHookSpec = HookSpec & {
  readonly type: 'prompt'
  readonly prompt: string
  readonly model: string | null
  readonly continueOnBlock: boolean
}

/** A command handler or a prompt handler of a settings file. */
export type SettingsHookSpec
  = | { readonly kind: 'command', readonly spec: HookSpec }
    | { readonly kind: 'prompt', readonly spec: PromptHookSpec }

function comparePositions(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] - b[0] || a[1] - b[1]
}

/**
 * The handlers of one settings file in declaration order: the command handlers in reader order, each prompt handler
 * placed before the first command handler of its event that comes after it (else after the last one of its event, else
 * at the end).
 */
export function mergeHookSpecs(items: readonly HookSpec[], prompts: readonly PromptHookSpec[]): SettingsHookSpec[] {
  const merged: SettingsHookSpec[] = items.map(spec => ({ kind: 'command', spec }))
  for (const spec of prompts) {
    const entry: SettingsHookSpec = { kind: 'prompt', spec }
    const before = merged.findIndex(other => other.spec.event === spec.event && comparePositions(other.spec.position, spec.position) > 0)
    if (before !== -1) {
      merged.splice(before, 0, entry)
      continue
    }
    let last = -1
    merged.forEach((other, index) => {
      if (other.spec.event === spec.event)
        last = index
    })
    if (last !== -1) {
      merged.splice(last + 1, 0, entry)
      continue
    }
    // The first handler of its event (runs group the handlers by event, so the place among other events is free).
    merged.push(entry)
  }
  return merged
}

/** The script files a hook names: its command's (`extractCommandFileRefs`), then its exec-form arguments'. */
export function hookItemRefPaths(command: string | null, args?: readonly string[] | null): string[] {
  const paths: string[] = []
  const add = (list: readonly string[]): void => {
    for (const path of list) {
      if (paths.length >= TRUST_LIMITS.refFilesMax)
        return
      if (!paths.includes(path))
        paths.push(path)
    }
  }
  if (typeof command === 'string' && command !== '')
    add(extractCommandFileRefs(command))
  if (Array.isArray(args))
    add(extractArgsFileRefs(args.filter((arg): arg is string => typeof arg === 'string')))
  return paths
}

/** The exec-form arguments recorded in a hook hash item's `extra`, or null. */
export function hashItemArgs(hashItem: Extract<TrustHashItem, { readonly kind: 'hook' }>): string[] | null {
  const extra = hashItem.extra
  if (typeof extra !== 'object' || extra === null)
    return null
  const args = (extra as { args?: unknown }).args
  return Array.isArray(args) && args.every(arg => typeof arg === 'string') ? [...args as string[]] : null
}

/** The `extra` of a command handler's hash item: its `args`, `async` and `if`; undefined (v1 layout) without them. */
export function commandHashExtra(spec: HookSpec): Readonly<Record<string, unknown>> | undefined {
  const extra: Record<string, unknown> = {
    ...(spec.args === undefined ? {} : { args: [...spec.args] }),
    ...(spec.async === true ? { async: true } : {}),
    ...(spec.if === undefined ? {} : { if: spec.if }),
  }
  return Object.keys(extra).length === 0 ? undefined : extra
}

/** The `extra` of a prompt handler's hash item (always the v2 layout). */
export function promptHashExtra(spec: PromptHookSpec): Readonly<Record<string, unknown>> {
  return {
    type: 'prompt',
    prompt: spec.prompt,
    model: spec.model,
    continueOnBlock: spec.continueOnBlock,
    ...(spec.if === undefined ? {} : { if: spec.if }),
  }
}

/** The hash item of a handler (refs hashed by the caller). */
export function hookHashItem(entry: SettingsHookSpec, refs: Extract<TrustHashItem, { readonly kind: 'hook' }>['refs']): Extract<TrustHashItem, { readonly kind: 'hook' }> {
  const { spec } = entry
  if (entry.kind === 'prompt')
    return { kind: 'hook', event: spec.event, matcher: spec.matcher, command: null, timeoutSec: spec.timeoutSec, extra: promptHashExtra(entry.spec), refs }
  const extra = commandHashExtra(entry.spec)
  return { kind: 'hook', event: spec.event, matcher: spec.matcher, command: entry.spec.command, timeoutSec: spec.timeoutSec, ...(extra === undefined ? {} : { extra }), refs }
}

/** The referenced paths of a handler. */
export function settingsHookRefPaths(entry: SettingsHookSpec): string[] {
  return entry.kind === 'prompt' ? [] : hookItemRefPaths(entry.spec.command, entry.spec.args)
}

/** The item `spec` of a handler (a prompt handler: `command: ''` plus its prompt fields). */
export function itemSpec(entry: SettingsHookSpec): HookSpec {
  if (entry.kind === 'command')
    return entry.spec
  const spec: ProjectPromptHookSpec = { ...entry.spec, type: 'prompt', command: '' }
  return spec
}

/** The short label of a handler for lists (the command with its arguments, or the prompt's first line). */
export function hookItemLabel(entry: SettingsHookSpec, max: number): string {
  if (entry.kind === 'prompt') {
    const line = entry.spec.prompt.split(/\r?\n/).map(value => value.trim()).find(value => value !== '') ?? ''
    return line.slice(0, max)
  }
  const { command, args } = entry.spec
  return (args === undefined || args.length === 0 ? command : `${command} ${args.join(' ')}`).slice(0, max)
}

/** The command lines whose review warnings a handler gets (`commandWarnings`); none for a prompt handler. */
export function hookWarningCommands(entry: SettingsHookSpec): string[] {
  if (entry.kind === 'prompt')
    return []
  const { command, args } = entry.spec
  if (args === undefined)
    return [command]
  return [execFormCommand(command, args) ?? command]
}

/** The prompt fields of a project hook item, or null for a command item. */
export function projectPromptSpec(item: Pick<ProjectHookItem, 'spec' | 'hashItem'>): PromptHookSpec | null {
  const spec = item.spec as Partial<ProjectPromptHookSpec>
  if (spec.type !== 'prompt' || typeof spec.prompt !== 'string' || item.hashItem.command !== null)
    return null
  return {
    event: item.spec.event,
    matcher: item.spec.matcher,
    prompt: spec.prompt,
    model: typeof spec.model === 'string' ? spec.model : null,
    timeoutSec: item.spec.timeoutSec,
    continueOnBlock: spec.continueOnBlock === true,
    position: item.spec.position,
    ...(item.spec.file === undefined ? {} : { file: item.spec.file }),
    ...(item.spec.if === undefined ? {} : { if: item.spec.if }),
    ...(item.spec.statusMessage === undefined ? {} : { statusMessage: item.spec.statusMessage }),
  }
}
