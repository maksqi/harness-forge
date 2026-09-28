// libsql connection + Drizzle instance (ARCHITECTURE.md section 8).
//
// Pragmas: `journal_mode=WAL` is persistent in the database file; `busy_timeout` is applied to every pooled
// connection through the client `timeout` option; `foreign_keys` is ON in libsql builds by default and re-asserted
// here; `synchronous=NORMAL` is best effort (per connection). In-memory databases (`:memory:`) use a single
// connection: while a transaction is open, only the transaction object may be used.
import type { Client } from '@libsql/client'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema.ts'

export type DbSchema = typeof schema

/** The Drizzle database used by every service (`deps.db`). */
export type Db = LibSQLDatabase<DbSchema>

/** A Drizzle transaction (`db.transaction(async tx => ...)`). */
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0]

/** `Db` or a transaction: helpers that work in both accept this. */
export type DbExecutor = Db | DbTransaction

export interface Database {
  readonly db: Db
  readonly client: Client
  /** libsql URL (`file:/abs/path/harness.db` or `:memory:`). */
  readonly url: string
  readonly inMemory: boolean
  /** Closes every connection. Idempotent. */
  readonly close: () => void
}

export interface OpenDatabaseOptions {
  /** Absolute file path, or `:memory:` for an in-memory database (tests). */
  path: string
  /** Busy timeout in ms for every connection; default 5000. */
  busyTimeoutMs?: number
}

/** `:memory:` for in-memory databases, else a `file:` URL of the absolute path. */
export function databaseUrl(path: string): string {
  if (path === ':memory:')
    return ':memory:'
  return pathToFileURL(isAbsolute(path) ? path : resolve(path)).href
}

/** Opens the database (creating its directory), applies the pragmas and returns the Drizzle instance. */
export async function openDatabase(options: OpenDatabaseOptions): Promise<Database> {
  const inMemory = options.path === ':memory:'
  if (!inMemory)
    mkdirSync(dirname(resolve(options.path)), { recursive: true })
  const url = databaseUrl(options.path)
  const client = createClient({ url, timeout: options.busyTimeoutMs ?? 5000 })
  try {
    if (!inMemory)
      await client.execute('PRAGMA journal_mode = WAL')
    await client.execute('PRAGMA foreign_keys = ON')
    await client.execute('PRAGMA synchronous = NORMAL')
  }
  catch (error) {
    client.close()
    throw error
  }
  const db = drizzle(client, { schema })
  let closed = false
  return {
    db,
    client,
    url,
    inMemory,
    close: () => {
      if (closed)
        return
      closed = true
      client.close()
    },
  }
}
