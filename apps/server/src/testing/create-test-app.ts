// In-process test harness (AGENT.md "Prefer in-process tests"): the real composition (`createDeps`, `createApp`) over an
// in-memory database with migrations applied, a fresh temp data directory, a fake keyring and a memory logger.
//
//   const t = await createTestApp({ env: { HF_PASSWORD: 'secret' }, overrides: { events: createRecordingEventBus() } })
//   const res = await t.request('/api/settings')          // or: await t.client.settings.get()
//   await t.close()
//
// Phase 5 fakes (`./fakes.ts`): `overrides: { runs: createFakeChatRunner(), data: createFakeDataService(), shares:
// createFakeShareService() }`, `factories: { chats: createFakeChatsService, files: createFakeFilesService }`.
// Phase 6 fakes: `factories: { images: createFakeImageService, providers: fakeMediaProviders() }` (the latter from
// `providers/testing.ts`, with `env: { HF_MOCK_PROVIDER: '1' }` for the `mock:*` media models) and `overrides: { audio:
// createFakeAudioService() }`.
// Phase 7 (C14-T6): `workspaceRoots` / `workspaceShell` set `HF_WORKSPACE_ROOTS` / `HF_WORKSPACE_SHELL`, and
// `factories: { projects: createFakeProjectService }` (./fake-projects.ts) gives projects with real temp folders. The temp
// data directory is a canonical path (`realpath(mkdtemp())`: macOS `/var` is a link to `/private/var`), so
// `<dataDir>/workspaces` passes the workspace containment checks.
// Phase 8 (C19-T9): `checkpoints` / `shellRules` install a service (`'fake'`: `createFakeCheckpointService()` /
// `createFakeShellRuleService(deps)` of ./fake-checkpoints.ts and ./fake-shell-rules.ts); `overrides` and `factories` of
// the same name win.
// Phase 9 (C24-T5): `projectFiles` installs the mention file service (`'fake'`: `createFakeProjectFileService()` of
// ./fake-project-files.ts, or a ready service); `overrides` and `factories` of the same name win. `createFakeChatRunner`
// (./fakes.ts) has the steer queue members.
import type { ApiClient } from '@harness-forge/shared'
import type { Hono } from 'hono'
import type { Database, Db } from '../db/client.ts'
import type { ServiceFactories } from '../deps.ts'
import type { Env } from '../env.ts'
import type { AppEnv } from '../http/types.ts'
import type { MemoryLogger } from '../logger.ts'
import type { BuiltinPlugin } from '../plugins/types.ts'
import type { CheckpointService } from '../services/checkpoints/types.ts'
import type { ProjectFileService } from '../services/project-files/types.ts'
import type { ShellRuleService } from '../services/shell-rules/types.ts'
import type { AppDeps, AppServices } from '../types.ts'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiClient } from '@harness-forge/shared'
import { createApp } from '../app.ts'
import { getBuiltinPlugins } from '../builtin-plugins/index.ts'
import { openDatabase } from '../db/client.ts'
import { migrateDatabase } from '../db/migrate.ts'
import { createDeps, startDeps, stopDeps } from '../deps.ts'
import { ensureDataDir, loadEnv } from '../env.ts'
import { createMemoryLogger } from '../logger.ts'
import { createRedactor } from '../security/redact.ts'
import { createFakeCheckpointService } from './fake-checkpoints.ts'
import { createFakeProjectFileService } from './fake-project-files.ts'
import { createFakeShellRuleService } from './fake-shell-rules.ts'
import { createFakeKeyring } from './fakes.ts'

/** Base URL of the typed client and of relative `request()` paths. */
export const TEST_ORIGIN = 'http://127.0.0.1:8787'

export interface TestAppOptions {
  /**
   * Raw environment variables parsed by `loadEnv` (e.g. `{ HF_PASSWORD: 'secret', HF_MOCK_PROVIDER: '1',
   * ANTHROPIC_API_KEY: 'sk-test' }`); the real `process.env` is never read. `HF_DATA_DIR` defaults to `dataDir`.
   */
  env?: Record<string, string | undefined>
  /** Data directory; default: a fresh temp directory removed by `close()`. */
  dataDir?: string
  /**
   * Database file; default `:memory:`. Pass a file path (e.g. inside a shared `dataDir`) to test persistence across
   * two `createTestApp()` instances.
   */
  databasePath?: string
  /** Builtin plugins; default `getBuiltinPlugins(env)` (the real builtins, `mock` with `HF_MOCK_PROVIDER=1`). */
  builtins?: readonly BuiltinPlugin[]
  /**
   * Service replacements (fakes). `keyring` defaults to `createFakeKeyring()` unless `overrides.keyring` or
   * `factories.keyring` is given (`factories: { keyring: createKeyring }` tests the real keyring on the temp data dir).
   */
  overrides?: Partial<AppServices>
  /** Factory replacements (fakes that need `deps`); `overrides` win. */
  factories?: Partial<ServiceFactories>
  /** Run the boot sequence (`startDeps`: workspace roots, installer recovery, plugin host, catalog, MCP); default true. */
  start?: boolean
  /**
   * Phase 7: `HF_WORKSPACE_ROOTS` as a list of absolute folders (joined with `,`; use canonical paths, e.g.
   * `realpath(await mkdtemp(...))`); default: unset, the only root is `<dataDir>/workspaces`. `env.HF_WORKSPACE_ROOTS`
   * wins when both are given.
   */
  workspaceRoots?: readonly string[]
  /** Phase 7: `HF_WORKSPACE_SHELL` (`false` = `0`: no `execute` tools); default: unset (on). `env` wins. */
  workspaceShell?: boolean
  /**
   * Phase 8: the checkpoint service: `'fake'` = `createFakeCheckpointService()` (a recording journal, canned answers),
   * or a ready service; default: the real one. `overrides.checkpoints` / `factories.checkpoints` win.
   */
  checkpoints?: 'fake' | CheckpointService
  /**
   * Phase 8: the shell rule service: `'fake'` = `createFakeShellRuleService(deps)` (rules in memory, project ids checked
   * against the test database), or a ready service; default: the real one. `overrides` / `factories` win.
   */
  shellRules?: 'fake' | ShellRuleService
  /**
   * Phase 9: the project file service of `@` mentions: `'fake'` = `createFakeProjectFileService()` (paths in memory,
   * ranked by the shared `rankPaths`; a fixed `FileRef` for `attach`), or a ready service; default: the real one.
   * `overrides.projectFiles` / `factories.projectFiles` win.
   */
  projectFiles?: 'fake' | ProjectFileService
}

export interface TestRequestOptions {
  /** Client address seen by the server (`getConnInfo(c).remote.address`); default `127.0.0.1`. */
  remoteAddress?: string
}

/** `c.env` of a test request: the `incoming.socket` fields read by `getConnInfo`. */
export function testBindings(remoteAddress = '127.0.0.1'): AppEnv['Bindings'] {
  const remoteFamily = remoteAddress.includes(':') ? 'IPv6' : 'IPv4'
  const incoming = { socket: { remoteAddress, remotePort: 50_000, remoteFamily } }
  return { incoming: incoming as unknown as NonNullable<AppEnv['Bindings']['incoming']> }
}

export interface TestApp {
  app: Hono<AppEnv>
  deps: AppDeps
  env: Env
  db: Db
  database: Database
  /** Every log record of this app (redacted), for assertions. */
  logs: MemoryLogger
  /** Typed API client over `app.request` (base `http://127.0.0.1:8787/api`). */
  client: ApiClient
  /**
   * `app.request` with `path` relative to the origin (`/api/health`) and node-server-like bindings, so
   * `getConnInfo(c)` of `@hono/node-server/conninfo` works (remote address `127.0.0.1` unless overridden).
   */
  request: (path: string, init?: RequestInit, options?: TestRequestOptions) => Promise<Response>
  /** Stops the services, closes the database and removes the temp data directory. Idempotent. */
  close: () => Promise<void>
}

/** The fake keyring is used unless the test passes its own keyring (value or factory, e.g. the real `createKeyring`). */
function usesFakeKeyring(options: TestAppOptions): boolean {
  return options.overrides?.keyring === undefined && options.factories?.keyring === undefined
}

/** The Phase 8 and Phase 9 service options as factories (`overrides` and `factories` of the same name win). */
function serviceOptionFactories(options: TestAppOptions): Partial<ServiceFactories> {
  const { checkpoints, shellRules, projectFiles } = options
  return {
    ...(checkpoints === undefined ? {} : { checkpoints: () => (checkpoints === 'fake' ? createFakeCheckpointService() : checkpoints) }),
    ...(shellRules === undefined ? {} : { shellRules: (deps: AppDeps) => (shellRules === 'fake' ? createFakeShellRuleService(deps) : shellRules) }),
    ...(projectFiles === undefined ? {} : { projectFiles: () => (projectFiles === 'fake' ? createFakeProjectFileService() : projectFiles) }),
  }
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const ownsDataDir = options.dataDir === undefined
  const dataDir = options.dataDir ?? realpathSync(mkdtempSync(join(tmpdir(), 'harness-forge-test-')))
  let database: Database | undefined
  try {
    const workspace: Record<string, string> = {
      ...(options.workspaceRoots === undefined ? {} : { HF_WORKSPACE_ROOTS: options.workspaceRoots.join(',') }),
      ...(options.workspaceShell === undefined ? {} : { HF_WORKSPACE_SHELL: options.workspaceShell ? '1' : '0' }),
    }
    const env = loadEnv({ HF_DATA_DIR: dataDir, ...workspace, ...options.env }, { cwd: dataDir })
    ensureDataDir(env)
    const redactor = createRedactor()
    const logs = createMemoryLogger({ redactor })
    database = await openDatabase({ path: options.databasePath ?? ':memory:' })
    await migrateDatabase(database.db)
    const deps = createDeps({
      env,
      logger: logs.logger,
      redactor,
      db: database.db,
      builtins: options.builtins ?? getBuiltinPlugins(env),
      overrides: { ...(usesFakeKeyring(options) ? { keyring: createFakeKeyring() } : {}), ...options.overrides },
      factories: { ...serviceOptionFactories(options), ...options.factories },
    })
    if (options.start ?? true)
      await startDeps(deps)
    const app = createApp(deps)
    const request = async (path: string, init?: RequestInit, requestOptions: TestRequestOptions = {}): Promise<Response> =>
      app.request(new URL(path, TEST_ORIGIN).href, init, testBindings(requestOptions.remoteAddress))
    const client = createApiClient({
      baseUrl: `${TEST_ORIGIN}/api`,
      fetch: async (input, init) => app.request(input instanceof Request ? input : String(input), init, testBindings()),
    })

    let closed = false
    const openDatabaseHandle = database
    return {
      app,
      deps,
      env,
      db: database.db,
      database,
      logs,
      client,
      request,
      close: async () => {
        if (closed)
          return
        closed = true
        try {
          await stopDeps(deps)
        }
        finally {
          openDatabaseHandle.close()
          if (ownsDataDir)
            rmSync(dataDir, { recursive: true, force: true })
        }
      },
    }
  }
  catch (error) {
    database?.close()
    if (ownsDataDir)
      rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
}
