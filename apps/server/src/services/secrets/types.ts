// Frozen interfaces of the encrypted secret store and of provider credentials (ARCHITECTURE.md 10.3, 6.6).
// Implementations (W1.2): `createSecretStore(deps)` in `services/secrets/index.ts`,
// `createCredentialService(deps)` in `services/secrets/credentials.ts`.
import type { CredentialField, CredentialState, CredentialValues } from '@harness-forge/shared'

/** `provider:<id>` | `plugin:<id>` | `mcp:<id>` | `auth`. */
export type SecretScope = `provider:${string}` | `plugin:${string}` | `mcp:${string}` | 'auth'

/** Metadata of a stored secret; never the value. */
export interface SecretEntry {
  scope: SecretScope
  /** e.g. `apiKey`, `settings.<key>`, `header.<Name>`, `env.<NAME>`, `password`. */
  name: string
  /** Masked hint computed at write time (`sk-…9fQ2`); null for short values. */
  hint: string | null
  keyVersion: number
  updatedAt: number
}

/**
 * AES-256-GCM secrets over the `secrets` table: random 12-byte IV per write, AAD = UTF-8 of `<scope>/<name>`
 * (a ciphertext copied to another row fails to decrypt), keyring `encryption` subkey. Decrypted values are registered
 * with the redactor (`deps.redactor.addSecret`) so they never reach logs.
 */
export interface SecretStore {
  /**
   * The decrypted value, or null when absent. A value that cannot be decrypted (changed master key, tampered row) is
   * logged as a warning and reported as null (the provider then shows `not_configured`), never thrown.
   */
  readonly get: (scope: SecretScope, name: string) => Promise<string | null>
  /** Encrypts and upserts; stores the masked hint. */
  readonly set: (scope: SecretScope, name: string, value: string) => Promise<void>
  /** Deletes one secret; true when it existed. */
  readonly delete: (scope: SecretScope, name: string) => Promise<boolean>
  /** Deletes every secret of a scope (plugin uninstall, MCP server delete); returns the count. */
  readonly deleteScope: (scope: SecretScope) => Promise<number>
  /** Metadata of every secret of a scope, sorted by name. */
  readonly list: (scope: SecretScope) => Promise<SecretEntry[]>
}

/** Where a resolved credential value comes from. */
export type CredentialValueSource = 'stored' | 'env' | 'default'

/** Credentials of one provider resolved for a call (never serialized to a response). */
export interface ResolvedCredentials {
  /** Value per field key: stored -> env var (`CredentialField.envVar`, first non-empty) -> `default`. */
  values: Record<string, string>
  /** Source per resolved key. */
  sources: Record<string, CredentialValueSource>
  /** Keys of required fields without a value (non-empty -> `provider_not_configured`). */
  missing: string[]
}

/**
 * Write-only provider credentials (API.md 5.6). Secret fields are stored in `secrets` (scope `provider:<id>`, name =
 * field key); other fields in `provider_configs.options`. The provider's `CredentialField[]` come from the registry.
 * Env fallbacks are read from `deps.env.vars`.
 */
export interface CredentialService {
  /**
   * Resolves every field of a registered provider; `overrides` (candidate values of `POST /providers/:id/test`) win
   * over stored values for this call only. Throws `not_found` for an unknown provider.
   */
  readonly resolve: (providerId: string, overrides?: Record<string, string>) => Promise<ResolvedCredentials>
  /** DTO state per field key: `{ set, hint, source, value? }` (`value` only for non-secret fields). */
  readonly states: (providerId: string) => Promise<Record<string, CredentialState>>
  /**
   * Validates `values` against the provider's fields (unknown keys, > 4096 chars, invalid URL, value not in a select's
   * options -> `validation_error`) and stores them; `''` clears a stored value; omitted keys are unchanged.
   * Does not emit events (the `credentials.ts` route emits `provider.changed` with the new summary).
   */
  readonly set: (providerId: string, values: CredentialValues) => Promise<void>
  /** Removes every stored value of the provider (env fallbacks keep working). */
  readonly clear: (providerId: string) => Promise<void>
  /**
   * `set` against the given fields instead of the registered provider's, for a provider that is not registered right
   * now (a declarative plugin created disabled, in safe mode or whose load failed): same validation, storage layout
   * and per-provider serialization. `validation_error` for an invalid provider id. W4.6 addition, optional so fakes
   * of this interface keep compiling; `createCredentialService` implements it.
   */
  readonly setFor?: (providerId: string, fields: readonly CredentialField[], values: CredentialValues) => Promise<void>
}
