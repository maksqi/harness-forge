// The personal definitions (Phase 10, ADR-044; API.md 4.28 / 5.28, ARCHITECTURE.md 6.23 "User store"). Owner: W10.1.
//
// - Table `customizations`: the raw markdown (`content`) plus the denormalized `kind`, `name`, `description`, `enabled`;
//   ids `cus_` + 16 characters. Every create and update parses the content with the shared `parseDefinition` (personal
//   content has no file name, so `name` comes from the frontmatter): an `error` diagnostic is `400 validation_error`
//   with the diagnostics in `details.diagnostics` (a builtin or reserved name is such an error, `reserved-name`).
// - `(kind, name)` is unique: a taken name is `409 conflict` `exists`, decided by the unique index
//   `customizations_kind_name_uq` (a race past the check maps `SQLITE_CONSTRAINT_UNIQUE` to the same answer); at most
//   `LIMITS.customizationsPerKindMax` (200) rows per kind (`409` `exists`, API.md 5.28). A new name in updated content
//   renames the row (the kind stays). Writes run one at a time (an in-process queue), so the cap holds.
// - The catalog lists every row (`source: 'user'`, `off` when turned off); parses are memoized per row and dropped on
//   every write of the row.
// - Backups (`customizations.json`, W10.6): `exportBackup` lists every row (kind, name, content, enabled);
//   `restoreBackup` parses each item like a create, keeps an existing kind and name (skipped) and fails invalid items
//   and items beyond the per-kind limit (one warning each: kind and name, never the content).
// - Logging: ids, kinds and counts at `info`; never the content or the description.
import type {
  BackupCustomization,
  BackupCustomizations,
  Customization,
  CustomizationCreate,
  CustomizationEntry,
  CustomizationKind,
  CustomizationUpdate,
  DefinitionDiagnostic,
  ParseDefinitionResult,
} from '@harness-forge/shared'
import type { CustomizationRow } from '../../db/schema.ts'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { CustomizationRestoreResult, LoadedDefinition } from './types.ts'
import { createCustomizationId, CUSTOMIZATION_KINDS, HarnessError, LIMITS, parseDefinition } from '@harness-forge/shared'
import { and, count, eq, inArray, ne } from 'drizzle-orm'
import { customizations } from '../../db/schema.ts'
import { databaseError, guardDb, sqliteErrorCodes } from '../chats/db-errors.ts'
import { DIAGNOSTICS_MAX, entryFromParse } from './entries.ts'

/** Characters of one restore warning. */
const RESTORE_WARNING_MAX_CHARS = 300
/** Ids per `IN (…)` query. */
const ID_CHUNK = 500

// ---------- errors (user-facing, API.md 5.28) ----------

export function customizationNotFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Customization ${id} not found.` })
}

/** `409 exists`: a personal definition of the same kind and name. */
export function customizationExists(kind: CustomizationKind, name: string): HarnessError {
  return new HarnessError({ code: 'conflict', message: `A personal ${kind} named "${name}" already exists.`, details: { reason: 'exists' } })
}

/** `409` at `LIMITS.customizationsPerKindMax` rows of a kind (reason `exists`: the API has no other reason for it). */
export function customizationsFull(kind: CustomizationKind): HarnessError {
  const max = LIMITS.customizationsPerKindMax
  return new HarnessError({ code: 'conflict', message: `At most ${max} personal ${kind}s can be stored; delete one first.`, details: { reason: 'exists' } })
}

/**
 * `400 validation_error` of content that cannot be used: the message of the first `error` diagnostic, the diagnostics
 * in `details.diagnostics` and one issue on `issuePath`.
 */
export function invalidDefinition(diagnostics: readonly DefinitionDiagnostic[], issuePath: readonly string[] = ['content']): HarnessError {
  const first = diagnostics.find(entry => entry.level === 'error')
  const message = first?.message ?? 'The definition is not valid.'
  return new HarnessError({
    code: 'validation_error',
    message,
    details: { diagnostics: diagnostics.slice(0, DIAGNOSTICS_MAX), issues: [{ path: [...issuePath], message, code: 'custom' }] },
  })
}

function isUniqueViolation(error: unknown): boolean {
  return sqliteErrorCodes(error).includes('SQLITE_CONSTRAINT_UNIQUE')
}

/** The parse of `content` when it is usable (no `error`), else throws the `400`. */
function parseUsable(kind: CustomizationKind, content: string): ParseDefinitionResult & { definition: NonNullable<ParseDefinitionResult['definition']> } {
  const result = parseDefinition(kind, content)
  const definition = result.definition
  if (definition === null || definition.kind !== kind || result.diagnostics.some(entry => entry.level === 'error'))
    throw invalidDefinition(result.diagnostics)
  return { definition, diagnostics: result.diagnostics }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Control characters of a name shown in a restore warning (a backup is user data). */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu

function restoreWarning(item: BackupCustomization, reason: string): string {
  const name = String(item.name).replace(CONTROL_CHARACTERS, '?').slice(0, 64)
  return `The personal ${item.kind} "${name}" was not restored: ${reason}`.slice(0, RESTORE_WARNING_MAX_CHARS)
}

// ---------- the store ----------

export interface CustomizationStoreOptions {
  readonly now: () => number
  readonly logger: () => Logger
}

export interface CustomizationStore {
  /** The catalog entries of every row (`source: 'user'`), parsed (memoized per row). */
  readonly entries: () => Promise<CustomizationEntry[]>
  readonly get: (id: string) => Promise<Customization>
  readonly create: (body: CustomizationCreate) => Promise<Customization>
  readonly update: (id: string, body: CustomizationUpdate) => Promise<Customization>
  /** Returns the removed row's kind. */
  readonly remove: (id: string) => Promise<Customization>
  /** The body of a personal catalog entry (`load`): the enabled row of the entry's id (else its kind and name). */
  readonly load: (entry: CustomizationEntry) => Promise<LoadedDefinition>
  readonly exportBackup: () => Promise<BackupCustomizations>
  readonly restoreBackup: (items: readonly BackupCustomization[]) => Promise<CustomizationRestoreResult>
}

interface Memo {
  readonly kind: CustomizationKind
  readonly updatedAt: number
  readonly result: ParseDefinitionResult
}

export function createCustomizationStore(deps: Pick<AppDeps, 'db'>, options: CustomizationStoreOptions): CustomizationStore {
  const { db } = deps
  const memo = new Map<string, Memo>()

  /** Writes one at a time (the duplicate and cap checks and the write must not interleave). */
  let queue: Promise<unknown> = Promise.resolve()
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation)
    queue = result.catch(() => {})
    return result
  }

  function parseRow(row: Pick<CustomizationRow, 'id' | 'kind' | 'content' | 'updatedAt'>): ParseDefinitionResult {
    const cached = memo.get(row.id)
    if (cached !== undefined && cached.kind === row.kind && cached.updatedAt === row.updatedAt)
      return cached.result
    const result = parseDefinition(row.kind, row.content)
    memo.set(row.id, { kind: row.kind, updatedAt: row.updatedAt, result })
    return result
  }

  function toCustomization(row: CustomizationRow): Customization {
    const result = parseRow(row)
    const usable = result.definition !== null && result.definition.kind === row.kind && !result.diagnostics.some(entry => entry.level === 'error')
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      description: row.description,
      content: row.content,
      enabled: row.enabled,
      diagnostics: result.diagnostics.slice(0, DIAGNOSTICS_MAX),
      fields: usable ? result.definition!.fields : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as Customization
  }

  async function findRow(id: string): Promise<CustomizationRow | undefined> {
    const [row] = await guardDb(async () => db.select().from(customizations).where(eq(customizations.id, id)).limit(1))
    return row
  }

  async function requireRow(id: string): Promise<CustomizationRow> {
    const row = await findRow(id)
    if (row === undefined)
      throw customizationNotFound(id)
    return row
  }

  async function nameTaken(kind: CustomizationKind, name: string, exceptId?: string): Promise<boolean> {
    const condition = exceptId === undefined
      ? and(eq(customizations.kind, kind), eq(customizations.name, name))
      : and(eq(customizations.kind, kind), eq(customizations.name, name), ne(customizations.id, exceptId))
    const rows = await guardDb(async () => db.select({ id: customizations.id }).from(customizations).where(condition).limit(1))
    return rows.length > 0
  }

  async function countOf(kind: CustomizationKind): Promise<number> {
    const [{ n } = { n: 0 }] = await guardDb(async () => db.select({ n: count() }).from(customizations).where(eq(customizations.kind, kind)))
    return n
  }

  /** Inserts a parsed definition; the unique index maps a race to `409 exists`. */
  async function insert(kind: CustomizationKind, content: string, enabled: boolean, name: string, description: string): Promise<CustomizationRow> {
    const at = options.now()
    let row: CustomizationRow | undefined
    try {
      [row] = await db
        .insert(customizations)
        .values({ id: createCustomizationId(), kind, name, description, content, enabled, createdAt: at, updatedAt: at })
        .returning()
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw customizationExists(kind, name)
      throw databaseError(error)
    }
    if (row === undefined)
      throw new HarnessError({ code: 'internal_error', message: 'The customization was not stored.' })
    return row
  }

  async function allRows(): Promise<CustomizationRow[]> {
    return guardDb(async () => db.select().from(customizations))
  }

  return {
    entries: async () => {
      const rows = await guardDb(async () => db
        .select({
          id: customizations.id,
          kind: customizations.kind,
          name: customizations.name,
          enabled: customizations.enabled,
          updatedAt: customizations.updatedAt,
        })
        .from(customizations))
      // Content is read only for the rows whose parse is not memoized (a definition may be 64 KiB).
      const stale = rows.filter((row) => {
        const cached = memo.get(row.id)
        return cached === undefined || cached.kind !== row.kind || cached.updatedAt !== row.updatedAt
      })
      for (let start = 0; start < stale.length; start += ID_CHUNK) {
        const ids = stale.slice(start, start + ID_CHUNK).map(row => row.id)
        const contents = await guardDb(async () => db
          .select({ id: customizations.id, kind: customizations.kind, content: customizations.content, updatedAt: customizations.updatedAt })
          .from(customizations)
          .where(inArray(customizations.id, ids)))
        for (const row of contents)
          parseRow(row)
      }
      const live = new Set(rows.map(row => row.id))
      for (const id of memo.keys()) {
        if (!live.has(id))
          memo.delete(id)
      }
      const entries: CustomizationEntry[] = []
      for (const row of rows) {
        const cached = memo.get(row.id)
        const result = cached?.result ?? { definition: null, diagnostics: [] }
        entries.push(entryFromParse(row.kind, 'user', result, { id: row.id, enabled: row.enabled, fallbackName: row.name }))
      }
      return entries
    },

    get: async id => toCustomization(await requireRow(id)),

    create: async (body) => {
      const { definition } = parseUsable(body.kind, body.content)
      const { name, description } = definition.fields
      const row = await serialized(async () => {
        if (await nameTaken(body.kind, name))
          throw customizationExists(body.kind, name)
        if (await countOf(body.kind) >= LIMITS.customizationsPerKindMax)
          throw customizationsFull(body.kind)
        return insert(body.kind, body.content, body.enabled ?? true, name, description)
      })
      memo.delete(row.id)
      options.logger().info('customization created', { customizationId: row.id, kind: row.kind })
      return toCustomization(row)
    },

    update: async (id, body) => {
      const row = await serialized(async () => {
        const current = await requireRow(id)
        const patch: Partial<CustomizationRow> = { updatedAt: Math.max(options.now(), current.updatedAt + 1) }
        if (body.content !== undefined) {
          const { definition } = parseUsable(current.kind, body.content)
          const { name, description } = definition.fields
          if (name !== current.name && await nameTaken(current.kind, name, id))
            throw customizationExists(current.kind, name)
          Object.assign(patch, { content: body.content, name, description })
        }
        if (body.enabled !== undefined)
          patch.enabled = body.enabled
        let updated: CustomizationRow | undefined
        try {
          [updated] = await db.update(customizations).set(patch).where(eq(customizations.id, id)).returning()
        }
        catch (error) {
          if (isUniqueViolation(error))
            throw customizationExists(current.kind, patch.name ?? current.name)
          throw databaseError(error)
        }
        if (updated === undefined)
          throw customizationNotFound(id)
        return updated
      })
      memo.delete(id)
      options.logger().info('customization updated', { customizationId: id, kind: row.kind, content: body.content !== undefined, enabled: row.enabled })
      return toCustomization(row)
    },

    remove: async (id) => {
      const [row] = await serialized(async () => guardDb(async () => db.delete(customizations).where(eq(customizations.id, id)).returning()))
      if (row === undefined)
        throw customizationNotFound(id)
      const removed = toCustomization(row)
      memo.delete(id)
      options.logger().info('customization removed', { customizationId: id, kind: row.kind })
      return removed
    },

    load: async (entry) => {
      const gone = (): HarnessError => new HarnessError({ code: 'not_found', message: `The ${entry.kind} "${entry.name}" is no longer available.` })
      let row: CustomizationRow | undefined
      if (entry.id !== undefined) {
        row = await findRow(entry.id)
      }
      else {
        const [found] = await guardDb(async () => db
          .select()
          .from(customizations)
          .where(and(eq(customizations.kind, entry.kind), eq(customizations.name, entry.name)))
          .limit(1))
        row = found
      }
      if (row === undefined || row.kind !== entry.kind || row.name !== entry.name || !row.enabled)
        throw gone()
      const result = parseRow(row)
      const definition = result.definition
      if (definition === null || definition.kind !== entry.kind || result.diagnostics.some(item => item.level === 'error'))
        throw invalidDefinition(result.diagnostics, [])
      if (definition.fields.name !== entry.name)
        throw gone()
      return { entry, definition, diagnostics: result.diagnostics.slice(0, DIAGNOSTICS_MAX) }
    },

    exportBackup: async () => {
      const rows = await allRows()
      const kindOrder = (kind: CustomizationKind): number => CUSTOMIZATION_KINDS.indexOf(kind)
      const items = rows
        .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || compareText(a.name, b.name))
        .map((row): BackupCustomization => ({ kind: row.kind, name: row.name, content: row.content, enabled: row.enabled }))
      return { items }
    },

    restoreBackup: async items => serialized(async () => {
      const rows = await guardDb(async () => db.select({ kind: customizations.kind, name: customizations.name }).from(customizations))
      const taken = new Set(rows.map(row => `${row.kind}\u0000${row.name}`))
      const counts = new Map<CustomizationKind, number>()
      for (const row of rows)
        counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1)
      let imported = 0
      let skipped = 0
      let failed = 0
      const warnings: string[] = []
      for (const item of items) {
        if (!(CUSTOMIZATION_KINDS as readonly string[]).includes(item.kind) || typeof item.content !== 'string') {
          failed += 1
          warnings.push(restoreWarning(item, 'it is not a definition.'))
          continue
        }
        const result = parseDefinition(item.kind, item.content)
        const definition = result.definition
        if (definition === null || definition.kind !== item.kind || result.diagnostics.some(entry => entry.level === 'error')) {
          failed += 1
          const reason = result.diagnostics.find(entry => entry.level === 'error')?.message ?? 'it is not a valid definition.'
          warnings.push(restoreWarning(item, reason))
          continue
        }
        const { name, description } = definition.fields
        const key = `${item.kind}\u0000${name}`
        if (taken.has(key)) {
          skipped += 1
          continue
        }
        if ((counts.get(item.kind) ?? 0) >= LIMITS.customizationsPerKindMax) {
          failed += 1
          warnings.push(restoreWarning(item, `the limit of ${LIMITS.customizationsPerKindMax} personal ${item.kind}s is reached.`))
          continue
        }
        try {
          await insert(item.kind, item.content, item.enabled !== false, name, description)
        }
        catch (error) {
          if (error instanceof HarnessError && error.code === 'conflict') {
            skipped += 1
            taken.add(key)
            continue
          }
          options.logger().warn('customization not restored', { kind: item.kind, err: error })
          failed += 1
          warnings.push(restoreWarning(item, 'it could not be stored.'))
          continue
        }
        taken.add(key)
        counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
        imported += 1
      }
      options.logger().info('customizations restored', { imported, skipped, failed })
      return { imported, skipped, failed, warnings }
    }),
  }
}
