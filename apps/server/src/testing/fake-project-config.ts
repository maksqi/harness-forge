// Test double of the project config reader (Phase 11, C36-T10), so the hook service, project trust and the project MCP
// manager can be tested against project items the test controls, without settings files:
//
//   const t = await createTestApp({ projectConfig: 'fake' })   // or overrides: { projectConfig: createFakeProjectConfigService() }
//   const fake = t.deps.projectConfig as FakeProjectConfigService
//   const hook = fakeProjectHookItem({ event: 'PreToolUse', matcher: 'Bash', command: 'sh .claude/hooks/guard.sh' })
//   fake.snapshots.set(projectId, fakeProjectConfigSnapshot(projectId, { hooks: [hook] }))
//   await fake.verify(projectId, hook)                            // true
//   fake.changed.add(hook.sha256)                                 // a referenced file changed: verify answers false
//
// `snapshot` answers the snapshot set for the project (any id is a project), else an available folder without items.
// `verify` answers true when the item's hash still equals the sha256 of `trustHashInput(item.hashItem)` (the real
// hash, so a tampered `hashItem` fails) and the hash is not in `changed`; it never reads a file. Every call is counted.
import type { HookSpec, McpJsonRemoteServer, McpJsonStdioServer } from '@harness-forge/shared'
import type { ProjectConfigService, ProjectConfigSnapshot, ProjectHookItem, ProjectMcpServerItem, TrustSubject } from '../services/project-config/types.ts'
import { mcpServerIdFromName } from '@harness-forge/shared'
import { emptyProjectConfigSnapshot, trustSha256 } from '../services/project-config/index.ts'

/** The root of fake snapshots (never read). */
export const FAKE_PROJECT_ROOT = '/srv/projects/fake'

/**
 * A project hook item of `.claude/settings.json` with its real trust hash (no referenced files unless `fields.refs`
 * are given through `hashItem`); `spec` fields default to an every-target `PreToolUse` hook without a timeout.
 */
export function fakeProjectHookItem(spec: Partial<HookSpec> & { readonly command: string }, fields: Partial<Pick<ProjectHookItem, 'path' | 'label' | 'warnings'>> & { readonly refs?: ProjectHookItem['hashItem']['refs'] } = {}): ProjectHookItem {
  const path = fields.path ?? spec.file ?? '.claude/settings.json'
  const full: HookSpec = { event: 'PreToolUse', matcher: null, timeoutSec: null, position: [0, 0], ...spec, file: path }
  const hashItem: ProjectHookItem['hashItem'] = { kind: 'hook', event: full.event, matcher: full.matcher, command: full.command, timeoutSec: full.timeoutSec, refs: fields.refs ?? [] }
  return {
    kind: 'hook',
    sha256: trustSha256(hashItem),
    hashItem,
    spec: full,
    path,
    label: fields.label ?? full.command.slice(0, 200),
    warnings: fields.warnings ?? [],
  }
}

/**
 * A `.mcp.json` server item with its real trust hash: `transport` defaults to a stdio server `node server.mjs`; the id
 * comes from the name (`mcpServerIdFromName`); `raw` is the transport as written.
 */
export function fakeProjectMcpServerItem(name: string, transport: McpJsonStdioServer | McpJsonRemoteServer = { type: 'stdio', command: 'node', args: ['server.mjs'], env: {} }, fields: Partial<Pick<ProjectMcpServerItem, 'path' | 'label' | 'warnings'>> & { readonly id?: string } = {}): ProjectMcpServerItem {
  const raw = transport.type === 'stdio'
    ? { command: transport.command, args: [...transport.args], env: { ...transport.env } }
    : { type: transport.type, url: transport.url, headers: { ...transport.headers } }
  const hashItem: ProjectMcpServerItem['hashItem'] = { kind: 'mcp', name, server: raw, refs: [] }
  return {
    kind: 'mcp',
    sha256: trustSha256(hashItem),
    hashItem,
    server: { name, id: fields.id ?? mcpServerIdFromName(name, new Set()), transport, raw },
    path: fields.path ?? '.mcp.json',
    label: fields.label ?? name,
    warnings: fields.warnings ?? [],
  }
}

/** A snapshot of an available folder (`FAKE_PROJECT_ROOT`) holding `fields`; the files read follow the items. */
export function fakeProjectConfigSnapshot(projectId: string, fields: Partial<Omit<ProjectConfigSnapshot, 'projectId'>> = {}): ProjectConfigSnapshot {
  const base = emptyProjectConfigSnapshot(projectId, { available: true, issue: null, root: FAKE_PROJECT_ROOT }, fields.scannedAt ?? Date.now())
  const hooks = fields.hooks ?? []
  const mcpServers = fields.mcpServers ?? []
  return {
    ...base,
    settingsFiles: [...new Set(hooks.map(item => item.path))],
    mcpFile: mcpServers.length > 0,
    ...fields,
    hooks,
    mcpServers,
  }
}

export interface FakeProjectConfigServiceOptions {
  /** Snapshots per project id. */
  snapshots?: Readonly<Record<string, ProjectConfigSnapshot>>
  /** Clock of the default snapshots (epoch ms; default `Date.now`). */
  now?: () => number
}

export interface FakeProjectConfigService extends ProjectConfigService {
  /** Snapshots per project id; tests may edit them at any time (no cache). */
  readonly snapshots: Map<string, ProjectConfigSnapshot>
  /** Hashes whose items changed since the scan: `verify` answers false for them. */
  readonly changed: Set<string>
  /** Every `verify` call, in order. */
  readonly verified: Array<{ projectId: string, sha256: string }>
  /** Every `snapshot` call, in order (`refresh` as given). */
  readonly reads: Array<{ projectId: string, refresh: boolean }>
  /** Number of calls of each member. */
  readonly calls: Record<keyof ProjectConfigService, number>
  /** Every `invalidate` argument, in order. */
  readonly invalidated: Array<string | null>
}

export function createFakeProjectConfigService(options: FakeProjectConfigServiceOptions = {}): FakeProjectConfigService {
  const now = options.now ?? Date.now
  const snapshots = new Map(Object.entries(options.snapshots ?? {}))
  const changed = new Set<string>()
  const verified: Array<{ projectId: string, sha256: string }> = []
  const reads: Array<{ projectId: string, refresh: boolean }> = []
  const invalidated: Array<string | null> = []
  const calls: Record<keyof ProjectConfigService, number> = { snapshot: 0, verify: 0, invalidate: 0, stop: 0 }
  return {
    snapshots,
    changed,
    verified,
    reads,
    calls,
    invalidated,
    snapshot: async (projectId, snapshotOptions) => {
      calls.snapshot += 1
      reads.push({ projectId, refresh: snapshotOptions?.refresh === true })
      snapshotOptions?.signal?.throwIfAborted()
      return snapshots.get(projectId) ?? emptyProjectConfigSnapshot(projectId, { available: true, issue: null, root: FAKE_PROJECT_ROOT }, now())
    },
    verify: async (projectId, item: TrustSubject, signal) => {
      calls.verify += 1
      verified.push({ projectId, sha256: item.sha256 })
      signal?.throwIfAborted()
      return !changed.has(item.sha256) && trustSha256(item.hashItem) === item.sha256
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
