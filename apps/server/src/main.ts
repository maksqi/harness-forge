// Process entry (ARCHITECTURE.md section 5): `.env` -> env -> bind check -> data dir -> database + migrations ->
// services -> bind check with a stored password -> boot sequence -> HTTP server; graceful shutdown on SIGINT / SIGTERM
// (the handlers exist from the start of the boot, so a signal during plugin loading is a graceful shutdown too).
// Owner after Phase 0: W1.1 (W1.1-T8); the trusted proxy boot log: W5.7; the Phase 7 boot hooks: C16 (C16-T3).
//
// Phase 7 boot hooks (ADR-034, frozen after Gate P7-0b): `argv[2] === 'rotate-key'` runs the offline key rotation CLI
// (`services/keys/cli.ts`) instead of the server, before any boot step runs; `acquireServerLock` runs right after
// the data directory exists and its `release()` at the end of a shutdown and when the boot fails; `recoverKeyState`
// runs after the migrations and before `createDeps`, whose keyring factory takes the `keyVersion` it returns.
//
// Phase 10 boot hook (C30, frozen after Gate P10-0b): the boot sweep of background tasks (`runs.boot()`: rows still
// `running` become `aborted`, undelivered results fill the in-memory inboxes, no turn starts) runs once per process,
// inside `startDeps` right after `checkpoints.start()` (`BOOT_STEPS`); `stopDeps` stops the background tasks inside
// `runs.stopAll()` (queues, then background tasks, then runs) before it drops the customization catalog caches.
//
// Phase 11 (C36, frozen after Gate P11-0b): no new boot hook (hook snapshots, the project config reader, project trust
// and the project MCP runtimes are lazy; `<dataDir>/hooks` is created on the first hook run); `stopDeps` kills the
// running hook process groups right after the runs and then stops the project MCP runtimes (`SHUTDOWN_STEPS`), all
// inside the shutdown timeout.
//
// Bind safety: a non-loopback `HF_HOST` needs `HF_PASSWORD`, a password stored in the data directory, or
// `HF_INSECURE=1`; otherwise the process exits with code 1 before any plugin starts or any port is opened. An invalid
// `HF_TRUST_PROXY` (`1`, `true`, a hop count, an unknown token) fails the boot the same way, with the format explained;
// a valid one is logged with every trusted range (ADR-026).
import type { ServerType } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import type { Database } from './db/client.ts'
import type { Env } from './env.ts'
import type { Logger } from './logger.ts'
import type { ServerLock } from './services/keys/server-lock.ts'
import type { AppDeps } from './types.ts'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { getBuiltinPlugins } from './builtin-plugins/index.ts'
import { openDatabase } from './db/client.ts'
import { migrateDatabase } from './db/migrate.ts'
import { createDeps, startDeps, stopDeps } from './deps.ts'
import { bindSafetyError, defaultEnvFile, ensureDataDir, EnvError, isLoopbackHost, loadDotEnvFile, loadEnv } from './env.ts'
import { createLogger } from './logger.ts'
import { createKeyring } from './security/keyring.ts'
import { trustedRanges } from './security/proxy-trust.ts'
import { createRedactor } from './security/redact.ts'
import { isRotateKeyCommand, runRotateKeyCommand } from './services/keys/cli.ts'
import { recoverKeyState } from './services/keys/recover.ts'
import { acquireServerLock } from './services/keys/server-lock.ts'

/** A shutdown that takes longer exits with code 1. */
const SHUTDOWN_TIMEOUT_MS = 10_000

function displayHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}

function fail(message: string): never {
  process.stderr.write(`harness-forge: ${message}\n`)
  process.exit(1)
}

/** Loads `<workspace root>/.env` (variables already set win); a file that exists but cannot be read stops the boot. */
function loadEnvFile(): string | null {
  const file = defaultEnvFile()
  try {
    return loadDotEnvFile(file)
  }
  catch (error) {
    return fail(`cannot load ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readEnv(): Env {
  try {
    return loadEnv()
  }
  catch (error) {
    if (error instanceof EnvError)
      fail(error.message)
    throw error
  }
}

function listen(deps: AppDeps): Promise<{ server: ServerType, info: AddressInfo }> {
  const { env } = deps
  const app = createApp(deps)
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info: AddressInfo) => {
      resolve({ server, info })
    })
    server.once('error', reject)
  })
}

/**
 * What a shutdown has to release, filled in while the boot goes on. The signal handlers exist from the start of the
 * boot, so SIGINT / SIGTERM during plugin loading (or right after `listening` is logged) is a graceful shutdown, never
 * the default signal action.
 */
interface BootState {
  /** `server.lock`, taken right after the data directory exists. */
  lock: ServerLock | undefined
  database: Database | undefined
  deps: AppDeps | undefined
  /** `startDeps` was called: plugins, MCP servers and background tasks may be running. */
  started: boolean
  server: ServerType | undefined
  /** The boot step in progress; a shutdown waits for it before it releases anything. */
  current: Promise<unknown> | null
  stopping: boolean
}

/** Runs one boot step so that a shutdown can wait for it. */
function bootStep<T>(state: BootState, promise: Promise<T>): Promise<T> {
  state.current = promise
  return promise
}

function installShutdown(state: BootState, logger: Logger): void {
  async function shutdown(signal: string): Promise<void> {
    if (state.stopping) {
      logger.warn('second signal, exiting now', { signal })
      process.exit(1)
    }
    state.stopping = true
    logger.info('shutting down', { signal, phase: state.server === undefined ? 'booting' : 'listening' })
    const timer = setTimeout(() => {
      logger.error('shutdown timed out', { timeoutMs: SHUTDOWN_TIMEOUT_MS })
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    timer.unref()

    try {
      // A half-finished boot step settles first (the boot stops after it), then everything it created is released:
      // stop accepting connections, end runs / plugins / MCP / SSE streams, drop what is left and close the DB.
      await state.current?.catch(() => {})
      const server = state.server
      const closed = server === undefined ? Promise.resolve() : new Promise<void>(resolve => server.close(() => resolve()))
      if (state.started && state.deps !== undefined)
        await stopDeps(state.deps)
      if (server !== undefined && 'closeAllConnections' in server)
        server.closeAllConnections()
      await closed
      state.database?.close()
      state.lock?.release()
    }
    catch (error) {
      logger.error('shutdown failed', { err: error })
      state.lock?.release()
      process.exit(1)
    }
    logger.info('stopped')
    process.exit(0)
  }

  // A second signal during shutdown exits immediately.
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

/** Bind safety with the password stored in the data directory (the env-only check could not allow the bind). */
async function storedPasswordAllowsBind(deps: AppDeps): Promise<boolean> {
  return (await deps.passwords.source()) === 'settings'
}

async function main(): Promise<void> {
  const envFile = loadEnvFile()
  const env = readEnv()
  const redactor = createRedactor()
  if (env.password !== null)
    redactor.addSecret(env.password)
  const logger = createLogger({ level: env.logLevel, redactor })
  if (envFile !== null)
    logger.info('loaded environment file', { file: envFile })

  process.on('unhandledRejection', (reason) => {
    // Never fatal (PLUGINS.md 11 "Guards"): plugin code may leak rejections.
    logger.error('unhandled rejection', { err: reason })
  })
  process.on('uncaughtException', (error) => {
    // Plugin code (e.g. a timer left behind by a disabled plugin) must not take the server down; host code is
    // guarded, so a synchronous throw reaching this point is logged (redacted) and the process keeps serving.
    logger.error('uncaught exception', { err: error })
  })

  // Without HF_PASSWORD or HF_INSECURE=1 a non-loopback bind needs a stored password; with no database yet there is
  // none, so refuse before creating anything.
  const envBindError = bindSafetyError(env)
  if (envBindError !== null && !existsSync(env.paths.db)) {
    logger.error(envBindError, { host: env.host })
    process.exit(1)
  }

  const state: BootState = { lock: undefined, database: undefined, deps: undefined, started: false, server: undefined, current: null, stopping: false }
  installShutdown(state, logger)
  try {
    ensureDataDir(env)
    state.lock = acquireServerLock({ env, logger })
    const database = await bootStep(state, openDatabase({ path: env.paths.db }))
    state.database = database
    if (state.stopping)
      return
    await bootStep(state, migrateDatabase(database.db))
    if (state.stopping)
      return
    // Finishes or drops an interrupted rotation and records the key check on the first v1.3 boot (ADR-034).
    const { keyVersion } = await bootStep(state, recoverKeyState({ env, db: database.db, logger, redactor }))
    if (state.stopping)
      return
    const deps = createDeps({
      env,
      logger,
      redactor,
      db: database.db,
      builtins: getBuiltinPlugins(env),
      factories: { keyring: appDeps => createKeyring(appDeps, { keyVersion }) },
    })
    state.deps = deps

    if (envBindError !== null) {
      const storedPassword = await bootStep(state, storedPasswordAllowsBind(deps))
      if (state.stopping)
        return
      const bindError = bindSafetyError(env, { storedPassword })
      if (bindError !== null) {
        logger.error(bindError, { host: env.host })
        database.close()
        state.lock?.release()
        process.exit(1)
      }
    }
    if (!isLoopbackHost(env.host) && env.insecure && (await bootStep(state, deps.passwords.source())) === null)
      logger.warn('listening on a non-loopback address without a password (HF_INSECURE=1)', { host: env.host })
    if (state.stopping)
      return
    if (env.trustProxy !== null)
      logger.info('trusting reverse proxies (HF_TRUST_PROXY)', { trustProxy: env.trustProxy, ranges: trustedRanges(env.trustProxy) })

    state.started = true
    await bootStep(state, startDeps(deps))
    if (state.stopping)
      return
    const { server, info } = await bootStep(state, listen(deps))
    state.server = server
    if (state.stopping)
      return
    logger.info('listening', {
      url: `http://${displayHost(info.address)}:${info.port}`,
      dataDir: env.dataDir,
      safeMode: env.safeMode,
      mockProvider: env.mockProvider,
    })
  }
  catch (error) {
    // A step that failed because a shutdown is releasing its resources is not a boot failure.
    if (state.stopping)
      return
    logger.error('boot failed', { err: error })
    if (state.started && state.deps !== undefined)
      await stopDeps(state.deps).catch(() => {})
    state.database?.close()
    state.lock?.release()
    process.exit(1)
  }
}

/** `rotate-key [--force]`: the offline key rotation instead of the server (it loads `.env` and the env itself). */
async function rotateKey(args: readonly string[]): Promise<void> {
  let code: number
  try {
    code = await runRotateKeyCommand(args)
  }
  catch (error) {
    // The CLI resolves its exit code; a rejection is a bug there. Print the message only (no stack, no values).
    process.stderr.write(`harness-forge rotate-key: ${error instanceof Error ? error.message : 'failed'}\n`)
    code = 1
  }
  process.exit(code)
}

if (isRotateKeyCommand(process.argv))
  void rotateKey(process.argv.slice(3))
else
  void main()
