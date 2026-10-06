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
// Phase 10 (C30-T8): `customizations` installs the customization service (`'fake'`: `createFakeCustomizationService({
// events })` of ./fake-customizations.ts, or a ready service); `backgroundTasks` installs the background manager of the
// real chat runner (`'fake'`: `createFakeBackgroundTasks({ events })` of ./fake-background-tasks.ts, or a ready manager;
// through `createChatRunnerWith(deps, { backgroundTasks })`), exposed as `TestApp.backgroundTasks`. `overrides` and
// `factories` of the same name (`customizations`, `runs`) win.
// Phase 11 (C36-T10): `hooks` installs the hook service (`'fake'`: `createFakeHookService({ events })` of ./fake-hooks.ts:
// scripted snapshots, personal hooks in memory), `projectConfig` the project config reader (`'fake'`:
// `createFakeProjectConfigService()` of ./fake-project-config.ts), `projectTrust` project trust (`'fake'`:
// `createFakeProjectTrustService({ events })` of ./fake-project-trust.ts, an in-memory approved set) and `projectMcp` the
// project MCP manager (`'fake'`: `createFakeProjectMcpManager()` of ./fake-project-mcp.ts, scripted tools), or ready
// services; `overrides` and `factories` of the same name win.
// Phase 12 (C43-T9): `marketplaces` installs the marketplace service (`'fake'`: `createFakeMarketplaceService({ events,
// offline })` of ./fake-marketplaces.ts: remote catalogs the test registers), `claudeImport` the home-folder import
// (`'fake'`: `createFakeClaudeImportService({ events })` of ./fake-claude-import.ts: scripted plan items) and
// `projectDefinitions` the project definition editor (`'fake'`: `createFakeProjectDefinitionsService({ events })` of
// ./fake-project-definitions.ts: files in memory), or ready services; `overrides` and `factories` of the same name win.
// `HF_CLAUDE_HOME` defaults to `<dataDir>/claude-home` (not created: the home route answers `missing`), so no test ever
// reads the real `~/.claude`; `env.HF_CLAUDE_HOME` wins (`'0'` = the scan is off).
import type { ApiClient } from '@harness-forge/shared'
import type { Hono } from 'hono'
import type { BackgroundTasks } from '../chat/background/types.ts'
import type { Database, Db } from '../db/client.ts'
import type { ServiceFactories } from '../deps.ts'
import type { Env } from '../env.ts'
import type { AppEnv } from '../http/types.ts'
import type { MemoryLogger } from '../logger.ts'
import type { ProjectMcpManager } from '../mcp/types.ts'
import type { MarketplaceService } from '../plugins/marketplaces/types.ts'
import type { BuiltinPlugin } from '../plugins/types.ts'
import type { CheckpointService } from '../services/checkpoints/types.ts'
import type { ClaudeImportService } from '../services/claude-import/types.ts'
import type { CustomizationService } from '../services/customizations/types.ts'
import type { HookService } from '../services/hooks/types.ts'
import type { ProjectConfigService } from '../services/project-config/types.ts'
import type { ProjectDefinitionsService } from '../services/project-definitions/types.ts'
import type { ProjectFileService } from '../services/project-files/types.ts'
import type { ProjectTrustService } from '../services/project-trust/types.ts'
import type { ShellRuleService } from '../services/shell-rules/types.ts'
import type { AppDeps, AppServices } from '../types.ts'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiClient } from '@harness-forge/shared'
import { createApp } from '../app.ts'
import { getBuiltinPlugins } from '../builtin-plugins/index.ts'
import { createChatRunnerWith } from '../chat/index.ts'
import { openDatabase } from '../db/client.ts'
import { migrateDatabase } from '../db/migrate.ts'
import { createDeps, startDeps, stopDeps } from '../deps.ts'
import { ensureDataDir, loadEnv } from '../env.ts'
import { createMemoryLogger } from '../logger.ts'
import { createRedactor } from '../security/redact.ts'
import { createFakeBackgroundTasks } from './fake-background-tasks.ts'
import { createFakeCheckpointService } from './fake-checkpoints.ts'
import { createFakeClaudeImportService } from './fake-claude-import.ts'
import { createFakeCustomizationService } from './fake-customizations.ts'
import { createFakeHookService } from './fake-hooks.ts'
import { createFakeMarketplaceService } from './fake-marketplaces.ts'
import { createFakeProjectConfigService } from './fake-project-config.ts'
import { createFakeProjectDefinitionsService } from './fake-project-definitions.ts'
import { createFakeProjectFileService } from './fake-project-files.ts'
import { createFakeProjectMcpManager } from './fake-project-mcp.ts'
import { createFakeProjectTrustService } from './fake-project-trust.ts'
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
  /**
   * Phase 10: the customization service: `'fake'` = `createFakeCustomizationService({ events: deps.events })` (a catalog
   * the test controls, personal definitions in memory), or a ready service; default: the real one.
   * `overrides.customizations` / `factories.customizations` win.
   */
  customizations?: 'fake' | CustomizationService
  /**
   * Phase 10: the background manager of the real chat runner: `'fake'` = `createFakeBackgroundTasks({ events:
   * deps.events })` (scripted launches, `finish`, an in-memory inbox), or a ready manager; default: the runner's own
   * (`createBackgroundTasks`). Exposed as `TestApp.backgroundTasks`. `overrides.runs` / `factories.runs` win (then the
   * option is ignored).
   */
  backgroundTasks?: 'fake' | BackgroundTasks
  /**
   * Phase 11: the hook service: `'fake'` = `createFakeHookService({ events: deps.events })` (scripted snapshots, personal
   * hooks in memory), or a ready service; default: the real one. `overrides.hooks` / `factories.hooks` win.
   */
  hooks?: 'fake' | HookService
  /**
   * Phase 11: the project config reader: `'fake'` = `createFakeProjectConfigService()` (snapshots the test sets), or a
   * ready service; default: the real one. `overrides` / `factories` win.
   */
  projectConfig?: 'fake' | ProjectConfigService
  /**
   * Phase 11: project trust: `'fake'` = `createFakeProjectTrustService({ events: deps.events })` (an in-memory approved
   * set), or a ready service; default: the real one. `overrides` / `factories` win.
   */
  projectTrust?: 'fake' | ProjectTrustService
  /**
   * Phase 11: the project MCP manager: `'fake'` = `createFakeProjectMcpManager()` (scripted tools and lists), or a ready
   * manager; default: the real one. `overrides` / `factories` win.
   */
  projectMcp?: 'fake' | ProjectMcpManager
  /**
   * Phase 12: the marketplace service: `'fake'` = `createFakeMarketplaceService({ events: deps.events, offline:
   * env.offline })` (remote catalogs the test registers, marketplaces in memory), or a ready service; default: the real
   * one. `overrides.marketplaces` / `factories.marketplaces` win.
   */
  marketplaces?: 'fake' | MarketplaceService
  /**
   * Phase 12: the home-folder import: `'fake'` = `createFakeClaudeImportService({ events: deps.events })` (a scripted
   * `home()` and plan items, plans in memory), or a ready service; default: the real one. `overrides` / `factories` win.
   */
  claudeImport?: 'fake' | ClaudeImportService
  /**
   * Phase 12: the project definition editor: `'fake'` = `createFakeProjectDefinitionsService({ events: deps.events })`
   * (files in memory), or a ready service; default: the real one. `overrides` / `factories` win.
   */
  projectDefinitions?: 'fake' | ProjectDefinitionsService
}

/** The folder name of the default `HF_CLAUDE_HOME` of a test app, inside its data directory (never created). */
export const TEST_CLAUDE_HOME_NAME = 'claude-home'

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
  /**
   * Phase 10: the background manager installed by `options.backgroundTasks` (the fake for `'fake'`), or null without the
   * option (the runner's own manager is internal).
   */
  backgroundTasks: BackgroundTasks | null
  /** Stops the services, closes the database and removes the temp data directory. Idempotent. */
  close: () => Promise<void>
}

/** The fake keyring is used unless the test passes its own keyring (value or factory, e.g. the real `createKeyring`). */
function usesFakeKeyring(options: TestAppOptions): boolean {
  return options.overrides?.keyring === undefined && options.factories?.keyring === undefined
}

/** The Phase 12 service options as factories (`overrides` and `factories` of the same name win). */
function phase12OptionFactories(options: TestAppOptions): Partial<ServiceFactories> {
  const { marketplaces, claudeImport, projectDefinitions } = options
  return {
    ...(marketplaces === undefined
      ? {}
      : { marketplaces: (deps: AppDeps) => (marketplaces === 'fake' ? createFakeMarketplaceService({ events: deps.events, offline: deps.env.offline }) : marketplaces) }),
    ...(claudeImport === undefined
      ? {}
      : { claudeImport: (deps: AppDeps) => (claudeImport === 'fake' ? createFakeClaudeImportService({ events: deps.events }) : claudeImport) }),
    ...(projectDefinitions === undefined
      ? {}
      : { projectDefinitions: (deps: AppDeps) => (projectDefinitions === 'fake' ? createFakeProjectDefinitionsService({ events: deps.events }) : projectDefinitions) }),
  }
}

/**
 * The Phase 8 - 12 service options as factories (`overrides` and `factories` of the same name win). `background` receives
 * the manager that `backgroundTasks` installs once the runner is built.
 */
function serviceOptionFactories(options: TestAppOptions, background: { manager: BackgroundTasks | null }): Partial<ServiceFactories> {
  const { checkpoints, shellRules, projectFiles, customizations, backgroundTasks, hooks, projectConfig, projectTrust, projectMcp } = options
  return {
    ...phase12OptionFactories(options),
    ...(hooks === undefined ? {} : { hooks: (deps: AppDeps) => (hooks === 'fake' ? createFakeHookService({ events: deps.events }) : hooks) }),
    ...(projectConfig === undefined ? {} : { projectConfig: () => (projectConfig === 'fake' ? createFakeProjectConfigService() : projectConfig) }),
    ...(projectTrust === undefined
      ? {}
      : { projectTrust: (deps: AppDeps) => (projectTrust === 'fake' ? createFakeProjectTrustService({ events: deps.events }) : projectTrust) }),
    ...(projectMcp === undefined ? {} : { projectMcp: () => (projectMcp === 'fake' ? createFakeProjectMcpManager() : projectMcp) }),
    ...(checkpoints === undefined ? {} : { checkpoints: () => (checkpoints === 'fake' ? createFakeCheckpointService() : checkpoints) }),
    ...(shellRules === undefined ? {} : { shellRules: (deps: AppDeps) => (shellRules === 'fake' ? createFakeShellRuleService(deps) : shellRules) }),
    ...(projectFiles === undefined ? {} : { projectFiles: () => (projectFiles === 'fake' ? createFakeProjectFileService() : projectFiles) }),
    ...(customizations === undefined
      ? {}
      : { customizations: (deps: AppDeps) => (customizations === 'fake' ? createFakeCustomizationService({ events: deps.events }) : customizations) }),
    ...(backgroundTasks === undefined
      ? {}
      : {
          runs: (deps: AppDeps) => createChatRunnerWith(deps, {
            backgroundTasks: (managerDeps) => {
              background.manager = backgroundTasks === 'fake' ? createFakeBackgroundTasks({ events: managerDeps.events }) : backgroundTasks
              return background.manager
            },
          }),
        }),
  }
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const ownsDataDir = options.dataDir === undefined
  const dataDir = options.dataDir ?? realpathSync(mkdtempSync(join(tmpdir(), 'harness-forge-test-')))
  let database: Database | undefined
  try {
    const workspace: Record<string, string> = {
      // Phase 12: never the real `~/.claude` (a folder inside the temp data directory, not created).
      HF_CLAUDE_HOME: join(dataDir, TEST_CLAUDE_HOME_NAME),
      ...(options.workspaceRoots === undefined ? {} : { HF_WORKSPACE_ROOTS: options.workspaceRoots.join(',') }),
      ...(options.workspaceShell === undefined ? {} : { HF_WORKSPACE_SHELL: options.workspaceShell ? '1' : '0' }),
    }
    // `homedir`: even an explicitly unset `HF_CLAUDE_HOME` resolves inside the temp data directory.
    const env = loadEnv({ HF_DATA_DIR: dataDir, ...workspace, ...options.env }, { cwd: dataDir, homedir: dataDir })
    ensureDataDir(env)
    const redactor = createRedactor()
    const logs = createMemoryLogger({ redactor })
    const background: { manager: BackgroundTasks | null } = { manager: null }
    database = await openDatabase({ path: options.databasePath ?? ':memory:' })
    await migrateDatabase(database.db)
    const deps = createDeps({
      env,
      logger: logs.logger,
      redactor,
      db: database.db,
      builtins: options.builtins ?? getBuiltinPlugins(env),
      overrides: { ...(usesFakeKeyring(options) ? { keyring: createFakeKeyring() } : {}), ...options.overrides },
      factories: { ...serviceOptionFactories(options, background), ...options.factories },
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
      get backgroundTasks() {
        return background.manager
      },
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
