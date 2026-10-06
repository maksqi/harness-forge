// Secret scopes and names (DECISIONS.md "Secret scopes", ARCHITECTURE.md 8 `secrets`).
import type { SecretScope } from './types.ts'
import { HarnessError } from '@harness-forge/shared'

/**
 * `provider:<id>` | `plugin:<id>` | `mcp:<id>` (lowercase ids of 1-64 characters) | `auth` | Phase 11 (ADR-050):
 * `project:<projectId>` (`prj_` + 16 characters of `[0-9A-Za-z]`; the project's MCP variables).
 */
const SECRET_SCOPE = /^(?:(?:provider|plugin|mcp):[\da-z](?:[\da-z-]{0,62}[\da-z])?|project:prj_[\dA-Za-z]{16}|auth)$/
/** Visible ASCII without spaces, 1-256 characters (`apiKey`, `settings.<key>`, `header.<Name>`, `env.<NAME>`). */
const SECRET_NAME = /^[\x21-\x7E]{1,256}$/

/** Largest value the store accepts (credential values are limited to 4096 characters, plugin secrets to 16 KB). */
export const SECRET_VALUE_MAX_BYTES = 65_536

export function isSecretScope(value: unknown): value is SecretScope {
  return typeof value === 'string' && SECRET_SCOPE.test(value)
}

export function isSecretName(value: unknown): value is string {
  return typeof value === 'string' && SECRET_NAME.test(value)
}

/** Scope of a provider's secret credential fields. */
export function providerSecretScope(providerId: string): SecretScope {
  return `provider:${providerId}`
}

function invalid(message: string, path: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: [path], message, code: 'custom' }] } })
}

export function assertSecretScope(scope: unknown): asserts scope is SecretScope {
  if (!isSecretScope(scope))
    throw invalid('Invalid secret scope.', 'scope')
}

export function assertSecretName(name: unknown): asserts name is string {
  if (!isSecretName(name))
    throw invalid('Invalid secret name.', 'name')
}
