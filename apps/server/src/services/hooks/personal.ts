// Personal hooks (Phase 11, ADR-048; API.md 4.31 / 5.31): the rows of the `hooks` table (`hok_` ids, at most
// `LIMITS.personalHooksMax`), configuration that is never in backups and survives delete-all. Creating one needs fresh
// auth; changing one too unless the change only turns it off (`isHookTurnOff`); deleting one never does (it only takes
// power away). The matcher is checked with the shared `compileMatcher` (the safe subset; `validation_error` on
// `['matcher']`), the command (1 – 4096 characters, no NUL) and the timeout (1 – 600 s) with the shared schemas. The rows
// are cached in memory (they change only here); `invalidate()` drops the cache.
import type { HookCreate, HookUpdate, PersonalHook } from '@harness-forge/shared'
import type { HookRow } from '../../db/schema.ts'
import type { AppDeps, SensitiveOperationOptions } from '../../types.ts'
import {
  createHookId,
  HarnessError,
  hookCreateSchema,
  hookUpdateSchema,
  isHookTurnOff,
  LIMITS,
  validationError,
} from '@harness-forge/shared'
import { asc, count, eq } from 'drizzle-orm'
import { hooks } from '../../db/schema.ts'
import { guardDb } from '../chats/db-errors.ts'

/** Answer of a create at `LIMITS.personalHooksMax` rows (API.md 5.31). */
export const PERSONAL_HOOKS_FULL_MESSAGE = `At most ${LIMITS.personalHooksMax} personal hooks can be stored; delete one first.`

export interface PersonalHookStore {
  /** Every row, oldest first (run order); cached. */
  readonly rows: () => Promise<readonly HookRow[]>
  readonly create: (body: HookCreate, options?: SensitiveOperationOptions) => Promise<PersonalHook>
  readonly update: (id: string, body: HookUpdate, options?: SensitiveOperationOptions) => Promise<PersonalHook>
  readonly remove: (id: string) => Promise<void>
  /** Drops the cached rows. */
  readonly invalidate: () => void
}

/** A row as the DTO (`personalHookSchema`). */
export function personalHookOf(row: HookRow): PersonalHook {
  return {
    id: row.id,
    // Phase 12 (C40 compile fix): every stored row is a command hook until the `hooks.type` column lands (P12-0b).
    type: 'command',
    event: row.event,
    matcher: row.matcher,
    command: row.command,
    timeout: row.timeout,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function notFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Hook ${id} not found.` })
}

/** The Phase 12 hook fields (ADR-057) the `hooks` table cannot store yet (columns of P12-0b, behavior of W12.5). */
const PHASE_12_FIELDS = ['args', 'async', 'if', 'statusMessage', 'prompt', 'model', 'continueOnBlock'] as const

/** Phase 12 (C40 compile fix): refuses prompt hooks and the new handler fields until they can be stored. */
function refusePhase12Fields(body: Readonly<Record<string, unknown>>): void {
  const field = PHASE_12_FIELDS.find(key => body[key] !== undefined)
  if (body.type === 'prompt' || field !== undefined)
    throw new HarnessError({ code: 'not_implemented', message: `Prompt hooks and the field "${field ?? 'type'}" are not supported yet.` })
}

/** A blank matcher is stored as null (every target); otherwise the trimmed matcher. */
function storedMatcher(matcher: string | null | undefined): string | null {
  if (matcher === undefined || matcher === null)
    return null
  const trimmed = matcher.trim()
  return trimmed === '' ? null : trimmed
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

  function changed(): void {
    invalidate()
    options.changed()
  }

  return {
    rows,
    invalidate,
    create: async (body, sensitive) => {
      sensitive?.requireFreshAuth()
      const parsed = hookCreateSchema.safeParse(body)
      if (!parsed.success)
        throw validationError(parsed.error)
      refusePhase12Fields(parsed.data)
      if (parsed.data.type === 'prompt')
        throw new HarnessError({ code: 'not_implemented', message: 'Prompt hooks are not supported yet.' })
      const [total] = await guardDb(() => db.select({ value: count() }).from(hooks))
      if ((total?.value ?? 0) >= LIMITS.personalHooksMax)
        throw new HarnessError({ code: 'conflict', message: PERSONAL_HOOKS_FULL_MESSAGE, details: { reason: 'exists' } })
      const at = Math.max(options.now(), lastCreatedAt + 1)
      lastCreatedAt = at
      const row: HookRow = {
        id: createHookId(),
        event: parsed.data.event,
        matcher: storedMatcher(parsed.data.matcher),
        command: parsed.data.command.trim(),
        timeout: parsed.data.timeout ?? null,
        enabled: parsed.data.enabled ?? true,
        createdAt: at,
        updatedAt: at,
        // Phase 12 columns (`0009`): prompt hooks and the Claude handler fields land in P12-A (W12.5).
        type: 'command',
        prompt: null,
        model: null,
        options: null,
      }
      await guardDb(() => db.insert(hooks).values(row))
      changed()
      return personalHookOf(row)
    },
    update: async (id, body, sensitive) => {
      // Turning a hook off only takes power away; every other change can change what runs.
      if (!isHookTurnOff(body))
        sensitive?.requireFreshAuth()
      const parsed = hookUpdateSchema.safeParse(body)
      if (!parsed.success)
        throw validationError(parsed.error)
      refusePhase12Fields(parsed.data)
      const current = await find(id)
      const patch = parsed.data
      const next: HookRow = {
        ...current,
        ...(patch.event === undefined ? {} : { event: patch.event }),
        ...(patch.matcher === undefined ? {} : { matcher: storedMatcher(patch.matcher) }),
        ...(patch.command === undefined ? {} : { command: patch.command.trim() }),
        ...(patch.timeout === undefined ? {} : { timeout: patch.timeout }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        updatedAt: Math.max(options.now(), current.updatedAt),
      }
      const updated = await guardDb(() => db.update(hooks).set({
        event: next.event,
        matcher: next.matcher,
        command: next.command,
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
  }
}
