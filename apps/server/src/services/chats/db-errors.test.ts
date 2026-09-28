import type { Database } from '../../db/client.ts'
import { HarnessError } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../db/client.ts'
import { migrateDatabase } from '../../db/migrate.ts'
import { chats } from '../../db/schema.ts'
import { createRedactor } from '../../security/redact.ts'
import { databaseError, guardDb, isConstraintError, isDriverError, sqliteErrorCodes } from './db-errors.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
const PRIVATE_TITLE = 'my private medical question'

let database: Database

beforeAll(async () => {
  database = await openDatabase({ path: ':memory:' })
  await migrateDatabase(database.db)
  await database.db.insert(chats).values({ id: CHAT_ID })
})

afterAll(() => {
  database.close()
})

async function failingInsert(): Promise<unknown> {
  try {
    await database.db.insert(chats).values({ id: CHAT_ID, title: PRIVATE_TITLE })
  }
  catch (error) {
    return error
  }
  throw new Error('expected a constraint violation')
}

describe('database errors', () => {
  it('recognizes constraint violations of single queries and batches', async () => {
    const single = await failingInsert()
    expect(isDriverError(single)).toBe(true)
    expect(isConstraintError(single)).toBe(true)
    expect(sqliteErrorCodes(single)).toContain('SQLITE_CONSTRAINT')
    let batchError: unknown
    try {
      await database.db.batch([database.db.insert(chats).values({ id: CHAT_ID })])
    }
    catch (error) {
      batchError = error
    }
    expect(isConstraintError(batchError)).toBe(true)
  })

  it('turns driver errors into a generic internal_error without the query parameters', async () => {
    const original = await failingInsert()
    expect(String((original as Error).message)).toContain(PRIVATE_TITLE)
    const sanitized = databaseError(original)
    expect(sanitized).toBeInstanceOf(HarnessError)
    expect((sanitized as HarnessError).code).toBe('internal_error')
    expect(JSON.stringify((sanitized as HarnessError).toJSON())).not.toContain(PRIVATE_TITLE)
    // What the error handler would log: the error with its cause chain, redacted.
    const logged = JSON.stringify(createRedactor().redact({ err: sanitized }))
    expect(logged).toContain('SQLITE_CONSTRAINT')
    expect(logged).not.toContain(PRIVATE_TITLE)
    expect(isConstraintError(sanitized)).toBe(true)
  })

  it('passes HarnessErrors and non-driver errors through', async () => {
    const harness = new HarnessError({ code: 'not_found', message: 'Chat not found.' })
    expect(databaseError(harness)).toBe(harness)
    const plain = new Error('pipeline failed')
    expect(databaseError(plain)).toBe(plain)
    await expect(guardDb(async () => {
      throw plain
    })).rejects.toBe(plain)
    await expect(guardDb(async () => 42)).resolves.toBe(42)
  })
})
