// Frozen interface of the customization service (Phase 10, ADR-044 / ADR-045; API.md 4.28 / 5.28, ARCHITECTURE.md
// 6.23): the catalog of agents, commands and skills merged from four sources (builtin < plugin < user < project
// `.claude/` < project `.harness/`) and the personal definitions of the `customizations` table. Implementation:
// `createCustomizationService(deps)` in `services/customizations/index.ts` (C30 stub: a builtins-only catalog; W10.1
// implements discovery, the user store, the merge, the cache and `load`). Consumers: the `customizations` routes
// (W10.1), `prepareRun` (one catalog per run, `PreparedRun.catalog`: commands, the agent-types and skills blocks,
// `task`, `skill`; W10.2 - W10.5), `GET /commands?projectId` (W10.2), the backup and restore of `customizations.json`
// (W10.6) and shutdown (`stopDeps`: `stop()` right after the runs stopped). Test double: `createFakeCustomizationService`
// (`testing/fake-customizations.ts`), installed with `createTestApp({ customizations: 'fake' })`.
// Phase 11 (ADR-051; C36): the fourth kind `style` (output styles: builtins `default` / `explanatory` / `learning`,
// plugin styles of `registry.styles`, personal rows, `.claude/output-styles` and `.harness/output-styles`), read by
// `CustomizationCatalog.styles()` / `style(name)` (the run's style resolution, `chat/output-style.ts`, W11.6).
//
// Definition files are untrusted input: they are read only through `resolveWorkspacePath` / `openWorkspaceFile`
// (`workspace/paths.ts`; no link on the path, regular files only, binary skipped, byte caps before parsing) and parsed
// only by the shared `parseDefinition` (`packages/shared/src/util/definitions.ts`). A definition only ever narrows what
// a run may do (its tools); it never grants an approval, a mode, a tool override or a shell rule. Bodies, command
// expansions and file contents are never logged at info; diagnostics carry project-relative paths only.
import type {
  BackupCustomization,
  BackupCustomizations,
  Customization,
  CustomizationCreate,
  CustomizationEntry,
  CustomizationList,
  CustomizationProjectScan,
  CustomizationSourceQuery,
  CustomizationSourceResult,
  CustomizationsQuery,
  CustomizationUpdate,
  DefinitionDiagnostic,
  ParsedDefinition,
} from '@harness-forge/shared'

/** Options of `CustomizationService.catalog`. */
export interface CustomizationCatalogOptions {
  /** Rebuild the project part now instead of serving the cached catalog (`GET /customizations?refresh=1`). */
  readonly refresh?: boolean
  /** Aborts the wait for a build (the build itself goes on for the other waiters). */
  readonly signal?: AbortSignal
}

/**
 * One catalog snapshot (ADR-044): the merged entries of every source with their states, built at `builtAt`. A run takes
 * one snapshot in `prepareRun` (`PreparedRun.catalog`) and every consumer of the run (commands, the agent-types and
 * skills blocks, `task`, `skill`, background launches) reads the same one. Immutable; the getters never read a file.
 */
export interface CustomizationCatalog {
  /** The project of the snapshot; null = the global catalog (builtin, plugin and personal entries only). */
  readonly projectId: string | null
  /**
   * Every entry, every source and state (`active`, `shadowed`, `invalid`, `off`): kind (`CUSTOMIZATION_KINDS` order),
   * then name, then precedence (the active entry first). The `items` of `GET /customizations`.
   */
  readonly entries: readonly CustomizationEntry[]
  /** Folder-level diagnostics (`link`, `limit`, `read-failed`, `project-unavailable`), project-relative paths only. */
  readonly diagnostics: readonly DefinitionDiagnostic[]
  /** What was read from the project folder; null for the global catalog. */
  readonly project: CustomizationProjectScan | null
  /** When the snapshot was built (epoch ms). */
  readonly builtAt: number
  /** The active agents (`state: 'active'`), sorted by name; the builtins `explore` and `general` unless shadowed. */
  readonly agents: () => readonly CustomizationEntry[]
  /** The active commands, sorted by name. */
  readonly commands: () => readonly CustomizationEntry[]
  /** The active skills, sorted by name. */
  readonly skills: () => readonly CustomizationEntry[]
  /**
   * The active output styles (Phase 11, ADR-051: kind `style`), sorted by name; the builtins `default`, `explanatory`
   * and `learning` unless shadowed.
   */
  readonly styles: () => readonly CustomizationEntry[]
  /**
   * The active agent of that name, the aliases of `AGENT_TYPE_ALIASES` resolved (`general-purpose` → `general`); null
   * when there is none (a shadowed, invalid or turned-off entry is never returned).
   */
  readonly agent: (name: string) => CustomizationEntry | null
  /** The active command of that name (without the leading `/`), else null. */
  readonly command: (name: string) => CustomizationEntry | null
  /** The active skill of that name, else null. */
  readonly skill: (name: string) => CustomizationEntry | null
  /**
   * The active output style of that name (Phase 11, ADR-051), else null (an unknown, shadowed, invalid or turned-off
   * style: the run falls back to `default` with the notice `output-style-unavailable`).
   */
  readonly style: (name: string) => CustomizationEntry | null
}

/**
 * A catalog entry with its body: the definition read and parsed again by `load` (never cached between calls). The
 * `definition.kind` equals `entry.kind`.
 */
export interface LoadedDefinition {
  readonly entry: CustomizationEntry
  readonly definition: ParsedDefinition
  /** The warnings and infos of the re-parse (an `error` makes `load` throw instead). */
  readonly diagnostics: readonly DefinitionDiagnostic[]
}

/** What `restoreBackup` did with the items of a backup's `customizations.json`. */
export interface CustomizationRestoreResult {
  /** Personal definitions created. */
  readonly imported: number
  /** The kind and name already existed (the existing entry is kept). */
  readonly skipped: number
  /** Invalid content, a builtin or reserved name, or the per-kind limit (`LIMITS.customizationsPerKindMax`). */
  readonly failed: number
  /** One line per failed item (kind and name, never the content), each at most 300 characters. */
  readonly warnings: readonly string[]
}

/**
 * The catalog and the personal definitions. Errors are `HarnessError`s the routes pass through (API.md 2). Every change
 * of a personal definition emits `customization.changed` (`{ kind, id }`); a dropped project cache emits it with
 * `projectId`; plugin changes of agents, skills or commands emit it without fields. Frozen after P10-0b.
 */
export interface CustomizationService {
  /**
   * The catalog snapshot of a project (`projectId`) or the global one (null): served from the per-project cache (TTL
   * `LIMITS.customizationIndexTtlMs`, single-flight builds) unless `options.refresh`. The project root comes from
   * `deps.projects.openWorkspace(projectId)`: an unavailable folder, and an unknown project, give no project entries
   * and the folder diagnostic `project-unavailable`, so a run never fails on its catalog (`list` answers `not_found`
   * for an unknown project). Rejects only when `options.signal` aborts.
   */
  readonly catalog: (projectId: string | null, options?: CustomizationCatalogOptions) => Promise<CustomizationCatalog>
  /**
   * `GET /customizations` (query validated by the route with `customizationsQuerySchema`): the catalog as
   * `CustomizationList` (`items` filtered by `query.kind`). Throws `not_found` for an unknown project.
   */
  readonly list: (query: CustomizationsQuery) => Promise<CustomizationList>
  /**
   * `GET /customizations/source`: the markdown of a project, plugin or builtin entry (a project file read again through
   * the discovery guards; `query.path` picks a shadowed file of the same name; plugin and builtin definitions formatted
   * with `formatDefinition`). Throws `validation_error` for `source: 'user'` (use `get`) or a project source without a
   * usable project, `not_found` when the entry is gone.
   */
  readonly source: (query: CustomizationSourceQuery) => Promise<CustomizationSourceResult>
  /**
   * The body of a catalog entry, read and validated again (ADR-044): a project file through the same guards as the
   * discovery (≤ 64 KiB, re-parsed, its name must still match), a plugin definition from the registry, a personal one
   * from the table, a builtin from `core-agent`. Throws `not_found` when the definition is gone or its name changed, and
   * `validation_error` (the diagnostics in `details.diagnostics`) when it no longer parses without an `error`.
   */
  readonly load: (entry: CustomizationEntry, signal?: AbortSignal) => Promise<LoadedDefinition>
  /** `GET /customizations/:id`: a personal definition. Throws `not_found`. */
  readonly get: (id: string) => Promise<Customization>
  /**
   * `POST /customizations`: parses `body.content` with `parseDefinition` (`validation_error` with `details.diagnostics`
   * when it has an `error`, or for a builtin or reserved name), stores the raw markdown with the denormalized kind,
   * name, description and `enabled` (`cus_` id). Throws `conflict` `exists` when the kind and name are taken, `conflict`
   * when the kind already has `LIMITS.customizationsPerKindMax` rows.
   */
  readonly create: (body: CustomizationCreate) => Promise<Customization>
  /**
   * `PATCH /customizations/:id`: new `content` is parsed like a create and keeps the kind (a changed name must stay
   * unique: `conflict` `exists`); `enabled` turns the definition on or off. Throws `not_found`.
   */
  readonly update: (id: string, body: CustomizationUpdate) => Promise<Customization>
  /** `DELETE /customizations/:id`. Throws `not_found`. */
  readonly remove: (id: string) => Promise<void>
  /**
   * Every personal definition for a backup's `customizations.json` (kind, name, raw content, `enabled`; no ids, no
   * timestamps, no secrets), sorted by kind and name.
   */
  readonly exportBackup: () => Promise<BackupCustomizations>
  /**
   * Restores the items of a backup's `customizations.json` (`restoreCustomizations`): each item is parsed like a create;
   * an existing kind and name is kept (skipped); invalid items and items beyond the per-kind limit fail (warnings).
   * Never throws for an item.
   */
  readonly restoreBackup: (items: readonly BackupCustomization[]) => Promise<CustomizationRestoreResult>
  /**
   * Drops the cached catalog of a project (a build in flight is not kept); null drops every cached catalog (the global
   * one and every project's). Called by the service itself on `workspace.changed`, `project.changed`, `run.finished`,
   * registry changes of agents, skills and commands, and personal CRUD. Never throws.
   */
  readonly invalidate: (projectId: string | null) => void
  /**
   * Shutdown (`stopDeps`, right after the runs stopped): drops every cache, discards builds in flight and removes the
   * event and registry subscriptions. Idempotent; never throws.
   */
  readonly stop: () => void
}
