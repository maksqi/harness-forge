// Credential values of drafts (API.md 4.12): checked against the declared fields of a declarative provider before
// anything is stored or sent. `PluginDraft.credentials` are saved as provider credentials after creation (never in
// `plugin.json`); `DraftTestRequest.credentials` live for one test only. Owner: W3.3.
import type { CredentialField } from '@harness-forge/plugin-sdk'
import type { ValidationIssue } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import { HarnessError, isHarnessError, validationError } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { providerConfigs } from '../../db/schema.ts'
import { validateCredentialValues } from '../../services/secrets/credentials.ts'
import { providerSecretScope } from '../../services/secrets/scope.ts'

/**
 * Validates `values` against `fields` (unknown keys, control characters, `url` and `select` rules, <= 4096 characters)
 * and returns the trimmed, non-empty values. Issues are reported under `path` (e.g. `['credentials', 'my-provider']`).
 */
export function checkCredentialValues(
  fields: readonly CredentialField[],
  values: Record<string, string>,
  path: readonly (string | number)[],
): Record<string, string> {
  let checked: Record<string, string>
  try {
    checked = validateCredentialValues(fields, values)
  }
  catch (error) {
    if (!isHarnessError(error) || error.code !== 'validation_error')
      throw error
    const details = error.details as { issues?: ValidationIssue[] } | undefined
    const issues = (details?.issues ?? []).map(issue => ({
      ...issue,
      path: [...path, ...(issue.path[0] === 'values' ? issue.path.slice(1) : issue.path)],
    }))
    const first = issues[0]
    throw validationError(issues, first ? `${first.path.join('.')}: ${first.message}` : error.message)
  }
  return Object.fromEntries(Object.entries(checked).filter(([, value]) => value !== ''))
}

/** Values of every declared field for a draft test: the supplied value, else the field default. */
export function resolveDraftCredentials(fields: readonly CredentialField[], values: Record<string, string>): {
  values: Record<string, string>
  missing: CredentialField[]
} {
  const resolved: Record<string, string> = {}
  const missing: CredentialField[] = []
  for (const field of fields) {
    const value = values[field.key] || field.default || ''
    if (value !== '')
      resolved[field.key] = value
    else if (field.required)
      missing.push(field)
  }
  return { values: resolved, missing }
}

/**
 * Stores credentials of a provider that is not registered (a draft created disabled, in safe mode, or whose load
 * failed) in the layout of the credential service (W1.2): secret fields encrypted in `secrets` (scope
 * `provider:<id>`, name = key), the other fields in `provider_configs.options`. The credential service requires a
 * registered provider, so it cannot be used before the plugin loads.
 */
export async function storeUnregisteredCredentials(
  deps: AppDeps,
  providerId: string,
  fields: readonly CredentialField[],
  values: Record<string, string>,
): Promise<void> {
  const byKey = new Map(fields.map(field => [field.key, field]))
  const options: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key)
    if (!field)
      throw new HarnessError({ code: 'validation_error', message: `Unknown credential field "${key}".` })
    if (field.type === 'secret') {
      deps.redactor.addSecret(value)
      await deps.secrets.set(providerSecretScope(providerId), key, value)
    }
    else {
      options[key] = value
    }
  }
  if (Object.keys(options).length === 0)
    return
  const [row] = await deps.db
    .select({ options: providerConfigs.options })
    .from(providerConfigs)
    .where(eq(providerConfigs.providerId, providerId))
    .limit(1)
  const stored = row?.options !== null && typeof row?.options === 'object' && !Array.isArray(row.options) ? row.options as Record<string, unknown> : {}
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value === 'string')
      merged[key] = value
  }
  Object.assign(merged, options)
  const updatedAt = Date.now()
  await deps.db
    .insert(providerConfigs)
    .values({ providerId, options: merged, lastError: null, updatedAt })
    .onConflictDoUpdate({ target: providerConfigs.providerId, set: { options: merged, lastError: null, updatedAt } })
}
