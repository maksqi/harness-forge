// The install preview (`PluginInspection`, API.md 4.11; PLUGINS.md 12 "Flow" step 1): what the host validated
// (`PluginHost.inspectDirectory`) plus what the user needs to review before installing: the hosts the plugin talks
// to, the secrets it asks for, its advisory permissions and warnings (code, programs it starts, plain HTTP, private
// network addresses, updates / downgrades, source conflicts, incompatibility, linked folders).
//
// Phase 12 (ADR-053 / ADR-054, W12.2): the inspection carries the format and, for a Claude Code plugin, the host's
// `claude` block (components, executables, hosts, `userConfig`, ignored parts, diagnostics: the web renders "Asks for:"
// and "Ignored:" from it). The warnings add what a Claude Code plugin can run (every command hook, stdio MCP server and
// `!` span, as written), the whole-tree pin sentence when it runs anything, the plain-HTTP and private hosts of its
// `claude.hosts`, "This plugin installs turned off." (`defaultEnabled: false`) and the conflicts of another format or
// origin holding the same id.
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import type { ClaudePluginInfo, PluginInspection, PluginSource } from '@harness-forge/shared'
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

function networkHosts(manifest: PluginManifest, claude: ClaudePluginInfo | null = null): HostReport {
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
  // Phase 12: the hosts a Claude Code plugin's reader found (http MCP servers, declared URLs): host names, or URLs.
  for (const entry of claude?.hosts ?? []) {
    const parsed = /^[a-z][\d+.a-z-]*:\/\//i.test(entry) ? hostOf(entry) : { host: entry, http: false }
    if (parsed === null || parsed.host === '')
      continue
    hosts.add(parsed.host)
    if (parsed.http)
      plain.add(parsed.host)
    if (isLocalHost(parsed.host))
      local.add(parsed.host)
  }
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
  /**
   * Resolved source shown in "I trust <source>": npm `name@version`, the URL, the folder realpath, the zip name; Phase 12:
   * `owner/repo@<sha12>[/path]` (GitHub and GitHub-backed marketplace entries).
   */
  sourceRef?: string
  existing: ExistingPlugin | null
  /** Notes of the source (npm deprecation, install scripts). */
  notes?: string[]
  /**
   * Phase 12: why the installed plugin of the same id blocks this install (another source, format or origin); null or
   * absent when an install would update it.
   */
  conflict?: string | null
  /** Phase 12: a Claude Code plugin whose `defaultEnabled` is false (it installs turned off unless asked otherwise). */
  installsDisabled?: boolean
}

/** The warning of a Claude Code plugin that runs anything (UI.md 8.13). */
export const CLAUDE_TREE_PIN_WARNING = 'The files are pinned as a whole: editing any file of the plugin asks for your trust again.'
/** The warning of a Claude Code plugin with `defaultEnabled: false` (UI.md 8.13). */
export const INSTALLS_DISABLED_WARNING = 'This plugin installs turned off.'

/** One warning per thing a Claude Code plugin can run (the trust consent lists the same items). */
function claudeExecutableWarnings(claude: ClaudePluginInfo): string[] {
  return claude.executables.map((executable) => {
    const command = clip(executable.command)
    switch (executable.kind) {
      case 'mcp':
        return `Starts a program on your server (MCP server ${clip(executable.label, 80)}): ${command}`
      case 'span':
        return `Runs a shell command when ${clip(executable.label, 80)} is used: ${command}`
      default:
        return `Runs a command on your server (${clip(executable.label, 80)} hook): ${command}`
    }
  })
}

/** Builds the preview of a staged (or linked) plugin. */
export function buildInspection(input: InspectionInput): PluginInspection {
  const { directory, source, existing } = input
  const manifest = directory.manifest
  const claude = directory.format === 'claude' ? directory.claude : null
  const report = networkHosts(manifest, claude)
  const warnings: string[] = []

  if (directory.kind === 'code')
    warnings.push('Runs code with full server privileges.')
  for (const command of stdioCommands(manifest))
    warnings.push(`Starts a program on your server: ${command}`)
  if (claude !== null) {
    warnings.push(...claudeExecutableWarnings(claude))
    if (directory.requiresTrust)
      warnings.push(CLAUDE_TREE_PIN_WARNING)
  }
  for (const host of report.plain)
    warnings.push(`Sends requests over unencrypted HTTP to ${host}.`)
  for (const host of report.local)
    warnings.push(`Connects to a local or private network address: ${host}.`)
  if (!directory.compatible)
    warnings.push(`Needs plugin API ${manifest.engines.harness}; this server provides ${PLUGIN_API_VERSION}. It cannot be installed.`)
  if (existing !== null) {
    if (existing.source !== source)
      warnings.push(`A plugin with the id "${manifest.id}" is installed from ${sourceLabel(existing.source)}; uninstall it first.`)
    else if (input.conflict !== undefined && input.conflict !== null)
      warnings.push(input.conflict)
    else
      warnings.push(versionWarning(existing, manifest.version))
  }
  if (source === 'link')
    warnings.push('Linked folder: file changes reload the plugin without another trust review.')
  if (claude !== null && input.installsDisabled === true && existing === null)
    warnings.push(INSTALLS_DISABLED_WARNING)
  warnings.push(...(input.notes ?? []))

  return {
    manifest,
    kind: directory.kind,
    format: directory.format,
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
    claude,
  }
}
