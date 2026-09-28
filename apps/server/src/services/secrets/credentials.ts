// Write-only provider credentials (API.md 4.4 / 5.6, ARCHITECTURE.md 6.6, W1.2-T5). Implements the frozen
// `CredentialService` (./types.ts).
//
// Storage: `secret` fields are encrypted in `secrets` (scope `provider:<id>`, name = field key); `text` / `url` /
// `select` fields live in `provider_configs.options`. The fields come from the registered `ProviderDefinition`.
//
// Resolution of one field (`resolve`, used by the providers service for every call and test):
//   candidate value (`overrides`, provider test only; `''` means "as if cleared")
//   -> stored value -> first non-empty environment variable of `CredentialField.envVar` (from `deps.env.vars`;
//   `HF_*` names are never used) -> `CredentialField.default`.
//
// DTO state (`states`, never a secret value): stored secret -> `{ set: true, hint: 'sk-…9fQ2', source: 'stored' }`;
// stored text/url/select -> `{ set: true, hint: null, source: 'stored', value }`; resolved from the environment ->
// `{ set: true, hint: null, source: 'env' }` (environment values are never echoed, not even masked); otherwise
// `{ set: false, hint: null, source: null }` (a default is not a configured value; the UI shows the field default).
// A stored secret that cannot be decrypted counts as not stored.
import type { CredentialField } from '@harness-forge/plugin-sdk'
import type { CredentialState, CredentialValues, ValidationIssue } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { CredentialService, CredentialValueSource, ResolvedCredentials } from './types.ts'
import { credentialValuesSchema, HarnessError, httpUrlSchema, PROVIDER_ID_PATTERN, validationError } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { providerConfigs } from '../../db/schema.ts'
import { providerSecretScope } from './scope.ts'

/** Environment variables reserved for harness-forge itself; never used as credential fallbacks. */
const RESERVED_ENV_PREFIX = 'HF_'

/** Field keys of `values` checked by `validateCredentialValues` (the request body is `{ values }`). */
const VALUES_PATH = 'values'

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7F)
      return true
  }
  return false
}

function unknownProvider(providerId: string): HarnessError {
  return new HarnessError({
    code: 'not_found',
    message: PROVIDER_ID_PATTERN.test(providerId) ? `Unknown provider "${providerId}".` : 'Unknown provider.',
    ...(PROVIDER_ID_PATTERN.test(providerId) ? { providerId } : {}),
  })
}

/**
 * Validates credential values against a provider's fields: the shared `credentialValuesSchema` (field key format, trim,
 * <= 4096 characters), then unknown keys, control characters, `url` fields (absolute http(s) URL without credentials)
 * and `select` fields (one of `options`). `''` (clear) is always accepted for a known key. Throws `validation_error`
 * with issue paths `['values', key]`; returns the trimmed values.
 */
export function validateCredentialValues(fields: readonly CredentialField[], values: unknown): CredentialValues {
  const parsed = credentialValuesSchema.safeParse(values)
  if (!parsed.success)
    throw validationError({ issues: parsed.error.issues.map(issue => ({ ...issue, path: [VALUES_PATH, ...issue.path] })) })
  const byKey = new Map(fields.map(field => [field.key, field]))
  const issues: ValidationIssue[] = []
  const fail = (key: string, message: string): void => {
    issues.push({ path: [VALUES_PATH, key], message, code: 'custom' })
  }
  for (const [key, value] of Object.entries(parsed.data)) {
    const field = byKey.get(key)
    if (field === undefined) {
      fail(key, `Unknown credential field "${key}".`)
      continue
    }
    if (value === '')
      continue
    if (hasControlChars(value))
      fail(key, `${field.label} cannot contain control characters.`)
    else if (field.type === 'url' && !httpUrlSchema.safeParse(value).success)
      fail(key, `${field.label} must be an absolute http:// or https:// URL without credentials.`)
    else if (field.type === 'select' && !(field.options ?? []).includes(value))
      fail(key, `${field.label} must be one of: ${(field.options ?? []).join(', ')}.`)
  }
  if (issues.length > 0)
    throw validationError(issues)
  return parsed.data
}

/** Env fallback names of a field, in order, without the reserved `HF_*` names. */
export function envVarNames(field: CredentialField): string[] {
  const names = field.envVar === undefined ? [] : Array.isArray(field.envVar) ? field.envVar : [field.envVar]
  return names.filter(name => !name.toUpperCase().startsWith(RESERVED_ENV_PREFIX))
}

/** The first non-empty (trimmed) environment variable of `field.envVar`, or undefined. */
export function envCredentialValue(field: CredentialField, vars: Readonly<Record<string, string | undefined>>): string | undefined {
  for (const name of envVarNames(field)) {
    const value = vars[name]?.trim()
    if (value)
      return value
  }
  return undefined
}

/** Keeps the string values of a stored `provider_configs.options` object. */
function stringOptions(options: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    return out
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'string')
      out[key] = value
  }
  return out
}

/**
 * Serializes async tasks per key (credential writes of one provider): a read-modify-write of `options` never loses a
 * concurrent update. A failed task does not block the next one.
 */
function createKeyedQueue(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>()
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(task)
    const tail = result.then(() => {}, () => {})
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail)
        tails.delete(key)
    })
    return result
  }
}

export function createCredentialService(deps: AppDeps): CredentialService {
  const { db } = deps
  const serialize = createKeyedQueue()

  function fieldsOf(providerId: string): readonly CredentialField[] {
    const provider = typeof providerId === 'string' ? deps.registry.providers.get(providerId) : undefined
    if (provider === undefined)
      throw unknownProvider(String(providerId))
    return provider.definition.credentials
  }

  function envValue(field: CredentialField): string | undefined {
    return envCredentialValue(field, deps.env.vars)
  }

  async function storedOptions(providerId: string): Promise<Record<string, string>> {
    const [row] = await db
      .select({ options: providerConfigs.options })
      .from(providerConfigs)
      .where(eq(providerConfigs.providerId, providerId))
      .limit(1)
    return stringOptions(row?.options)
  }

  /** Stored value of a field (secrets decrypted), or undefined; an empty stored string counts as unset. */
  async function storedValue(providerId: string, field: CredentialField, options: Record<string, string>): Promise<string | undefined> {
    const value = field.type === 'secret'
      ? await deps.secrets.get(providerSecretScope(providerId), field.key)
      : options[field.key]
    return value || undefined
  }

  async function writeOptions(providerId: string, changes: ReadonlyMap<string, string | null> | null): Promise<void> {
    const options = changes === null ? {} : await storedOptions(providerId)
    for (const [key, value] of changes ?? []) {
      if (value === null)
        delete options[key]
      else
        options[key] = value
    }
    const updatedAt = Date.now()
    // New credentials make the last provider error stale (API.md 5.6 "Clears lastError").
    await db
      .insert(providerConfigs)
      .values({ providerId, options, lastError: null, updatedAt })
      .onConflictDoUpdate({ target: providerConfigs.providerId, set: { options, lastError: null, updatedAt } })
  }

  async function resolve(providerId: string, overrides?: Record<string, string>): Promise<ResolvedCredentials> {
    const fields = fieldsOf(providerId)
    const candidates = overrides === undefined ? undefined : validateCredentialValues(fields, overrides)
    const options = await storedOptions(providerId)
    const values: Record<string, string> = {}
    const sources: Record<string, CredentialValueSource> = {}
    const missing: string[] = []
    for (const field of fields) {
      const candidate = candidates?.[field.key]
      let value: string | undefined
      let source: CredentialValueSource | undefined
      if (candidate !== undefined) {
        // A candidate replaces the stored value; `''` tests the provider as if the stored value were cleared.
        if (candidate !== '') {
          value = candidate
          source = 'stored'
        }
      }
      else {
        value = await storedValue(providerId, field, options)
        source = value === undefined ? undefined : 'stored'
      }
      if (value === undefined) {
        value = envValue(field)
        source = value === undefined ? undefined : 'env'
      }
      if (value === undefined && field.default) {
        value = field.default
        source = 'default'
      }
      if (value === undefined || source === undefined) {
        if (field.required)
          missing.push(field.key)
        continue
      }
      values[field.key] = value
      sources[field.key] = source
      if (field.type === 'secret')
        deps.redactor.addSecret(value)
    }
    return { values, sources, missing }
  }

  async function states(providerId: string): Promise<Record<string, CredentialState>> {
    const fields = fieldsOf(providerId)
    const scope = providerSecretScope(providerId)
    const options = await storedOptions(providerId)
    const hints = new Map((await deps.secrets.list(scope)).map(entry => [entry.name, entry.hint]))
    const out: Record<string, CredentialState> = {}
    for (const field of fields) {
      if (field.type === 'secret') {
        // Only a decryptable value counts as stored (a row written with another master key shows as not set).
        if (hints.has(field.key) && await deps.secrets.get(scope, field.key)) {
          out[field.key] = { set: true, hint: hints.get(field.key) ?? null, source: 'stored' }
          continue
        }
      }
      else {
        const value = options[field.key]
        if (value) {
          out[field.key] = { set: true, hint: null, source: 'stored', value }
          continue
        }
      }
      out[field.key] = envValue(field) === undefined
        ? { set: false, hint: null, source: null }
        : { set: true, hint: null, source: 'env' }
    }
    return out
  }

  async function set(providerId: string, values: CredentialValues): Promise<void> {
    const fields = fieldsOf(providerId)
    const parsed = validateCredentialValues(fields, values)
    const byKey = new Map(fields.map(field => [field.key, field]))
    const scope = providerSecretScope(providerId)
    await serialize(providerId, async () => {
      const optionChanges = new Map<string, string | null>()
      for (const [key, value] of Object.entries(parsed)) {
        if (byKey.get(key)?.type === 'secret') {
          if (value === '')
            await deps.secrets.delete(scope, key)
          else
            await deps.secrets.set(scope, key, value)
        }
        else {
          optionChanges.set(key, value === '' ? null : value)
        }
      }
      await writeOptions(providerId, optionChanges)
    })
  }

  async function clear(providerId: string): Promise<void> {
    fieldsOf(providerId)
    await serialize(providerId, async () => {
      await deps.secrets.deleteScope(providerSecretScope(providerId))
      await writeOptions(providerId, null)
    })
  }

  return { resolve, states, set, clear }
}
