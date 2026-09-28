// Hook execution (PLUGINS.md 9 "Hooks"): handlers run sequentially in call order with a frozen input and a copy of the
// output draft; the copy is committed only when the handler succeeds. Each call is guarded (3 s); 5 consecutive
// failures disable a handler until its plugin reloads. `tool.before` is special: a throw blocks the tool call (not
// counted as a failure), a timeout blocks it and counts.
import type { HookHandler, HookMap, HookName } from '@harness-forge/plugin-sdk'
import type { LogLevel } from '@harness-forge/shared'
import type { GuardOptions } from '../plugins/types.ts'
import { HarnessError } from '@harness-forge/shared'

/** Timeout of every hook handler call. */
export const HOOK_TIMEOUT_MS = 3000
/** Consecutive failures after which a handler is disabled until its plugin reloads. */
export const HOOK_FAILURE_LIMIT = 5

/** A registered handler with its runtime counters. */
export interface HookEntry {
  readonly pluginId: string
  readonly name: HookName
  readonly handler: HookHandler<HookName>
  readonly priority: number
  readonly seq: number
  failures: number
  disabled: boolean
  removed: boolean
}

export interface HookRunnerServices {
  /** `PluginHost.guard`. */
  readonly guard: <T>(pluginId: string, fn: (signal: AbortSignal) => T | Promise<T>, options: GuardOptions) => Promise<T>
  /** `PluginHost.log`. */
  readonly log: (pluginId: string, level: LogLevel, message: string, data?: unknown) => void
  /** False when the owner plugin is known and not active (its handlers are skipped). */
  readonly isRunnable: (pluginId: string) => boolean
  /** True when `error` is the guard's timeout (as opposed to a throw of the handler). */
  readonly isTimeout: (error: unknown) => boolean
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Copy of an output draft: plain objects and arrays are copied recursively, every other value (class instances such as
 * `URL`, `Uint8Array`, `Date`, functions) is shared. Cycles are preserved.
 */
export function cloneDraft<T>(value: T, seen = new Map<object, unknown>()): T {
  if (typeof value !== 'object' || value === null)
    return value
  const known = seen.get(value)
  if (known !== undefined)
    return known as T
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value, copy)
    for (const item of value)
      copy.push(cloneDraft(item, seen))
    return copy as T
  }
  if (!isPlainObject(value))
    return value
  const copy: Record<PropertyKey, unknown> = Object.create(Object.getPrototypeOf(value) as object | null) as Record<PropertyKey, unknown>
  seen.set(value, copy)
  for (const key of Reflect.ownKeys(value))
    copy[key] = cloneDraft((value as Record<PropertyKey, unknown>)[key], seen)
  return copy as T
}

/**
 * A read-only copy of a hook input: plain objects and arrays are copied and frozen recursively (so a handler cannot
 * change objects the pipeline shares, such as the catalog's `ModelInfo`); class instances are shared as they are.
 */
export function freezeInput<T>(value: T): T {
  const copy = cloneDraft(value)
  const seen = new Set<object>()
  const freeze = (item: unknown): void => {
    if (typeof item !== 'object' || item === null || seen.has(item))
      return
    if (!Array.isArray(item) && !isPlainObject(item))
      return
    seen.add(item)
    for (const key of Reflect.ownKeys(item))
      freeze((item as Record<PropertyKey, unknown>)[key])
    Object.freeze(item)
  }
  freeze(copy)
  return copy
}

/** Writes the top-level keys of `draft` into `target` in place (removed keys are deleted). */
export function commitDraft(target: object, draft: object): void {
  const out = target as Record<PropertyKey, unknown>
  const source = draft as Record<PropertyKey, unknown>
  for (const key of Reflect.ownKeys(out)) {
    if (!Object.hasOwn(source, key))
      delete out[key]
  }
  for (const key of Reflect.ownKeys(source))
    out[key] = source[key]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The error of a `tool.before` handler that blocked the call. */
export function blockedError(pluginId: string, error: unknown): HarnessError {
  return new HarnessError(
    { code: 'plugin_error', message: `Blocked by ${pluginId}: ${errorMessage(error)}`, details: { pluginId, phase: 'hook' } },
    { cause: error },
  )
}

function recordFailure(services: HookRunnerServices, entry: HookEntry): void {
  entry.failures += 1
  if (entry.failures >= HOOK_FAILURE_LIMIT && !entry.disabled) {
    entry.disabled = true
    services.log(
      entry.pluginId,
      'warn',
      `The "${entry.name}" hook handler was disabled after ${HOOK_FAILURE_LIMIT} consecutive failures; reload the plugin to enable it again.`,
    )
  }
}

/**
 * Runs `entries` (already in call order) for one hook invocation. Only `tool.before` rethrows (as a `plugin_error`
 * "Blocked by <pluginId>: <message>"); every other failure is logged by the guard, counted and swallowed.
 */
export async function runHookEntries<K extends HookName>(
  services: HookRunnerServices,
  name: K,
  entries: readonly HookEntry[],
  args: HookMap[K],
): Promise<void> {
  const [input, output] = args as unknown as [object, object | undefined]
  const frozenInput = freezeInput(input)
  for (const entry of entries) {
    if (entry.removed || entry.disabled || !services.isRunnable(entry.pluginId))
      continue
    const draft = output === undefined ? undefined : cloneDraft(output)
    const options: GuardOptions = { timeoutMs: HOOK_TIMEOUT_MS, phase: 'hook', label: name }
    try {
      await services.guard(entry.pluginId, () => (entry.handler as (input: object, output: object | undefined) => unknown)(frozenInput, draft), options)
      entry.failures = 0
      if (output !== undefined && draft !== undefined)
        commitDraft(output, draft)
    }
    catch (error) {
      const timeout = services.isTimeout(error)
      if (name === 'tool.before') {
        if (timeout)
          recordFailure(services, entry)
        throw blockedError(entry.pluginId, error)
      }
      recordFailure(services, entry)
    }
  }
}
