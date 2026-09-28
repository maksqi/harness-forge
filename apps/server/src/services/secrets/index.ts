// Encrypted secret store over the `secrets` table (ARCHITECTURE.md 10.3, W1.2-T2). Implements the frozen `SecretStore`
// (./types.ts): AES-256-GCM with the keyring `encryption` subkey, a random 12-byte IV per write, AAD = `<scope>/<name>`
// (./crypto.ts) and a masked hint computed at write time (./hint.ts; never for the `auth` scope).
//
// Write-only by design: values leave this module only through `get()` for in-process use (provider calls, MCP connect,
// the owning plugin's `ctx.secrets`), and every value read or written is registered with the redactor so it can never
// reach a log line. A row that cannot be decrypted (other master key, row copied or tampered with) is reported as absent
// and logged once as a warning, without the value.
import type { AppDeps } from '../../types.ts'
import type { SecretEntry, SecretScope, SecretStore } from './types.ts'
import { Buffer } from 'node:buffer'
import { HarnessError } from '@harness-forge/shared'
import { and, asc, eq } from 'drizzle-orm'
import { secrets } from '../../db/schema.ts'
import { decryptSecret, encryptSecret, secretAad } from './crypto.ts'
import { secretHint } from './hint.ts'
import { assertSecretName, assertSecretScope, SECRET_VALUE_MAX_BYTES } from './scope.ts'

export { decryptSecret, encryptSecret, secretAad } from './crypto.ts'
export { secretHint } from './hint.ts'
export { isSecretName, isSecretScope, providerSecretScope } from './scope.ts'

function assertSecretValue(value: unknown): asserts value is string {
  if (typeof value !== 'string')
    throw new HarnessError({ code: 'validation_error', message: 'Secret values must be strings.' })
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > SECRET_VALUE_MAX_BYTES)
    throw new HarnessError({ code: 'validation_error', message: `Secret values are limited to ${SECRET_VALUE_MAX_BYTES} bytes.` })
  // Lone surrogates would not survive the UTF-8 round trip.
  if (bytes.toString('utf8') !== value)
    throw new HarnessError({ code: 'validation_error', message: 'Secret values must be valid Unicode text.' })
}

/** The hint stored for a value: none for the `auth` scope (password hashes), else `secretHint`. */
export function storedHint(scope: SecretScope, value: string): string | null {
  return scope === 'auth' ? null : secretHint(value)
}

export function createSecretStore(deps: AppDeps): SecretStore {
  const { db, logger, redactor } = deps
  /** Rows already reported as undecryptable (`scope/name@updatedAt`), so a broken row warns once per process. */
  const reported = new Set<string>()

  function whereRow(scope: SecretScope, name: string) {
    return and(eq(secrets.scope, scope), eq(secrets.name, name))
  }

  function reportUnreadable(scope: SecretScope, name: string, updatedAt: number, reason: string): void {
    const id = `${scope}/${name}@${updatedAt}`
    if (reported.has(id))
      return
    reported.add(id)
    logger.warn('stored secret cannot be decrypted and is ignored', { scope, name, reason })
  }

  async function get(scope: SecretScope, name: string): Promise<string | null> {
    assertSecretScope(scope)
    assertSecretName(name)
    const [row] = await db
      .select({ ciphertext: secrets.ciphertext, keyVersion: secrets.keyVersion, updatedAt: secrets.updatedAt })
      .from(secrets)
      .where(whereRow(scope, name))
      .limit(1)
    if (row === undefined)
      return null
    const { keyring } = deps
    if (row.keyVersion !== keyring.keyVersion) {
      reportUnreadable(scope, name, row.updatedAt, `key version ${row.keyVersion} is not available`)
      return null
    }
    // Outside the `try`: a keyring failure is a server error, not an unreadable row.
    const key = keyring.subkey('encryption')
    let value: string
    try {
      value = decryptSecret(key, secretAad(scope, name), row.ciphertext)
    }
    catch {
      reportUnreadable(scope, name, row.updatedAt, 'authentication failed (other master key, or the row was altered)')
      return null
    }
    redactor.addSecret(value)
    return value
  }

  async function set(scope: SecretScope, name: string, value: string): Promise<void> {
    assertSecretScope(scope)
    assertSecretName(name)
    assertSecretValue(value)
    redactor.addSecret(value)
    const { keyring } = deps
    const ciphertext = encryptSecret(keyring.subkey('encryption'), secretAad(scope, name), value)
    const hint = storedHint(scope, value)
    const updatedAt = Date.now()
    await db
      .insert(secrets)
      .values({ scope, name, ciphertext, hint, keyVersion: keyring.keyVersion, updatedAt })
      .onConflictDoUpdate({
        target: [secrets.scope, secrets.name],
        set: { ciphertext, hint, keyVersion: keyring.keyVersion, updatedAt },
      })
  }

  async function remove(scope: SecretScope, name: string): Promise<boolean> {
    assertSecretScope(scope)
    assertSecretName(name)
    const deleted = await db.delete(secrets).where(whereRow(scope, name)).returning({ name: secrets.name })
    return deleted.length > 0
  }

  async function deleteScope(scope: SecretScope): Promise<number> {
    assertSecretScope(scope)
    const deleted = await db.delete(secrets).where(eq(secrets.scope, scope)).returning({ name: secrets.name })
    return deleted.length
  }

  async function list(scope: SecretScope): Promise<SecretEntry[]> {
    assertSecretScope(scope)
    const rows = await db
      .select({ name: secrets.name, hint: secrets.hint, keyVersion: secrets.keyVersion, updatedAt: secrets.updatedAt })
      .from(secrets)
      .where(eq(secrets.scope, scope))
      .orderBy(asc(secrets.name))
    return rows.map(row => ({ scope, name: row.name, hint: row.hint, keyVersion: row.keyVersion, updatedAt: row.updatedAt }))
  }

  return { get, set, delete: remove, deleteScope, list }
}
