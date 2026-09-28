// Rules of the schema-driven settings form (docs/UI.md 8.9, docs/PLUGINS.md section 7): control per property,
// form values from a `PluginSettingsView`, validation with `settingsValuesSchema()` of @harness-forge/plugin-sdk (the
// validator the server uses), "Reset to defaults" and the `PUT /plugins/:id/settings` patch.
//
// Form values hold one entry per property. Secret properties are write-only: absent (undefined) keeps the stored
// value, a string replaces it, and '' clears it.
import type { PluginSettingsView, SettingsProperty, SettingsSchema } from '@harness-forge/shared'
import { settingsValuesSchema } from '@harness-forge/plugin-sdk'
import { flattenValidationIssues } from '@harness-forge/shared'

export type SettingsValues = Record<string, unknown>

/** The control a property renders as. */
export type SchemaFieldKind
  = | 'text'
    | 'url'
    | 'multiline'
    | 'secret'
    | 'select'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'checkboxes'
    | 'tags'

export function schemaFieldKind(property: SettingsProperty): SchemaFieldKind {
  switch (property.type) {
    case 'string':
      if (property.enum)
        return 'select'
      if (property.format === 'secret')
        return 'secret'
      if (property.format === 'url')
        return 'url'
      if (property.format === 'multiline')
        return 'multiline'
      return 'text'
    case 'number':
      return 'number'
    case 'integer':
      return 'integer'
    case 'boolean':
      return 'boolean'
    case 'array':
      return property.items.enum ? 'checkboxes' : 'tags'
  }
}

export function isSecretProperty(property: SettingsProperty): boolean {
  return property.type === 'string' && property.format === 'secret'
}

/** Property keys in schema order (docs/PLUGINS.md: "rendered in key order"). */
export function schemaKeys(schema: SettingsSchema): string[] {
  return Object.keys(schema.properties)
}

/**
 * Deep copy of plain JSON-like values (form values are strings, numbers, booleans and string arrays). Works on Vue
 * reactive proxies, which `structuredClone` rejects.
 */
export function cloneValues<T>(value: T): T {
  if (Array.isArray(value))
    return value.map(item => cloneValues(item)) as T
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value))
      copy[key] = cloneValues(item)
    return copy as T
  }
  return value
}

/** Equality of form values; a missing key equals `undefined`. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b))
    return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]))
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of keys) {
      if (!sameValue(left[key], right[key]))
        return false
    }
    return true
  }
  return false
}

/**
 * Form values of a settings view: the non-secret values of the schema's properties (the server already applied the
 * defaults; a switch without a value starts off); secret properties are absent, which keeps their stored values.
 */
export function settingsFormValues(view: Pick<PluginSettingsView, 'schema' | 'values'>): SettingsValues {
  const values: SettingsValues = {}
  if (!view.schema)
    return values
  for (const [key, property] of Object.entries(view.schema.properties)) {
    if (isSecretProperty(property))
      continue
    const value = view.values[key]
    if (value !== undefined && value !== null)
      values[key] = cloneValues(value)
    else if (property.type === 'boolean')
      values[key] = false
  }
  return values
}

/** Keys of secret properties with a stored value. */
export function storedSecretKeys(view: Pick<PluginSettingsView, 'secrets'>): string[] {
  return Object.entries(view.secrets).filter(([, state]) => state.set).map(([key]) => key)
}

/** Masked hints of stored secrets ("sk-…9fQ2"); null when too short to hint. */
export function storedSecretHints(view: Pick<PluginSettingsView, 'secrets'>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(view.secrets).filter(([, state]) => state.set).map(([key, state]) => [key, state.hint]))
}

/** The value "Reset to defaults" gives a property: its default, else empty (secrets are never reset). */
export function defaultValueOf(property: SettingsProperty): unknown {
  if (property.default !== undefined)
    return cloneValues(property.default)
  switch (schemaFieldKind(property)) {
    case 'text':
    case 'url':
    case 'multiline':
      return ''
    case 'checkboxes':
    case 'tags':
      return []
    case 'boolean':
      return false
    default:
      return undefined
  }
}

/** `values` with every non-secret property set to its default (secret properties keep their current value). */
export function valuesWithDefaults(schema: SettingsSchema, values: SettingsValues): SettingsValues {
  const next: SettingsValues = {}
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = isSecretProperty(property) ? values[key] : defaultValueOf(property)
    if (value !== undefined)
      next[key] = value
  }
  return next
}

/** True when every non-secret property already has its default value. */
export function hasDefaultValues(schema: SettingsSchema, values: SettingsValues): boolean {
  return Object.entries(schema.properties).every(([key, property]) =>
    isSecretProperty(property) || sameValue(normalizedEmpty(property, values[key]), normalizedEmpty(property, defaultValueOf(property))))
}

/**
 * The value that counts for comparisons: an empty text field is the same as an unset one, and an unset list without a
 * default is the same as an empty one. (A list with a default that is empty is an explicit choice.)
 */
function normalizedEmpty(property: SettingsProperty, value: unknown): unknown {
  if (property.type === 'array')
    return value === undefined && property.default === undefined ? [] : value
  if (property.type === 'string' && !property.enum && value === '')
    return undefined
  return value
}

/** Only the schema's keys, without `undefined` entries (the validator rejects unknown keys). */
export function presentValues(schema: SettingsSchema, values: SettingsValues): SettingsValues {
  const present: SettingsValues = {}
  for (const key of schemaKeys(schema)) {
    const value = values[key]
    if (value !== undefined)
      present[key] = value
  }
  return present
}

// ---------- validation ----------

export interface SettingsValidation {
  /** First message per property key. */
  fields: Record<string, string>
  /** A message that belongs to no property (unexpected keys). */
  form?: string
}

function describeRange(property: SettingsProperty): string | null {
  if (property.type !== 'number' && property.type !== 'integer')
    return null
  const { minimum, maximum } = property
  if (minimum !== undefined && maximum !== undefined)
    return `Enter a number from ${minimum} to ${maximum}.`
  if (minimum !== undefined)
    return `Enter a number of at least ${minimum}.`
  if (maximum !== undefined)
    return `Enter a number of at most ${maximum}.`
  return null
}

/** Plain wording for the generic zod messages (bounds, types, enum values); other messages stay as they are. */
function issueMessage(property: SettingsProperty | undefined, issue: { code: string, message: string, path: (string | number)[] }): string {
  if (!property)
    return issue.message
  const itemIssue = issue.path.length > 1
  if (property.type === 'number' || property.type === 'integer') {
    if (issue.code === 'too_small' || issue.code === 'too_big')
      return describeRange(property) ?? issue.message
    if (issue.code === 'invalid_type')
      return property.type === 'integer' ? 'Enter a whole number.' : 'Enter a number.'
  }
  if (issue.code === 'invalid_value')
    return itemIssue ? 'Choose values from the list.' : 'Choose a value from the list.'
  if (property.type === 'array' && itemIssue && issue.code === 'too_small')
    return 'Values cannot be empty.'
  if (issue.code === 'invalid_type')
    return `${property.title} has an invalid value.`
  return issue.message
}

/**
 * Validates form values with `settingsValuesSchema(schema, { secretsSet })`: null when valid, else the first message
 * per property. `secretsSet` lists secret properties that have a stored value (they satisfy `required`).
 */
export function validateSettingsValues(
  schema: SettingsSchema,
  values: SettingsValues,
  secretsSet: readonly string[] = [],
): SettingsValidation | null {
  const result = settingsValuesSchema(schema, { secretsSet }).safeParse(presentValues(schema, values))
  if (result.success)
    return null
  const validation: SettingsValidation = { fields: {} }
  for (const issue of flattenValidationIssues(result.error)) {
    const key = issue.path[0]
    if (typeof key === 'string' && Object.hasOwn(schema.properties, key)) {
      validation.fields[key] ??= issueMessage(schema.properties[key], issue)
    }
    else {
      validation.form ??= issue.message
    }
  }
  return validation
}

// ---------- saving ----------

/**
 * Body values of `PUT /plugins/:id/settings`: only properties that changed against `baseline` ('' and a missing
 * value count as the same). A cleared value is sent as null, which removes the stored value; secret properties are
 * sent only when replaced (a string) or cleared ('').
 */
export function settingsPatch(schema: SettingsSchema, values: SettingsValues, baseline: SettingsValues): SettingsValues {
  const patch: SettingsValues = {}
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = values[key]
    if (isSecretProperty(property)) {
      if (typeof value === 'string')
        patch[key] = value
      continue
    }
    const current = normalizedEmpty(property, value)
    if (sameValue(current, normalizedEmpty(property, baseline[key])))
      continue
    patch[key] = current === undefined ? null : cloneValues(current)
  }
  return patch
}

/** True when saving would change something (the patch is not empty). */
export function settingsChanged(schema: SettingsSchema, values: SettingsValues, baseline: SettingsValues): boolean {
  return Object.keys(settingsPatch(schema, values, baseline)).length > 0
}
