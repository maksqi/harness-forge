// Provider and credential DTOs (API.md section 4.4).
import { z } from 'zod'
import { providerStatusSchema } from '../enums.ts'
import { harnessErrorInitSchema } from '../errors.ts'
import { pluginIdSchema, providerIdSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { iconRefSchema, secretStateSchema } from './common.ts'
import { credentialFieldSchema, fieldKeySchema } from './plugin-data.ts'

/** State of one credential field; `value` only for non-secret fields (`text`, `url`, `select`). */
export const credentialStateSchema = secretStateSchema.extend({
  value: z.string().optional(),
})
export type CredentialState = z.infer<typeof credentialStateSchema>

export const providerSummarySchema = z.object({
  id: providerIdSchema,
  /** UI name, e.g. `Anthropic (Claude)`. */
  name: z.string(),
  /** Owner: `core-providers`, `mock` or a plugin id. */
  pluginId: pluginIdSchema,
  icon: iconRefSchema,
  /** `provider_configs.enabled`. */
  enabled: z.boolean(),
  /**
   * First match: required fields unresolved and not `local` -> `not_configured`; `lastError` with code `auth_invalid`
   * or `provider_unreachable` -> `error`; every resolved secret from env -> `env`; otherwise `connected`.
   */
  status: providerStatusSchema,
  credentialFields: z.array(credentialFieldSchema),
  /** Key = `CredentialField.key`, one entry per field. */
  credentials: z.record(z.string(), credentialStateSchema),
  /** "Get a key" link. */
  keyUrl: z.string().nullable(),
  /** No required secret field ("Local — no key"). */
  local: z.boolean(),
  /** Visible chat models in the catalog. */
  modelCount: z.int().min(0),
  /** Last successful live listing. */
  modelsFetchedAt: timestampSchema.nullable(),
  /** Last failed validation / listing / call (auth or network). */
  lastError: harnessErrorInitSchema.nullable(),
  /** Last successful validation. */
  validatedAt: timestampSchema.nullable(),
})
export type ProviderSummary = z.infer<typeof providerSummarySchema>

/** Body of `PATCH /providers/:id`. */
export const providerUpdateSchema = z.strictObject({
  enabled: z.boolean(),
})
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>

/** Credential values by `CredentialField.key` (trimmed, <= 4096 characters). */
export const credentialValuesSchema = z.record(fieldKeySchema, z.string().trim().max(LIMITS.credentialValueMaxChars))
export type CredentialValues = z.infer<typeof credentialValuesSchema>

/** Body of `PUT /providers/:id/credentials`: `''` clears a stored value; omitted keys are unchanged. */
export const credentialsUpdateSchema = z.strictObject({
  values: credentialValuesSchema,
})
export type CredentialsUpdate = z.infer<typeof credentialsUpdateSchema>

/** Body of `POST /providers/:id/test`: candidate values merged over the stored ones for this test only. */
export const providerTestBodySchema = z.strictObject({
  values: credentialValuesSchema.optional(),
})
export type ProviderTestBody = z.infer<typeof providerTestBodySchema>

/** A failed test is `ok: false` with `error`, not an HTTP error. */
export const providerTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().min(0),
  /** When validation listed models. */
  modelCount: z.int().min(0).optional(),
  /** When `ok` is false. */
  error: harnessErrorInitSchema.optional(),
})
export type ProviderTestResult = z.infer<typeof providerTestResultSchema>
