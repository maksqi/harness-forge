// Test helpers of the home-folder import (W12.3): the fake Claude Code home of the C45 builders written into a
// `realpath(mkdtemp())` folder (never the real `~/.claude`), the same home as the parts a browser upload sends and as a
// zip, a recording `McpManager` (no client, no network: the inputs it received are kept for assertions, values
// included, so a test can prove where a `${VAR}` came from) and an event recorder.
import type { ClaudeImportPlan, McpServer, McpServerInput, McpServerUpdate, ServerEvent } from '@harness-forge/shared'
import type { McpManager } from '../../mcp/types.ts'
import type { FixtureTree } from '../../testing/claude-fixtures.ts'
import type { AppDeps } from '../../types.ts'
import type { ClaudeImportUploadFile, ClaudeImportUploadInput } from './types.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessError, isClaudeHomeImportPath } from '@harness-forge/shared'
import { zipOf } from '../../plugins/install/testing.ts'
import { CLAUDE_HOME_CANARY_PREFIX, fakeClaudeHomeFiles, writeFileTree } from '../../testing/claude-fixtures.ts'

const cleanups: Array<() => Promise<void>> = []

/** A fresh canonical temp folder, removed by `cleanupImportFixtures()`. */
export async function tempFolder(prefix = 'hf-import-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

export async function cleanupImportFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
}

export interface FakeHome {
  /** The folder holding `.claude/` and `.claude.json` (the user's home). */
  readonly home: string
  /** `HF_CLAUDE_HOME`: `<home>/.claude`. */
  readonly claudeHome: string
  readonly tree: FixtureTree
}

/** Writes the fake home (`fakeClaudeHomeFiles()`, or `tree`) into a temp folder. */
export async function writeFakeHome(tree: FixtureTree = fakeClaudeHomeFiles()): Promise<FakeHome> {
  const home = await tempFolder('hf-claude-home-')
  await writeFileTree(home, tree)
  return { home, claudeHome: join(home, '.claude'), tree }
}

function blobOf(content: string | Uint8Array): Blob {
  return new Blob([typeof content === 'string' ? content : new Uint8Array(content)])
}

/**
 * The upload of a picked `.claude` folder as the browser sends it: the allowlisted files (`pickClaudeFiles`: paths
 * relative to the folder; a `.claude.json` inside is not `~/.claude.json`) and `~/.claude.json` in its own part.
 */
export function uploadOfHome(tree: FixtureTree, label = '.claude'): ClaudeImportUploadInput {
  const files: ClaudeImportUploadFile[] = []
  for (const path of Object.keys(tree).sort()) {
    if (!path.startsWith('.claude/'))
      continue
    const relative = path.slice('.claude/'.length)
    if (relative !== '.claude.json' && isClaudeHomeImportPath(relative))
      files.push({ path: relative, file: blobOf(tree[path]!.content) })
  }
  const claudeJson = tree['.claude.json']
  return { label, files, ...(claudeJson === undefined ? {} : { claudeJson: blobOf(claudeJson.content) }) }
}

/** The whole fake home zipped as `.claude/…` (every file, canaries included) plus `.claude.json` at the zip root. */
export function zipOfHome(tree: FixtureTree): Uint8Array {
  const entries: Record<string, string | Uint8Array> = {}
  for (const [path, entry] of Object.entries(tree))
    entries[path] = entry.content
  return zipOf(entries)
}

/** The items of a plan without the fields that differ between intakes (none should): for equality checks. */
export function planItems(plan: ClaudeImportPlan): unknown[] {
  return plan.items.map(item => ({ key: item.key, kind: item.kind, name: item.name, status: item.status, actions: item.actions, warnings: item.warnings, executable: item.executable, variables: item.variables }))
}

/** True when `text` holds any canary of the fake home (`HF_CANARY-…`). */
export function hasCanary(text: string): boolean {
  return text.includes(CLAUDE_HOME_CANARY_PREFIX)
}

/** Every event of the app's bus from now on. */
export function recordEvents(deps: AppDeps): ServerEvent[] {
  const events: ServerEvent[] = []
  const subscription = deps.events.subscribe(event => events.push(event))
  cleanups.push(async () => subscription.dispose())
  return events
}

export interface RecordingMcpManager extends McpManager {
  /** Every `create` input, values included (never leaves the test). */
  readonly created: McpServerInput[]
  /** Every `update` call. */
  readonly updated: Array<{ id: string, patch: McpServerUpdate }>
  /** How often `requireFreshAuth` was asked for. */
  freshAuthCalls: number
}

const SET = { set: true, hint: null, source: 'stored' as const }

function serverDto(input: McpServerInput, pluginId = 'core-mcp'): McpServer {
  const transport: McpServer['transport'] = input.transport.type === 'stdio'
    ? { type: 'stdio', command: input.transport.command, args: [...(input.transport.args ?? [])], env: Object.fromEntries(Object.keys(input.transport.env ?? {}).map(name => [name, SET])) }
    : { type: input.transport.type, url: input.transport.url, headers: Object.fromEntries(Object.keys(input.transport.headers ?? {}).map(name => [name, SET])) }
  return {
    id: input.id,
    name: input.name,
    pluginId,
    editable: pluginId === 'core-mcp',
    transport,
    policy: input.policy ?? 'ask',
    enabled: input.enabled ?? true,
    status: 'disabled',
    error: null,
    tools: [],
    connectedAt: null,
  }
}

/** An `McpManager` that keeps servers in memory (see the module comment); `pluginServers` are not editable. */
export function createRecordingMcpManager(pluginServers: readonly McpServerInput[] = []): RecordingMcpManager {
  const servers = new Map<string, McpServer>(pluginServers.map(input => [input.id, serverDto(input, 'acme-plugin')]))
  const manager: RecordingMcpManager = {
    created: [],
    updated: [],
    freshAuthCalls: 0,
    start: async () => {},
    stop: async () => {},
    list: async () => [...servers.values()],
    get: async (id) => {
      const server = servers.get(id)
      if (server === undefined)
        throw new HarnessError({ code: 'not_found', message: `Unknown MCP server "${id}".` })
      return server
    },
    create: async (input, sensitive) => {
      if (input.transport.type === 'stdio' && sensitive !== undefined) {
        manager.freshAuthCalls += 1
        sensitive.requireFreshAuth()
      }
      if (servers.has(input.id))
        throw new HarnessError({ code: 'conflict', message: `The id "${input.id}" is taken.`, details: { reason: 'exists' } })
      manager.created.push(input)
      const server = serverDto(input)
      servers.set(input.id, server)
      return server
    },
    update: async (id, patch, sensitive) => {
      const current = servers.get(id)
      if (current === undefined)
        throw new HarnessError({ code: 'not_found', message: `Unknown MCP server "${id}".` })
      if (!current.editable)
        throw new HarnessError({ code: 'forbidden', message: `The MCP server "${id}" is declared by a plugin.` })
      if (patch.transport?.type === 'stdio' && sensitive !== undefined) {
        manager.freshAuthCalls += 1
        sensitive.requireFreshAuth()
      }
      manager.updated.push({ id, patch })
      const transport = patch.transport === undefined
        ? undefined
        : serverDto({ id, name: current.name, transport: patch.transport as McpServerInput['transport'] }).transport
      const next: McpServer = { ...current, ...(patch.name === undefined ? {} : { name: patch.name }), ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }), ...(transport === undefined ? {} : { transport }) }
      servers.set(id, next)
      return next
    },
    remove: async (id) => {
      servers.delete(id)
    },
    reconnect: async id => manager.get(id),
  }
  return manager
}
