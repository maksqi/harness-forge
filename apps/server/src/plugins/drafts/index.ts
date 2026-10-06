// Declarative plugins created and edited in the browser (API.md 5.17, PLUGINS.md 4 / 12 / 13, UI.md 8.5). Owner: W3.3.
//
// `create`: validate the draft (declarative manifest, reserved ids -> 403, credentials against the declared fields,
//   icon file decoded and sanitized) -> fresh auth when the manifest requires trust (ADR-017 / ADR-052,
//   `manifestRequiresTrust`: a stdio MCP server, command hooks or `!` spans in a command template) -> id free (plugin row,
//   host entry, `data/plugins/<id>`) and provider / MCP server ids not used by another plugin (409 `exists`) ->
//   `plugin.json` (+ icon) written into `data/plugins/.staging/<uuid>`, validated by the host
//   (`inspectDirectory`) and renamed atomically to `data/plugins/<id>` -> `plugins` row (`source: 'created'`,
//   pinned when it requires trust) -> host load -> credentials stored as provider credentials (never in
//   `plugin.json`), then checked and listed in the background like `PUT /providers/:id/credentials` does.
// `updateManifest`: an editable declarative plugin gets its new `plugin.json` (+ icon) written atomically without
//   triggering the watcher, then reloads (hot reload on save). Saving a manifest that requires trust
//   (`manifestRequiresTrust`) needs fresh auth (W11.17: every such save, since it re-pins the new `plugin.json` through
//   the host's trust action); a pin is only ever set after that check.
// `test`: `test-provider.ts`.
import type { CredentialField, PluginManifest } from '@harness-forge/plugin-sdk'
import type { DraftTestRequest, DraftTestResult, PluginDetail, PluginDraft, PluginManifestUpdate } from '@harness-forge/shared'
import type { AppDeps, SensitiveOperationOptions } from '../../types.ts'
import type { PluginDrafts } from '../types.ts'
import type { IconFile } from './icon.ts'
import type { DraftTestOptions } from './test-provider.ts'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import {
  applyDeclarativeProviderDefaults,
  HarnessError,
  isReservedPluginId,
  LIMITS,
  manifestRequiresTrust,
  pluginDraftSchema,
  pluginManifestUpdateSchema,
  validationError,
} from '@harness-forge/shared'
import { checkCredentialValues } from './credentials.ts'
import { decodeIconFile } from './icon.ts'
import { runDraftTest } from './test-provider.ts'

export { sanitizeSvg, SvgSanitizeError } from './svg.ts'

const MANIFEST_FILE = 'plugin.json'

export interface PluginDraftsOptions extends DraftTestOptions {}

/** `PluginDrafts` plus a way to wait for the background credential checks started by `create` (tests). */
export interface PluginDraftsService extends PluginDrafts {
  readonly idle: () => Promise<void>
}

interface DraftCredentials {
  providerId: string
  fields: CredentialField[]
  values: Record<string, string>
}

function forbidden(message: string): HarnessError {
  return new HarnessError({ code: 'forbidden', message })
}

function exists(message: string): HarnessError {
  return new HarnessError({ code: 'conflict', message, details: { reason: 'exists' } })
}

function invalid(path: readonly (string | number)[], message: string): HarnessError {
  return validationError([{ path: [...path], message, code: 'custom' }], message)
}

/** `plugin.json` bytes: the validated manifest, pretty-printed. */
export function serializeManifest(manifest: PluginManifest): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
  if (bytes.length > LIMITS.manifestBytes)
    throw invalid(['manifest'], `plugin.json is limited to ${LIMITS.manifestBytes / 1024} KB.`)
  return bytes
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  }
  catch {
    return false
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Writes `name` inside `dir` through a temporary file and a rename (never follows an existing symlink). */
async function writeFileAtomic(dir: string, name: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dir, `.${name}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, bytes, { mode: 0o644, flag: 'wx' })
    await rename(temporary, join(dir, name))
  }
  catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export function createPluginDrafts(deps: AppDeps): PluginDrafts {
  return createPluginDraftsWith(deps, {})
}

/** `createPluginDrafts` with an injectable fetch and test timeout for the draft test (tests). */
export function createPluginDraftsWith(deps: AppDeps, options: PluginDraftsOptions): PluginDraftsService {
  const logger = deps.logger.child({ component: 'plugin-drafts' })
  const background = new Set<Promise<void>>()

  function track(task: Promise<void>): void {
    background.add(task)
    void task.finally(() => background.delete(task))
  }

  // ---------- checks ----------

  /** A plugin id is taken by a row, a host entry or a folder in `data/plugins`. */
  async function assertIdFree(id: string): Promise<void> {
    if (deps.plugins.state(id) !== null || await deps.plugins.record(id) !== null || await pathExists(join(deps.env.paths.plugins, id)))
      throw exists(`A plugin with the id "${id}" already exists.`)
  }

  /** Provider and MCP server ids of the manifest that another (loaded) plugin already registered. */
  function assertContributionIdsFree(pluginId: string, manifest: PluginManifest): void {
    for (const provider of manifest.contributes?.providers ?? []) {
      const owner = deps.registry.providers.get(provider.id)?.pluginId
      if (owner !== undefined && owner !== pluginId)
        throw exists(`The provider id "${provider.id}" is already used by the plugin "${owner}".`)
    }
    for (const server of manifest.contributes?.mcpServers ?? []) {
      const owner = deps.registry.mcpServers.get(server.id)?.pluginId
      if (owner !== undefined && owner !== pluginId)
        throw exists(`The MCP server id "${server.id}" is already used by "${owner}".`)
    }
  }

  /** Credentials of the draft checked against the fields of the providers they belong to. */
  function draftCredentials(manifest: PluginManifest, credentials: Record<string, Record<string, string>>): DraftCredentials[] {
    const providers = new Map((manifest.contributes?.providers ?? []).map(provider => [provider.id, applyDeclarativeProviderDefaults(provider)]))
    const result: DraftCredentials[] = []
    for (const [providerId, values] of Object.entries(credentials)) {
      const provider = providers.get(providerId)
      if (!provider)
        throw invalid(['credentials', providerId], `The manifest declares no provider "${providerId}".`)
      const checked = checkCredentialValues(provider.credentials, values, ['credentials', providerId])
      if (Object.keys(checked).length > 0)
        result.push({ providerId, fields: provider.credentials, values: checked })
    }
    return result
  }

  /** A relative icon file referenced by the manifest exists inside the plugin directory. */
  async function assertIconInside(dir: string, icon: string): Promise<void> {
    let path: string | null = null
    try {
      path = await realpath(join(dir, icon))
    }
    catch {}
    const extension = path === null ? '' : extname(path).toLowerCase()
    if (path === null || !isInside(dir, path) || (extension !== '.svg' && extension !== '.png') || !(await stat(path)).isFile())
      throw invalid(['manifest', 'icon'], `The icon file "${icon}" does not exist in the plugin. Upload it or pick another icon.`)
  }

  // ---------- credentials ----------

  async function emitProviderChanged(providerId: string): Promise<void> {
    try {
      deps.events.emit('provider.changed', { id: providerId, provider: await deps.providers.get(providerId) })
    }
    catch (error) {
      logger.debug('cannot announce a provider change', { providerId, err: error })
    }
  }

  /** Credential test and model listing after a save (as `PUT /providers/:id/credentials` does); never throws. */
  function checkInBackground(providerId: string): void {
    track((async () => {
      try {
        const { missing } = await deps.credentials.resolve(providerId)
        if (missing.length > 0)
          return
        const result = await deps.providers.test(providerId)
        if (result.ok)
          await deps.catalog.refresh(providerId)
      }
      catch (error) {
        logger.warn('background credential check of a created provider failed', { providerId, err: error })
      }
    })())
  }

  /** Stores the draft credentials; failures are logged on the plugin (the plugin already exists). */
  async function saveCredentials(pluginId: string, entries: readonly DraftCredentials[]): Promise<void> {
    for (const entry of entries) {
      const registered = deps.registry.providers.get(entry.providerId)
      try {
        if (registered?.pluginId === pluginId) {
          await deps.credentials.set(entry.providerId, entry.values)
          await emitProviderChanged(entry.providerId)
          checkInBackground(entry.providerId)
        }
        else if (registered === undefined) {
          // Not registered (created disabled, safe mode, failed load): stored against the declared fields.
          const setFor = deps.credentials.setFor
          if (setFor === undefined)
            throw new Error('The credential service cannot store credentials of a provider that is not registered.')
          await setFor(entry.providerId, entry.fields, entry.values)
        }
        else {
          deps.plugins.log(pluginId, 'warn', `The credentials of "${entry.providerId}" were not saved: the plugin "${registered.pluginId}" uses this provider id.`)
        }
      }
      catch (error) {
        logger.error('cannot save the credentials of a created provider', { pluginId, providerId: entry.providerId, err: error })
        deps.plugins.log(pluginId, 'error', `The credentials of "${entry.providerId}" could not be saved. Enter them in Settings > Providers.`)
      }
    }
  }

  // ---------- create ----------

  async function create(draft: PluginDraft, sensitive: SensitiveOperationOptions): Promise<PluginDetail> {
    const parsed = pluginDraftSchema.safeParse(draft)
    if (!parsed.success)
      throw validationError(parsed.error)
    const { manifest } = parsed.data
    const id = manifest.id
    if (isReservedPluginId(id))
      throw forbidden(`The plugin id "${id}" is reserved (core-*, mock and builtin provider ids).`)
    const credentials = draftCredentials(manifest, parsed.data.credentials ?? {})
    const icon: IconFile | null = parsed.data.iconFile ? decodeIconFile(parsed.data.iconFile) : null
    const manifestBytes = serializeManifest(manifest)
    // ADR-017 / ADR-052: a manifest that requires trust (a stdio MCP server, command hooks, `!` spans) runs commands on
    // the server; it is pinned below only after this check.
    const requiresTrust = manifestRequiresTrust(manifest)
    if (requiresTrust)
      sensitive.requireFreshAuth()
    await assertIdFree(id)
    assertContributionIdsFree(id, manifest)

    const staging = join(deps.env.paths.pluginStaging, randomUUID())
    const target = join(deps.env.paths.plugins, id)
    let committed = false
    try {
      await mkdir(staging, { recursive: true, mode: 0o755 })
      await writeFile(join(staging, MANIFEST_FILE), manifestBytes, { mode: 0o644 })
      if (icon)
        await writeFile(join(staging, icon.name), icon.bytes, { mode: 0o644 })
      const inspection = await deps.plugins.inspectDirectory(staging)
      try {
        await rename(staging, target)
      }
      catch (error) {
        if (await pathExists(target))
          throw exists(`A plugin with the id "${id}" already exists.`)
        throw error
      }
      committed = true
      await deps.plugins.saveRecord({
        id,
        source: 'created',
        sourceRef: null,
        version: manifest.version,
        enabled: parsed.data.enable ?? true,
        trustedHash: requiresTrust && inspection.requiresTrust ? inspection.sha256 : null,
      })
    }
    catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      if (committed) {
        await rm(target, { recursive: true, force: true }).catch(() => {})
        await deps.plugins.forget(id).catch(() => {})
      }
      throw error
    }

    logger.info('declarative plugin created', { pluginId: id })
    deps.plugins.log(id, 'info', 'Created in the provider wizard.')
    await deps.plugins.load(id)
    await saveCredentials(id, credentials)
    return deps.plugins.get(id)
  }

  // ---------- updateManifest ----------

  async function updateManifest(id: string, update: PluginManifestUpdate, sensitive: SensitiveOperationOptions): Promise<PluginDetail> {
    const parsed = pluginManifestUpdateSchema.safeParse(update)
    if (!parsed.success)
      throw validationError(parsed.error)
    const { manifest } = parsed.data
    if (manifest.id !== id)
      throw invalid(['manifest', 'id'], `The plugin id cannot change (expected "${id}").`)
    const current = await deps.plugins.get(id)
    if (current.builtin || current.source === 'builtin')
      throw forbidden('Builtin plugins cannot be edited.')
    if (!current.editable)
      throw forbidden(`Plugins installed from ${current.source} cannot be edited. Install a new version instead.`)
    if (current.kind === 'code')
      throw forbidden('Code plugins are edited in the Source tab.')
    const dir = await deps.plugins.directory(id)
    if (dir === null)
      throw new HarnessError({ code: 'not_found', message: `The folder of the plugin "${id}" is missing.` })

    const icon: IconFile | null = parsed.data.iconFile ? decodeIconFile(parsed.data.iconFile) : null
    if (!icon && manifest.icon !== undefined && !manifest.icon.startsWith('lobe:'))
      await assertIconInside(dir, manifest.icon)
    const manifestBytes = serializeManifest(manifest)
    assertContributionIdsFree(id, manifest)

    // ADR-017 / ADR-052: every save of a manifest that requires trust re-pins it below, so it needs fresh auth first.
    const requiresTrust = manifestRequiresTrust(manifest)
    if (requiresTrust)
      sensitive.requireFreshAuth()

    await deps.plugins.withoutWatch(id, async () => {
      if (icon)
        await writeFileAtomic(dir, icon.name, icon.bytes)
      await writeFileAtomic(dir, MANIFEST_FILE, manifestBytes)
    })
    logger.info('declarative plugin manifest saved', { pluginId: id })
    deps.plugins.log(id, 'info', 'Manifest saved in the provider wizard.')

    if (requiresTrust) {
      // Re-pin the new plugin.json (a linked folder stays pinned to its path) and reload.
      const inspection = await deps.plugins.inspectDirectory(dir)
      return deps.plugins.trust(id, inspection.sha256)
    }
    if (current.trust.trustedHash !== null && current.source !== 'link') {
      // Nothing that requires trust is left: the pin of the old plugin.json is meaningless now.
      await deps.plugins.saveRecord({ id, source: current.source, version: manifest.version, trustedHash: null })
    }
    return deps.plugins.load(id)
  }

  return {
    create,
    test: (request: DraftTestRequest): Promise<DraftTestResult> => runDraftTest(deps, request, options),
    updateManifest,
    idle: async () => {
      while (background.size > 0)
        await Promise.allSettled([...background])
    },
  }
}
