// The install preview (`PluginInspection`, API.md 4.11; PLUGINS.md 12 "Flow" step 1): what the host validated
// (`PluginHost.inspectDirectory`) plus what the user needs to review before installing: the hosts the plugin talks
// to, the secrets it asks for, its advisory permissions and warnings (code, programs it starts, plain HTTP, private
// network addresses, updates / downgrades, source conflicts, incompatibility, linked folders).
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import type { PluginInspection, PluginSource } from '@harness-forge/shared'
import type { PluginDirectoryInspection } from '../types.ts'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { applyDeclarativeProviderDefaults } from '@harness-forge/shared'
import semver from 'semver'

export type InstallSourceKind = Exclude<PluginSource, 'builtin' | 'created'>

/** The installed plugin an install would update (`PluginInspection.existing`). */
export type ExistingPlugin = NonNullable<PluginInspection['existing']>

const MAX_COMMAND_CHARS = 200

const SOURCE_LABELS: Record<PluginSource, string> = {
  builtin: 'the core plugins',
  created: 'the plugin editor',
  zip: 'a zip upload',
  npm: 'npm',
  url: 'a URL',
  link: 'a linked folder',
  copy: 'a copied folder',
  github: 'GitHub',
  marketplace: 'a marketplace',
}

/** "a zip upload", "npm", ... (messages). */
export function sourceLabel(source: PluginSource): string {
  return SOURCE_LABELS[source]
}

function clip(text: string, max = MAX_COMMAND_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/** `host[:port]` of an http(s) URL; the raw authority when it is templated (`{{settings.host}}`). */
function hostOf(url: string): { host: string, http: boolean } | null {
  const authority = url.match(/^(https?):\/\/([^/?#]*)/i)
  if (!authority)
    return null
  const http = authority[1]!.toLowerCase() === 'http'
  const raw = authority[2] ?? ''
  if (raw.includes('{{'))
    return { host: raw, http }
  try {
    return { host: new URL(url.replace(/\{\{[^{}]*\}\}/g, 'x')).host, http }
  }
  catch {
    return { host: raw, http }
  }
}

/** Loopback, private (RFC 1918), link-local, CGNAT, ULA and `.local` / `localhost` names. */
export function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1').toLowerCase()
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name === '::1' || name === '0.0.0.0')
    return true
  const v4 = name.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  return /^f[cd][\da-f]{2}:/.test(name) || /^fe[89ab][\da-f]:/.test(name)
}

interface HostReport {
  hosts: string[]
  plain: string[]
  local: string[]
}

function networkHosts(manifest: PluginManifest): HostReport {
  const urls: string[] = []
  for (const provider of manifest.contributes?.providers ?? []) {
    urls.push(provider.baseURL)
    const listing = provider.listModels
    if (typeof listing === 'object' && listing.path !== undefined && !listing.path.startsWith('/'))
      urls.push(listing.path)
  }
  for (const server of manifest.contributes?.mcpServers ?? []) {
    if (server.transport.type !== 'stdio')
      urls.push(server.transport.url)
  }
  const hosts = new Set<string>()
  const plain = new Set<string>()
  const local = new Set<string>()
  for (const url of urls) {
    const parsed = hostOf(url)
    if (parsed === null)
      continue
    hosts.add(parsed.host)
    if (parsed.http)
      plain.add(parsed.host)
    if (isLocalHost(parsed.host))
      local.add(parsed.host)
  }
  return { hosts: [...hosts].sort(), plain: [...plain].sort(), local: [...local].sort() }
}

function secretsRequested(manifest: PluginManifest): string[] {
  const secrets: string[] = []
  for (const provider of manifest.contributes?.providers ?? []) {
    for (const field of applyDeclarativeProviderDefaults(provider).credentials) {
      if (field.type === 'secret')
        secrets.push(`${field.label} (${provider.name})`)
    }
  }
  for (const [key, property] of Object.entries(manifest.settings?.properties ?? {})) {
    if (property.type === 'string' && property.format === 'secret')
      secrets.push(`${property.title || key} (setting)`)
  }
  for (const server of manifest.contributes?.mcpServers ?? []) {
    const transport = server.transport
    if (transport.type === 'stdio') {
      for (const name of Object.keys(transport.env ?? {}))
        secrets.push(`${name} environment variable (${server.name})`)
    }
    else {
      for (const name of Object.keys(transport.headers ?? {}))
        secrets.push(`${name} header (${server.name})`)
    }
  }
  return [...new Set(secrets)]
}

function stdioCommands(manifest: PluginManifest): string[] {
  const commands: string[] = []
  for (const server of manifest.contributes?.mcpServers ?? []) {
    if (server.transport.type === 'stdio')
      commands.push(clip([server.transport.command, ...(server.transport.args ?? [])].join(' ')))
  }
  return commands
}

function versionWarning(existing: ExistingPlugin, next: string): string {
  const current = semver.valid(existing.version)
  if (current !== null && semver.valid(next) !== null) {
    if (semver.lt(next, current))
      return `Downgrades the installed version ${existing.version} to ${next}.`
    if (semver.eq(next, current))
      return `Reinstalls the installed version ${existing.version}.`
  }
  return `Replaces the installed version ${existing.version}.`
}

export interface InspectionInput {
  directory: PluginDirectoryInspection
  source: InstallSourceKind
  /** Resolved source shown in "I trust <source>": npm `name@version`, the URL, the folder realpath, the zip name. */
  sourceRef?: string
  existing: ExistingPlugin | null
  /** Notes of the source (npm deprecation, install scripts). */
  notes?: string[]
}

/** Builds the preview of a staged (or linked) plugin. */
export function buildInspection(input: InspectionInput): PluginInspection {
  const { directory, source, existing } = input
  const manifest = directory.manifest
  const report = networkHosts(manifest)
  const warnings: string[] = []

  if (directory.kind === 'code')
    warnings.push('Runs code with full server privileges.')
  for (const command of stdioCommands(manifest))
    warnings.push(`Starts a program on your server: ${command}`)
  for (const host of report.plain)
    warnings.push(`Sends requests over unencrypted HTTP to ${host}.`)
  for (const host of report.local)
    warnings.push(`Connects to a local or private network address: ${host}.`)
  if (!directory.compatible)
    warnings.push(`Needs plugin API ${manifest.engines.harness}; this server provides ${PLUGIN_API_VERSION}. It cannot be installed.`)
  if (existing !== null) {
    if (existing.source === source)
      warnings.push(versionWarning(existing, manifest.version))
    else
      warnings.push(`A plugin with the id "${manifest.id}" is installed from ${sourceLabel(existing.source)}; uninstall it first.`)
  }
  if (source === 'link')
    warnings.push('Linked folder: file changes reload the plugin without another trust review.')
  warnings.push(...(input.notes ?? []))

  return {
    manifest,
    kind: directory.kind,
    // Phase 12 (C40 compile fix): harness plugins only until the Claude Code format lands (W12.1 / W12.2).
    format: 'harness',
    source,
    ...(input.sourceRef === undefined || input.sourceRef === '' ? {} : { sourceRef: input.sourceRef }),
    sha256: directory.sha256,
    contributions: directory.contributions,
    networkHosts: report.hosts,
    secretsRequested: secretsRequested(manifest),
    permissions: [...(manifest.permissions ?? [])],
    requiresTrust: directory.requiresTrust,
    compatible: directory.compatible,
    existing,
    files: directory.files,
    warnings,
    claude: null,
  }
}
