// Process entry (ARCHITECTURE.md section 5): env -> bind check -> data dir -> database + migrations -> services ->
// boot sequence -> HTTP server; graceful shutdown on SIGINT / SIGTERM. Owner after Phase 0: W1.1 (W1.1-T8 extends the
// bind check with a stored password).
import type { ServerType } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import type { Database } from './db/client.ts'
import type { Env } from './env.ts'
import type { Logger } from './logger.ts'
import type { AppDeps } from './types.ts'
import process from 'node:process'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { getBuiltinPlugins } from './builtin-plugins/index.ts'
import { openDatabase } from './db/client.ts'
import { migrateDatabase } from './db/migrate.ts'
import { createDeps, startDeps, stopDeps } from './deps.ts'
import { bindSafetyError, ensureDataDir, EnvError, loadEnv } from './env.ts'
import { createLogger } from './logger.ts'
import { createRedactor } from './security/redact.ts'

/** A shutdown that takes longer exits with code 1. */
const SHUTDOWN_TIMEOUT_MS = 10_000

function displayHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}

function readEnv(): Env {
  try {
    return loadEnv()
  }
  catch (error) {
    if (error instanceof EnvError) {
      process.stderr.write(`harness-forge: ${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

function listen(deps: AppDeps, logger: Logger): Promise<ServerType> {
  const { env } = deps
  const app = createApp(deps)
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info: AddressInfo) => {
      logger.info('listening', {
        url: `http://${displayHost(info.address)}:${info.port}`,
        dataDir: env.dataDir,
        safeMode: env.safeMode,
        mockProvider: env.mockProvider,
      })
      resolve(server)
    })
    server.once('error', reject)
  })
}

function installShutdown(server: ServerType, deps: AppDeps, database: Database, logger: Logger): void {
  let shuttingDown = false

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      logger.warn('second signal, exiting now', { signal })
      process.exit(1)
    }
    shuttingDown = true
    logger.info('shutting down', { signal })
    const timer = setTimeout(() => {
      logger.error('shutdown timed out', { timeoutMs: SHUTDOWN_TIMEOUT_MS })
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    timer.unref()

    // Stop accepting connections, end runs / plugins / MCP / SSE streams, then drop what is left and close the DB.
    const closed = new Promise<void>(resolve => server.close(() => resolve()))
    await stopDeps(deps)
    if ('closeAllConnections' in server)
      server.closeAllConnections()
    await closed
    database.close()
    logger.info('stopped')
    process.exit(0)
  }

  // A second signal during shutdown exits immediately.
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

async function main(): Promise<void> {
  const env = readEnv()
  const redactor = createRedactor()
  if (env.password !== null)
    redactor.addSecret(env.password)
  const logger = createLogger({ level: env.logLevel, redactor })

  process.on('unhandledRejection', (reason) => {
    // Never fatal (PLUGINS.md 11 "Guards"): plugin code may leak rejections.
    logger.error('unhandled rejection', { err: reason })
  })

  const bindError = bindSafetyError(env)
  if (bindError !== null) {
    logger.error(bindError, { host: env.host })
    process.exit(1)
  }

  let database: Database | undefined
  try {
    ensureDataDir(env)
    database = await openDatabase({ path: env.paths.db })
    await migrateDatabase(database.db)
    const deps = createDeps({ env, logger, redactor, db: database.db, builtins: getBuiltinPlugins(env) })
    await startDeps(deps)
    const server = await listen(deps, logger)
    installShutdown(server, deps, database, logger)
  }
  catch (error) {
    logger.error('boot failed', { err: error })
    database?.close()
    process.exit(1)
  }
}

void main()
