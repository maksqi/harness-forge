// Rules of the install and trust dialogs (docs/UI.md 8.3, 8.4; docs/PLUGINS.md 12, 13): the source draft of each tab,
// its client-side validation with the shared schemas, the request it becomes, how server validation issues map back
// to fields, the "I trust {source}" label, permission labels and the stale-review answer (fresh auth is useFreshAuth's).
// Phase 11 (plugin API 1.5.0, W11.8): the commands a manifest runs ("Runs these commands": every command hook and every
// `!` span of a command template, read with the shared `readHooksConfig` / `planCommandExpansion`) and the summary's
// hooks and output styles.
import type {
  PluginContributions,
  PluginInspection,
  PluginInstallBody,
  PluginInstallSource,
  PluginManifest,
  PluginPermission,
  PluginSource,
} from '@harness-forge/shared'
import { LIMITS, planCommandExpansion, pluginInspectBodySchema, readHooksConfig } from '@harness-forge/shared'
import { formatBytes } from '~/components/common/format'
import { toHarnessError } from '~/utils/errors'

/** Source tabs of the install dialog (`ui.installSource`). */
export type InstallTab = 'zip' | 'npm' | 'url' | 'folder'
export const INSTALL_TABS: readonly InstallTab[] = ['zip', 'npm', 'url', 'folder']

export const TAB_LABELS: Record<InstallTab, string> = {
  zip: 'Zip',
  npm: 'npm',
  url: 'URL',
  folder: 'Local folder',
}

/** Exact trust warning of docs/PLUGINS.md section 13 ("Trust warning"). */
export const TRUST_WARNING_TEXT = 'Runs code on your server with harness-forge\'s permissions. It can read API keys and conversations and make network requests. Only install plugins from sources you trust.'

/** Labels of the advisory permissions (docs/PLUGINS.md 3 "Permissions"). */
export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  network: 'Connects to the network',
  secrets: 'Stores secrets',
  storage: 'Stores data',
  hooks: 'Reads and changes conversations',
  process: 'Starts programs',
}

export function permissionLabel(permission: string): string {
  return (PERMISSION_LABELS as Record<string, string | undefined>)[permission] ?? permission
}

// ---------- drafts ----------

export interface InstallDraft {
  file: File | null
  npmName: string
  npmVersion: string
  url: string
  integrity: string
  folderPath: string
  folderMode: 'link' | 'copy'
}

export type DraftField = 'file' | 'npmName' | 'npmVersion' | 'url' | 'integrity' | 'folderPath'
export type FieldErrors = Partial<Record<DraftField, string>>

export function emptyDraft(): InstallDraft {
  return { file: null, npmName: '', npmVersion: '', url: '', integrity: '', folderPath: '', folderMode: 'link' }
}

/** What an inspect / install call sends: the zip as multipart, every other source as JSON. */
export type InstallRequest
  = | { kind: 'zip', file: File }
    | { kind: 'json', source: PluginInstallSource }

export interface DraftCheck {
  request: InstallRequest | null
  errors: FieldErrors
}

/** Field of a tab that carries the server issue path (`details.issues[].path[0]`). */
const ISSUE_FIELDS: Record<InstallTab, Record<string, DraftField>> = {
  zip: { file: 'file' },
  npm: { spec: 'npmName' },
  url: { url: 'url', integrity: 'integrity' },
  folder: { path: 'folderPath', mode: 'folderPath' },
}

/** npm spec of the two inputs (`name` + optional version / range / tag). */
export function npmSpec(draft: Pick<InstallDraft, 'npmName' | 'npmVersion'>): string {
  const name = draft.npmName.trim()
  const version = draft.npmVersion.trim()
  return version === '' ? name : `${name}@${version}`
}

function schemaErrors(tab: InstallTab, source: unknown): { source: PluginInstallSource | null, errors: FieldErrors } {
  const parsed = pluginInspectBodySchema.safeParse(source)
  if (parsed.success)
    return { source: parsed.data, errors: {} }
  const errors: FieldErrors = {}
  for (const issue of parsed.error.issues) {
    const field = ISSUE_FIELDS[tab][String(issue.path[0] ?? '')]
    if (field && errors[field] === undefined)
      errors[field] = issue.message
  }
  if (Object.keys(errors).length === 0)
    errors[Object.values(ISSUE_FIELDS[tab])[0]!] = parsed.error.issues[0]?.message ?? 'Invalid value.'
  return { source: null, errors }
}

/** Validates the draft of `tab` and builds its request. */
export function buildRequest(tab: InstallTab, draft: InstallDraft): DraftCheck {
  switch (tab) {
    case 'zip': {
      const file = draft.file
      if (!file)
        return { request: null, errors: { file: 'Choose a .zip file.' } }
      if (file.size === 0)
        return { request: null, errors: { file: 'The file is empty.' } }
      if (file.size > LIMITS.pluginZipBytes)
        return { request: null, errors: { file: `The zip is larger than ${formatBytes(LIMITS.pluginZipBytes)}.` } }
      return { request: { kind: 'zip', file }, errors: {} }
    }
    case 'npm': {
      const name = draft.npmName.trim()
      if (name === '')
        return { request: null, errors: { npmName: 'Enter a package name.' } }
      if (draft.npmVersion.trim() !== '' && name.indexOf('@', 1) > 0)
        return { request: null, errors: { npmVersion: 'The package name already contains a version: clear one of them.' } }
      const { source, errors } = schemaErrors(tab, { source: 'npm', spec: npmSpec(draft) })
      return { request: source ? { kind: 'json', source } : null, errors }
    }
    case 'url': {
      const { source, errors } = schemaErrors(tab, { source: 'url', url: draft.url.trim(), integrity: draft.integrity.trim() })
      return { request: source ? { kind: 'json', source } : null, errors }
    }
    case 'folder': {
      const { source, errors } = schemaErrors(tab, { source: 'path', path: draft.folderPath.trim(), mode: draft.folderMode })
      return { request: source ? { kind: 'json', source } : null, errors }
    }
  }
}

/** What an install adds to its source: trust, and the hash the user reviewed in the preview. */
export interface InstallOptions {
  trust?: boolean
  /** `PluginInspection.sha256` of the reviewed preview; the server answers `409 conflict` (`stale`) when it changed. */
  sha256?: string
}

/** Multipart body of a zip inspect / install (`trust` and `sha256` only for installs). */
export function zipForm(file: File, options: InstallOptions = {}): FormData {
  const form = new FormData()
  form.append('file', file, file.name)
  if (options.trust)
    form.append('trust', 'true')
  if (options.sha256)
    form.append('sha256', options.sha256)
  return form
}

/** JSON body of a npm / URL / folder install: the inspected source plus the reviewed hash and trust. */
export function installBody(source: PluginInstallSource, options: InstallOptions = {}): PluginInstallBody {
  return {
    ...source,
    ...(options.sha256 ? { sha256: options.sha256 } : {}),
    ...(options.trust ? { trust: true } : {}),
  }
}

/**
 * Field errors from a server `validation_error` whose issues point at a field of the tab (the rest of the error is
 * shown as an alert). Null when the error has no such issue.
 */
export function serverFieldErrors(tab: InstallTab, error: unknown): FieldErrors | null {
  const harnessError = toHarnessError(error)
  if (harnessError.code !== 'validation_error')
    return null
  const issues = (harnessError.details as { issues?: Array<{ path?: unknown[], message?: unknown }> } | undefined)?.issues ?? []
  const errors: FieldErrors = {}
  for (const issue of issues) {
    const field = ISSUE_FIELDS[tab][String(issue.path?.[0] ?? '')]
    if (field && errors[field] === undefined)
      errors[field] = typeof issue.message === 'string' ? issue.message : harnessError.message
  }
  return Object.keys(errors).length > 0 ? errors : null
}

// ---------- labels ----------

function urlHost(url: string): string {
  try {
    return new URL(url).host || url
  }
  catch {
    return url
  }
}

/**
 * "{source}" of "I trust {source}" in the install dialog: the source the server resolved for the preview
 * (`PluginInspection.sourceRef`: `name@1.2.3` for npm, the URL, the folder's real path) when it sent one, else the
 * request's file name, package, URL host or folder path.
 */
export function inspectionSourceLabel(inspection: Pick<PluginInspection, 'sourceRef'>, request: InstallRequest): string {
  const resolved = inspection.sourceRef?.trim()
  return resolved || requestSourceLabel(request)
}

/** "{source}" of an install request: file name, package, URL host or folder path. */
export function requestSourceLabel(request: InstallRequest): string {
  if (request.kind === 'zip')
    return request.file.name
  const source = request.source
  switch (source.source) {
    case 'npm':
      return source.spec
    case 'url':
      return urlHost(source.url)
    case 'path':
      return source.path
  }
}

/** "{source}" of an installed plugin (trust dialog): its `sourceRef` (URL host for URLs), else the plugin name. */
export function pluginSourceLabel(plugin: { source: PluginSource, sourceRef: string | null, name: string }): string {
  if (plugin.sourceRef === null || plugin.sourceRef === '')
    return plugin.name
  return plugin.source === 'url' ? urlHost(plugin.sourceRef) : plugin.sourceRef
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * "2 providers · 3 models · 1 MCP server · 2 commands · 1 output style · 3 hooks" (empty parts omitted; Phase 11: output
 * styles, and the command hook handlers counted with the code hooks).
 */
export function contributionSummary(contributions: PluginContributions): string {
  const parts: string[] = []
  if (contributions.providers.length > 0)
    parts.push(plural(contributions.providers.length, 'provider', 'providers'))
  if (contributions.models > 0)
    parts.push(plural(contributions.models, 'model', 'models'))
  if (contributions.tools.length > 0)
    parts.push(plural(contributions.tools.length, 'tool', 'tools'))
  if (contributions.mcpServers.length > 0)
    parts.push(plural(contributions.mcpServers.length, 'MCP server', 'MCP servers'))
  if (contributions.commands.length > 0)
    parts.push(plural(contributions.commands.length, 'command', 'commands'))
  if (contributions.outputStyles.length > 0)
    parts.push(plural(contributions.outputStyles.length, 'output style', 'output styles'))
  const hooks = contributions.hooks.length + contributions.commandHooks
  if (hooks > 0)
    parts.push(plural(hooks, 'hook', 'hooks'))
  return parts.join(' · ')
}

/** "3 files · 12 KB". */
export function filesSummary(files: PluginInspection['files']): string {
  return `${plural(files.count, 'file', 'files')} · ${formatBytes(files.bytes)}`
}

/** Programs a manifest starts (stdio MCP servers), as command lines. */
export function stdioCommands(manifest: PluginManifest): string[] {
  return (manifest.contributes?.mcpServers ?? [])
    .flatMap(server => server.transport.type === 'stdio' ? [[server.transport.command, ...(server.transport.args ?? [])].join(' ')] : [])
}

/** One shell command a manifest runs (plugin API 1.5.0): a command hook (with its event) or a `!` span of a command. */
export interface ManifestRunCommand {
  /** "PreToolUse hook", "/deploy". */
  source: string
  command: string
}

/**
 * Shell commands a manifest runs (plugin API 1.5.0, docs/PLUGINS.md 13 "Runs these commands"): the command of every
 * command hook (`contributes.hooks`, read with the shared `readHooksConfig`) and every `` !`cmd` `` span of a command
 * template (scanned with the shared `planCommandExpansion`), in manifest order.
 */
export function runCommands(manifest: PluginManifest): ManifestRunCommand[] {
  const hooks = readHooksConfig(manifest.contributes?.hooks, { source: 'plugin' }).items.map(hook => ({ source: `${hook.event} hook`, command: hook.command }))
  const spans = (manifest.contributes?.commands ?? [])
    .flatMap(command => (command.template.includes('!`') ? planCommandExpansion(command.template).shellCommands : [])
      .map(span => ({ source: `/${command.name}`, command: span })))
  return [...hooks, ...spans]
}

/**
 * Hosts a manifest declares (provider base URLs, MCP http / sse URLs), like `PluginInspection.networkHosts`; a
 * templated host (`{{settings.host}}`) is shown as written.
 */
export function manifestHosts(manifest: PluginManifest): string[] {
  const urls = [
    ...(manifest.contributes?.providers ?? []).map(provider => provider.baseURL),
    ...(manifest.contributes?.mcpServers ?? []).flatMap(server => server.transport.type === 'stdio' ? [] : [server.transport.url]),
  ]
  const hosts = new Set<string>()
  for (const url of urls) {
    const authority = url.match(/^https?:\/\/([^/?#]*)/i)?.[1]
    if (!authority)
      continue
    if (authority.includes('{{')) {
      hosts.add(authority)
      continue
    }
    try {
      hosts.add(new URL(url).host)
    }
    catch {
      hosts.add(authority)
    }
  }
  return [...hosts].sort()
}

/** ProviderIcon URLs of a `lobe:<slug>` manifest icon (file icons are not served before the plugin is installed). */
export function manifestIcon(icon: string | undefined): { color?: string, mono?: string } | null {
  if (!icon?.startsWith('lobe:'))
    return null
  const slug = icon.slice('lobe:'.length)
  const base = slug.endsWith('-color') ? slug.slice(0, -'-color'.length) : slug
  return { color: `/api/icons/lobe/${encodeURIComponent(`${base}-color`)}`, mono: `/api/icons/lobe/${encodeURIComponent(base)}` }
}

// ---------- stale review ----------

/** The source changed since it was inspected (`409 conflict`, reason `stale`): inspect again before installing. */
export function isStaleReview(error: unknown): boolean {
  const harnessError = toHarnessError(error)
  const reason = (harnessError.details as { reason?: unknown } | undefined)?.reason
  return harnessError.code === 'conflict' && reason === 'stale'
}
