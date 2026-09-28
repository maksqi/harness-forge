// Applies the generated SQL migrations (`apps/server/drizzle`, created by `pnpm db:generate`) at boot.
import type { Db } from './client.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { migrationsFolder } from '../paths.ts'

/** The migrations folder of the server package; throws when the journal is missing (run `pnpm db:generate`). */
export function resolveMigrationsFolder(): string {
  const folder = migrationsFolder()
  if (!existsSync(join(folder, 'meta', '_journal.json')))
    throw new Error(`No migrations found in ${folder}: run "pnpm db:generate".`)
  return folder
}

/** Brings the database schema up to date. Idempotent; a failure should stop the boot (exit 1). */
export async function migrateDatabase(db: Db, options: { migrationsFolder?: string } = {}): Promise<void> {
  await migrate(db, { migrationsFolder: options.migrationsFolder ?? resolveMigrationsFolder() })
}
