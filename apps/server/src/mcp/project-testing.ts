// Test helpers of the project MCP manager tests (imported by `*.test.ts` only; W11.4): a test app with the real manager
// (short delays), the C36 fakes of the project config reader and of project trust, a recording event bus and one
// project folder in a temp workspace root; `.mcp.json` items of the dependency-free stdio fixture `mcp-min.mjs` and of
// http fixtures on 127.0.0.1 (never a remote URL).
import type { McpJsonRemoteServer, ProjectSummary } from '@harness-forge/shared'
import type { BuiltinPlugin } from '../plugins/types.ts'
import type { ProjectMcpServerItem } from '../services/project-config/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeProjectConfigService } from '../testing/fake-project-config.ts'
import type { FakeProjectTrustService } from '../testing/fake-project-trust.ts'
import type { RecordingEventBus } from '../testing/fakes.ts'
import type { ProjectMcpManagerOptions } from './project.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeProjectConfigService, fakeProjectConfigSnapshot, fakeProjectMcpServerItem } from '../testing/fake-project-config.ts'
import { createRecordingEventBus } from '../testing/fakes.ts'
import { MCP_MIN_PATH } from './__fixtures__/harness.ts'
import { createProjectMcpManagerCore } from './project.ts'

export interface ProjectMcpTestApp {
  t: TestApp
  events: RecordingEventBus
  config: FakeProjectConfigService
  trust: FakeProjectTrustService
  /** The project (its folder is a fresh temp folder inside the workspace root). */
  project: ProjectSummary
  /** A second project without servers. */
  other: ProjectSummary
  /** A temp folder outside the projects (pid files). */
  scratch: string
  /** Sets the project's `.mcp.json` servers (the snapshot root is the project folder). */
  setServers: (items: readonly ProjectMcpServerItem[], projectId?: string) => void
  /** Approves items through the fake trust service (emits `project-trust.changed`). */
  approve: (...items: readonly ProjectMcpServerItem[]) => Promise<void>
  /** Revokes an item through the fake trust service (emits `project-trust.changed`). */
  revoke: (item: ProjectMcpServerItem) => Promise<void>
  close: () => Promise<void>
}

export interface ProjectMcpTestAppOptions {
  env?: Record<string, string | undefined>
  manager?: ProjectMcpManagerOptions
  /** Default: none. */
  builtins?: readonly BuiltinPlugin[]
  /** Use the real hook service etc.: only the project MCP pieces are replaced (default true: `hooks: 'fake'`). */
  fakeHooks?: boolean
}

export async function createProjectMcpTestApp(options: ProjectMcpTestAppOptions = {}): Promise<ProjectMcpTestApp> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hf-pmcp-')))
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'hf-pmcp-scratch-')))
  const events = createRecordingEventBus()
  const config = createFakeProjectConfigService()
  let t: TestApp
  try {
    t = await createTestApp({
      ...(options.builtins === undefined ? { builtins: [] } : { builtins: options.builtins }),
      env: options.env,
      workspaceRoots: [root],
      projectConfig: config,
      projectTrust: 'fake',
      ...(options.fakeHooks === false ? {} : { hooks: 'fake' as const }),
      overrides: { events },
      factories: {
        projectMcp: deps => createProjectMcpManagerCore(deps, { eventDelayMs: 5, reconcileDelayMs: 10, killGraceMs: 500, connectTimeoutMs: 15_000, ...options.manager }),
      },
    })
  }
  catch (error) {
    await rm(root, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
    throw error
  }
  const project = await t.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })
  const other = await t.deps.projects.create({ name: 'Other', path: root, newFolder: 'other' })
  const trust = t.deps.projectTrust as FakeProjectTrustService
  let closed = false
  return {
    t,
    events,
    config,
    trust,
    project,
    other,
    scratch,
    setServers: (items, projectId = project.id) => {
      const path = projectId === other.id ? other.path : project.path
      config.snapshots.set(projectId, fakeProjectConfigSnapshot(projectId, { root: path, mcpServers: [...items] }))
    },
    approve: async (...items) => {
      await trust.approve(project.id, items.map(item => ({ kind: 'mcp' as const, sha256: item.sha256 })))
    },
    revoke: async (item) => {
      await trust.revoke(project.id, item.sha256)
    },
    close: async () => {
      if (closed)
        return
      closed = true
      try {
        await t.close()
      }
      finally {
        await rm(root, { recursive: true, force: true })
        await rm(scratch, { recursive: true, force: true })
      }
    },
  }
}

/** A `.mcp.json` stdio item running `mcp-min.mjs` with the current Node binary (`args` and `env` as written). */
export function minServerItem(name: string, args: readonly string[] = [], env: Readonly<Record<string, string>> = {}): ProjectMcpServerItem {
  return fakeProjectMcpServerItem(name, { type: 'stdio', command: process.execPath, args: [MCP_MIN_PATH, ...args], env: { ...env } })
}

/** A `.mcp.json` http / sse item. */
export function remoteServerItem(name: string, url: string, headers: Readonly<Record<string, string>> = {}, type: McpJsonRemoteServer['type'] = 'http'): ProjectMcpServerItem {
  return fakeProjectMcpServerItem(name, { type, url, headers: { ...headers } })
}

/** Kills leftover fixture processes (a failed assertion must not leave one behind). */
export function killAll(pids: Iterable<number | null>): void {
  for (const pid of pids) {
    if (pid === null)
      continue
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {}
  }
}
