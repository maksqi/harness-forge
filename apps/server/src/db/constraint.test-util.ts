// Test helper of the database tests (Phase 9, C24-T6): Drizzle wraps a failed query in a `DrizzleQueryError` whose own
// message holds only the SQL, so a constraint violation is checked on the driver error in its `cause` chain.

const MAX_CAUSE_DEPTH = 5

/** The messages and codes of an error and its causes. */
export function errorChain(error: unknown): Array<{ message: string, code: string | null }> {
  const chain: Array<{ message: string, code: string | null }> = []
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth++) {
    const entry = current as { message?: unknown, code?: unknown, cause?: unknown }
    chain.push({ message: typeof entry.message === 'string' ? entry.message : '', code: typeof entry.code === 'string' ? entry.code : null })
    current = entry.cause
  }
  return chain
}

/**
 * Resolves with the `UNIQUE constraint failed: <table>.<columns>` message of a rejected write (the driver error in
 * the cause chain); throws when the write succeeded or failed for another reason.
 */
export async function uniqueViolation(write: PromiseLike<unknown>): Promise<string> {
  let failure: unknown
  try {
    await write
  }
  catch (error) {
    failure = error
  }
  if (failure === undefined)
    throw new Error('Expected a unique violation, but the write succeeded.')
  const message = errorChain(failure).map(entry => entry.message).find(text => text.includes('UNIQUE constraint failed'))
  if (message === undefined)
    throw new Error(`Expected a unique violation, got: ${errorChain(failure).map(entry => entry.code ?? entry.message.slice(0, 80)).join(' <- ')}`)
  return message.slice(message.indexOf('UNIQUE constraint failed'))
}
