// Test double of `CustomizationService` (Phase 10, C30-T8), so commands, sub-agents, skills, routes and backups can be
// tested against a catalog the test controls, without definition files:
//
//   const t = await createTestApp({ customizations: 'fake' })   // or overrides: { customizations: createFakeCustomizationService() }
//   const fake = t.deps.customizations as FakeCustomizationService
//   fake.entries.set(projectId, [fakeCatalogEntry('agent', 'reviewer', { path: '.harness/agents/reviewer.md' })])
//   fake.bodies.set(catalogEntryKey(entry), '---\nname: reviewer\ndescription: Reviews.\n---\nReview the diff.')
//   (await fake.catalog(projectId)).agent('reviewer')            // the active entry
//   await fake.load(entry)                                        // parsed with the shared parseDefinition
//
// The catalog of a project = the builtins (`explore`, `general`; unless `builtins: false`) + the global entries
// (`entries.get('')`: plugin entries, say) + the personal rows (created through `create`, `off` when disabled) + the
// project's entries (`entries.get(projectId)`), merged with `applyPrecedence` (the shared `resolvePrecedence`): entries
// set `invalid` or `off` stay so, the rest become `active` / `shadowed`. Bodies (`bodies`, by `catalogEntryKey`) are raw
// markdown parsed by the shared `parseDefinition` or a ready `ParsedDefinition`. Personal definitions follow the contract
// in memory: parsed like a create (400 `validation_error` with `details.diagnostics`), unique (kind, name) (409
// `exists`), at most `LIMITS.customizationsPerKindMax` per kind; every change emits `customization.changed` on
// `options.events`. Projects are not checked (any id is a project with an available folder and no folders read).
// Every call is counted.
import type {
  BackupCustomization,
  Customization,
  CustomizationEntry,
  CustomizationKind,
  CustomizationSource,
  DefinitionDiagnostic,
  ParsedDefinition,
} from '@harness-forge/shared'
import type { CustomizationCatalog, CustomizationRestoreResult, CustomizationService, LoadedDefinition } from '../services/customizations/types.ts'
import type { EventBus } from '../services/events/types.ts'
import {
  createCustomizationId,
  CUSTOMIZATION_KINDS,
  formatDefinition,
  HarnessError,
  LIMITS,
  parseDefinition,
} from '@harness-forge/shared'
import { builtinCatalogEntries, loadBuiltin } from '../services/customizations/builtins.ts'
import { applyPrecedence, catalogList, createCatalogSnapshot } from '../services/customizations/snapshot.ts'

/** The key of a catalog entry's body in `FakeCustomizationService.bodies`: `kind:source:name[:path or pluginId]`. */
export function catalogEntryKey(entry: Pick<CustomizationEntry, 'kind' | 'source' | 'name' | 'path' | 'pluginId'>): string {
  const where = entry.path ?? entry.pluginId
  return `${entry.kind}:${entry.source}:${entry.name}${where === undefined ? '' : `:${where}`}`
}

/** A valid catalog entry for tests: `source: 'project'`, `active`, a description, no diagnostics; `fields` win. */
export function fakeCatalogEntry(kind: CustomizationKind, name: string, fields: Partial<CustomizationEntry> = {}): CustomizationEntry {
  const source: CustomizationSource = fields.source ?? 'project'
  const folder = kind === 'skill' ? `skills/${name}/SKILL.md` : `${kind}s/${name}.md`
  return {
    kind,
    name,
    description: `The ${name} ${kind}.`,
    source,
    ...(source === 'project' ? { path: `.harness/${folder}` } : {}),
    enabled: true,
    state: 'active',
    diagnostics: [],
    ...fields,
  }
}

export interface FakeCustomizationServiceOptions {
  /** Catalog entries per project id (`''` = every catalog: global entries such as plugin entries). */
  entries?: Readonly<Record<string, readonly CustomizationEntry[]>>
  /** Bodies by `catalogEntryKey`: raw markdown (parsed on `load`) or a parsed definition. */
  bodies?: Readonly<Record<string, string | ParsedDefinition>>
  /** Folder-level diagnostics per project id (`''` = the global catalog). */
  diagnostics?: Readonly<Record<string, readonly DefinitionDiagnostic[]>>
  /** Include the builtin agents `explore` and `general` (default true). */
  builtins?: boolean
  /** Receives `customization.changed` on personal changes (default: no events). */
  events?: Pick<EventBus, 'emit'>
  /** Clock (epoch ms; default `Date.now`). */
  now?: () => number
}

export interface FakeCustomizationService extends CustomizationService {
  /** Catalog entries per project id (`''` = global); tests may edit them at any time (no cache). */
  readonly entries: Map<string, CustomizationEntry[]>
  /** Bodies by `catalogEntryKey`; tests may edit them. */
  readonly bodies: Map<string, string | ParsedDefinition>
  /** Folder-level diagnostics per project id (`''` = global). */
  readonly diagnostics: Map<string, DefinitionDiagnostic[]>
  /** Personal definitions by id. */
  readonly personal: Map<string, Customization>
  /** Number of calls of each member. */
  readonly calls: Record<keyof CustomizationService, number>
  /** Every `invalidate` argument, in order. */
  readonly invalidated: Array<string | null>
}

function notFound(message: string): HarnessError {
  return new HarnessError({ code: 'not_found', message })
}

/** The 400 of content with an `error` diagnostic (API.md 5.28). */
function invalidContent(diagnostics: readonly DefinitionDiagnostic[]): HarnessError {
  const first = diagnostics.find(entry => entry.level === 'error')
  const message = first?.message ?? 'The definition is not valid.'
  return new HarnessError({
    code: 'validation_error',
    message,
    details: { diagnostics, issues: [{ path: ['content'], message }] },
  })
}

function exists(kind: CustomizationKind, name: string): HarnessError {
  return new HarnessError({ code: 'conflict', message: `A personal ${kind} named "${name}" already exists.`, details: { reason: 'exists' } })
}

/** The personal DTO of parsed content (the `fields` of the parsed definition, or null). */
function toCustomization(base: Omit<Customization, 'kind' | 'fields'>, kind: CustomizationKind, definition: ParsedDefinition | null): Customization {
  return { ...base, kind, fields: definition?.kind === kind ? definition.fields : null } as Customization
}

export function createFakeCustomizationService(options: FakeCustomizationServiceOptions = {}): FakeCustomizationService {
  const now = options.now ?? Date.now
  const entries = new Map(Object.entries(options.entries ?? {}).map(([key, list]) => [key, [...list]]))
  const bodies = new Map(Object.entries(options.bodies ?? {}))
  const diagnostics = new Map(Object.entries(options.diagnostics ?? {}).map(([key, list]) => [key, [...list]]))
  const personal = new Map<string, Customization>()
  const invalidated: Array<string | null> = []
  const calls: Record<keyof CustomizationService, number> = {
    catalog: 0,
    list: 0,
    source: 0,
    load: 0,
    get: 0,
    create: 0,
    update: 0,
    remove: 0,
    exportBackup: 0,
    restoreBackup: 0,
    invalidate: 0,
    stop: 0,
  }

  function changed(kind: CustomizationKind, id: string): void {
    options.events?.emit('customization.changed', { kind, id })
  }

  function personalEntry(row: Customization): CustomizationEntry {
    return {
      kind: row.kind,
      name: row.name,
      description: row.description,
      source: 'user',
      id: row.id,
      enabled: row.enabled,
      state: !row.enabled ? 'off' : row.fields === null ? 'invalid' : 'active',
      diagnostics: [...row.diagnostics],
    }
  }

  function snapshot(projectId: string | null): CustomizationCatalog {
    const builtAt = now()
    const candidates = [
      ...(options.builtins === false ? [] : builtinCatalogEntries()),
      ...(entries.get('') ?? []),
      ...[...personal.values()].map(personalEntry),
      ...(projectId === null ? [] : entries.get(projectId) ?? []),
    ]
    return createCatalogSnapshot({
      projectId,
      entries: applyPrecedence(candidates),
      diagnostics: diagnostics.get(projectId ?? '') ?? [],
      project: projectId === null ? null : { id: projectId, available: true, folders: [], scannedAt: builtAt },
      builtAt,
    })
  }

  /** Parses personal content like a create: throws the 400 of an `error` diagnostic. */
  function parsePersonal(kind: CustomizationKind, content: string): { definition: ParsedDefinition, diagnostics: DefinitionDiagnostic[] } {
    const result = parseDefinition(kind, content)
    if (result.definition === null || result.diagnostics.some(entry => entry.level === 'error'))
      throw invalidContent(result.diagnostics)
    return { definition: result.definition, diagnostics: [...result.diagnostics] }
  }

  function nameTaken(kind: CustomizationKind, name: string, exceptId?: string): boolean {
    return [...personal.values()].some(row => row.kind === kind && row.name === name && row.id !== exceptId)
  }

  function createRow(kind: CustomizationKind, content: string, enabled: boolean): Customization {
    const { definition, diagnostics: found } = parsePersonal(kind, content)
    const name = definition.fields.name
    if (nameTaken(kind, name))
      throw exists(kind, name)
    if ([...personal.values()].filter(row => row.kind === kind).length >= LIMITS.customizationsPerKindMax)
      throw new HarnessError({ code: 'conflict', message: `At most ${LIMITS.customizationsPerKindMax} personal ${kind}s can be stored.`, details: { reason: 'limit' } })
    const at = now()
    const row = toCustomization({ id: createCustomizationId(), name, description: definition.fields.description, content, enabled, diagnostics: found, createdAt: at, updatedAt: at }, kind, definition)
    personal.set(row.id, row)
    changed(kind, row.id)
    return row
  }

  function personalRow(id: string): Customization {
    const row = personal.get(id)
    if (row === undefined)
      throw notFound(`Customization ${id} not found.`)
    return row
  }

  function bodyOf(entry: CustomizationEntry): ParsedDefinition {
    const body = bodies.get(catalogEntryKey(entry))
    if (body === undefined)
      throw notFound(`The ${entry.kind} "${entry.name}" is no longer available.`)
    if (typeof body !== 'string')
      return body
    const fileName = entry.path?.slice(entry.path.lastIndexOf('/') + 1)
    const result = parseDefinition(entry.kind, body, fileName === undefined ? {} : { fileName })
    if (result.definition === null || result.diagnostics.some(item => item.level === 'error'))
      throw invalidContent(result.diagnostics)
    if (result.definition.fields.name !== entry.name)
      throw notFound(`The ${entry.kind} "${entry.name}" is no longer available.`)
    return result.definition
  }

  return {
    entries,
    bodies,
    diagnostics,
    personal,
    calls,
    invalidated,
    catalog: async (projectId, catalogOptions) => {
      calls.catalog += 1
      catalogOptions?.signal?.throwIfAborted()
      return snapshot(projectId)
    },
    list: async (query) => {
      calls.list += 1
      return catalogList(snapshot(query.projectId ?? null), query.kind)
    },
    source: async (query) => {
      calls.source += 1
      if (query.source === 'user')
        throw new HarnessError({ code: 'validation_error', message: 'Read personal definitions with GET /customizations/:id.' })
      if (query.source === 'project' && query.projectId === undefined)
        throw new HarnessError({ code: 'validation_error', message: 'Project definitions need "projectId".' })
      const entry = snapshot(query.projectId ?? null).entries.find(item =>
        item.kind === query.kind && item.name === query.name && item.source === query.source && (query.path === undefined || item.path === query.path))
      if (entry === undefined)
        throw notFound(`The ${query.kind} "${query.name}" was not found.`)
      const builtin = loadBuiltin(entry)
      if (builtin !== null)
        return { content: formatDefinition(builtin.definition) }
      const body = bodies.get(catalogEntryKey(entry))
      if (body === undefined)
        throw notFound(`The ${query.kind} "${query.name}" is no longer available.`)
      const content = typeof body === 'string' ? body : formatDefinition(body)
      return entry.path === undefined ? { content } : { content, path: entry.path }
    },
    load: async (entry, signal): Promise<LoadedDefinition> => {
      calls.load += 1
      signal?.throwIfAborted()
      const builtin = loadBuiltin(entry)
      if (builtin !== null)
        return builtin
      if (entry.source === 'user') {
        const row = [...personal.values()].find(item => item.kind === entry.kind && item.name === entry.name && item.enabled)
        if (row === undefined)
          throw notFound(`The ${entry.kind} "${entry.name}" is no longer available.`)
        const parsed = parsePersonal(row.kind, row.content)
        return { entry, definition: parsed.definition, diagnostics: parsed.diagnostics }
      }
      return { entry, definition: bodyOf(entry), diagnostics: [] }
    },
    get: async (id) => {
      calls.get += 1
      return personalRow(id)
    },
    create: async (body) => {
      calls.create += 1
      return createRow(body.kind, body.content, body.enabled ?? true)
    },
    update: async (id, body) => {
      calls.update += 1
      const row = personalRow(id)
      let next: Customization = row
      if (body.content !== undefined) {
        const { definition, diagnostics: found } = parsePersonal(row.kind, body.content)
        if (nameTaken(row.kind, definition.fields.name, row.id))
          throw exists(row.kind, definition.fields.name)
        next = toCustomization({ ...row, name: definition.fields.name, description: definition.fields.description, content: body.content, diagnostics: found }, row.kind, definition)
      }
      next = { ...next, ...(body.enabled === undefined ? {} : { enabled: body.enabled }), updatedAt: now() }
      personal.set(id, next)
      changed(next.kind, id)
      return next
    },
    remove: async (id) => {
      calls.remove += 1
      const row = personalRow(id)
      personal.delete(id)
      changed(row.kind, id)
    },
    exportBackup: async () => {
      calls.exportBackup += 1
      const items = [...personal.values()]
        .sort((a, b) => CUSTOMIZATION_KINDS.indexOf(a.kind) - CUSTOMIZATION_KINDS.indexOf(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((row): BackupCustomization => ({ kind: row.kind, name: row.name, content: row.content, enabled: row.enabled }))
      return { items }
    },
    restoreBackup: async (items): Promise<CustomizationRestoreResult> => {
      calls.restoreBackup += 1
      let imported = 0
      let skipped = 0
      let failed = 0
      const warnings: string[] = []
      for (const item of items) {
        if (nameTaken(item.kind, item.name)) {
          skipped += 1
          continue
        }
        try {
          createRow(item.kind, item.content, item.enabled)
          imported += 1
        }
        catch (error) {
          if (error instanceof HarnessError && error.code === 'conflict' && (error.details as { reason?: unknown } | undefined)?.reason === 'exists') {
            skipped += 1
            continue
          }
          failed += 1
          warnings.push(`The personal ${item.kind} "${item.name}" was not restored.`.slice(0, 300))
        }
      }
      return { imported, skipped, failed, warnings }
    },
    invalidate: (projectId) => {
      calls.invalidate += 1
      invalidated.push(projectId)
    },
    stop: () => {
      calls.stop += 1
    },
  }
}
