// Frozen interfaces of the plugin host (W1.3) and of the Phase 3 plugin services (PLUGINS.md 11-13,
// ARCHITECTURE.md 6.4 / 6.5, API.md 5.15-5.18). Implementations:
// - `PluginHost`      -> `createPluginHost(deps)` in `plugins/host.ts` (W1.3)
// - `PluginInstaller` -> `createPluginInstaller(deps)` in `plugins/install/index.ts` (W3.2)
// - `PluginDrafts`    -> `createPluginDrafts(deps)` in `plugins/drafts/index.ts` (W3.3)
// - `PluginFiles`     -> `createPluginFiles(deps)` in `plugins/scaffold/index.ts` (W3.4)
// Phase 3 agents use only these interfaces (never W1.3 internals); a missing capability is a CCR.
//
// Phase 12 (ADR-053 / ADR-054; C43, frozen after Gate P12-0b): the plugin format (`PluginRecord.format`, column
// `plugins.format`: `harness` = a `plugin.json` plugin, `claude` = a Claude Code plugin read in place by
// `plugins/claude/**`), where a GitHub or marketplace install came from (`StoredPluginOrigin`, column `plugins.origin`,
// with the marketplace entry overlay that never reaches a DTO), the format and Claude Code info of an inspection and the
// `inspectDirectory` options (`format`, `overlay`, `nameHint`, `versionHint`). W12.1 reads the Claude Code format behind
// them; W12.2 stages the new sources and stores the origin.
import type { DeclarativeProvider, Disposable, PluginManifest, PluginModule, ProviderDefinition } from '@harness-forge/plugin-sdk'
import type {
  BuildDiagnostic,
  BuildResult,
  BuiltinPluginId,
  ClaudeMarketplaceEntry,
  ClaudePluginInfo,
  DraftTestRequest,
  DraftTestResult,
  HarnessErrorInit,
  LogLevel,
  PluginBuildBody,
  PluginContributions,
  PluginDetail,
  PluginDraft,
  PluginErrorPhase,
  PluginFileContent,
  PluginFileEntry,
  PluginFileWrite,
  PluginFormat,
  PluginInspection,
  PluginInstallSource,
  PluginKind,
  PluginLogEntry,
  PluginManifestUpdate,
  PluginOrigin,
  PluginSettingsView,
  PluginSource,
  PluginState,
  PluginSummary,
  ScaffoldRequest,
} from '@harness-forge/shared'
import type { SensitiveOperationOptions } from '../types.ts'

// ---------- builtins ----------

/** A builtin plugin (`builtin-plugins/index.ts`): statically imported, trusted, loaded even in safe mode. */
export interface BuiltinPlugin {
  readonly id: BuiltinPluginId
  /** Exported by the builtin module (no `plugin.json` on disk); validated with `pluginManifestBaseSchema`. */
  readonly manifest: PluginManifest
  readonly module: PluginModule
}

// ---------- records ----------

/**
 * The marketplace entry a Claude Code plugin was installed from, as `mergeEntryOverlay` (`util/claude-plugins.ts`)
 * applies it to the plugin's own `plugin.json` (ADR-054): the entry `name`, `strict` (true merges, false makes the entry
 * the whole manifest), the entry `version` / `description` fallbacks and the inline `plugin.json` fields (`overlay`).
 * Kept in `plugins.origin` (never in the files, so they stay byte-identical, and never in a DTO); part of the whole-tree
 * trust hash (`O\0` + `canonicalJson(overlay)`).
 */
export type ClaudeEntryOverlay = Pick<ClaudeMarketplaceEntry, 'name' | 'strict' | 'version' | 'description' | 'overlay'>

/**
 * Where a `github` or `marketplace` install came from (Phase 12, ADR-054; column `plugins.origin`): the DTO
 * `PluginOrigin` plus, for a marketplace entry, the entry overlay (`ClaudeEntryOverlay`; the DTO drops it). Null for the
 * other sources.
 */
export type StoredPluginOrigin
  = | (Extract<PluginOrigin, { kind: 'marketplace' }> & { readonly overlay?: ClaudeEntryOverlay })
    | Extract<PluginOrigin, { kind: 'github' }>

/** A `plugins` row. */
export interface PluginRecord {
  id: string
  source: PluginSource
  /** npm spec, URL, linked absolute path, zip file name; Phase 12: `owner/repo@<sha12>[/path]` (github, marketplace). */
  sourceRef: string | null
  version: string
  /** User intent. */
  enabled: boolean
  /** Trust pin (sha256 hex, or `path:<sha256>` for `link`). */
  trustedHash: string | null
  /** Boot sentinel. */
  loadingSince: number | null
  lastError: HarnessErrorInit | null
  installedAt: number
  updatedAt: number
  /**
   * Phase 12 (ADR-053): `harness` (a `plugin.json` plugin; every row before v1.8 and every builtin) or `claude` (a Claude
   * Code plugin, read in place by `plugins/claude/**`). The host picks the reader by it.
   */
  format: PluginFormat
  /** Phase 12 (ADR-054): where a `github` or `marketplace` install came from; null for the other sources. */
  origin: StoredPluginOrigin | null
}

/** Creates or updates a `plugins` row (installs, updates, drafts, scaffolds). */
export interface PluginRecordInput {
  id: string
  source: Exclude<PluginSource, 'builtin'>
  sourceRef?: string | null
  version: string
  /** Default: keep the current value, else true. */
  enabled?: boolean
  /** `undefined`: keep the current pin; `null`: clear it. */
  trustedHash?: string | null
  /** Phase 12: `undefined` keeps the current format (a new row: `harness`). */
  format?: PluginFormat
  /** Phase 12: `undefined` keeps the current origin (a new row: null); `null` clears it. */
  origin?: StoredPluginOrigin | null
}

/** Result of validating a plugin directory that is not loaded (install staging, drafts). */
export interface PluginDirectoryInspection {
  /**
   * Parsed with `pluginManifestBaseSchema` (reserved ids are allowed here: see `reserved`). Phase 12: for a Claude Code
   * plugin, the synthesized manifest (id from `claudePluginId`, name, version, description, author, homepage, the
   * `settings` of its `userConfig`; no `contributes`).
   */
  manifest: PluginManifest
  kind: PluginKind
  /**
   * The trust hash of the files (PLUGINS.md 13 "Pinning"): the value `trust` / `trustedHash` pins. Phase 12: for a
   * Claude Code plugin, the whole-tree hash `hf-claude-plugin/v1` (every regular file with its mode, plus the overlay).
   */
  sha256: string
  /**
   * Code plugin or declares a stdio MCP server (plugin API 1.5.0: command hooks, `!` spans). Phase 12: a Claude Code
   * plugin with a command hook handler, a stdio MCP server or a `!` span.
   */
  requiresTrust: boolean
  /** `engines.harness` satisfies `PLUGIN_API_VERSION`. */
  compatible: boolean
  /** `isReservedPluginId(manifest.id)`. */
  reserved: boolean
  /** Declared in the manifest (code plugins may register more at runtime). */
  contributions: PluginContributions
  files: { count: number, bytes: number }
  /** Phase 12 (ADR-053): the format that was read. */
  format: PluginFormat
  /** Phase 12: the Claude Code plugin info (components, executables, hosts, `userConfig`, diagnostics); null for harness. */
  claude: ClaudePluginInfo | null
}

/** Options of `PluginHost.inspectDirectory` (Phase 12, ADR-053 / ADR-054). */
export interface InspectDirectoryOptions {
  /**
   * The format to read; omitted = `harness` (the folder's layout is detected by the caller with `detectPluginLayout`,
   * `plugins/claude/detect.ts`).
   */
  format?: PluginFormat
  /** A Claude Code plugin from a marketplace: the entry overlay applied to its `plugin.json` (and hashed with it). */
  overlay?: ClaudeEntryOverlay
  /**
   * A Claude Code plugin without a `plugin.json` name and without an overlay: the name its id is derived from (the
   * folder, repository or package name).
   */
  nameHint?: string
  /**
   * A Claude Code plugin without a version in `plugin.json` or the entry: the raw version (the 12-character commit or
   * archive sha256 of its origin); else `0.0.0`.
   */
  versionHint?: string
}

// ---------- runtime ----------

export interface GuardOptions {
  /** setup 10 s, dispose 5 s, hooks / policies / `toModelOutput` / `onChange` 3 s, tools 60 s default, build 60 s. */
  timeoutMs: number
  /** Reported in `plugin_error` details. */
  phase: PluginErrorPhase
  /** Aborts the call early (e.g. the run signal of a tool call); the guard signal also aborts on timeout. */
  signal?: AbortSignal
  /** Tool / hook / command name for the plugin log. */
  label?: string
}

/** A file icon of a plugin (`manifest.icon` is a relative `.svg` / `.png` path). */
export interface PluginIconContent {
  kind: 'file'
  contentType: 'image/svg+xml' | 'image/png'
  body: Uint8Array
  /** First 8 hex chars of the file sha256 (the `?v=` of icon URLs). */
  version: string
}

/** A `lobe:<slug>` manifest icon (`GET /plugins/:id/icon` redirects to `/api/icons/lobe/<slug>`). */
export interface PluginIconLobe {
  kind: 'lobe'
  slug: string
}

/** A plugin icon for `GET /plugins/:id/icon`. */
export type PluginIconFile = PluginIconContent | PluginIconLobe

/** A plugin entered a state (`PluginHost.onStateChange`). */
export interface PluginStateChange {
  id: string
  /** The new state; null when the plugin was removed (uninstall, forget). */
  state: PluginState | null
  /** The state before the change (a plugin starts in `loading`). */
  previous: PluginState
}

/** Output of compiling / checking a code plugin entry (`POST /plugins/:id/build`). */
export interface PluginCompileResult {
  /** No error diagnostics. */
  ok: boolean
  durationMs: number
  diagnostics: BuildDiagnostic[]
  /** The module the host imports: `data/cache/plugins/<id>/<sha256>.mjs` for `.ts`, the entry for `.mjs` / `.js`. */
  outputFile: string | null
}

// ---------- host ----------

/**
 * Plugin lifecycle, state and runtime services (PLUGINS.md 11). States are computed by the host; every transition
 * emits `plugin.changed` (+ `catalog.changed` / `provider.changed` when contributions change). A broken plugin never
 * throws out of `start()`: it ends in `error` / `incompatible` / `untrusted`.
 */
export interface PluginHost {
  // ----- lifecycle (composition root)

  /** Loads builtins (load order), then unless `HF_SAFE_MODE=1` `data/plugins/*` + linked folders sorted by id. */
  readonly start: () => Promise<void>
  /** Disposes every plugin (guarded, 5 s each) and aborts every `ctx.signal`. */
  readonly stop: () => Promise<void>

  // ----- queries

  /** Builtins first (load order), then by id. */
  readonly list: () => Promise<PluginSummary[]>
  /** `not_found` for an unknown id. */
  readonly get: (id: string) => Promise<PluginDetail>
  /** For `plugin.changed` payloads; `not_found`. */
  readonly summary: (id: string) => Promise<PluginSummary>
  /** The `plugins` row, or null. */
  readonly record: (id: string) => Promise<PluginRecord | null>
  /** Current state; null for an unknown id. */
  readonly state: (id: string) => PluginState | null
  /** State is `active` (tool / hook owner check of the chat pipeline). */
  readonly isActive: (id: string) => boolean
  /** Realpath of the plugin directory (`data/plugins/<id>` or the linked folder); null for builtins and unknown ids. */
  readonly directory: (id: string) => Promise<string | null>

  // ----- actions (plugins.ts routes)

  /** Sets `enabled = true` and loads; a load failure is reported in the DTO. `not_found`. */
  readonly enable: (id: string) => Promise<PluginDetail>
  /** Sets `enabled = false` and disposes. `not_found`. */
  readonly disable: (id: string) => Promise<PluginDetail>
  /** Dispose + load (cache-busted import). `conflict` (`disabled`), `not_found`. The route adds fresh auth for code. */
  readonly reload: (id: string) => Promise<PluginDetail>
  /**
   * Dispose, remove `data/plugins/<id>` (a `link` only forgets the link) and the row; unless `keepData` also purges
   * settings, KV, `plugin:<id>` secrets, the private data dir and the credentials / configs of its providers.
   * `forbidden` for builtins, `not_found`. Emits `plugin.changed` with `plugin: null`.
   */
  readonly uninstall: (id: string, options: { keepData: boolean }) => Promise<void>
  /**
   * Pins `trusted_hash` (a `link` pins its realpath) when `sha256` equals the current hash (else `conflict`, `stale`),
   * then reloads if enabled.
   */
  readonly trust: (id: string, sha256: string) => Promise<PluginDetail>
  /** Schema (null without settings), non-secret values with defaults, secret states. `not_found`. */
  readonly getSettings: (id: string) => Promise<PluginSettingsView>
  /**
   * Validates with `settingsValuesSchema(schema, { partial: true })` (no schema -> `validation_error`), stores secret
   * properties in `plugin:<id>` / `settings.<key>`, runs `ctx.settings.onChange` handlers (guarded).
   */
  readonly updateSettings: (id: string, values: Record<string, unknown>) => Promise<PluginSettingsView>
  /** Every settings value with defaults, secrets decrypted (MCP `{{settings.<key>}}` templates). `not_found`. */
  readonly settingsValues: (id: string) => Promise<Record<string, unknown>>
  /** Ring buffer entries with `seq > after`, oldest first, at most `limit` (default 200). `not_found`. */
  readonly logs: (id: string, query?: { after?: number, limit?: number }) => Promise<PluginLogEntry[]>
  /** The manifest icon (`not_found` without one). */
  readonly icon: (id: string) => Promise<PluginIconFile>

  // ----- runtime services (chat pipeline, MCP manager, builds)

  /**
   * Runs plugin code with a timeout. A throw or timeout becomes `plugin_error` (`details: { pluginId, phase }`) plus a
   * plugin log entry; on timeout the signal passed to `fn` aborts and the host stops waiting.
   */
  readonly guard: <T>(pluginId: string, fn: (signal: AbortSignal) => T | Promise<T>, options: GuardOptions) => Promise<T>
  /** Appends to the plugin's log ring buffer (500 entries, message <= 4 KB, redacted) and emits `plugin.log`. */
  readonly log: (pluginId: string, level: LogLevel, message: string, data?: unknown) => void

  // ----- Phase 3 hooks: install (W3.2), drafts (W3.3), scaffold / files / build (W3.4)

  /**
   * Validates a plugin directory without loading it (validation steps 1-6 of PLUGINS.md 11 except the directory name
   * and trust checks) and computes its trust hash. Throws `validation_error` (with issues) for a missing or invalid
   * `plugin.json`, an entry or icon outside the directory, a wrong extension. Phase 12: `options.format: 'claude'` reads
   * a Claude Code plugin (`readClaudePluginDirectory`, W12.1) with the entry `overlay` and the `nameHint` /
   * `versionHint` fallbacks; it throws `validation_error` for an unusable `plugin.json`, a path outside the folder, a
   * link or a special file.
   */
  readonly inspectDirectory: (dir: string, options?: InspectDirectoryOptions) => Promise<PluginDirectoryInspection>
  /** Upserts the `plugins` row; does not load (call `load`). */
  readonly saveRecord: (input: PluginRecordInput) => Promise<PluginRecord>
  /**
   * (Re)loads a plugin from its directory according to its row (`enabled`, pin) and returns the resulting detail; a
   * failure is reported as state `error` / `untrusted` / `incompatible`, not thrown. Emits `plugin.changed`.
   */
  readonly load: (id: string) => Promise<PluginDetail>
  /** Disposes a loaded plugin without changing `enabled` (before an atomic directory swap). No-op when not loaded. */
  readonly unload: (id: string) => Promise<void>
  /** Removes the row and the runtime state without touching files (rollback of a failed fresh install). */
  readonly forget: (id: string) => Promise<void>
  /**
   * Compiles a `.ts` entry with esbuild into `data/cache/plugins/<id>/<sha256>.mjs` (SDK aliased to the host shim) or
   * syntax-checks a `.mjs` / `.js` entry; build output goes to the plugin log. `not_found`, `forbidden` for builtins and
   * declarative plugins.
   */
  readonly compile: (id: string) => Promise<PluginCompileResult>
  /** Runs `fn` (file writes through the editor API) without triggering the hot-reload watcher for this plugin. */
  readonly withoutWatch: <T>(id: string, fn: () => Promise<T>) => Promise<T>
  /** The declarative adapter: a `ProviderDefinition` for a `DeclarativeProvider` (draft test), not registered. */
  readonly declarativeProvider: (pluginId: string, provider: DeclarativeProvider) => ProviderDefinition

  // ----- W4.6 additions (optional so fakes of this interface keep compiling; `createPluginHost` implements both)

  /**
   * Re-reads the row and the files of a loaded plugin without (re)loading it, so its DTO shows the current trust hash,
   * pin and manifest (after an editor write re-pinned it). The running code, the state and the hot-reload fingerprint
   * are unchanged. Emits `plugin.changed` when the detail changed. `not_found`.
   */
  readonly refresh?: (id: string) => Promise<PluginDetail>
  /**
   * Calls `listener` synchronously on every state transition (when `plugin.changed` is emitted) and when a plugin is
   * removed (`state: null`). In-process: no event-bus subscription. A throwing listener is logged and ignored.
   */
  readonly onStateChange?: (listener: (change: PluginStateChange) => void) => Disposable
}

// ---------- Phase 3 services ----------

/** A source to inspect or install: a multipart zip upload or a JSON `PluginInstallSource`. */
export type PluginInstallInput
  = | { source: 'zip', fileName: string, data: Uint8Array }
    | PluginInstallSource

export interface PluginInstallOptions {
  /** Pin the sha256 in the same step. */
  trust?: boolean
  /** Default true. */
  enable?: boolean
  /** The hash the user reviewed in the inspect preview; a different staged hash fails with `conflict` (`stale`). */
  sha256?: string
  /**
   * Called after the staged package is validated and before anything is committed, with the inspection; throws to
   * abort (the staging directory is removed). The route requires fresh auth here when `requiresTrust` (ADR-017).
   */
  authorize: (inspection: PluginInspection) => void
}

/** Install from zip / npm / URL / folder through `plugins/.staging` + atomic swap (PLUGINS.md 12). */
export interface PluginInstaller {
  /**
   * Boot (before `PluginHost.start`): moves an interrupted swap's `<id>.prev-<uuid>` back when `plugins/<id>` is
   * missing and deletes every other staging entry.
   */
  readonly recover: () => Promise<void>
  /** Fetch / extract into staging with every guard, validate, report, delete the staging copy. */
  readonly inspect: (input: PluginInstallInput) => Promise<PluginInspection>
  /** Same source again, validated again, committed atomically; rollback to the previous version on a failed load. */
  readonly install: (input: PluginInstallInput, options: PluginInstallOptions) => Promise<PluginDetail>
  /** Zip of the plugin directory without build output, `node_modules`, `.git`. `forbidden` for builtins. */
  readonly export: (id: string) => Promise<{ fileName: string, data: Uint8Array }>
}

/** Declarative plugins created in the browser (API.md 5.17). */
export interface PluginDrafts {
  /**
   * Creates `data/plugins/<id>/plugin.json` (+ icon) through staging, `source: 'created'`, saves `credentials` as
   * provider credentials and loads it. A manifest that requires trust (`manifestRequiresTrust`: a stdio MCP server,
   * command hooks, `!` spans) calls `requireFreshAuth` and is pinned.
   * `forbidden` (reserved id), `conflict` (`exists`), `validation_error`.
   */
  readonly create: (draft: PluginDraft, options: SensitiveOperationOptions) => Promise<PluginDetail>
  /** Temporary provider from the draft (nothing stored), 15 s; failures are `ok: false`. */
  readonly test: (request: DraftTestRequest) => Promise<DraftTestResult>
  /**
   * Replaces `plugin.json` of an editable declarative plugin and reloads it; a manifest that requires trust
   * (`manifestRequiresTrust`) calls `requireFreshAuth` on every save and re-pins. `not_found`, `forbidden`,
   * `validation_error` (id changed).
   */
  readonly updateManifest: (id: string, update: PluginManifestUpdate, options: SensitiveOperationOptions) => Promise<PluginDetail>
}

/** Code plugins from templates and the traversal-safe file API (API.md 5.18). Paths are validated `PluginFileParams`. */
export interface PluginFiles {
  /** Template -> `data/plugins/<id>/`, `source: 'created'`, trusted, enabled, loaded. The route requires fresh auth. */
  readonly scaffold: (request: ScaffoldRequest) => Promise<PluginDetail>
  /** Recursive tree, directories first, sorted; skips `node_modules` and `.git`; <= 2000 entries. */
  readonly list: (id: string) => Promise<PluginFileEntry[]>
  readonly read: (id: string, path: string) => Promise<PluginFileContent>
  /**
   * Writes a text file (parents created) of an editable plugin; calls `requireFreshAuth` for code plugins; a `created`
   * plugin is re-pinned automatically. `conflict` (`stale` etag).
   */
  readonly write: (id: string, path: string, write: PluginFileWrite, options: SensitiveOperationOptions) => Promise<PluginFileEntry>
  /** Deletes a file (not `plugin.json` or the entry); same fresh-auth and re-pin rules as `write`. */
  readonly remove: (id: string, path: string, options: SensitiveOperationOptions) => Promise<void>
  /** Compile via the host, re-pin on success, reload when `reload !== false`. The route requires fresh auth. */
  readonly build: (id: string, body: PluginBuildBody) => Promise<BuildResult>
}
