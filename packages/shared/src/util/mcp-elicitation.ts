/**
 * MCP elicitation forms (Phase 14, ADR-060): reads the `requestedSchema` of an MCP `elicitation/create` request into a
 * normalized form, validates a user's answer against it, and helps the web build and coerce form values. The MCP
 * specification restricts elicitation schemas to a flat object of primitive properties; anything outside the subset
 * below is `unsupported` and the server declines the request. Pure and isomorphic; never throws.
 * Contract skeleton written by the coordinator in P14-0a; implemented by C48. Adding members is fine; renaming or
 * removing one is a CCR.
 *
 * Supported subset (`parseElicitationForm`): `{ type: 'object', properties: { … }, required?: string[] }` with at most
 * `ELICITATION_FIELDS_MAX` properties whose names match `ELICITATION_FIELD_NAME_PATTERN`; each property one of
 * - `string` (`minLength`, `maxLength`, `format`: `email` | `uri` | `date` | `date-time`; `default`),
 * - `number` / `integer` (`minimum`, `maximum`; `default`),
 * - `boolean` (`default`),
 * - single-select enum: `{ type: 'string', enum: [...] }` (+ legacy `enumNames` titles) or `{ type: 'string', oneOf:
 *   [{ const, title }] }` (`default`),
 * - multi-select: `{ type: 'array', items: { type: 'string', enum: [...] } | { anyOf: [{ const, title }] } }`
 *   (`minItems`, `maxItems`, `default`),
 * each with optional `title` / `description` (plain text, capped). Unknown annotation keys are ignored; nested
 * objects, `$ref`, other types, more than `ELICITATION_OPTIONS_MAX` options, or a `required` name that is not a
 * property make the whole form unsupported.
 *
 * Details (C48):
 * - Ignored: every key outside the subset that does not change the shape of the form (`$schema`, `examples`, `x-*`,
 *   `additionalProperties`, `uniqueItems`, and validation keywords the subset lacks such as `pattern`, `multipleOf` or
 *   `exclusiveMinimum`; a `pattern` is never compiled), and a `format` other than the four (the field stays a plain
 *   string). Unsupported: a missing or non-`object` root type; `$ref` / `$dynamicRef` / `$recursiveRef`, `allOf`,
 *   `anyOf`, `oneOf`, `not`, `if` / `then` / `else`, `dependentRequired`, `dependentSchemas`, `dependencies` and
 *   `patternProperties` on the root; on a property the same (except `oneOf` of a string) plus `const`, `properties`,
 *   `prefixItems`, `contains`, any union other than the nullable shape below, and `enum` / `oneOf` on a type other
 *   than `string`; an invalid bound (a length or count that is not a non-negative
 *   integer, a minimum or maximum that is not a finite number), bounds that no answer can meet, and a required field
 *   no answer can fill; options that are not non-empty strings, are duplicated or longer than
 *   `ELICITATION_VALUE_MAX_CHARS`; the property name `__proto__`. Malformed `enumNames` are ignored.
 * - Nullable fields (Pydantic / FastMCP `Optional[...]`): `{ anyOf: [X, { type: 'null' }] }` or `oneOf` (either order;
 *   the null branch carries only `type` / `title` / `description`, the wrapper no shape keys of its own) and
 *   `{ type: [T, 'null'] }` (either order; `null` leaves `enum`) read as X / T with `required: false` even when listed
 *   in `required`; the wrapper's `title` / `description` / `default` win over X's, and `default: null` is no default.
 *   X itself must be a supported schema (no nested union). An answer of `null` is empty, like for every field.
 * - Text: titles, descriptions and option labels lose control characters (C0, DEL, C1) and bidirectional formatting
 *   characters, line breaks and tabs become spaces, whitespace runs collapse, the result is trimmed and capped with an
 *   ellipsis; an empty text is null (a label falls back to the value). The request message keeps its line breaks.
 * - Normalized fields keep the schema's bounds; `maxLength` is clamped to `ELICITATION_VALUE_MAX_CHARS` and `maxItems`
 *   to the number of options. A `default` is kept only when it is a valid, non-empty answer of the field (a number
 *   default must be a JSON number).
 * - Answers: an absent value, `null`, a blank string and an empty list count as empty — an empty optional field is
 *   left out, an empty required field is a `required` issue (so a required multi-select needs at least one option).
 *   `false` is a value. Lengths count code points; `ELICITATION_VALUE_MAX_CHARS` counts UTF-16 code units (like the
 *   answer body schema). Values of a field with a `format` are trimmed; other strings are kept as typed. A number may
 *   come as a decimal string (`'12'`, `' -1.5e3 '`).
 * - Formats: `email` = a pragmatic `local@domain.tld` (≤ 254 characters, no whitespace, control characters or
 *   `<>()[]\,;:"`); `uri` = an absolute `http(s)://host…`, `mailto:` or `urn:<nid>:<nss>` URL; `date` = a real
 *   `YYYY-MM-DD` date; `date-time` = RFC 3339 (`T`, seconds, `Z` or `±HH:MM`; a leap second only at 23:59:60 UTC).
 * - The web's `datetime-local` value: `elicitationInitialValues` turns a `date-time` default into local
 *   `YYYY-MM-DDTHH:MM[:SS[.mmm]]`, `coerceElicitationValue` turns such a local value back into RFC 3339 UTC.
 */
import { hasControlChars } from './text.ts'

/** Most fields one form may have. */
export const ELICITATION_FIELDS_MAX = 20

/** Most options of one enum or multi-select field. */
export const ELICITATION_OPTIONS_MAX = 100

/** Longest request message kept (longer messages are cut with an ellipsis). */
export const ELICITATION_MESSAGE_MAX_CHARS = 2000

/** Longest field title / description kept. */
export const ELICITATION_TEXT_MAX_CHARS = 500

/** Longest string value accepted in an answer (also when the schema allows more). */
export const ELICITATION_VALUE_MAX_CHARS = 10_000

/** A property name: 1..64 characters of `[A-Za-z0-9_.-]`, starting with a letter or `_`. */
export const ELICITATION_FIELD_NAME_PATTERN = /^[A-Z_][\w.-]{0,63}$/i

export type ElicitationFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multi-enum'

export type ElicitationStringFormat = 'email' | 'uri' | 'date' | 'date-time'

export interface ElicitationOption {
  readonly value: string
  /** The option's title, or the value when it has none. */
  readonly label: string
}

export type ElicitationValue = string | number | boolean | string[]

export interface ElicitationField {
  readonly name: string
  readonly type: ElicitationFieldType
  readonly title: string | null
  readonly description: string | null
  readonly required: boolean
  readonly default?: ElicitationValue
  /** `string` only. */
  readonly format?: ElicitationStringFormat
  readonly minLength?: number
  readonly maxLength?: number
  /** `number` / `integer` only. */
  readonly minimum?: number
  readonly maximum?: number
  /** `enum` / `multi-enum` only. */
  readonly options?: readonly ElicitationOption[]
  /** `multi-enum` only. */
  readonly minItems?: number
  readonly maxItems?: number
}

export interface ElicitationForm {
  readonly fields: readonly ElicitationField[]
}

export type ElicitationFormResult
  = | { readonly ok: true, readonly form: ElicitationForm }
    | { readonly ok: false, readonly reason: string }

/** An accepted answer: field name → value (only known fields; optional empty fields left out). */
export type ElicitationContent = Record<string, ElicitationValue>

export type ElicitationIssueCode
  = | 'required'
    | 'type'
    | 'format'
    | 'too-short'
    | 'too-long'
    | 'too-small'
    | 'too-large'
    | 'not-integer'
    | 'option'
    | 'too-few'
    | 'too-many'
    | 'unknown-field'

export interface ElicitationFieldIssue {
  readonly field: string
  readonly code: ElicitationIssueCode
  /** A short English sentence for the form ("Enter an email address."). */
  readonly message: string
}

export type ElicitationAnswerResult
  = | { readonly ok: true, readonly content: ElicitationContent }
    | { readonly ok: false, readonly issues: readonly ElicitationFieldIssue[] }

/** Raw input of one form control before coercion (text inputs, a checkbox, a multi-select). */
export type ElicitationRawValue = string | boolean | readonly string[] | null | undefined

// ---------- sensitive fields (used by `isSensitiveField`) ----------

/**
 * Patterns over the normalized words of a name, title or description (lowercase, camelCase split, every run of
 * other characters one space). Substrings where a word cannot occur innocently (`newpassword`), whole words where it
 * can (`pin` but not `spin` / `pinned`, `token` but not `tokens` / `tokenizer`).
 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /pass(?:word|wd|code|phrase)/,
  /secret(?!ar)/,
  /(?:^| )[a-z]*token(?: |$)/,
  /api ?key/,
  /private ?key/,
  /(?:^| )pin(?:code|number)?(?: |$)/,
  /(?:^| )[ht]?otp(?: |$)/,
  /2fa|(?:^| )mfa(?: |$)|two ?factor/,
  /(?:^| )cv[cv]2?(?: |$)/,
  /card ?number|credit ?card/,
  /(?:^| )ssn(?: |$)|social ?security/,
  /(?:^| )iban(?: |$)/,
]

function sensitiveWords(value: unknown): string {
  if (typeof value !== 'string')
    return ''
  return value
    .slice(0, 1000)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// ---------- API ----------

/** Reads an MCP `requestedSchema` into a normalized form, or `unsupported` with a short reason. */
export function parseElicitationForm(schema: unknown): ElicitationFormResult {
  try {
    return { ok: true, form: { fields: readForm(schema) } }
  }
  catch (error) {
    return { ok: false, reason: error instanceof UnsupportedSchema ? error.message : 'The requested schema could not be read.' }
  }
}

/** Caps and cleans an elicitation request message (control characters removed, `ELICITATION_MESSAGE_MAX_CHARS`). */
export function elicitationMessageText(message: unknown): string {
  try {
    if (typeof message !== 'string')
      return ''
    const text = cleanChars(message, true)
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return capText(text, ELICITATION_MESSAGE_MAX_CHARS)
  }
  catch {
    return ''
  }
}

/**
 * Validates an answer's `content` against the form: every required field present, types / formats / bounds / options
 * respected, no unknown field. Returns the cleaned content (numbers as numbers, optional empty values dropped).
 */
export function validateElicitationAnswer(form: ElicitationForm, content: unknown): ElicitationAnswerResult {
  try {
    if (content !== undefined && content !== null && !isObject(content))
      return { ok: false, issues: [{ field: '', code: 'type', message: 'The answer must be an object of field values.' }] }
    const answers: JsonObject = content ?? {}
    const issues: ElicitationFieldIssue[] = []
    const entries: [string, ElicitationValue][] = []
    const known = new Set<string>()
    for (const field of formFields(form)) {
      known.add(field.name)
      const value = own(answers, field.name)
      if (isEmptyValue(value)) {
        if (field.required === true)
          issues.push({ field: field.name, code: 'required', message: requiredMessage(field) })
        continue
      }
      const checked = checkValue(field, value, false)
      if (checked.ok)
        entries.push([field.name, checked.value])
      else
        issues.push({ field: field.name, code: checked.code, message: checked.message })
    }
    let unknown = 0
    for (const key of Object.keys(answers)) {
      if (known.has(key))
        continue
      if (unknown++ >= ELICITATION_FIELDS_MAX)
        break
      issues.push({ field: key.slice(0, 64), code: 'unknown-field', message: 'This field is not part of the form.' })
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, content: Object.fromEntries(entries) }
  }
  catch {
    return { ok: false, issues: [{ field: '', code: 'type', message: 'The answer could not be read.' }] }
  }
}

/**
 * True when a field looks like it asks for a secret (name / title / description mention a password, passcode, token,
 * API key, secret, PIN, card number, CVV, SSN …): the card shows an extra warning and the server never logs it.
 */
export function isSensitiveField(field: ElicitationField): boolean {
  try {
    if (!isObject(field))
      return false
    return [own(field, 'name'), own(field, 'title'), own(field, 'description')].some((text) => {
      const words = sensitiveWords(text)
      return words !== '' && SENSITIVE_PATTERNS.some(pattern => pattern.test(words))
    })
  }
  catch {
    return false
  }
}

/** The initial raw values of a form (defaults applied; empty strings, `false` or `[]` otherwise). */
export function elicitationInitialValues(form: ElicitationForm): Record<string, ElicitationRawValue> {
  try {
    return Object.fromEntries(formFields(form).map(field => [field.name, initialValue(field)]))
  }
  catch {
    return {}
  }
}

/**
 * Coerces one control's raw value into an answer value (`'12'` → 12 for numbers, `''` → undefined for an empty
 * optional field); returns undefined when the value is empty. Validation stays in `validateElicitationAnswer`.
 */
export function coerceElicitationValue(field: ElicitationField, raw: ElicitationRawValue): ElicitationValue | undefined {
  try {
    if (raw === null || raw === undefined || !isObject(field))
      return undefined
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed === '')
        return undefined
      switch (field.type) {
        case 'string':
          if (field.format === 'date-time')
            return isDateTime(trimmed) ? trimmed : localDateTimeToRfc3339(trimmed) ?? trimmed
          return field.format === undefined ? raw : trimmed
        case 'number':
        case 'integer':
          return parseDecimal(trimmed) ?? raw
        case 'boolean':
          return trimmed === 'true' ? true : trimmed === 'false' ? false : raw
        case 'multi-enum':
          return [raw]
        default:
          return raw
      }
    }
    if (typeof raw === 'boolean')
      return raw
    if (Array.isArray(raw))
      return raw.length === 0 ? undefined : [...raw]
    return undefined
  }
  catch {
    return undefined
  }
}

// ---------- internals: reading the schema ----------

type JsonObject = Record<string, unknown>
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Thrown inside the parser for a schema outside the subset; never escapes `parseElicitationForm`. */
class UnsupportedSchema extends Error {}

function unsupported(reason: string): never {
  throw new UnsupportedSchema(reason)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An own property (never one inherited from a prototype). */
function own(object: object, key: string): unknown {
  return Object.hasOwn(object, key) ? (object as JsonObject)[key] : undefined
}

const REF_KEYS = ['$ref', '$dynamicRef', '$recursiveRef'] as const
const LOGIC_KEYS = ['allOf', 'not', 'if', 'then', 'else'] as const

/** Root keys that change the shape of the form. */
const ROOT_UNSUPPORTED = [...REF_KEYS, ...LOGIC_KEYS, 'anyOf', 'oneOf', 'dependentRequired', 'dependentSchemas', 'dependencies', 'patternProperties'] as const

/** Property keys that change the shape of a field (`oneOf` is a titled single-select; checked per type). */
const PROPERTY_UNSUPPORTED = [...REF_KEYS, ...LOGIC_KEYS, 'anyOf', 'const', 'properties', 'patternProperties', 'prefixItems', 'contains'] as const

/** Keys of a multi-select's `items` that change its shape (`anyOf` holds titled options). */
const ITEMS_UNSUPPORTED = [...REF_KEYS, ...LOGIC_KEYS, 'oneOf', 'const', 'properties', 'items', 'prefixItems'] as const

const STRING_FORMATS: readonly string[] = ['email', 'uri', 'date', 'date-time'] satisfies readonly ElicitationStringFormat[]

function rejectKeys(object: JsonObject, keys: readonly string[], subject: string): void {
  for (const key of keys) {
    if (Object.hasOwn(object, key))
      unsupported(`${subject} uses "${key}", which elicitation forms do not support.`)
  }
}

function readForm(schema: unknown): ElicitationField[] {
  if (!isObject(schema))
    unsupported('The requested schema is not an object.')
  if (own(schema, 'type') !== 'object')
    unsupported('The requested schema is not of type "object".')
  rejectKeys(schema, ROOT_UNSUPPORTED, 'The requested schema')
  const rawProperties = own(schema, 'properties')
  const properties = rawProperties === undefined ? {} : rawProperties
  if (!isObject(properties))
    unsupported('The "properties" of the requested schema are not an object.')
  const names = Object.keys(properties)
  if (names.length > ELICITATION_FIELDS_MAX)
    unsupported(`The form has more than ${ELICITATION_FIELDS_MAX} fields.`)
  const required = readRequired(own(schema, 'required'), properties)
  return names.map(name => readField(name, properties[name], required.has(name)))
}

function readRequired(value: unknown, properties: JsonObject): Set<string> {
  const names = new Set<string>()
  if (value === undefined)
    return names
  if (!Array.isArray(value))
    unsupported('The "required" list of the requested schema is not a list.')
  for (const name of value) {
    if (typeof name !== 'string' || !Object.hasOwn(properties, name))
      unsupported('A required field is not a property of the form.')
    names.add(name)
  }
  return names
}

function readField(name: string, property: unknown, listedRequired: boolean): ElicitationField {
  if (name === '__proto__' || !ELICITATION_FIELD_NAME_PATTERN.test(name))
    unsupported('A field name is not supported (1-64 characters of letters, digits, "_", "." and "-", starting with a letter or "_").')
  const subject = `Field "${name}"`
  if (!isObject(property))
    unsupported(`${subject} is not a schema object.`)
  // A nullable property (null allowed) is read as its other schema and is never required.
  const nonNull = nonNullBranch(property, subject)
  const schema = nonNull ?? property
  rejectKeys(schema, PROPERTY_UNSUPPORTED, subject)
  const field: Mutable<ElicitationField> = {
    name,
    type: 'string',
    title: cleanLine(own(schema, 'title')),
    description: cleanLine(own(schema, 'description')),
    required: listedRequired && nonNull === null,
  }
  const type = own(schema, 'type')
  if (type === 'string') {
    readStringField(field, schema, subject)
  }
  else if (type === 'number' || type === 'integer') {
    readNumberField(field, schema, subject, type)
  }
  else if (type === 'boolean') {
    rejectChoices(schema, subject)
    field.type = 'boolean'
  }
  else if (type === 'array') {
    readMultiSelectField(field, schema, subject)
  }
  else {
    unsupported(`${subject} has a type that elicitation forms do not support.`)
  }
  readDefault(field, own(schema, 'default'))
  return field
}

/** The only keys of a `{ type: 'null' }` branch. */
const NULL_BRANCH_KEYS: readonly string[] = ['type', 'title', 'description']

/** Keys a nullable wrapper (`anyOf` / `oneOf`) must not carry: they belong to its non-null schema. */
const NULLABLE_WRAPPER_UNSUPPORTED = [
  ...REF_KEYS,
  ...LOGIC_KEYS,
  'type',
  'enum',
  'enumNames',
  'const',
  'items',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'properties',
  'patternProperties',
  'prefixItems',
  'contains',
] as const

function isNullBranch(value: unknown): boolean {
  return isObject(value) && own(value, 'type') === 'null' && Object.keys(value).every(key => NULL_BRANCH_KEYS.includes(key))
}

/**
 * The non-null schema of a nullable property (Pydantic / FastMCP `Optional[...]`): `{ anyOf | oneOf: [X, { type:
 * 'null' }] }` in either order (the wrapper's `title` / `description` / `default` win over X's) or `{ type: [T, 'null']
 * }` (in either order; `null` leaves `enum` and the matching `enumNames`). Null for every other property.
 */
function nonNullBranch(property: JsonObject, subject: string): JsonObject | null {
  const type = own(property, 'type')
  if (Array.isArray(type)) {
    const other: unknown = type.length === 2 && type.includes('null') ? type.find(entry => entry !== 'null') : undefined
    if (typeof other !== 'string')
      return null
    const branch: JsonObject = { ...property, type: other }
    const values = own(property, 'enum')
    if (Array.isArray(values) && values.includes(null)) {
      const names = own(property, 'enumNames')
      branch.enum = values.filter(value => value !== null)
      if (Array.isArray(names) && names.length === values.length)
        branch.enumNames = names.filter((_, index) => values[index] !== null)
    }
    return branch
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const union = own(property, key)
    if (!Array.isArray(union) || union.length !== 2 || !union.some(isNullBranch))
      continue
    const inner: unknown = isNullBranch(union[0]) ? union[1] : union[0]
    if (!isObject(inner))
      unsupported(`${subject} allows null, but its other schema is not a schema object.`)
    rejectKeys(property, [...NULLABLE_WRAPPER_UNSUPPORTED, key === 'anyOf' ? 'oneOf' : 'anyOf'], subject)
    const branch: JsonObject = { ...inner }
    for (const annotation of ['title', 'description'] as const) {
      if (typeof own(property, annotation) === 'string')
        branch[annotation] = own(property, annotation)
    }
    if (Object.hasOwn(property, 'default'))
      branch.default = own(property, 'default')
    return branch
  }
  return null
}

function rejectChoices(schema: JsonObject, subject: string): void {
  for (const key of ['enum', 'oneOf']) {
    if (Object.hasOwn(schema, key))
      unsupported(`${subject} uses "${key}" with a type other than "string".`)
  }
}

function readStringField(field: Mutable<ElicitationField>, schema: JsonObject, subject: string): void {
  const values = own(schema, 'enum')
  const titled = own(schema, 'oneOf')
  if (values !== undefined && titled !== undefined)
    unsupported(`${subject} has both "enum" and "oneOf".`)
  if (values !== undefined || titled !== undefined) {
    field.type = 'enum'
    field.options = values !== undefined ? enumOptions(values, own(schema, 'enumNames'), subject) : titledOptions(titled, subject)
    return
  }
  field.type = 'string'
  const format = own(schema, 'format')
  if (typeof format === 'string' && STRING_FORMATS.includes(format))
    field.format = format as ElicitationStringFormat
  const minLength = readCount(schema, 'minLength', subject)
  const maxLength = readCount(schema, 'maxLength', subject)
  if (minLength !== undefined && minLength > ELICITATION_VALUE_MAX_CHARS)
    unsupported(`${subject} asks for more than ${ELICITATION_VALUE_MAX_CHARS} characters.`)
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength)
    unsupported(`${subject} has a "minLength" above its "maxLength".`)
  if (field.required && maxLength === 0)
    unsupported(`${subject} is required but allows no characters.`)
  if (minLength !== undefined)
    field.minLength = minLength
  if (maxLength !== undefined)
    field.maxLength = Math.min(maxLength, ELICITATION_VALUE_MAX_CHARS)
}

function readNumberField(field: Mutable<ElicitationField>, schema: JsonObject, subject: string, type: 'number' | 'integer'): void {
  rejectChoices(schema, subject)
  field.type = type
  const minimum = readBound(schema, 'minimum', subject)
  const maximum = readBound(schema, 'maximum', subject)
  if (minimum !== undefined && maximum !== undefined) {
    if (minimum > maximum)
      unsupported(`${subject} has a "minimum" above its "maximum".`)
    if (type === 'integer' && Math.ceil(minimum) > Math.floor(maximum))
      unsupported(`${subject} allows no whole number between its "minimum" and "maximum".`)
  }
  if (minimum !== undefined)
    field.minimum = minimum
  if (maximum !== undefined)
    field.maximum = maximum
}

function readMultiSelectField(field: Mutable<ElicitationField>, schema: JsonObject, subject: string): void {
  rejectChoices(schema, subject)
  const items = own(schema, 'items')
  if (!isObject(items))
    unsupported(`${subject} is a list without option items.`)
  rejectKeys(items, ITEMS_UNSUPPORTED, `The items of f${subject.slice(1)}`)
  const itemType = own(items, 'type')
  if (itemType !== undefined && itemType !== 'string')
    unsupported(`${subject} is a list of a type other than "string".`)
  const values = own(items, 'enum')
  const titled = own(items, 'anyOf')
  if (values !== undefined && titled !== undefined)
    unsupported(`${subject} has both "enum" and "anyOf" items.`)
  if (values === undefined && titled === undefined)
    unsupported(`${subject} is a list without options.`)
  const options = values !== undefined ? enumOptions(values, own(items, 'enumNames'), subject) : titledOptions(titled, subject)
  field.type = 'multi-enum'
  field.options = options
  const minItems = readCount(schema, 'minItems', subject)
  const maxItems = readCount(schema, 'maxItems', subject)
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems)
    unsupported(`${subject} has a "minItems" above its "maxItems".`)
  if (minItems !== undefined && minItems > options.length)
    unsupported(`${subject} asks for more options than it offers.`)
  if (field.required && maxItems === 0)
    unsupported(`${subject} is required but allows no options.`)
  if (minItems !== undefined)
    field.minItems = minItems
  if (maxItems !== undefined)
    field.maxItems = Math.min(maxItems, options.length)
}

/** A length or count: absent, or a non-negative safe integer. */
function readCount(schema: JsonObject, key: string, subject: string): number | undefined {
  const value = own(schema, key)
  if (value === undefined)
    return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    unsupported(`${subject} has an invalid "${key}".`)
  return value
}

/** A numeric bound: absent, or a finite number. */
function readBound(schema: JsonObject, key: string, subject: string): number | undefined {
  const value = own(schema, key)
  if (value === undefined)
    return undefined
  if (typeof value !== 'number' || !Number.isFinite(value))
    unsupported(`${subject} has an invalid "${key}".`)
  return value === 0 ? 0 : value
}

function enumOptions(values: unknown, names: unknown, subject: string): ElicitationOption[] {
  if (!Array.isArray(values))
    unsupported(`${subject} has an "enum" that is not a list.`)
  const titles: readonly unknown[] | null = Array.isArray(names) && names.length === values.length ? names : null
  return checkOptions(values.map((value: unknown, index) => [value, titles?.[index]] as const), subject)
}

function titledOptions(entries: unknown, subject: string): ElicitationOption[] {
  if (!Array.isArray(entries))
    unsupported(`${subject} has titled options that are not a list.`)
  return checkOptions(entries.map((entry: unknown) => {
    if (!isObject(entry) || !Object.hasOwn(entry, 'const'))
      unsupported(`${subject} has a titled option without "const".`)
    return [own(entry, 'const'), own(entry, 'title')] as const
  }), subject)
}

function checkOptions(pairs: readonly (readonly [unknown, unknown])[], subject: string): ElicitationOption[] {
  if (pairs.length === 0)
    unsupported(`${subject} has no options.`)
  if (pairs.length > ELICITATION_OPTIONS_MAX)
    unsupported(`${subject} has more than ${ELICITATION_OPTIONS_MAX} options.`)
  const seen = new Set<string>()
  return pairs.map(([value, title], index) => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > ELICITATION_VALUE_MAX_CHARS)
      unsupported(`${subject} has an option that is not a non-empty string of at most ${ELICITATION_VALUE_MAX_CHARS} characters.`)
    if (seen.has(value))
      unsupported(`${subject} has duplicate options.`)
    seen.add(value)
    return { value, label: cleanLine(title) ?? cleanLine(value) ?? `Option ${index + 1}` }
  })
}

function readDefault(field: Mutable<ElicitationField>, value: unknown): void {
  if (isEmptyValue(value))
    return
  const checked = checkValue(field, value, true)
  if (checked.ok)
    field.default = checked.value
}

// ---------- internals: values ----------

type Check
  = | { readonly ok: true, readonly value: ElicitationValue }
    | { readonly ok: false, readonly code: ElicitationIssueCode, readonly message: string }

function isEmptyValue(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0)
}

function fail(code: ElicitationIssueCode, message: string): Check {
  return { ok: false, code, message }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

const FORMAT_MESSAGES: Readonly<Record<ElicitationStringFormat, string>> = {
  'email': 'Enter an email address.',
  'uri': 'Enter a link (http, https, mailto or urn).',
  'date': 'Enter a date (YYYY-MM-DD).',
  'date-time': 'Enter a date and time.',
}

function requiredMessage(field: ElicitationField): string {
  if (field.type === 'enum')
    return 'Choose an option.'
  if (field.type === 'multi-enum')
    return 'Choose at least one option.'
  return 'This field is required.'
}

/** Checks one non-empty value; `strict` (defaults) takes numbers only as JSON numbers. */
function checkValue(field: ElicitationField, value: unknown, strict: boolean): Check {
  switch (field.type) {
    case 'string':
      return checkString(field, value)
    case 'number':
    case 'integer':
      return checkNumber(field, value, strict)
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : fail('type', 'Choose yes or no.')
    case 'enum':
      if (typeof value !== 'string')
        return fail('type', 'Choose one of the options.')
      return optionValues(field).has(value) ? { ok: true, value } : fail('option', 'Choose one of the options.')
    case 'multi-enum':
      return checkMultiSelect(field, value)
    default:
      return fail('type', 'This field cannot be answered.')
  }
}

function checkString(field: ElicitationField, value: unknown): Check {
  if (typeof value !== 'string')
    return fail('type', 'Enter text.')
  const text = field.format === undefined ? value : value.trim()
  if (text.length > ELICITATION_VALUE_MAX_CHARS)
    return fail('too-long', `Enter at most ${plural(ELICITATION_VALUE_MAX_CHARS, 'character')}.`)
  const length = codePointLength(text)
  if (typeof field.maxLength === 'number' && length > field.maxLength)
    return fail('too-long', `Enter at most ${plural(field.maxLength, 'character')}.`)
  if (typeof field.minLength === 'number' && length < field.minLength)
    return fail('too-short', `Enter at least ${plural(field.minLength, 'character')}.`)
  if (field.format !== undefined && !matchesFormat(field.format, text))
    return fail('format', FORMAT_MESSAGES[field.format] ?? 'Enter a valid value.')
  return { ok: true, value: text }
}

function checkNumber(field: ElicitationField, value: unknown, strict: boolean): Check {
  const integer = field.type === 'integer'
  const number = typeof value === 'number' ? value : !strict && typeof value === 'string' ? parseDecimal(value.trim()) : undefined
  if (number === undefined || !Number.isFinite(number))
    return fail('type', integer ? 'Enter a whole number.' : 'Enter a number.')
  if (integer && !Number.isInteger(number))
    return fail('not-integer', 'Enter a whole number.')
  if (typeof field.minimum === 'number' && number < field.minimum)
    return fail('too-small', `Enter ${field.minimum} or more.`)
  if (typeof field.maximum === 'number' && number > field.maximum)
    return fail('too-large', `Enter ${field.maximum} or less.`)
  return { ok: true, value: number === 0 ? 0 : number }
}

function checkMultiSelect(field: ElicitationField, value: unknown): Check {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string'))
    return fail('type', 'Choose from the options.')
  const allowed = optionValues(field)
  const chosen = new Set<string>()
  for (const item of value as string[]) {
    if (!allowed.has(item))
      return fail('option', 'Choose only the listed options.')
    if (chosen.has(item))
      return fail('option', 'Choose each option only once.')
    chosen.add(item)
  }
  if (typeof field.minItems === 'number' && chosen.size < field.minItems)
    return fail('too-few', `Choose at least ${plural(field.minItems, 'option')}.`)
  if (typeof field.maxItems === 'number' && chosen.size > field.maxItems)
    return fail('too-many', `Choose at most ${plural(field.maxItems, 'option')}.`)
  return { ok: true, value: [...chosen] }
}

function optionValues(field: ElicitationField): Set<string> {
  const values = new Set<string>()
  if (Array.isArray(field.options)) {
    for (const option of field.options as readonly unknown[]) {
      const value = isObject(option) ? own(option, 'value') : undefined
      if (typeof value === 'string')
        values.add(value)
    }
  }
  return values
}

/** Code points of `text` (lengths in JSON Schema count code points, not UTF-16 code units). */
function codePointLength(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0xDC00 || code > 0xDFFF || index === 0 || !isHighSurrogate(text.charCodeAt(index - 1)))
      count++
  }
  return count
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF
}

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/** A decimal number written as text (`'12'`, `'-1.5e3'`), or undefined. */
function parseDecimal(text: string): number | undefined {
  if (text.length > 400 || !DECIMAL_PATTERN.test(text))
    return undefined
  const number = Number(text)
  return Number.isFinite(number) ? number : undefined
}

// ---------- internals: formats ----------

function matchesFormat(format: ElicitationStringFormat, text: string): boolean {
  switch (format) {
    case 'email':
      return isEmail(text)
    case 'uri':
      return isUri(text)
    case 'date':
      return isDate(text)
    case 'date-time':
      return isDateTime(text)
    default:
      return false
  }
}

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[^\s@<>()[\]\\,;:"._]{1,63}\.)+[^\s@<>()[\]\\,;:"._]{2,63}$/u

function isEmail(text: string): boolean {
  return text.length <= 254 && !hasControlChars(text) && EMAIL_PATTERN.test(text)
}

const URN_PATTERN = /^urn:[a-z0-9][a-z0-9-]{0,31}:\S+$/i

function isUri(text: string): boolean {
  if (/\s/.test(text) || hasControlChars(text))
    return false
  if (/^https?:\/\/[^/?#\\]/i.test(text))
    return URL.canParse(text) && new URL(text).hostname !== ''
  if (/^mailto:./i.test(text))
    return URL.canParse(text)
  return URN_PATTERN.test(text)
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/i
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/i

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1)
    return false
  const days = month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  return day <= days
}

function isDate(text: string): boolean {
  const match = text.match(DATE_PATTERN)
  return match !== null && isRealDate(Number(match[1]), Number(match[2]), Number(match[3]))
}

function isDateTime(text: string): boolean {
  const match = text.match(DATE_TIME_PATTERN)
  if (match === null || !isRealDate(Number(match[1]), Number(match[2]), Number(match[3])))
    return false
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = Number(match[8] ?? 0)
  const offsetMinute = Number(match[9] ?? 0)
  if (hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59)
    return false
  if (second < 60)
    return true
  // A leap second exists only at 23:59:60 UTC.
  const offset = (match[7] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute)
  return ((hour * 60 + minute - offset) % 1440 + 1440) % 1440 === 1439
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** A local `YYYY-MM-DDTHH:MM[:SS[.fff]]` (a `datetime-local` input) → RFC 3339 in UTC, or null. */
function localDateTimeToRfc3339(text: string): string | null {
  const match = text.match(LOCAL_DATE_TIME_PATTERN)
  if (match === null)
    return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] ?? 0)
  const millisecond = Number((match[7] ?? '').slice(0, 3).padEnd(3, '0'))
  if (!isRealDate(year, month, day) || hour > 23 || minute > 59 || second > 59)
    return null
  const date = new Date(2000, 0, 1, hour, minute, second, millisecond)
  date.setFullYear(year, month - 1, day)
  if (Number.isNaN(date.getTime()))
    return null
  const iso = date.toISOString()
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso
}

/** An RFC 3339 date-time → the local `YYYY-MM-DDTHH:MM[:SS[.mmm]]` of a `datetime-local` input (else unchanged). */
function rfc3339ToLocalDateTime(text: string): string {
  if (!isDateTime(text))
    return text
  const time = Date.parse(text.toUpperCase().replace(/(\.\d{3})\d+/, '$1'))
  if (Number.isNaN(time))
    return text
  const date = new Date(time)
  const year = date.getFullYear()
  if (year < 0 || year > 9999)
    return text
  const seconds = date.getSeconds()
  const milliseconds = date.getMilliseconds()
  let local = `${pad(year, 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (seconds !== 0 || milliseconds !== 0)
    local += `:${pad(seconds)}`
  if (milliseconds !== 0)
    local += `.${pad(milliseconds, 3)}`
  return local
}

// ---------- internals: form values ----------

function formFields(form: ElicitationForm): ElicitationField[] {
  const fields = isObject(form) ? own(form, 'fields') : undefined
  if (!Array.isArray(fields))
    return []
  return fields.filter((field: unknown): field is ElicitationField => isObject(field) && typeof own(field, 'name') === 'string')
}

function initialValue(field: ElicitationField): ElicitationRawValue {
  const value = field.default
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : false
    case 'multi-enum':
      return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
    case 'number':
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
    case 'string':
      if (typeof value !== 'string')
        return ''
      return field.format === 'date-time' ? rfc3339ToLocalDateTime(value) : value
    default:
      return typeof value === 'string' ? value : ''
  }
}

// ---------- internals: text ----------

/** Longest input the text cleaners look at (bounded work on hostile input; far above every cap). */
const CLEAN_INPUT_MAX = 65_536

/** Line breaks (`\n`, `\r`, NEL, LINE / PARAGRAPH SEPARATOR). */
function isLineBreak(code: number): boolean {
  return code === 0x0A || code === 0x0D || code === 0x85 || code === 0x2028 || code === 0x2029
}

/** C0 / C1 control characters, DEL and the bidirectional formatting characters (they could reorder what a user reads). */
function isInvisibleControl(code: number): boolean {
  return code < 0x20
    || (code >= 0x7F && code <= 0x9F)
    || code === 0x200E
    || code === 0x200F
    || (code >= 0x202A && code <= 0x202E)
    || (code >= 0x2066 && code <= 0x2069)
}

/** Removes invisible controls; line breaks become `\n` (or a space), tabs and form feeds a space. */
function cleanChars(value: string, keepBreaks: boolean): string {
  let end = Math.min(value.length, CLEAN_INPUT_MAX)
  if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1)))
    end--
  const parts: string[] = []
  let start = 0
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index)
    if (!isLineBreak(code) && !isInvisibleControl(code))
      continue
    parts.push(value.slice(start, index))
    start = index + 1
    if (code === 0x0D && value.charCodeAt(index + 1) === 0x0A)
      continue
    if (isLineBreak(code))
      parts.push(keepBreaks ? '\n' : ' ')
    else if (code === 0x09 || code === 0x0B || code === 0x0C)
      parts.push(' ')
  }
  parts.push(value.slice(start, end))
  return parts.join('')
}

/** Cuts `text` to `max` UTF-16 code units with an ellipsis (never inside a surrogate pair). */
function capText(text: string, max: number): string {
  if (text.length <= max)
    return text
  let end = max - 1
  if (isHighSurrogate(text.charCodeAt(end - 1)))
    end--
  return `${text.slice(0, end).trimEnd()}…`
}

/** A title, description or option label: one line, at most `ELICITATION_TEXT_MAX_CHARS`; null when empty. */
function cleanLine(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const text = cleanChars(value, false).replace(/\s+/g, ' ').trim()
  return text === '' ? null : capText(text, ELICITATION_TEXT_MAX_CHARS)
}
