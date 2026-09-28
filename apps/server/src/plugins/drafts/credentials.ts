// Credential values of drafts (API.md 4.12): checked against the declared fields of a declarative provider before
// anything is stored or sent. `PluginDraft.credentials` are saved as provider credentials after creation (never in
// `plugin.json`) through the credential service (`set`, or `setFor` while the provider is not registered);
// `DraftTestRequest.credentials` live for one test only. Owner: W3.3.
import type { CredentialField } from '@harness-forge/plugin-sdk'
import type { ValidationIssue } from '@harness-forge/shared'
import { isHarnessError, validationError } from '@harness-forge/shared'
import { validateCredentialValues } from '../../services/secrets/credentials.ts'

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
