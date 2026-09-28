// Values validator of a plugin settings form (PLUGINS.md section 7), shared by the server
// (`PUT /plugins/:id/settings`, `ctx.settings.get()`) and the web settings form.
import type { SettingsProperty, SettingsSchema } from '@harness-forge/shared'
import { settingsPropertyValueSchema } from '@harness-forge/shared'
import { z } from 'zod'

export interface SettingsValuesSchemaOptions {
  /**
   * Validate a patch (body of `PUT /plugins/:id/settings`): every key is optional (omitted = unchanged), no defaults
   * are applied, and `null` removes the stored value of a property that is not required. Default false.
   */
  partial?: boolean
  /**
   * Keys of secret properties (`format: 'secret'`) that already have a stored value: they satisfy `required` when
   * omitted (the value is write-only and never sent back).
   */
  secretsSet?: readonly string[]
}

function isSecret(property: SettingsProperty): boolean {
  return property.type === 'string' && property.format === 'secret'
}

/** Rejects `undefined` with "<title> is required." before running `schema`. */
function requiredValue(schema: z.ZodType, message: string): z.ZodType {
  return z.custom<unknown>(value => value !== undefined, message).pipe(schema)
}

/** A string that is empty, or valid for `schema` (optional text inputs may stay empty). */
function emptyOr(schema: z.ZodType): z.ZodType {
  return z.string().superRefine((text, ctx) => {
    if (text === '')
      return
    const result = schema.safeParse(text)
    if (!result.success) {
      for (const issue of result.error.issues)
        ctx.addIssue({ code: 'custom', message: issue.message, path: [...issue.path] })
    }
  })
}

/** Schema of a present value, including the "not blank" rules of required fields. */
function presentValue(property: SettingsProperty, required: boolean, message: string): z.ZodType {
  if (isSecret(property))
    return required ? z.string().refine(text => text.trim() !== '', message) : z.string()
  const value = settingsPropertyValueSchema(property)
  if (property.type === 'string' && !property.enum)
    return required ? value.refine(text => typeof text === 'string' && text.trim() !== '', message) : emptyOr(value)
  if (property.type === 'array' && required)
    return value.refine(items => Array.isArray(items) && items.length > 0, `${property.title} needs at least one value.`)
  return value
}

function fieldSchema(key: string, property: SettingsProperty, required: boolean, options: SettingsValuesSchemaOptions): z.ZodType {
  const message = `${property.title} is required.`
  const value = presentValue(property, required, message)
  if (options.partial)
    return required ? value.optional() : value.nullable().optional()
  if (isSecret(property)) {
    const stored = options.secretsSet?.includes(key) === true
    return required && !stored ? requiredValue(value, message) : value.optional()
  }
  if (property.default !== undefined) {
    const fallback = property.default
    return value.optional().default(() => structuredClone(fallback))
  }
  return required ? requiredValue(value, message) : value.optional()
}

/**
 * Builds the zod validator of a plugin's settings values from its `SettingsSchema`: unknown keys are rejected, every
 * value is checked against its property (enum, `url`, `pattern`, bounds, integer, unique array items), `required`
 * properties must be present and not blank, and defaults are applied to missing values.
 *
 * Secret properties (`format: 'secret'`) take any string; `''` clears the stored secret (not allowed when required).
 * Use `secretsSet` for secrets that already have a stored value, and `partial: true` to validate a `PUT` patch.
 */
export function settingsValuesSchema(schema: SettingsSchema, options: SettingsValuesSchemaOptions = {}): z.ZodType<Record<string, unknown>> {
  const required = new Set(schema.required ?? [])
  const shape: Record<string, z.ZodType> = {}
  for (const [key, property] of Object.entries(schema.properties))
    shape[key] = fieldSchema(key, property, required.has(key), options)
  return z.strictObject(shape)
}
