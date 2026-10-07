// Test helpers of the marketplace service and the GitHub / marketplace install sources (Phase 12, W12.2; not app
// code). Nothing here touches the network: GitHub, archive hosts and the npm registry come from the in-memory fake
// remote (`testing/fake-remote.ts`) through `createFakeSafeFetch` and a `fetch` over the same routes.
//
// - `createSourcesTestApp(options)`: an in-process app whose installer and marketplace service use the fake remote,
//   with recording events, an in-memory secret store and fake icons. With `fakeClaude: true` (the default) the plugin
//   host reads Claude Code plugins with `fakeClaudeInspection` (`withFakeClaudeReader`): the real reader is W12.1's
//   (`plugins/claude/reader.ts`, behind `PluginHost.inspectDirectory`); the installer only depends on the frozen
//   signature, so these tests use a small stand-in with the same contract (a synthesized manifest, the id from
//   `claudePluginId`, a whole-tree hash over paths, modes, sizes, contents and the overlay, `requiresTrust` for command
//   hooks, stdio MCP servers and `!` spans). The real round trips are probed at the gate.
// - `npmFetchOver(routes)`: a `fetch` serving `https://registry.npmjs.org/…` from the routes (the npm pipeline uses
//   `fetch`, not `safeFetch`).
import type { PluginDetail, PluginState, PluginSummary } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeRemoteRoutes, FakeSafeFetch } from '../../testing/fake-remote.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import type { AppDeps } from '../../types.ts'
import type { InstallerOptions } from '../install/index.ts'
import type { InspectDirectoryOptions, PluginDirectoryInspection, PluginHost, PluginRecord } from '../types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalJson,
  claudePluginId,
  HarnessError,
  isReservedPluginId,
  mergeEntryOverlay,
  parseClaudePluginManifest,
} from '@harness-forge/shared'
import semver from 'semver'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeRemoteRoutes, createFakeSafeFetch } from '../../testing/fake-remote.ts'
import { createFakeIconService, createMemorySecretStore, createRecordingEventBus } from '../../testing/fakes.ts'
import { createPluginHost } from '../host.ts'
import { createInstaller } from '../install/index.ts'
import { createMarketplaceService } from './index.ts'

// ---------- the stand-in Claude Code reader ----------

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

interface TreeFile {
  path: string
  mode: 0o755 | 0o644
  data: Uint8Array
}

/** Every regular file below `dir` (sorted by path); a link or special file is a `validation_error`. */
async function treeOf(dir: string): Promise<TreeFile[]> {
  const files: TreeFile[] = []
  const walk = async (folder: string, relative: string): Promise<void> => {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name)
      const shown = relative === '' ? name : `${relative}/${name}`
      const info = await lstat(path)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new HarnessError({ code: 'validation_error', message: `The plugin contains a link or a special file: ${shown}.` })
      if (info.isDirectory())
        await walk(path, shown)
      else
        files.push({ path: shown, mode: (info.mode & 0o100) !== 0 ? 0o755 : 0o644, data: new Uint8Array(await readFile(path)) })
    }
  }
  await walk(dir, '')
  return files.sort((a, b) => (Buffer.from(a.path) < Buffer.from(b.path) ? -1 : 1))
}

const text = (data: Uint8Array): string => new TextDecoder().decode(data)

/**
 * The stand-in of W12.1's `readClaudePluginDirectory` behind `inspectDirectory(dir, { format: 'claude', … })` (see the
 * module comment): enough of the contract for the installer and marketplace tests.
 */
export async function fakeClaudeInspection(dir: string, options: InspectDirectoryOptions = {}): Promise<PluginDirectoryInspection> {
  const files = await treeOf(dir)
  const byPath = new Map(files.map(file => [file.path, file]))
  const manifestFile = byPath.get('.claude-plugin/plugin.json')
  const own = manifestFile === undefined ? null : parseClaudePluginManifest(text(manifestFile.data)).manifest
  const overlay = options.overlay
  const merged = overlay === undefined ? own : mergeEntryOverlay(own, { ...overlay, source: { kind: 'unknown' }, supported: true, tags: [] }).manifest
  const name = merged?.name ?? overlay?.name ?? options.nameHint ?? 'plugin'
  const id = claudePluginId(name, { digest: sha256, isReserved: isReservedPluginId })
  const rawVersion = merged?.version ?? options.versionHint ?? '0.0.0'
  const version = semver.valid(rawVersion) ?? `0.0.0+${rawVersion.replace(/[^\dA-Z-]+/gi, '-').replace(/^-+|-+$/g, '') || 'x'}`
  const hooks = byPath.get('hooks/hooks.json')
  const mcp = byPath.get('.mcp.json')
  const commands = files.filter(file => file.path.startsWith('commands/') && file.path.endsWith('.md'))
  const executables = [
    ...(hooks !== undefined && text(hooks.data).includes('"command"') ? [{ kind: 'hook' as const, label: 'hooks/hooks.json', command: '(hook commands)' }] : []),
    ...(mcp !== undefined && text(mcp.data).includes('"command"') ? [{ kind: 'mcp' as const, label: '.mcp.json', command: '(stdio servers)' }] : []),
    ...commands.filter(file => text(file.data).includes('!`')).map(file => ({ kind: 'span' as const, label: file.path, command: '(! spans)' })),
  ]
  const hash = createHash('sha256').update('fake-claude-plugin/v1\0')
  for (const file of files)
    hash.update(`F\0${file.path}\0${file.mode === 0o755 ? '755' : '644'}\0${file.data.byteLength}\0`).update(sha256(file.data))
  if (overlay !== undefined)
    hash.update(`O\0${canonicalJson(overlay)}`)
  const count = (prefix: string, suffix: string): number => files.filter(file => file.path.startsWith(prefix) && file.path.endsWith(suffix)).length
  return {
    manifest: {
      manifestVersion: 1,
      id,
      name: name.slice(0, 64),
      version,
      engines: { harness: '^1.6.0' },
      ...(merged?.description === undefined ? {} : { description: merged.description.slice(0, 280) }),
    },
    kind: 'declarative',
    sha256: hash.digest('hex'),
    requiresTrust: executables.length > 0,
    compatible: true,
    reserved: isReservedPluginId(id),
    contributions: { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] },
    files: { count: files.length, bytes: files.reduce((sum, file) => sum + file.data.byteLength, 0) },
    format: 'claude',
    claude: {
      name: name.slice(0, 128),
      version: merged?.version ?? options.versionHint ?? null,
      namespace: id,
      components: {
        commands: commands.length,
        agents: count('agents/', '.md'),
        skills: count('skills/', '/SKILL.md') + (byPath.has('SKILL.md') ? 1 : 0),
        outputStyles: count('output-styles/', '.md'),
        hooks: hooks === undefined ? 0 : 1,
        mcpServers: mcp === undefined ? 0 : 1,
      },
      executables,
      hosts: [],
      userConfig: [],
      unsupported: byPath.has('.lsp.json') ? [{ component: '.lsp.json', reason: 'LSP servers aren\'t supported' }] : [],
      diagnostics: [],
    },
  }
}

/**
 * The real plugin host with Claude Code plugins handled by the stand-in reader: `inspectDirectory` with `format:
 * 'claude'`, and `load` / `get` / `summary` / `state` / `list` / `unload` / `forget` / `uninstall` / `trust` of rows
 * whose format is `claude` (state: `disabled` when not enabled, `untrusted` when it runs anything without a matching
 * pin, else `active`; `plugin.changed` on every load). Everything else goes to the real host.
 */
export function withFakeClaudeReader(host: PluginHost, deps: AppDeps): PluginHost {
  const states = new Map<string, PluginState>()

  async function claudeRecord(id: string): Promise<PluginRecord | null> {
    const record = await host.record(id)
    return record?.format === 'claude' ? record : null
  }

  async function detailOf(record: PluginRecord): Promise<PluginDetail> {
    const dir = join(deps.env.paths.plugins, record.id)
    const overlay = record.origin?.kind === 'marketplace' ? record.origin.overlay : undefined
    const read = await fakeClaudeInspection(dir, overlay === undefined ? {} : { overlay })
    const trusted = !read.requiresTrust || record.trustedHash === read.sha256
    const state: PluginState = !record.enabled ? 'disabled' : trusted ? 'active' : 'untrusted'
    states.set(record.id, state)
    const origin = record.origin === null ? null : (({ overlay: _overlay, ...rest }) => rest)(record.origin as typeof record.origin & { overlay?: unknown })
    return {
      id: record.id,
      name: read.manifest.name,
      version: record.version,
      description: read.manifest.description ?? null,
      icon: null,
      kind: 'declarative',
      format: 'claude',
      source: record.source,
      sourceRef: record.sourceRef,
      builtin: false,
      removable: true,
      enabled: record.enabled,
      state,
      runsCode: read.requiresTrust,
      contributions: read.contributions,
      lastError: null,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      manifest: read.manifest,
      trust: { required: read.requiresTrust, trusted, hash: read.sha256, trustedHash: record.trustedHash },
      editable: false,
      hasSettings: false,
      origin: origin as PluginDetail['origin'],
      claude: read.claude,
    }
  }

  function summaryOf(detail: PluginDetail): PluginSummary {
    const { manifest: _m, trust: _t, editable: _e, hasSettings: _h, origin: _o, claude: _c, ...summary } = detail
    return summary
  }

  async function load(record: PluginRecord): Promise<PluginDetail> {
    const detail = await detailOf(record)
    deps.events.emit('plugin.changed', { id: record.id, plugin: summaryOf(detail) })
    return detail
  }

  return {
    ...host,
    inspectDirectory: async (dir, options) => options?.format === 'claude' ? fakeClaudeInspection(dir, options) : host.inspectDirectory(dir, options),
    load: async (id) => {
      const record = await claudeRecord(id)
      return record === null ? host.load(id) : load(record)
    },
    get: async (id) => {
      const record = await claudeRecord(id)
      return record === null ? host.get(id) : detailOf(record)
    },
    summary: async (id) => {
      const record = await claudeRecord(id)
      return record === null ? host.summary(id) : summaryOf(await detailOf(record))
    },
    state: id => states.get(id) ?? host.state(id),
    isActive: id => (states.has(id) ? states.get(id) === 'active' : host.isActive(id)),
    list: async () => {
      const summaries = await host.list()
      const claude: PluginSummary[] = []
      for (const id of states.keys()) {
        const record = await claudeRecord(id)
        if (record !== null)
          claude.push(summaryOf(await detailOf(record)))
      }
      return [...summaries.filter(summary => !states.has(summary.id)), ...claude]
    },
    unload: async id => (states.has(id) ? undefined : host.unload(id)),
    forget: async (id) => {
      states.delete(id)
      await host.forget(id)
    },
    uninstall: async (id, options) => {
      if (!states.has(id))
        return host.uninstall(id, options)
      states.delete(id)
      await rm(join(deps.env.paths.plugins, id), { recursive: true, force: true })
      await host.forget(id)
      deps.events.emit('plugin.changed', { id, plugin: null })
    },
    enable: async (id) => {
      const record = await claudeRecord(id)
      if (record === null)
        return host.enable(id)
      return load(await host.saveRecord({ id, source: record.source as Exclude<PluginRecord['source'], 'builtin'>, version: record.version, enabled: true }))
    },
    disable: async (id) => {
      const record = await claudeRecord(id)
      if (record === null)
        return host.disable(id)
      return load(await host.saveRecord({ id, source: record.source as Exclude<PluginRecord['source'], 'builtin'>, version: record.version, enabled: false }))
    },
    trust: async (id, sha256Value) => {
      const record = await claudeRecord(id)
      if (record === null)
        return host.trust(id, sha256Value)
      const current = await detailOf(record)
      if (current.trust.hash !== sha256Value)
        throw new HarnessError({ code: 'conflict', message: 'The plugin changed since it was inspected.', details: { reason: 'stale' } })
      return load(await host.saveRecord({ id, source: record.source as Exclude<PluginRecord['source'], 'builtin'>, version: record.version, trustedHash: sha256Value }))
    },
  }
}

// ---------- network fakes ----------

/** A `fetch` that serves `https://<host>/…` from `routes` (the npm pipeline's registry requests); 502 for other hosts. */
export function npmFetchOver(routes: FakeRemoteRoutes): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value
    })
    const answer = routes.handle({ method: init?.method ?? 'GET', host: url.host, path: `${url.pathname}${url.search}`, headers })
    if (answer === null)
      return new Response('not served by the fake remote', { status: 502 })
    const body = answer.body instanceof Uint8Array ? answer.body : new Uint8Array(answer.body.zeros)
    return new Response(Buffer.from(body), { status: answer.status, headers: answer.headers })
  }
}

// ---------- the app ----------

export interface SourcesTestApp {
  readonly t: TestApp
  readonly events: RecordingEventBus
  readonly routes: FakeRemoteRoutes
  readonly fake: FakeSafeFetch
  readonly close: () => Promise<void>
}

export interface SourcesTestAppOptions {
  readonly env?: Record<string, string | undefined>
  readonly routes?: FakeRemoteRoutes
  /** Read Claude Code plugins with the stand-in reader (default true). */
  readonly fakeClaude?: boolean
  readonly installer?: InstallerOptions
}

/** An in-process app with the fake remote behind the installer and the marketplace service (see the module comment). */
export async function createSourcesTestApp(options: SourcesTestAppOptions = {}): Promise<SourcesTestApp> {
  const routes = options.routes ?? createFakeRemoteRoutes()
  const fake = createFakeSafeFetch(routes)
  const events = createRecordingEventBus()
  const t = await createTestApp({
    env: options.env,
    start: false,
    builtins: [],
    overrides: { events, secrets: createMemorySecretStore(), icons: createFakeIconService() },
    factories: {
      installer: deps => createInstaller(deps, { safeFetch: fake.safeFetch, fetch: npmFetchOver(routes), ...options.installer }),
      marketplaces: deps => createMarketplaceService(deps, { safeFetch: fake.safeFetch }),
      ...(options.fakeClaude === false ? {} : { plugins: (deps: AppDeps) => withFakeClaudeReader(createPluginHost(deps), deps) }),
    },
  })
  await t.deps.installer.recover()
  await t.deps.plugins.start()
  return { t, events, routes, fake, close: () => t.close() }
}
