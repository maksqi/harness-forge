// Plugin settings form schema (`SettingsSchema`, PLUGINS.md section 7). The values validator
// `settingsValuesSchema()` lives in `@harness-forge/plugin-sdk` and builds on `settingsPropertyValueSchema()`.
import { z } from 'zod'
import { FIELD_KEY_PATTERN } from '../ids.ts'
import { compileRegExp, duplicates, isUnique } from '../util/text.ts'
import { isHttpUrl } from '../util/url.ts'

/** Maximum number of properties of a settings schema. */
export const SETTINGS_PROPERTIES_MAX = 50
/** Maximum number of `enum` values of a property. */
export const SETTINGS_ENUM_MAX = 100

/** Key of a settings property: `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`. */
export const settingsKeySchema = z.string().regex(FIELD_KEY_PATTERN, 'Keys start with a letter and use up to 64 characters of a-z, A-Z, 0-9 and "_".')

const enumValuesSchema = z
  .array(z.string())
  .min(1)
  .max(SETTINGS_ENUM_MAX)
  .refine(isUnique, 'Enum values must be unique.')

const propertyBase = {
  /** Label of the form control. */
  title: z.string().trim().min(1).max(100),
  /** Help text (plain text, never HTML). */
  description: z.string().max(1000).optional(),
  /** Must validate against the property; not allowed for `format: 'secret'`. */
  default: z.unknown().optional(),
}

const stringPropertySchema = z.strictObject({
  type: z.literal('string'),
  ...propertyBase,
  enum: enumValuesSchema.optional(),
  format: z.enum(['secret', 'url', 'multiline']).optional(),
  /** JavaScript regular expression source compiled with the `u` flag, not implicitly anchored. */
  pattern: z.string().min(1).max(256).optional(),
})

const numberPropertySchema = z.strictObject({
  type: z.enum(['number', 'integer']),
  ...propertyBase,
  minimum: z.number().optional(),
  maximum: z.number().optional(),
})

const booleanPropertySchema = z.strictObject({
  type: z.literal('boolean'),
  ...propertyBase,
})

const arrayPropertySchema = z.strictObject({
  type: z.literal('array'),
  ...propertyBase,
  items: z.strictObject({ type: z.literal('string'), enum: enumValuesSchema.optional() }),
})

/**
 * One property of a settings form: `{ title; description?; default? }` and, by `type`, `string` (`enum?`, `format?`
 * `'secret' | 'url' | 'multiline'`, `pattern?`), `number` / `integer` (`minimum?`, `maximum?`), `boolean`, or
 * `array` of strings (`items: { type: 'string'; enum? }`).
 */
export type SettingsProperty
  = | z.infer<typeof stringPropertySchema>
    | z.infer<typeof numberPropertySchema>
    | z.infer<typeof booleanPropertySchema>
    | z.infer<typeof arrayPropertySchema>

/**
 * Zod schema of one present value of `property` (no required / optional handling): enum membership, `url` format,
 * `pattern`, number bounds, integer check, unique array items. Used for `default` checks and by
 * `settingsValuesSchema()` of `@harness-forge/plugin-sdk`.
 */
export function settingsPropertyValueSchema(property: SettingsProperty): z.ZodType {
  switch (property.type) {
    case 'string': {
      if (property.enum)
        return property.enum.length > 0 ? z.enum(property.enum) : z.never()
      let schema = z.string()
      if (property.format === 'url')
        schema = schema.refine(isHttpUrl, 'Enter an absolute http:// or https:// URL.')
      const pattern = property.pattern === undefined ? null : compileRegExp(property.pattern, 'u')
      if (pattern)
        schema = schema.regex(pattern, `Must match the pattern ${property.pattern}.`)
      return schema
    }
    case 'number':
    case 'integer': {
      let schema = property.type === 'integer' ? z.int() : z.number()
      if (property.minimum !== undefined)
        schema = schema.min(property.minimum)
      if (property.maximum !== undefined)
        schema = schema.max(property.maximum)
      return schema
    }
    case 'boolean':
      return z.boolean()
    case 'array': {
      const item = property.items.enum
        ? (property.items.enum.length > 0 ? z.enum(property.items.enum) : z.never())
        : z.string().trim().min(1)
      return z.array(item).refine(isUnique, 'Values must be unique.')
    }
  }
}

/** One property of a settings form (discriminated on `type`). */
export const settingsPropertySchema = z
  .discriminatedUnion('type', [stringPropertySchema, numberPropertySchema, booleanPropertySchema, arrayPropertySchema])
  .superRefine((property, ctx) => {
    if (property.type === 'string') {
      if (property.enum && property.format)
        ctx.addIssue({ code: 'custom', path: ['format'], message: '"enum" and "format" cannot be combined.' })
      if (property.format === 'secret' && property.default !== undefined)
        ctx.addIssue({ code: 'custom', path: ['default'], message: 'Secret properties cannot have a default.' })
      if (property.pattern !== undefined && !compileRegExp(property.pattern, 'u'))
        ctx.addIssue({ code: 'custom', path: ['pattern'], message: 'Invalid regular expression.' })
    }
    if ((property.type === 'number' || property.type === 'integer')
      && property.minimum !== undefined && property.maximum !== undefined && property.minimum > property.maximum) {
      ctx.addIssue({ code: 'custom', path: ['maximum'], message: '"maximum" must be greater than or equal to "minimum".' })
    }
    if (property.default !== undefined && !settingsPropertyValueSchema(property).safeParse(property.default).success)
      ctx.addIssue({ code: 'custom', path: ['default'], message: 'The default value does not match the property.' })
  })

/** A JSON-Schema-like form description rendered as the plugin "Configuration" tab. */
export const settingsSchemaSchema = z
  .strictObject({
    type: z.literal('object'),
    required: z.array(settingsKeySchema).optional(),
    properties: z.record(settingsKeySchema, settingsPropertySchema),
  })
  .superRefine((schema, ctx) => {
    const keys = Object.keys(schema.properties)
    if (keys.length > SETTINGS_PROPERTIES_MAX)
      ctx.addIssue({ code: 'custom', path: ['properties'], message: `At most ${SETTINGS_PROPERTIES_MAX} properties are allowed.` })
    const required = schema.required ?? []
    for (const key of duplicates(required))
      ctx.addIssue({ code: 'custom', path: ['required'], message: `"${key}" is listed twice.` })
    required.forEach((key, index) => {
      if (!Object.hasOwn(schema.properties, key))
        ctx.addIssue({ code: 'custom', path: ['required', index], message: `Required property "${key}" is not defined.` })
    })
  })
export type SettingsSchema = z.infer<typeof settingsSchemaSchema>
