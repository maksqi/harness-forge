// Database error handling for the W1.5 services. Drizzle wraps a failed query in a `DrizzleQueryError` whose message
// contains the SQL parameters (message parts, titles, file names); such an error must never reach a log line or a
// response. `guardDb` turns driver errors into a generic `internal_error` whose `cause` is the driver error without the
// parameters; `HarnessError`s and every other error pass through unchanged.
import { HarnessError, isHarnessError } from '@harness-forge/shared'

const MAX_CAUSE_DEPTH = 5

function causeChain(error: unknown): object[] {
  const chain: object[] = []
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth++) {
    chain.push(current)
    current = (current as { cause?: unknown }).cause
  }
  return chain
}

/** Every SQLite error code (`SQLITE_CONSTRAINT`, `SQLITE_CONSTRAINT_PRIMARYKEY`, ...) of an error and its causes. */
export function sqliteErrorCodes(error: unknown): string[] {
  return causeChain(error).flatMap((entry) => {
    const code = (entry as { code?: unknown }).code
    return typeof code === 'string' && code.startsWith('SQLITE_') ? [code] : []
  })
}

/** A UNIQUE / PRIMARY KEY / FOREIGN KEY / NOT NULL / CHECK violation anywhere in the error chain. */
export function isConstraintError(error: unknown): boolean {
  return sqliteErrorCodes(error).some(code => code.startsWith('SQLITE_CONSTRAINT'))
}

function isDrizzleQueryError(error: unknown): error is Error & { query: unknown, params: unknown } {
  return error instanceof Error && 'query' in error && 'params' in error
}

/** An error raised by Drizzle or the libsql driver. */
export function isDriverError(error: unknown): boolean {
  return causeChain(error).some((entry) => {
    const code = (entry as { code?: unknown }).code
    return isDrizzleQueryError(entry)
      || (entry instanceof Error && entry.name.startsWith('Libsql'))
      || (typeof code === 'string' && code.startsWith('SQLITE_'))
  })
}

/** The error without SQL parameters: a drizzle query error is replaced by its driver cause. */
export function withoutQueryParameters(error: unknown): unknown {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isDrizzleQueryError(current); depth++)
    current = current.cause
  return isDrizzleQueryError(current) ? undefined : current
}

/** Driver errors become a generic `internal_error` (parameters stripped); anything else is returned unchanged. */
export function databaseError(error: unknown, message = 'A database error occurred.'): unknown {
  if (isHarnessError(error) || !isDriverError(error))
    return error
  return new HarnessError({ code: 'internal_error', message }, { cause: withoutQueryParameters(error) })
}

/** Runs `operation`, sanitizing driver errors (see `databaseError`). */
export async function guardDb<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  }
  catch (error) {
    throw databaseError(error)
  }
}
