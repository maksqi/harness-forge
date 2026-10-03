// Composition root: builds `AppDeps` from the base values and the service factories, and runs the boot / shutdown
// sequence (ARCHITECTURE.md section 5). Used by `main.ts` and `createTestApp()`. FROZEN after Phase 0: later waves
// only replace the factory implementations (same names and signatures).
//
// Services are created lazily through getters on the `deps` object, so a factory may read other services while it
// runs (`const { db, events } = deps`) regardless of declaration order; `createDeps` then instantiates all of them
// eagerly (in `SERVICE_NAMES` order) so a failing factory fails the boot. A factory that needs itself through another
// service's factory (a construction cycle) throws; defer such calls to the service methods or `start()`.
import type { AppBase, AppDeps, AppServices, ServiceName } from './types.ts'
import { createModelCatalog } from './catalog/index.ts'
import { createChatRunner } from './chat/index.ts'
import { envBootWarnings } from './env.ts'
import { createMcpManager } from './mcp/index.ts'
import { createToolService } from './mcp/tools.ts'
import { createPluginDrafts } from './plugins/drafts/index.ts'
import { createPluginHost } from './plugins/host.ts'
import { createPluginInstaller } from './plugins/install/index.ts'
import { createPluginFiles } from './plugins/scaffold/index.ts'
import { createIconService } from './providers/icons.ts'
import { createProviderService } from './providers/index.ts'
import { createRegistry } from './registry/index.ts'
import { createKeyring } from './security/keyring.ts'
import { createPasswordService } from './security/password.ts'
import { createSessionService } from './security/session.ts'
import { createAudioService } from './services/audio/index.ts'
import { createChatsService } from './services/chats/index.ts'
import { createCheckpointService } from './services/checkpoints/index.ts'
import { createDataService } from './services/data/index.ts'
import { createEventBus } from './services/events/index.ts'
import { createFilesService } from './services/files/index.ts'
import { createImageService } from './services/images/index.ts'
import { createKeyService } from './services/keys/index.ts'
import { createMaintenanceService } from './services/maintenance/index.ts'
import { createProjectFileService } from './services/project-files/index.ts'
import { createProjectService } from './services/projects/index.ts'
import { createCredentialService } from './services/secrets/credentials.ts'
import { createSecretStore } from './services/secrets/index.ts'
import { createSettingsService } from './services/settings/index.ts'
import { createShareService } from './services/shares/index.ts'
import { createShellRuleService } from './services/shell-rules/index.ts'

export type ServiceFactories = { readonly [K in ServiceName]: (deps: AppDeps) => AppServices[K] }

/** The production factory of every service. */
export const SERVICE_FACTORIES: ServiceFactories = {
  keyring: createKeyring,
  events: createEventBus,
  settings: createSettingsService,
  secrets: createSecretStore,
  passwords: createPasswordService,
  sessions: createSessionService,
  registry: createRegistry,
  credentials: createCredentialService,
  icons: createIconService,
  catalog: createModelCatalog,
  providers: createProviderService,
  plugins: createPluginHost,
  installer: createPluginInstaller,
  drafts: createPluginDrafts,
  pluginFiles: createPluginFiles,
  chats: createChatsService,
  files: createFilesService,
  runs: createChatRunner,
  tools: createToolService,
  mcp: createMcpManager,
  data: createDataService,
  shares: createShareService,
  images: createImageService,
  audio: createAudioService,
  // Phase 7 (P7-0b): projects (C14 stub, W7.1), maintenance lock (C16), master-key service (C16 stub, W7.7).
  projects: createProjectService,
  maintenance: createMaintenanceService,
  keys: createKeyService,
  // Phase 8 (P8-0b): checkpoints (C19 stub, W8.1 - W8.3), shell rules (C19 stub, W8.6).
  checkpoints: createCheckpointService,
  shellRules: createShellRuleService,
  // Phase 9 (P9-0b): the file index of `@` mentions (C24 stub, W9.6).
  projectFiles: createProjectFileService,
}

/** Instantiation order (dependencies first; construction-time access to later services still works lazily). */
export const SERVICE_NAMES = Object.keys(SERVICE_FACTORIES) as ServiceName[]

export interface CreateDepsOptions extends AppBase {
  /** Replaces services with ready values (tests: fakes; `createTestApp()` always replaces `keyring`). */
  overrides?: Partial<AppServices>
  /** Replaces service factories (tests: fakes that need `deps`). `overrides` win over `factories`. */
  factories?: Partial<ServiceFactories>
}

/** Builds every service. Throws when a factory throws (boot fails with exit 1). */
export function createDeps(options: CreateDepsOptions): AppDeps {
  const { overrides = {}, factories = {}, ...base } = options
  const deps = { ...base } as AppDeps
  const states = new Map<ServiceName, 'building' | 'ready'>()
  const values = new Map<ServiceName, unknown>()

  for (const name of SERVICE_NAMES) {
    Object.defineProperty(deps, name, {
      enumerable: true,
      configurable: false,
      get() {
        const state = states.get(name)
        if (state === 'ready')
          return values.get(name)
        if (state === 'building')
          throw new Error(`Circular dependency while creating deps.${name}: defer the access to a method or start().`)
        states.set(name, 'building')
        try {
          const factory = (factories[name] ?? SERVICE_FACTORIES[name]) as (deps: AppDeps) => unknown
          const value = overrides[name] ?? factory(deps)
          values.set(name, value)
          states.set(name, 'ready')
          return value
        }
        catch (error) {
          states.delete(name)
          throw error
        }
      },
    })
  }

  for (const name of SERVICE_NAMES)
    void deps[name]
  return Object.freeze(deps)
}

/**
 * Boot sequence after migrations (ARCHITECTURE.md 5): workspace roots (Phase 7: the default root is created and every
 * root is checked; a refused root throws `EnvError`) -> the checkpoint store (Phase 8: `checkpoints/` created 0700, one
 * prune, the prune timer) -> staging recovery -> plugin host (builtins, then user plugins) -> model catalog warm-up ->
 * MCP manager -> the data service last (Phase 8: the automatic file sweep timer, ADR-039). A broken plugin never fails
 * the boot. The environment warnings (`envBootWarnings`) are logged first.
 */
export async function startDeps(deps: AppDeps): Promise<void> {
  for (const warning of envBootWarnings(deps.env))
    deps.logger.warn(warning)
  await deps.projects.start()
  await deps.checkpoints.start()
  await deps.installer.recover()
  await deps.plugins.start()
  await deps.catalog.start()
  await deps.mcp.start()
  await deps.data.start()
}

/** The steps of `stopDeps`, in order (each named by its service). */
export const SHUTDOWN_STEPS = ['data', 'runs', 'projectFiles', 'checkpoints', 'plugins', 'mcp', 'catalog', 'events'] as const
export type ShutdownStep = typeof SHUTDOWN_STEPS[number]

/**
 * Shutdown (ARCHITECTURE.md 5): stop the automatic file sweep first (Phase 8: its timer, and a sweep in flight is
 * aborted) -> the runs (`runs.stopAll()`; Phase 9: every chat's steer queue cleared first, so no queued message starts
 * a new turn, then every run aborted and persisted as `aborted`, its sub-agents through the run's signal) -> drop the
 * mention file index (Phase 9, `projectFiles.stop()`) -> stop the checkpoint store (Phase 8: the prune timer, after
 * the runs so no journal write is cut off) -> dispose plugins -> close MCP clients -> stop catalog timers -> close SSE
 * streams. Every step runs even when an earlier one fails (failures are logged). The caller closes the HTTP server
 * before and the database after. Frozen order (Phase 9): `SHUTDOWN_STEPS`.
 */
export async function stopDeps(deps: AppDeps): Promise<void> {
  const steps: Array<[ShutdownStep, () => Promise<void>]> = [
    ['data', () => deps.data.stop()],
    ['runs', () => deps.runs.stopAll()],
    ['projectFiles', async () => deps.projectFiles.stop()],
    ['checkpoints', () => deps.checkpoints.stop()],
    ['plugins', () => deps.plugins.stop()],
    ['mcp', () => deps.mcp.stop()],
    ['catalog', () => deps.catalog.stop()],
    ['events', () => deps.events.stop()],
  ]
  for (const [step, run] of steps) {
    try {
      await run()
    }
    catch (error) {
      deps.logger.error('shutdown step failed', { step, err: error })
    }
  }
}
