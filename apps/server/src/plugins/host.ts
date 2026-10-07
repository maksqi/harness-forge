// Plugin host (PLUGINS.md 11-13, ARCHITECTURE.md 6.4). Owner: W1.3 (W1.3-T1..T4, T7, T8).
//
// Discovery and load order: builtins (`deps.builtins`, static imports, trusted, loaded even in safe mode), then unless
// `HF_SAFE_MODE=1` every directory of `data/plugins/*` (not starting with `.`) plus linked folders (`plugins` rows with
// `source = 'link'`), sorted by id, each loaded independently and guarded. Loading a user plugin validates it
// (loader.ts steps 1-5), checks the trust pin (step 6), registers its manifest contributions through its own `ctx`,
// compiles / scans code entries (compile.ts), imports them cache-busted and runs the guarded `setup` (10 s for module
// evaluation + setup). Every state transition emits `plugin.changed` and then calls the in-process `onStateChange`
// listeners (the MCP manager follows `core-mcp` this way); loads and unloads that change providers or models also emit
// `provider.changed` / `catalog.changed`. `refresh` re-reads a plugin's row and files for its DTO without loading it
// (after the editor re-pinned its trust hash).
//
// Plugin API 1.5.0 (ADR-048, ADR-052; W11.7): a declarative manifest with command hooks (`contributes.hooks`) or a
// `` !`cmd` `` span in a command template requires trust like one with a stdio MCP server (`manifestRequiresTrust`;
// `runsCode` follows it). Its contributions, the command hooks (`registry.hookCommands`, through the runtime) and
// output styles (`registry.styles`) included, are registered only by a load, so they exist only while the plugin is
// active and trusted; disable, reload, uninstall and safe mode remove them. The pin still covers `plugin.json` only:
// a script that a hook calls is not pinned.
//
// Plugin API 1.6.0 (ADR-053; W12.1-T6): a plugin row has a format. `claude` plugins (Claude Code's own layout, read in
// place by `plugins/claude/reader.ts` through `formats.ts`) get a synthesized manifest (no `contributes`), the
// whole-tree trust hash (`hf-claude-plugin/v1`, the marketplace overlay of their origin included) and their
// contributions registered by `registerClaudeContributions` instead of the declarative adapter; `runsCode` and the
// trust requirement come from the read (a command hook, a stdio MCP server or a `!` span), they are never `editable`,
// saving their settings reloads them (the variables are substituted again), and a folder placed by hand is detected by
// its layout (`detectFolderFormat`). The detail carries the origin (without the entry overlay) and the Claude Code info.
//
// Robustness: operations on one plugin are serialized; a failing plugin ends in `error` / `incompatible` /
// `untrusted` and never breaks `start()` or other plugins; the boot sentinel (`plugins.loading_since`) skips a plugin
// that crashed the process while loading; disposal runs `dispose()` (5 s), unregisters every contribution and aborts
// `ctx.signal` (in-flight tool calls then fail with "Tool unavailable").
import type { PluginManifest, SettingsProperty, SettingsSchema } from '@harness-forge/plugin-sdk'
import type {
  HarnessErrorInit,
  IconRef,
  LogLevel,
  PluginContributions,
  PluginDetail,
  PluginFormat,
  PluginOrigin,
  PluginSettingsView,
  PluginState,
  PluginSummary,
  PluginTrust,
  SecretState,
} from '@harness-forge/shared'
import type { AppDeps } from '../types.ts'
import type { ClaudePluginRead } from './claude/types.ts'
import type { PluginRuntime } from './context.ts'
import type { FormatRead } from './formats.ts'
import type { GuardServices } from './guard.ts'
import type { PluginDirectoryRead } from './loader.ts'
import type {
  BuiltinPlugin,
  GuardOptions,
  PluginCompileResult,
  PluginHost,
  PluginIconFile,
  PluginRecord,
  PluginStateChange,
} from './types.ts'
import type { WatchFunction } from './watch.ts'
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { settingsValuesSchema } from '@harness-forge/plugin-sdk'
import {
  HarnessError,
  isBuiltinProviderId,
  isPluginNamespacedId,
  manifestRequiresTrust,
  MOCK_PROVIDER_ID,
  PLUGIN_ID_PATTERN,
  settingsPropertyValueSchema,
  validationError,
} from '@harness-forge/shared'
import { appVersion, serverPackageRoot } from '../paths.ts'
import { comparePluginIds, isBuiltinPluginId } from '../registry/order.ts'
import { registerClaudeContributions } from './claude/register.ts'
import { clearTreeHashCache } from './claude/tree-hash.ts'
import { compileEntry } from './compile.ts'
import { createPluginRuntime } from './context.ts'
import { createDeclarativeProvider, registerDeclaredContributions } from './declarative.ts'
import { claudeContributions, detectFolderFormat, inspectDirectoryFor, readPluginDirectoryFor } from './formats.ts'
import { asPluginError, createPluginLogStore, GUARD_TIMEOUTS, guardCall, pluginError, thrownMessage } from './guard.ts'
import {
  declaredContributions,
  ICON_CONTENT_TYPES,
  ICON_MAX_BYTES,
  importEntry,
  isInside,
  manifestKind,
  pathPin,
  pluginModuleOf,
  resolveInside,
  sha256Hex,
  synthesizeManifest,
} from './loader.ts'
import {
  createPluginRecordStore,
  createPluginStorage,
  deleteProviderRows,
  deleteSettingsValues,
  deleteStorage,
  isAllowedTransition,
  readSettingsValues,
  storedProviderIds,
  writeSettingsValues,
} from './state.ts'
import { createPluginWatcher } from './watch.ts'

/** The plugin module shape the host calls (validated by `pluginModuleOf`). */
interface LoadedModule {
  setup: (ctx: unknown) => unknown
  dispose?: () => unknown
}

interface PluginEntry {
  readonly id: string
  readonly builtin: BuiltinPlugin | null
  record: PluginRecord | null
  /** Realpath of the plugin directory (user plugins; null when missing). */
  dir: string | null
  /** Last validation of the directory (user plugins). */
  read: PluginDirectoryRead | null
  /** Phase 12: the format of the last read (`harness` for builtins). */
  format: PluginFormat
  /** Phase 12: the Claude Code part of the last read (`claude` plugins), else null. */
  claude: ClaudePluginRead | null
  /** Manifest of the DTOs: the builtin manifest, the plugin's valid manifest, or a synthesized one. */
  manifest: PluginManifest
  /** `manifest` is the plugin's own valid manifest (always true for builtins). */
  valid: boolean
  state: PluginState
  lastError: HarnessErrorInit | null
  runtime: PluginRuntime | null
  module: LoadedModule | null
  /** Set while the plugin is being disposed: its tools and hooks are no longer called. */
  stopping: boolean
  /** `loading` was already announced (`plugin.changed`) for the current load. */
  announcedLoading: boolean
  /** Content fingerprint of the files (hot reload change detection). */
  fingerprint: string | null
  /** Files of the loaded code (unhandled rejection attribution). */
  codeFiles: string[]
}

interface LoadOptions {
  /** Keep a running previous version when the new code fails to build (reload, hot reload). */
  keepPreviousOnBuildError?: boolean
  /** Boot: honor the sentinel of a load that crashed the previous process. */
  boot?: boolean
}

interface ContributionSnapshot {
  providers: string[]
  models: number
}

const SETTINGS_SECRET_PREFIX = 'settings.'

function isSecretProperty(property: SettingsProperty): boolean {
  return property.type === 'string' && property.format === 'secret'
}

function notFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Unknown plugin "${id}".` })
}

function forbidden(message: string): HarnessError {
  return new HarnessError({ code: 'forbidden', message })
}

/** A snapshot error (plain JSON) of anything thrown during a load. */
function errorInit(pluginId: string, phase: 'load' | 'setup' | 'build', error: unknown): HarnessErrorInit {
  return asPluginError(pluginId, phase, error).toJSON().error
}

function crashedError(pluginId: string): HarnessErrorInit {
  return {
    code: 'plugin_error',
    message: 'The server stopped while this plugin was loading (crashed during load). Enable or reload it to try again.',
    details: { pluginId, phase: 'load' },
  }
}

function fingerprintOf(read: PluginDirectoryRead): string {
  return `${read.hash ?? '-'}:${read.iconVersion ?? '-'}`
}

/** Test seams of the host (production uses the defaults). */
export interface PluginHostOptions {
  /** Replaces `fs.watch` for hot reload (tests drive a fake watcher). */
  readonly watch?: WatchFunction
  /** Hot-reload debounce (default `WATCH_DEBOUNCE_MS`). */
  readonly watchDebounceMs?: number
}

export function createPluginHost(deps: AppDeps, options: PluginHostOptions = {}): PluginHost {
  const entries = new Map<string, PluginEntry>()
  const locks = new Map<string, Promise<unknown>>()
  /** Provider ids each plugin registered during this process (uninstall purges their stored configuration). */
  const knownProviders = new Map<string, Set<string>>()
  /** `onStateChange` listeners (in-process; the event bus is for clients). */
  const stateListeners = new Set<(change: PluginStateChange) => void>()
  let started = false
  let stopped = false
  let userAgentVersion: string | undefined
  let registrySubscription: { dispose: () => void } | undefined

  const records = createPluginRecordStore(deps.db)
  const logStore = createPluginLogStore({
    logger: deps.logger,
    redactor: deps.redactor,
    publish: (pluginId, entry) => deps.events.emit('plugin.log', { pluginId, entry }),
  })
  const watcher = createPluginWatcher({
    logger: deps.logger,
    onChange: pluginId => void onWatchedChange(pluginId),
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    ...(options.watchDebounceMs === undefined ? {} : { debounceMs: options.watchDebounceMs }),
  })

  const guardServices: GuardServices = {
    log: (pluginId, level, message, data) => logStore.append(pluginId, level, message, data),
    redactText: text => deps.redactor.redactText(text),
    lifecycleSignal: pluginId => entries.get(pluginId)?.runtime?.signal,
    isInactive: (pluginId) => {
      const entry = entries.get(pluginId)
      return entry !== undefined && (entry.state !== 'active' || entry.stopping)
    },
  }

  function guard<T>(pluginId: string, fn: (signal: AbortSignal) => T | Promise<T>, options: GuardOptions): Promise<T> {
    return guardCall(guardServices, pluginId, fn, options)
  }

  function log(pluginId: string, level: LogLevel, message: string, data?: unknown): void {
    logStore.append(pluginId, level, message, data)
  }

  // ---------- locking ----------

  /** Runs `fn` after every earlier operation on the same plugin settled. */
  function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve()
    const run = previous.then(fn)
    const tail = run.then(() => undefined, () => undefined)
    locks.set(id, tail)
    void tail.then(() => {
      if (locks.get(id) === tail)
        locks.delete(id)
    })
    return run
  }

  // ---------- DTOs ----------

  function iconRefOf(entry: PluginEntry): IconRef {
    const icon = entry.valid ? entry.manifest.icon : undefined
    if (icon === undefined)
      return null
    if (icon.startsWith('lobe:')) {
      try {
        return deps.icons.lobeRef(icon)
      }
      catch {
        let version = '0'
        try {
          version = deps.icons.version
        }
        catch {}
        return { mono: `/api/icons/lobe/${encodeURIComponent(icon.slice('lobe:'.length))}?v=${encodeURIComponent(version)}` }
      }
    }
    const version = entry.read?.iconVersion
    return version ? { color: `/api/plugins/${entry.id}/icon?v=${version}` } : null
  }

  function kindOf(entry: PluginEntry): 'declarative' | 'code' {
    if (entry.valid)
      return manifestKind(entry.manifest)
    return entry.read?.lenient.main !== undefined ? 'code' : 'declarative'
  }

  function contributionsOf(entry: PluginEntry): PluginContributions {
    if (entry.runtime !== null)
      return deps.registry.contributions(entry.id)
    if (entry.claude !== null)
      return claudeContributions(entry.claude)
    return declaredContributions(entry.valid && entry.builtin === null ? entry.manifest : null)
  }

  /** The DTO origin of a row (the stored marketplace entry overlay left out). */
  function originOf(record: PluginRecord | null): PluginOrigin | null {
    const origin = record?.origin ?? null
    if (origin === null)
      return null
    if (origin.kind === 'marketplace') {
      const { overlay: _overlay, ...rest } = origin
      return rest
    }
    return origin
  }

  function isPinned(record: PluginRecord | null, read: PluginDirectoryRead | null): boolean {
    const pin = record?.trustedHash ?? null
    if (pin === null || read === null)
      return false
    if (read.hash !== null && pin === read.hash)
      return true
    return record?.source === 'link' && read.dir !== null && pin === pathPin(read.dir)
  }

  function trustOf(entry: PluginEntry): PluginTrust {
    if (entry.builtin)
      return { required: false, trusted: true, hash: null, trustedHash: null }
    const required = entry.valid ? entry.read?.requiresTrust === true : kindOf(entry) === 'code'
    return {
      required,
      trusted: !required || isPinned(entry.record, entry.read),
      hash: entry.read?.hash ?? null,
      trustedHash: entry.record?.trustedHash ?? null,
    }
  }

  function summaryOf(entry: PluginEntry): PluginSummary {
    const builtin = entry.builtin !== null
    const kind = kindOf(entry)
    const now = Date.now()
    return {
      id: entry.id,
      name: entry.manifest.name,
      version: entry.manifest.version,
      description: entry.manifest.description ?? null,
      icon: iconRefOf(entry),
      kind,
      format: entry.format,
      source: entry.record?.source ?? (builtin ? 'builtin' : 'copy'),
      sourceRef: entry.record?.sourceRef ?? null,
      builtin,
      removable: !builtin,
      enabled: entry.record?.enabled ?? true,
      state: entry.state,
      // A declarative plugin runs commands exactly when it requires trust: a stdio MCP server or (plugin API 1.5.0)
      // command hooks or `!` spans in a command template; a Claude Code plugin (1.6.0) when its read requires trust.
      runsCode: !builtin && (kind === 'code' || (entry.valid && (entry.claude !== null ? entry.claude.requiresTrust : manifestRequiresTrust(entry.manifest)))),
      contributions: contributionsOf(entry),
      lastError: entry.lastError,
      installedAt: entry.record?.installedAt ?? now,
      updatedAt: entry.record?.updatedAt ?? now,
    }
  }

  function detailOf(entry: PluginEntry): PluginDetail {
    const summary = summaryOf(entry)
    return {
      ...summary,
      manifest: entry.manifest,
      trust: trustOf(entry),
      // Phase 12: Claude Code plugins are not edited in the plugin editor (v1.8).
      editable: !summary.builtin && entry.format !== 'claude' && (summary.source === 'created' || summary.source === 'copy' || summary.source === 'link'),
      hasSettings: entry.valid && entry.manifest.settings !== undefined,
      origin: originOf(entry.record),
      claude: entry.claude?.info ?? null,
    }
  }

  function emitChanged(entry: PluginEntry): void {
    try {
      deps.events.emit('plugin.changed', { id: entry.id, plugin: summaryOf(entry) })
    }
    catch (error) {
      deps.logger.warn('plugin.changed emit failed', { pluginId: entry.id, err: error })
    }
  }

  /** Calls the `onStateChange` listeners; a throwing listener is logged and never breaks the host. */
  function notifyState(id: string, state: PluginState | null, previous: PluginState): void {
    for (const listener of [...stateListeners]) {
      try {
        listener({ id, state, previous })
      }
      catch (error) {
        deps.logger.warn('plugin state listener failed', { pluginId: id, err: error })
      }
    }
  }

  function setState(entry: PluginEntry, state: PluginState, lastError: HarnessErrorInit | null): void {
    const previous = entry.state
    if (!isAllowedTransition(previous, state))
      deps.logger.debug('unexpected plugin state transition', { pluginId: entry.id, from: previous, to: state })
    entry.state = state
    entry.lastError = lastError
    entry.announcedLoading = state === 'loading'
    emitChanged(entry)
    notifyState(entry.id, state, previous)
  }

  /** Enters `loading` once per load (a single `plugin.changed`). */
  function enterLoading(entry: PluginEntry): void {
    if (entry.state !== 'loading' || !entry.announcedLoading)
      setState(entry, 'loading', null)
  }

  function requireEntry(id: string): PluginEntry {
    const entry = entries.get(id)
    if (!entry)
      throw notFound(id)
    return entry
  }

  // ---------- contribution events ----------

  function snapshot(id: string): ContributionSnapshot {
    const contributions = deps.registry.contributions(id)
    return { providers: contributions.providers, models: contributions.models }
  }

  async function emitProviderChanged(providerId: string, registered: boolean): Promise<void> {
    try {
      const provider = registered ? await deps.providers.get(providerId) : null
      deps.events.emit('provider.changed', { id: providerId, provider })
    }
    catch {
      // The provider service is not available (or the provider vanished again): nothing to announce.
    }
  }

  function emitContributionEvents(before: ContributionSnapshot, after: ContributionSnapshot): void {
    const affected = [...new Set([...before.providers, ...after.providers])]
    if (affected.length === 0 && before.models === 0 && after.models === 0)
      return
    const registered = new Set(after.providers)
    for (const providerId of affected)
      void emitProviderChanged(providerId, registered.has(providerId))
    try {
      deps.events.emit('catalog.changed', { providerId: affected.length === 1 ? affected[0] ?? null : null })
    }
    catch {}
  }

  async function trackContributions<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const before = snapshot(id)
    try {
      return await fn()
    }
    finally {
      emitContributionEvents(before, snapshot(id))
    }
  }

  // ---------- settings ----------

  function settingsSchemaOf(entry: PluginEntry): SettingsSchema | undefined {
    return entry.valid ? entry.manifest.settings : undefined
  }

  interface SettingsState {
    /** Non-secret values: stored (when still valid) over defaults. */
    values: Record<string, unknown>
    secretStates: Record<string, SecretState>
    /** Decrypted secret values (only with `decrypt`). */
    secretValues: Record<string, string>
  }

  async function readSettingsState(id: string, schema: SettingsSchema | undefined, decrypt: boolean): Promise<SettingsState> {
    const state: SettingsState = { values: {}, secretStates: {}, secretValues: {} }
    if (!schema)
      return state
    const stored = await readSettingsValues(deps.db, id)
    const secretKeys: string[] = []
    for (const [key, property] of Object.entries(schema.properties)) {
      if (isSecretProperty(property)) {
        secretKeys.push(key)
        continue
      }
      const value = stored[key]
      if (value !== undefined && settingsPropertyValueSchema(property).safeParse(value).success)
        state.values[key] = value
      else if (property.default !== undefined)
        state.values[key] = structuredClone(property.default)
    }
    if (secretKeys.length === 0)
      return state
    const scope = `plugin:${id}` as const
    let hints = new Map<string, string | null>()
    try {
      hints = new Map((await deps.secrets.list(scope)).map(entry => [entry.name, entry.hint]))
    }
    catch (error) {
      deps.logger.warn('plugin secret settings are unavailable', { pluginId: id, err: error })
    }
    for (const key of secretKeys) {
      const name = `${SETTINGS_SECRET_PREFIX}${key}`
      const set = hints.has(name)
      state.secretStates[key] = { set, hint: set ? hints.get(name) ?? null : null, source: set ? 'stored' : null }
      if (!set || !decrypt)
        continue
      try {
        const value = await deps.secrets.get(scope, name)
        if (value !== null) {
          deps.redactor.addSecret(value)
          state.secretValues[key] = value
        }
      }
      catch (error) {
        deps.logger.warn('a plugin secret setting cannot be read', { pluginId: id, key, err: error })
      }
    }
    return state
  }

  async function fullSettings(id: string, schema: SettingsSchema | undefined): Promise<Record<string, unknown>> {
    const state = await readSettingsState(id, schema, true)
    return { ...state.values, ...state.secretValues }
  }

  // ---------- runtime ----------

  function builtinDir(id: string): string {
    try {
      return join(serverPackageRoot(), 'src', 'builtin-plugins', id)
    }
    catch {
      return join(process.cwd(), 'builtin-plugins', id)
    }
  }

  function userAgent(id: string): string {
    if (userAgentVersion === undefined) {
      try {
        userAgentVersion = appVersion()
      }
      catch {
        userAgentVersion = '0.0.0'
      }
    }
    return `harness-forge/${userAgentVersion} plugin/${id}`
  }

  /** Disposes the loaded instance: `dispose()` (5 s) -> unregister everything -> abort `ctx.signal`. */
  async function teardown(entry: PluginEntry, callDispose: boolean): Promise<void> {
    const runtime = entry.runtime
    const module = entry.module
    if (runtime === null)
      return
    entry.stopping = true
    try {
      if (callDispose && module?.dispose) {
        const dispose = module.dispose
        await guard(entry.id, () => dispose.call(module), { timeoutMs: GUARD_TIMEOUTS.dispose, phase: 'dispose' }).catch(() => {})
      }
      runtime.disposeContributions()
      const registry = deps.registry as { removeOwner?: (pluginId: string) => number }
      registry.removeOwner?.(entry.id)
      runtime.abort(new Error(`The plugin "${entry.id}" was unloaded.`))
    }
    finally {
      entry.runtime = null
      entry.module = null
      entry.codeFiles = []
      entry.stopping = false
    }
  }

  /** Creates the context, registers manifest contributions, imports the entry and runs `setup`. Throws on failure. */
  async function startRuntime(entry: PluginEntry, manifest: PluginManifest, dir: string, outputFile: string | null, version: string): Promise<void> {
    const id = entry.id
    const dataDir = join(deps.env.paths.pluginData, id)
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    await chmod(dataDir, 0o700).catch(() => {})
    const runtime = createPluginRuntime({
      manifest,
      dir,
      dataDir,
      settings: await fullSettings(id, manifest.settings),
      services: {
        registry: deps.registry,
        secrets: deps.secrets,
        storage: createPluginStorage(deps.db, id),
        redactor: deps.redactor,
        log: (level, message, data) => log(id, level, message, data),
        resolveModel: async (ref, signal) => (await deps.providers.resolveModel(ref, { signal })).model,
        generateImages: input => deps.images.generate(input),
        userAgent: userAgent(id),
      },
    })
    entry.runtime = runtime
    try {
      // Plugin API 1.5.0: the command hooks of the manifest go through the runtime (no `ctx` API), owned like the rest.
      // Plugin API 1.6.0: a Claude Code plugin registers what its reader found instead (no `contributes`).
      const claude = entry.format === 'claude' ? entry.claude : null
      if (claude !== null)
        await guard(id, () => registerClaudeContributions(runtime.ctx, claude, runtime), { timeoutMs: GUARD_TIMEOUTS.setup, phase: 'load', label: 'contributions' })
      else
        await guard(id, () => registerDeclaredContributions(runtime.ctx, manifest, runtime), { timeoutMs: GUARD_TIMEOUTS.setup, phase: 'load', label: 'contributions' })
      let module: LoadedModule | null = entry.builtin ? entry.builtin.module as LoadedModule : null
      const deadline = Date.now() + GUARD_TIMEOUTS.setup
      if (!module && outputFile !== null) {
        entry.codeFiles = [outputFile, ...(entry.read?.entryPath ? [entry.read.entryPath] : [])]
        const namespace = await guard(id, () => importEntry(outputFile, version), { timeoutMs: GUARD_TIMEOUTS.setup, phase: 'load', label: 'import' })
        module = await guard(id, () => {
          const exported = pluginModuleOf(namespace)
          if ('problem' in exported)
            throw new Error(exported.problem)
          return exported.module
        }, { timeoutMs: GUARD_TIMEOUTS.setup, phase: 'load', label: 'module' })
      }
      if (module) {
        entry.module = module
        const setup = module.setup
        const target = module
        await guard(id, () => setup.call(target, runtime.ctx), { timeoutMs: Math.max(1, deadline - Date.now()), phase: 'setup' })
      }
    }
    catch (error) {
      await teardown(entry, true)
      throw error
    }
  }

  /** `loading` -> guarded start -> `active` or `error`, with the boot sentinel around user plugin loads. */
  async function activate(entry: PluginEntry, manifest: PluginManifest, dir: string, outputFile: string | null, version: string): Promise<void> {
    enterLoading(entry)
    const sentinel = entry.builtin === null
    if (sentinel)
      await records.update(entry.id, { loadingSince: Date.now() }).catch(() => null)
    const started = performance.now()
    let failure: HarnessErrorInit | null = null
    try {
      await startRuntime(entry, manifest, dir, outputFile, version)
    }
    catch (error) {
      failure = errorInit(entry.id, 'setup', error)
    }
    if (sentinel) {
      const record = await records.update(entry.id, { loadingSince: null, lastError: failure }).catch(() => null)
      if (record)
        entry.record = record
    }
    if (failure) {
      setState(entry, 'error', failure)
      return
    }
    if (stopped) {
      // The host stopped while this plugin was loading (shutdown): do not leave a live instance behind.
      await teardown(entry, true)
      return
    }
    log(entry.id, 'info', `Loaded in ${Math.round(performance.now() - started)} ms.`)
    setState(entry, 'active', null)
  }

  async function persistLastError(entry: PluginEntry, lastError: HarnessErrorInit | null): Promise<void> {
    if (entry.builtin !== null || entry.record === null)
      return
    const record = await records.update(entry.id, { lastError }).catch(() => null)
    if (record)
      entry.record = record
  }

  function applyRead(entry: PluginEntry, formatRead: FormatRead): void {
    const read = formatRead.directory
    entry.format = formatRead.format
    entry.claude = formatRead.claude
    entry.read = read
    entry.dir = read.dir
    entry.fingerprint = fingerprintOf(read)
    if (read.manifest) {
      entry.manifest = read.manifest
      entry.valid = true
    }
    else {
      entry.manifest = synthesizeManifest(entry.id, read.lenient)
      entry.valid = false
    }
  }

  /** A copy of `init` whose message went through the redactor (load problems may quote file contents). */
  function redactedInit(init: HarnessErrorInit): HarnessErrorInit {
    return { ...init, message: deps.redactor.redactText(init.message) }
  }

  function pluginDirOf(id: string, record: PluginRecord | null): string {
    if (record?.source === 'link' && record.sourceRef)
      return record.sourceRef
    return join(deps.env.paths.plugins, id)
  }

  /**
   * The raw version a Claude Code plugin without one reads as, the same hint the installer read it with: the 12-character
   * commit or archive sha of its origin, the npm version of a marketplace entry's package (`origin.npmVersion`), and
   * for an npm install the version the row stores (the package version it was installed as). So the version stays the
   * same across reloads and restarts (W12.18-T2); other sources have no hint (`0.0.0`).
   */
  function versionHintOf(record: PluginRecord | null): string | undefined {
    if (record === null)
      return undefined
    const origin = record.origin
    if (origin?.kind === 'github')
      return origin.commit.slice(0, 12)
    if (origin?.kind === 'marketplace')
      return origin.commit?.slice(0, 12) ?? origin.archiveSha256?.slice(0, 12) ?? origin.npmVersion
    return record.source === 'npm' ? record.version : undefined
  }

  /**
   * Reads a user plugin's folder with the reader of its format: the row's format, else (a folder placed by hand) the
   * detected layout, else `harness`. A Claude Code plugin is read with its origin's overlay and version hint.
   */
  async function readUserPlugin(id: string, record: PluginRecord | null): Promise<FormatRead> {
    const dir = pluginDirOf(id, record)
    const format = record?.format ?? await detectFolderFormat(dir) ?? 'harness'
    const overlay = record?.origin?.kind === 'marketplace' ? record.origin.overlay : undefined
    const versionHint = versionHintOf(record)
    return readPluginDirectoryFor(format, dir, {
      expectedId: id,
      nameHint: id,
      ...(overlay === undefined ? {} : { overlay }),
      ...(versionHint === undefined ? {} : { versionHint }),
      linked: record?.source === 'link',
    })
  }

  function shouldWatch(entry: PluginEntry): boolean {
    return !stopped && started && !deps.env.safeMode && entry.builtin === null && entry.dir !== null
      && (entry.record?.source === 'link' || deps.env.pluginWatch)
  }

  function syncWatch(entry: PluginEntry): void {
    if (shouldWatch(entry) && entry.dir !== null)
      watcher.watch(entry.id, entry.dir)
    else
      watcher.unwatch(entry.id)
  }

  async function compileFor(entry: PluginEntry, read: PluginDirectoryRead, force: boolean): Promise<PluginCompileResult> {
    const { dir, entryPath, entryBytes } = read
    if (dir === null || entryPath === null || entryBytes === null)
      return { ok: false, durationMs: 0, diagnostics: [{ severity: 'error', file: null, line: null, column: null, message: 'The entry file cannot be read.' }], outputFile: null }
    return guard(entry.id, () => compileEntry({
      dir,
      entryPath,
      entryBytes,
      cacheDir: join(deps.env.paths.pluginCache, entry.id),
      force,
    }), { timeoutMs: GUARD_TIMEOUTS.build, phase: 'build' })
  }

  function logBuild(id: string, result: PluginCompileResult): void {
    const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length
    for (const diagnostic of result.diagnostics) {
      const where = diagnostic.file === null ? '' : `${diagnostic.file}${diagnostic.line === null ? '' : `:${diagnostic.line}${diagnostic.column === null ? '' : `:${diagnostic.column}`}`}: `
      log(id, diagnostic.severity === 'error' ? 'error' : 'warn', `${where}${diagnostic.message}`)
    }
    if (result.ok)
      log(id, 'info', `Build succeeded in ${Math.round(result.durationMs)} ms.`)
    else
      log(id, 'error', `Build failed with ${errors} ${errors === 1 ? 'error' : 'errors'}.`)
  }

  function buildError(id: string, result: PluginCompileResult): HarnessErrorInit {
    const first = result.diagnostics.find(diagnostic => diagnostic.severity === 'error')
    const where = first?.file ? `${first.file}${first.line === null ? '' : `:${first.line}`}: ` : ''
    return pluginError(id, 'build', `Build failed: ${where}${first?.message ?? 'unknown error'}`).toJSON().error
  }

  async function refreshRecord(entry: PluginEntry): Promise<PluginRecord | null> {
    entry.record = await records.get(entry.id)
    return entry.record
  }

  /** (Re)loads a user plugin according to its row and files. Never throws for plugin problems. */
  async function loadUserLocked(entry: PluginEntry, options: LoadOptions = {}): Promise<void> {
    const id = entry.id
    let record = await refreshRecord(entry)
    const formatRead = await readUserPlugin(id, record)
    const read = formatRead.directory
    applyRead(entry, formatRead)
    if (record === null && read.dir !== null) {
      // A folder placed in data/plugins by hand: remember it like a copied folder (Phase 12: in the format it has).
      record = await records.upsert({ id, source: 'copy', sourceRef: null, version: read.manifest?.version ?? read.lenient.version ?? '0.0.0', format: formatRead.format })
      entry.record = record
    }
    else if (record !== null && read.manifest && record.version !== read.manifest.version) {
      entry.record = record = (await records.update(id, { version: read.manifest.version })) ?? record
    }

    if (!(record?.enabled ?? true) || deps.env.safeMode) {
      await teardown(entry, true)
      setState(entry, 'disabled', null)
      return
    }
    // Every (re)load passes through `loading`, except while a running version keeps serving during a hot rebuild.
    const keepRunning = options.keepPreviousOnBuildError === true && entry.runtime !== null && entry.state === 'active'
    if (!keepRunning)
      enterLoading(entry)
    if (options.boot && record?.loadingSince != null) {
      await persistLastError(entry, crashedError(id))
      setState(entry, 'error', crashedError(id))
      log(id, 'error', 'Skipped: the server stopped while this plugin was loading last time. Enable or reload it to try again.')
      return
    }
    if (read.problem === null && record?.source === 'link' && read.dir !== null && basename(read.dir) !== id) {
      read.problem = {
        state: 'error',
        error: pluginError(id, 'load', `The linked folder "${basename(read.dir)}" must be named after the plugin id "${id}".`).toJSON().error,
      }
    }
    if (read.problem) {
      const problem = redactedInit(read.problem.error)
      await teardown(entry, true)
      await persistLastError(entry, problem)
      setState(entry, read.problem.state, problem)
      log(id, read.problem.state === 'incompatible' ? 'warn' : 'error', `Not loaded: ${problem.message}`)
      return
    }
    const manifest = read.manifest
    if (manifest === null || read.dir === null || read.hash === null) {
      await teardown(entry, true)
      setState(entry, 'error', pluginError(id, 'load', 'The plugin cannot be read.').toJSON().error)
      return
    }
    if (read.requiresTrust && !isPinned(record, read)) {
      await teardown(entry, true)
      setState(entry, 'untrusted', null)
      log(id, 'warn', 'Not loaded: the plugin runs code (or starts a program or shell commands) and its files are not trusted. Review and trust it to load it.')
      return
    }

    let outputFile: string | null = null
    if (manifest.main !== undefined) {
      let compiled: PluginCompileResult
      try {
        compiled = await compileFor(entry, read, false)
      }
      catch (error) {
        compiled = { ok: false, durationMs: 0, diagnostics: [{ severity: 'error', file: null, line: null, column: null, message: thrownMessage(error) }], outputFile: null }
      }
      if (!compiled.ok || compiled.outputFile === null) {
        logBuild(id, compiled)
        if (options.keepPreviousOnBuildError && entry.runtime !== null && entry.state === 'active') {
          log(id, 'warn', 'The previous version keeps running until the build succeeds.')
          return
        }
        await teardown(entry, true)
        const failure = buildError(id, compiled)
        await persistLastError(entry, failure)
        setState(entry, 'error', failure)
        return
      }
      outputFile = compiled.outputFile
    }

    await teardown(entry, true)
    await activate(entry, manifest, read.dir, outputFile, read.hash)
  }

  async function loadBuiltinLocked(entry: PluginEntry): Promise<void> {
    const builtin = entry.builtin
    if (!builtin)
      return
    entry.record = await records.ensureBuiltin(entry.id, builtin.manifest.version)
    await teardown(entry, true)
    if (!entry.record.enabled) {
      setState(entry, 'disabled', null)
      return
    }
    await activate(entry, builtin.manifest, builtinDir(entry.id), null, builtin.manifest.version)
  }

  async function loadLocked(entry: PluginEntry, options: LoadOptions = {}): Promise<void> {
    if (stopped)
      return
    try {
      if (entry.builtin)
        await loadBuiltinLocked(entry)
      else
        await loadUserLocked(entry, options)
    }
    catch (error) {
      // Host-side failures (database, file system) must not escape: report them on the plugin.
      deps.logger.error('plugin load failed', { pluginId: entry.id, err: error })
      await teardown(entry, false).catch(() => {})
      setState(entry, 'error', errorInit(entry.id, 'load', error))
    }
    syncWatch(entry)
  }

  function newEntry(id: string, builtin: BuiltinPlugin | null): PluginEntry {
    return {
      id,
      builtin,
      record: null,
      dir: null,
      read: null,
      format: 'harness',
      claude: null,
      manifest: builtin ? builtin.manifest : synthesizeManifest(id, {}),
      valid: builtin !== null,
      state: 'loading',
      lastError: null,
      runtime: null,
      module: null,
      stopping: false,
      announcedLoading: false,
      fingerprint: null,
      codeFiles: [],
    }
  }

  /** The entry of a user plugin known by its row or its `data/plugins/<id>` folder (created on demand). */
  async function ensureUserEntry(id: string): Promise<PluginEntry> {
    const existing = entries.get(id)
    if (existing)
      return existing
    if (!PLUGIN_ID_PATTERN.test(id) || isBuiltinPluginId(id))
      throw notFound(id)
    const record = await records.get(id)
    if (record === null) {
      try {
        await lstat(join(deps.env.paths.plugins, id))
      }
      catch {
        throw notFound(id)
      }
    }
    else if (record.source === 'builtin') {
      throw notFound(id)
    }
    const entry = newEntry(id, null)
    entry.record = record
    entries.set(id, entry)
    return entry
  }

  async function discoverUserPluginIds(): Promise<string[]> {
    const ids = new Set<string>()
    for (const record of await records.list()) {
      if (record.source !== 'builtin' && !isBuiltinPluginId(record.id))
        ids.add(record.id)
    }
    let names: string[] = []
    try {
      names = (await readdir(deps.env.paths.plugins, { withFileTypes: true }))
        .filter(dirent => dirent.isDirectory() || dirent.isSymbolicLink())
        .map(dirent => dirent.name)
    }
    catch (error) {
      deps.logger.warn('cannot read the plugins directory', { dir: deps.env.paths.plugins, err: error })
    }
    for (const name of names) {
      if (name.startsWith('.'))
        continue
      if (!PLUGIN_ID_PATTERN.test(name) || isBuiltinPluginId(name)) {
        deps.logger.warn('ignoring a plugin folder whose name is not a usable plugin id', { name })
        continue
      }
      ids.add(name)
    }
    return [...ids].sort(comparePluginIds)
  }

  // ---------- hot reload ----------

  async function onWatchedChange(id: string): Promise<void> {
    if (stopped)
      return
    const entry = entries.get(id)
    if (!entry || entry.builtin)
      return
    try {
      await withLock(id, async () => {
        if (stopped || entries.get(id) !== entry)
          return
        const read = (await readUserPlugin(id, entry.record)).directory
        if (fingerprintOf(read) === entry.fingerprint)
          return
        log(id, 'info', 'Files changed on disk: reloading.')
        await trackContributions(id, () => loadLocked(entry, { keepPreviousOnBuildError: true }))
      })
    }
    catch (error) {
      deps.logger.error('plugin hot reload failed', { pluginId: id, err: error })
    }
  }

  // ---------- unhandled rejections ----------

  function onUnhandledRejection(reason: unknown): void {
    const stack = reason instanceof Error ? reason.stack ?? '' : ''
    if (stack === '')
      return
    for (const entry of entries.values()) {
      const files = entry.codeFiles
      if (files.some(file => stack.includes(file) || stack.includes(pathToFileURL(file).href))) {
        log(entry.id, 'error', `Unhandled promise rejection: ${thrownMessage(reason)}`, { error: reason })
        return
      }
    }
  }

  // ---------- uninstall helpers ----------

  /** Removes `data/plugins/<id>` (a symlink is unlinked, never followed out of the plugins directory). */
  async function removeInstalledDirectory(id: string): Promise<void> {
    const target = join(deps.env.paths.plugins, id)
    let info
    try {
      info = await lstat(target)
    }
    catch {
      return
    }
    if (info.isSymbolicLink()) {
      await rm(target, { force: true })
      return
    }
    const root = await realpath(deps.env.paths.plugins)
    const real = await realpath(target)
    if (!isInside(root, real)) {
      deps.logger.error('refusing to delete a plugin directory outside the plugins folder', { pluginId: id, dir: real })
      return
    }
    await rm(real, { recursive: true, force: true })
  }

  /** The plugin (of `candidates`) that owns a namespaced id: the longest matching plugin id. */
  function namespaceOwner(providerId: string, candidates: Iterable<string>): string | null {
    let owner: string | null = null
    for (const pluginId of candidates) {
      if (isPluginNamespacedId(pluginId, providerId) && (owner === null || pluginId.length > owner.length))
        owner = pluginId
    }
    return owner
  }

  /** Provider ids whose stored credentials / configuration belong to the removed plugin. */
  async function ownedProviderIds(id: string, known: Iterable<string>): Promise<string[]> {
    const plugins = [...entries.keys()]
    const owned = new Set<string>()
    const eligible = (providerId: string): boolean => !isBuiltinProviderId(providerId) && providerId !== MOCK_PROVIDER_ID
    for (const providerId of known) {
      if (eligible(providerId))
        owned.add(providerId)
    }
    try {
      for (const providerId of await storedProviderIds(deps.db)) {
        if (eligible(providerId) && namespaceOwner(providerId, plugins) === id)
          owned.add(providerId)
      }
    }
    catch (error) {
      deps.logger.warn('cannot list stored provider configuration', { pluginId: id, err: error })
    }
    return [...owned].sort()
  }

  // ---------- settings API ----------

  async function settingsView(entry: PluginEntry): Promise<PluginSettingsView> {
    const schema = settingsSchemaOf(entry)
    const state = await readSettingsState(entry.id, schema, false)
    return { schema: schema ?? null, values: state.values, secrets: state.secretStates }
  }

  // ---------- host ----------

  const host: PluginHost = {
    start: async () => {
      if (started)
        return
      started = true
      process.on('unhandledRejection', onUnhandledRejection)
      registrySubscription = deps.registry.onChange((change) => {
        if (change.kind === 'provider' && change.action === 'added') {
          let set = knownProviders.get(change.pluginId)
          if (!set) {
            set = new Set()
            knownProviders.set(change.pluginId, set)
          }
          set.add(change.key)
        }
      })

      for (const builtin of deps.builtins) {
        const entry = newEntry(builtin.id, builtin)
        entries.set(builtin.id, entry)
        await withLock(builtin.id, () => loadLocked(entry))
      }

      let ids: string[] = []
      try {
        ids = await discoverUserPluginIds()
      }
      catch (error) {
        deps.logger.error('plugin discovery failed', { err: error })
      }
      for (const id of ids) {
        if (entries.has(id))
          continue
        const entry = newEntry(id, null)
        entries.set(id, entry)
        await withLock(id, () => loadLocked(entry, { boot: true }))
      }
      const counts = new Map<PluginState, number>()
      for (const entry of entries.values())
        counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1)
      deps.logger.info('plugins loaded', { safeMode: deps.env.safeMode, ...Object.fromEntries(counts) })
    },

    stop: async () => {
      if (stopped)
        return
      stopped = true
      watcher.close()
      clearTreeHashCache()
      process.off('unhandledRejection', onUnhandledRejection)
      registrySubscription?.dispose()
      const loaded = [...entries.values()].sort((a, b) => comparePluginIds(b.id, a.id))
      const users = loaded.filter(entry => entry.builtin === null)
      const builtins = loaded.filter(entry => entry.builtin !== null)
      await Promise.all(users.map(entry => teardown(entry, true).catch(() => {})))
      await Promise.all(builtins.map(entry => teardown(entry, true).catch(() => {})))
      logStore.stop()
      stateListeners.clear()
    },

    list: async () => [...entries.values()]
      .sort((a, b) => comparePluginIds(a.id, b.id))
      .map(summaryOf),
    get: async id => detailOf(requireEntry(id)),
    summary: async id => summaryOf(requireEntry(id)),
    record: id => records.get(id),
    state: id => entries.get(id)?.state ?? null,
    isActive: (id) => {
      const entry = entries.get(id)
      return entry !== undefined && entry.state === 'active' && !entry.stopping
    },
    directory: async (id) => {
      const entry = entries.get(id)
      return entry !== undefined && entry.builtin === null ? entry.dir : null
    },

    enable: id => withLock(id, async () => {
      const entry = entries.get(id) ?? await ensureUserEntry(id)
      entry.record = entry.builtin
        ? await records.ensureBuiltin(id, entry.builtin.manifest.version)
        : entry.record
      await records.update(id, { enabled: true })
      await trackContributions(id, () => loadLocked(entry))
      return detailOf(entry)
    }),

    disable: id => withLock(id, async () => {
      const entry = entries.get(id) ?? await ensureUserEntry(id)
      if (entry.builtin)
        await records.ensureBuiltin(id, entry.builtin.manifest.version)
      entry.record = (await records.update(id, { enabled: false })) ?? entry.record
      await trackContributions(id, async () => {
        await teardown(entry, true)
        log(id, 'info', 'Disabled.')
        setState(entry, 'disabled', null)
      })
      syncWatch(entry)
      return detailOf(entry)
    }),

    reload: id => withLock(id, async () => {
      const entry = entries.get(id) ?? await ensureUserEntry(id)
      const record = await records.get(id)
      if (record !== null && !record.enabled)
        throw new HarnessError({ code: 'conflict', message: `The plugin "${id}" is disabled: enable it instead.`, details: { reason: 'disabled' } })
      await trackContributions(id, () => loadLocked(entry, { keepPreviousOnBuildError: true }))
      return detailOf(entry)
    }),

    uninstall: (id, options) => withLock(id, async () => {
      const entry = entries.get(id) ?? await ensureUserEntry(id)
      if (entry.builtin)
        throw forbidden('Builtin plugins cannot be uninstalled.')
      const before = snapshot(id)
      const known = new Set([
        ...before.providers,
        ...declaredContributions(entry.valid ? entry.manifest : null).providers,
        ...(knownProviders.get(id) ?? []),
      ])
      await teardown(entry, true)
      watcher.unwatch(id)
      const lastState = entry.state
      const record = entry.record ?? await records.get(id)
      if (record?.source !== 'link')
        await removeInstalledDirectory(id)
      await rm(join(deps.env.paths.pluginCache, id), { recursive: true, force: true })
      if (!options.keepData) {
        const providerIds = await ownedProviderIds(id, known)
        await deleteSettingsValues(deps.db, id)
        await deleteStorage(deps.db, id)
        for (const scope of [`plugin:${id}` as const, ...providerIds.map(providerId => `provider:${providerId}` as const)]) {
          try {
            await deps.secrets.deleteScope(scope)
          }
          catch (error) {
            deps.logger.warn('cannot delete plugin secrets', { pluginId: id, scope, err: error })
          }
        }
        await deleteProviderRows(deps.db, providerIds)
        await rm(join(deps.env.paths.pluginData, id), { recursive: true, force: true })
      }
      await records.remove(id)
      entries.delete(id)
      knownProviders.delete(id)
      logStore.clear(id)
      deps.logger.info('plugin uninstalled', { pluginId: id, keepData: options.keepData })
      try {
        deps.events.emit('plugin.changed', { id, plugin: null })
      }
      catch {}
      notifyState(id, null, lastState)
      emitContributionEvents(before, { providers: [], models: 0 })
    }),

    trust: (id, sha256) => withLock(id, async () => {
      const entry = entries.get(id) ?? await ensureUserEntry(id)
      if (entry.builtin)
        throw forbidden('Builtin plugins are always trusted.')
      const record = await refreshRecord(entry)
      const formatRead = await readUserPlugin(id, record)
      const read = formatRead.directory
      applyRead(entry, formatRead)
      if (read.hash === null || read.dir === null)
        throw new HarnessError({ code: 'validation_error', message: 'The plugin files cannot be read, so they cannot be trusted.' })
      if (read.hash !== sha256) {
        throw new HarnessError({
          code: 'conflict',
          message: 'The plugin files changed since they were reviewed: inspect them again before trusting.',
          details: { reason: 'stale' },
        })
      }
      const pin = record?.source === 'link' ? pathPin(read.dir) : read.hash
      entry.record = (await records.update(id, { trustedHash: pin })) ?? record
      log(id, 'info', 'Trusted.')
      await trackContributions(id, () => loadLocked(entry))
      return detailOf(entry)
    }),

    getSettings: async id => settingsView(requireEntry(id)),

    updateSettings: (id, values) => withLock(id, async () => {
      const entry = requireEntry(id)
      const schema = settingsSchemaOf(entry)
      if (!schema)
        throw new HarnessError({ code: 'validation_error', message: `The plugin "${id}" has no settings.`, details: { issues: [] } })
      const parsed = settingsValuesSchema(schema, { partial: true }).safeParse(values)
      if (!parsed.success)
        throw validationError(parsed.error)
      const stored = await readSettingsValues(deps.db, id)
      const next: Record<string, unknown> = {}
      for (const key of Object.keys(schema.properties)) {
        if (stored[key] !== undefined && !isSecretProperty(schema.properties[key] as SettingsProperty))
          next[key] = stored[key]
      }
      const scope = `plugin:${id}` as const
      for (const [key, value] of Object.entries(parsed.data)) {
        const property = schema.properties[key]
        if (!property || value === undefined)
          continue
        if (isSecretProperty(property)) {
          const name = `${SETTINGS_SECRET_PREFIX}${key}`
          if (value === null || value === '') {
            await deps.secrets.delete(scope, name)
          }
          else if (typeof value === 'string') {
            // Registered first, so the value is masked even if storing it fails and the error is logged.
            deps.redactor.addSecret(value)
            await deps.secrets.set(scope, name, value)
          }
        }
        else if (value === null) {
          delete next[key]
        }
        else {
          next[key] = value
        }
      }
      await writeSettingsValues(deps.db, id, next)
      const runtime = entry.runtime
      if (runtime && entry.format === 'claude') {
        // Phase 12: a Claude Code plugin substitutes its options when it loads (bodies, MCP servers, hooks): reload it.
        log(id, 'info', 'Settings saved: reloading.')
        await trackContributions(id, () => loadLocked(entry))
        return settingsView(entry)
      }
      if (runtime) {
        await runtime.updateSettings(await fullSettings(id, schema), async (callback, current) => {
          await guard(id, () => callback(current), { timeoutMs: GUARD_TIMEOUTS.hook, phase: 'hook', label: 'settings.onChange' }).catch(() => {})
        })
      }
      log(id, 'info', 'Settings saved.')
      return settingsView(entry)
    }),

    settingsValues: async (id) => {
      const entry = requireEntry(id)
      return entry.runtime ? structuredClone(entry.runtime.settings()) : fullSettings(id, settingsSchemaOf(entry))
    },

    logs: async (id, query) => {
      requireEntry(id)
      return logStore.entries(id, query)
    },

    icon: async (id): Promise<PluginIconFile> => {
      const entry = requireEntry(id)
      const icon = entry.valid ? entry.manifest.icon : undefined
      if (icon === undefined)
        throw new HarnessError({ code: 'not_found', message: `The plugin "${id}" has no icon.` })
      if (icon.startsWith('lobe:'))
        return { kind: 'lobe', slug: icon.slice('lobe:'.length) }
      const path = entry.dir === null ? null : await resolveInside(entry.dir, icon)
      const extension = path === null ? '' : extname(path).toLowerCase()
      if (path === null || !Object.hasOwn(ICON_CONTENT_TYPES, extension))
        throw new HarnessError({ code: 'not_found', message: `The icon of the plugin "${id}" is missing.` })
      const body = await readFile(path).catch(() => null)
      if (body === null || body.length > ICON_MAX_BYTES)
        throw new HarnessError({ code: 'not_found', message: `The icon of the plugin "${id}" cannot be read.` })
      return {
        kind: 'file',
        contentType: ICON_CONTENT_TYPES[extension as keyof typeof ICON_CONTENT_TYPES],
        body: new Uint8Array(body),
        version: sha256Hex(body).slice(0, 8),
      }
    },

    guard,
    log,

    // Phase 12 (ADR-053): `format: 'claude'` reads a Claude Code plugin (`formats.ts`, `plugins/claude/reader.ts`).
    inspectDirectory: async (dir, options) => inspectDirectoryFor(dir, options),

    saveRecord: async (input) => {
      if (!PLUGIN_ID_PATTERN.test(input.id))
        throw new HarnessError({ code: 'validation_error', message: `Invalid plugin id "${input.id}".` })
      if (isBuiltinPluginId(input.id))
        throw forbidden(`The plugin id "${input.id}" belongs to a builtin plugin.`)
      if (input.source === 'link' && (typeof input.sourceRef !== 'string' || !isAbsolute(input.sourceRef)))
        throw new HarnessError({ code: 'validation_error', message: 'A linked plugin needs the absolute path of its folder as sourceRef.' })
      return withLock(input.id, async () => {
        const record = await records.upsert(input)
        const entry = entries.get(input.id)
        if (entry)
          entry.record = record
        return record
      })
    },

    load: id => withLock(id, async () => {
      const entry = entries.get(id) ?? await ensureUserEntry(id)
      await trackContributions(id, () => loadLocked(entry))
      return detailOf(entry)
    }),

    unload: id => withLock(id, async () => {
      const entry = entries.get(id)
      if (!entry || entry.runtime === null)
        return
      await trackContributions(id, async () => {
        await teardown(entry, true)
        setState(entry, 'loading', null)
      })
    }),

    forget: id => withLock(id, async () => {
      const entry = entries.get(id)
      if (entry?.builtin)
        throw forbidden('Builtin plugins cannot be removed.')
      const before = snapshot(id)
      if (entry) {
        await teardown(entry, true)
        watcher.unwatch(id)
        entries.delete(id)
      }
      await records.remove(id)
      logStore.clear(id)
      if (entry) {
        try {
          deps.events.emit('plugin.changed', { id, plugin: null })
        }
        catch {}
        notifyState(id, null, entry.state)
        emitContributionEvents(before, { providers: [], models: 0 })
      }
    }),

    compile: id => withLock(id, async () => {
      const entry = entries.get(id) ?? await ensureUserEntry(id)
      if (entry.builtin)
        throw forbidden('Builtin plugins cannot be built.')
      const record = await refreshRecord(entry)
      const formatRead = await readUserPlugin(id, record)
      if (formatRead.format === 'claude')
        throw forbidden('Claude Code plugins have no code to build.')
      const read = formatRead.directory
      if (read.manifest === null) {
        const message = read.problem?.error.message ?? 'The manifest is invalid.'
        const result: PluginCompileResult = {
          ok: false,
          durationMs: 0,
          diagnostics: [{ severity: 'error', file: 'plugin.json', line: null, column: null, message }],
          outputFile: null,
        }
        logBuild(id, result)
        return result
      }
      if (read.manifest.main === undefined)
        throw forbidden('Declarative plugins have no code to build.')
      const result = await compileFor(entry, read, true)
      logBuild(id, result)
      return result
    }),

    withoutWatch: async (id, fn) => {
      const release = watcher.suppress(id)
      try {
        return await fn()
      }
      finally {
        const entry = entries.get(id)
        if (entry && entry.builtin === null) {
          try {
            const read = (await readUserPlugin(id, entry.record)).directory
            entry.fingerprint = fingerprintOf(read)
          }
          catch {}
        }
        release()
      }
    },

    declarativeProvider: (_pluginId, provider) => createDeclarativeProvider(provider),

    refresh: id => withLock(id, async () => {
      const entry = requireEntry(id)
      if (entry.builtin !== null)
        return detailOf(entry)
      const before = JSON.stringify(detailOf(entry))
      const record = await refreshRecord(entry)
      const read = await readUserPlugin(id, record)
      // The fingerprint keeps describing the files the host saw (loaded, or written through `withoutWatch`), so a
      // change made on disk in the meantime still hot-reloads.
      const fingerprint = entry.fingerprint
      applyRead(entry, read)
      entry.fingerprint = fingerprint
      syncWatch(entry)
      const detail = detailOf(entry)
      if (JSON.stringify(detail) !== before)
        emitChanged(entry)
      return detail
    }),

    onStateChange: (listener) => {
      // A wrapper per subscription: subscribing the same function twice needs two disposals.
      const subscription = (change: PluginStateChange): void => listener(change)
      stateListeners.add(subscription)
      return { dispose: () => void stateListeners.delete(subscription) }
    },
  }
  return host
}
