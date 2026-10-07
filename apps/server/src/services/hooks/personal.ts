// Personal hooks (Phase 11, ADR-048; API.md 4.31 / 5.31): the rows of the `hooks` table (`hok_` ids, at most
// `LIMITS.personalHooksMax`), configuration that is never in backups and survives delete-all. Creating one needs fresh
// auth; changing one too unless the change only turns it off (`isHookTurnOff`); deleting one never does (it only takes
// power away). The matcher is checked with the shared `compileMatcher` (the safe subset; `validation_error` on
// `['matcher']`), the command (1 – 4096 characters, no NUL) and the timeout (1 – 600 s) with the shared schemas. The rows
// are cached in memory (they change only here); `invalidate()` drops the cache.
//
// Phase 12 (ADR-057, W12.5): a row is a command hook (`type: 'command'`) or a prompt hook (`type: 'prompt'`: `prompt`,
// `model`, `command = ''`); the handler fields live in `options` (`{ continueOnBlock?, args?, async?, if?, statusMessage?
// }`, null when none). A `PATCH` may switch the type (the other type's fields are then cleared; the new type's required
// field must come with it); fields of the other type than the hook's (after the change) are a 400, and so are a prompt
// hook on an event without prompt handlers and an `if` rule on an event without a tool. `importPersonal(items)` stores
// the hooks of a home-folder import (the apply route required fresh auth): each item checked like a create body,
// command hooks off unless the item turns them on, prompt hooks as given, the 100-row cap; one `hooks.changed`.
import type { HookCreate, HookEvent, HookUpdate, PersonalHook } from '@harness-forge/shared'
import type { HookRow, PersonalHookOptions } from '../../db/schema.ts'
import type { AppDeps, SensitiveOperationOptions } from '../../types.ts'
import type { HookImportResult } from './types.ts'
import {
  createHookId,
  HarnessError,
  hookCreateSchema,
  hookUpdateSchema,
  isHookTurnOff,
  isPromptHookEvent,
  LIMITS,
  TOOL_HOOK_EVENTS,
  validationError,
} from '@harness-forge/shared'
import { asc, count, eq } from 'drizzle-orm'
import { hooks } from '../../db/schema.ts'
import { guardDb } from '../chats/db-errors.ts'

/** Answer of a create at `LIMITS.personalHooksMax` rows (API.md 5.31). */
export const PERSONAL_HOOKS_FULL_MESSAGE = `At most ${LIMITS.personalHooksMax} personal hooks can be stored; delete one first.`
/** `importPersonal`: an item that is not a valid hook (never quotes the command or the prompt). */
export const IMPORT_INVALID_MESSAGE = 'This hook is not valid and was not imported.'

const TOOL_EVENTS: ReadonlySet<string> = new Set(TOOL_HOOK_EVENTS)

export interface PersonalHookStore {
  /** Every row, oldest first (run order); cached. */
  readonly rows: () => Promise<readonly HookRow[]>
  readonly create: (body: HookCreate, options?: SensitiveOperationOptions) => Promise<PersonalHook>
  readonly update: (id: string, body: HookUpdate, options?: SensitiveOperationOptions) => Promise<PersonalHook>
  readonly remove: (id: string) => Promise<void>
  /** Phase 12: stores the hooks of an import (see the module comment); `changed` once when any row was created. */
  readonly importMany: (items: readonly HookCreate[]) => Promise<HookImportResult[]>
  /** Drops the cached rows. */
  readonly invalidate: () => void
}

/** The handler fields of a row (`options`), or an empty object. */
export function rowOptions(row: Pick<HookRow, 'options'>): PersonalHookOptions {
  const options = row.options
  return typeof options === 'object' && options !== null && !Array.isArray(options) ? options : {}
}

/** A row as the DTO (`personalHookSchema`). */
export function personalHookOf(row: HookRow): PersonalHook {
  const options = rowOptions(row)
  const base = {
    id: row.id,
    event: row.event,
    matcher: row.matcher,
    timeout: row.timeout,
    ...(typeof options.statusMessage === 'string' && options.statusMessage !== '' ? { statusMessage: options.statusMessage } : {}),
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  const rule = typeof options.if === 'string' && options.if !== '' ? { if: options.if } : {}
  if (row.type === 'prompt') {
    return {
      ...base,
      type: 'prompt',
      prompt: row.prompt ?? '',
      model: row.model,
      ...(options.continueOnBlock === true ? { continueOnBlock: true } : {}),
      ...rule,
    }
  }
  return {
    ...base,
    type: 'command',
    command: row.command,
    ...(Array.isArray(options.args) ? { args: [...options.args] } : {}),
    ...(options.async === true ? { async: true } : {}),
    ...rule,
  }
}

function notFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Hook ${id} not found.` })
}

/** A `validation_error` on one field (the shape of the schema errors). */
function fieldError(path: string, message: string): HarnessError {
  return validationError([{ code: 'custom', message, path: [path] }])
}

/** A blank matcher is stored as null (every target); otherwise the trimmed matcher. */
function storedMatcher(matcher: string | null | undefined): string | null {
  if (matcher === undefined || matcher === null)
    return null
  const trimmed = matcher.trim()
  return trimmed === '' ? null : trimmed
}

/** A blank model is stored as null (the hook model); otherwise the trimmed model. */
function storedModel(model: string | null | undefined): string | null {
  if (typeof model !== 'string')
    return null
  const trimmed = model.trim()
  return trimmed === '' ? null : trimmed
}

/** `options` without empty fields; null when nothing is left. */
function storedOptions(options: PersonalHookOptions): PersonalHookOptions | null {
  const result: PersonalHookOptions = {
    ...(options.continueOnBlock === true ? { continueOnBlock: true } : {}),
    ...(Array.isArray(options.args) ? { args: [...options.args] } : {}),
    ...(options.async === true ? { async: true } : {}),
    ...(typeof options.if === 'string' && options.if.trim() !== '' ? { if: options.if.trim() } : {}),
    ...(typeof options.statusMessage === 'string' && options.statusMessage.trim() !== '' ? { statusMessage: options.statusMessage.trim() } : {}),
  }
  return Object.keys(result).length === 0 ? null : result
}

/** The row fields of a validated create body (not the id, the times or `enabled`). */
function createdFields(body: HookCreate): Pick<HookRow, 'type' | 'event' | 'matcher' | 'command' | 'timeout' | 'prompt' | 'model' | 'options'> {
  const common = { event: body.event, matcher: storedMatcher(body.matcher), timeout: body.timeout ?? null }
  if (body.type === 'prompt') {
    return {
      ...common,
      type: 'prompt',
      command: '',
      prompt: body.prompt.trim(),
      model: storedModel(body.model),
      options: storedOptions({
        ...(body.continueOnBlock === true ? { continueOnBlock: true } : {}),
        ...(body.if === undefined || body.if === null ? {} : { if: body.if }),
        ...(body.statusMessage === undefined || body.statusMessage === null ? {} : { statusMessage: body.statusMessage }),
      }),
    }
  }
  return {
    ...common,
    type: 'command',
    command: body.command.trim(),
    prompt: null,
    model: null,
    options: storedOptions({
      ...(body.args === undefined || body.args === null ? {} : { args: body.args }),
      ...(body.async === true ? { async: true } : {}),
      ...(body.if === undefined || body.if === null ? {} : { if: body.if }),
      ...(body.statusMessage === undefined || body.statusMessage === null ? {} : { statusMessage: body.statusMessage }),
    }),
  }
}

/** The row a validated `PATCH` body makes of `current` (see the module comment); throws `validation_error`. */
export function patchedRow(current: HookRow, patch: HookUpdate, updatedAt: number): HookRow {
  const type = patch.type ?? current.type
  const switching = type !== current.type
  const event: HookEvent = patch.event ?? current.event
  if (type === 'command') {
    for (const key of ['prompt', 'model', 'continueOnBlock'] as const) {
      if (patch[key] !== undefined)
        throw fieldError(key, `"${key}" belongs to prompt hooks.`)
    }
  }
  else {
    for (const key of ['command', 'args', 'async'] as const) {
      if (patch[key] !== undefined)
        throw fieldError(key, `"${key}" belongs to command hooks.`)
    }
    if (!isPromptHookEvent(event))
      throw fieldError('event', `${event} hooks cannot use prompt handlers.`)
  }
  const before = rowOptions(current)
  // `null` clears a field; absent keeps it (a type switch keeps only the fields both types share).
  const pick = <T>(value: T | null | undefined, kept: T | undefined): T | undefined => value === null ? undefined : value ?? kept
  const rule = pick(patch.if, before.if)
  if (rule !== undefined && !TOOL_EVENTS.has(event))
    throw fieldError('if', `"if" applies only to tool events, not ${event}.`)
  const statusMessage = pick(patch.statusMessage, before.statusMessage)
  const common = {
    ...current,
    event,
    ...(patch.matcher === undefined ? {} : { matcher: storedMatcher(patch.matcher) }),
    ...(patch.timeout === undefined ? {} : { timeout: patch.timeout }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    updatedAt,
  }
  if (type === 'command') {
    if (switching && patch.command === undefined)
      throw fieldError('command', 'A command hook needs a command.')
    const args = pick(patch.args, switching ? undefined : before.args)
    const async = patch.async ?? (switching ? undefined : before.async)
    return {
      ...common,
      type: 'command',
      command: patch.command === undefined ? current.command : patch.command.trim(),
      prompt: null,
      model: null,
      options: storedOptions({
        ...(args === undefined ? {} : { args }),
        ...(async === true ? { async: true } : {}),
        ...(rule === undefined ? {} : { if: rule }),
        ...(statusMessage === undefined ? {} : { statusMessage }),
      }),
    }
  }
  if (switching && patch.prompt === undefined)
    throw fieldError('prompt', 'A prompt hook needs a prompt.')
  const continueOnBlock = patch.continueOnBlock ?? (switching ? undefined : before.continueOnBlock)
  return {
    ...common,
    type: 'prompt',
    command: '',
    prompt: patch.prompt === undefined ? (current.prompt ?? '') : patch.prompt.trim(),
    model: patch.model === undefined ? (switching ? null : current.model) : storedModel(patch.model),
    options: storedOptions({
      ...(continueOnBlock === true ? { continueOnBlock: true } : {}),
      ...(rule === undefined ? {} : { if: rule }),
      ...(statusMessage === undefined ? {} : { statusMessage }),
    }),
  }
}

export interface PersonalHookStoreOptions {
  /** Called after every change (the service emits `hooks.changed { projectId: null }`). */
  readonly changed: () => void
  /** Clock (epoch ms). */
  readonly now: () => number
}

export function createPersonalHookStore(deps: Pick<AppDeps, 'db'>, options: PersonalHookStoreOptions): PersonalHookStore {
  const { db } = deps
  let cache: Promise<readonly HookRow[]> | null = null
  // Bumped on every change, so a read that started before a change never refills the cache with stale rows.
  let version = 0
  // Creation times are strictly increasing in this process, so hooks created in the same millisecond keep their order.
  let lastCreatedAt = 0
  // Creates and imports one at a time (the row cap is checked and written together).
  let queue: Promise<unknown> = Promise.resolve()

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.catch(() => {}).then(operation)
    queue = next.catch(() => {})
    return next
  }

  function rows(): Promise<readonly HookRow[]> {
    if (cache !== null)
      return cache
    const started = version
    const read = guardDb(() => db.select().from(hooks).orderBy(asc(hooks.createdAt), asc(hooks.id)))
      .then(list => Object.freeze(list.map(row => Object.freeze(row))))
    cache = read
    read.catch(() => {
      if (cache === read)
        cache = null
    })
    return read.then((list) => {
      if (version !== started && cache === read)
        cache = null
      return list
    })
  }

  function invalidate(): void {
    version += 1
    cache = null
  }

  async function find(id: string): Promise<HookRow> {
    const [row] = await guardDb(() => db.select().from(hooks).where(eq(hooks.id, id)).limit(1))
    if (row === undefined)
      throw notFound(id)
    return row
  }

  async function total(): Promise<number> {
    const [result] = await guardDb(() => db.select({ value: count() }).from(hooks))
    return result?.value ?? 0
  }

  function changed(): void {
    invalidate()
    options.changed()
  }

  /** A new row of a validated body (`enabled` decided by the caller). */
  function newRow(body: HookCreate, enabled: boolean): HookRow {
    const at = Math.max(options.now(), lastCreatedAt + 1)
    lastCreatedAt = at
    return { id: createHookId(), ...createdFields(body), enabled, createdAt: at, updatedAt: at }
  }

  return {
    rows,
    invalidate,
    create: async (body, sensitive) => {
      sensitive?.requireFreshAuth()
      const parsed = hookCreateSchema.safeParse(body)
      if (!parsed.success)
        throw validationError(parsed.error)
      return serialized(async () => {
        if (await total() >= LIMITS.personalHooksMax)
          throw new HarnessError({ code: 'conflict', message: PERSONAL_HOOKS_FULL_MESSAGE, details: { reason: 'exists' } })
        const row = newRow(parsed.data, parsed.data.enabled ?? true)
        await guardDb(() => db.insert(hooks).values(row))
        changed()
        return personalHookOf(row)
      })
    },
    update: async (id, body, sensitive) => {
      // Turning a hook off only takes power away; every other change can change what runs.
      if (!isHookTurnOff(body))
        sensitive?.requireFreshAuth()
      const parsed = hookUpdateSchema.safeParse(body)
      if (!parsed.success)
        throw validationError(parsed.error)
      const current = await find(id)
      const next = patchedRow(current, parsed.data, Math.max(options.now(), current.updatedAt))
      const updated = await guardDb(() => db.update(hooks).set({
        type: next.type,
        event: next.event,
        matcher: next.matcher,
        command: next.command,
        prompt: next.prompt,
        model: next.model,
        options: next.options,
        timeout: next.timeout,
        enabled: next.enabled,
        updatedAt: next.updatedAt,
      }).where(eq(hooks.id, id)).returning({ id: hooks.id }))
      if (updated.length === 0)
        throw notFound(id)
      changed()
      return personalHookOf(next)
    },
    remove: async (id) => {
      const removed = await guardDb(() => db.delete(hooks).where(eq(hooks.id, id)).returning({ id: hooks.id }))
      if (removed.length === 0)
        throw notFound(id)
      changed()
    },
    importMany: async items => serialized(async () => {
      const results: HookImportResult[] = []
      let stored = await total()
      let created = 0
      try {
        for (const item of items) {
          const parsed = hookCreateSchema.safeParse(item)
          if (!parsed.success) {
            results.push({ ok: false, message: IMPORT_INVALID_MESSAGE })
            continue
          }
          if (stored >= LIMITS.personalHooksMax) {
            results.push({ ok: false, message: PERSONAL_HOOKS_FULL_MESSAGE })
            continue
          }
          // Command hooks arrive turned off unless the import turned them on; prompt hooks as given.
          const enabled = parsed.data.type === 'prompt' ? parsed.data.enabled ?? true : parsed.data.enabled === true
          const row = newRow(parsed.data, enabled)
          try {
            await guardDb(() => db.insert(hooks).values(row))
          }
          catch {
            results.push({ ok: false, message: 'This hook could not be stored.' })
            continue
          }
          stored += 1
          created += 1
          results.push({ ok: true, hook: personalHookOf(row) })
        }
      }
      finally {
        if (created > 0)
          changed()
      }
      return results
    }),
  }
}
