import type { ElicitationField, ElicitationForm, ElicitationIssueCode, ElicitationRawValue, ElicitationValue } from './mcp-elicitation.ts'
import { describe, expect, it } from 'vitest'
import { mcpElicitationFormSchema, mcpElicitationValueSchema } from '../schemas/mcp.ts'
import {
  coerceElicitationValue,
  ELICITATION_FIELD_NAME_PATTERN,
  ELICITATION_FIELDS_MAX,
  ELICITATION_MESSAGE_MAX_CHARS,
  ELICITATION_OPTIONS_MAX,
  ELICITATION_TEXT_MAX_CHARS,
  ELICITATION_VALUE_MAX_CHARS,
  elicitationInitialValues,
  elicitationMessageText,
  isSensitiveField,
  parseElicitationForm,
  validateElicitationAnswer,
} from './mcp-elicitation.ts'

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Parses a schema that must be supported. */
function form(schema: unknown): ElicitationForm {
  const result = parseElicitationForm(schema)
  if (!result.ok)
    throw new Error(`unsupported: ${result.reason}`)
  return result.form
}

/** The one field of a single-property form. */
function field(property: unknown, required = false): ElicitationField {
  const fields = form({ type: 'object', properties: { f: property }, required: required ? ['f'] : [] }).fields
  expect(fields).toHaveLength(1)
  return fields[0]!
}

function reason(schema: unknown): string {
  const result = parseElicitationForm(schema)
  expect(result.ok).toBe(false)
  return result.ok ? '' : result.reason
}

const ISSUE_CODES: readonly ElicitationIssueCode[] = ['required', 'type', 'format', 'too-short', 'too-long', 'too-small', 'too-large', 'not-integer', 'option', 'too-few', 'too-many', 'unknown-field']

/** True when `text` has a C0 / C1 control character, DEL or a bidirectional formatting character (`\n` allowed with `allowBreaks`). */
function hasInvisible(text: string, allowBreaks = false): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (allowBreaks && code === 0x0A)
      continue
    if (code < 0x20 || (code >= 0x7F && code <= 0x9F) || code === 0x200E || code === 0x200F || (code >= 0x202A && code <= 0x202E) || (code >= 0x2066 && code <= 0x2069))
      return true
  }
  return false
}

describe('parseElicitationForm: MCP specification examples', () => {
  it('reads the simple text request (spec example, 2025-06-18 and 2025-11-25)', () => {
    expect(parseElicitationForm({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })).toEqual({ ok: true, form: { fields: [{ name: 'name', type: 'string', title: null, description: null, required: true }] } })
  })

  it('reads the structured data request and accepts its response (spec example, 2025-06-18)', () => {
    const contact = form({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Your full name' },
        email: { type: 'string', format: 'email', description: 'Your email address' },
        age: { type: 'number', minimum: 18, description: 'Your age' },
      },
      required: ['name', 'email'],
    })
    expect(contact.fields).toEqual([
      { name: 'name', type: 'string', title: null, description: 'Your full name', required: true },
      { name: 'email', type: 'string', title: null, description: 'Your email address', required: true, format: 'email' },
      { name: 'age', type: 'number', title: null, description: 'Your age', required: false, minimum: 18 },
    ])
    expect(validateElicitationAnswer(contact, { name: 'Monalisa Octocat', email: 'octocat@github.com', age: 30 }))
      .toEqual({ ok: true, content: { name: 'Monalisa Octocat', email: 'octocat@github.com', age: 30 } })
    expect(validateElicitationAnswer(contact, { name: 'Monalisa Octocat', email: 'octocat@github.com', age: 17 }))
      .toEqual({ ok: false, issues: [{ field: 'age', code: 'too-small', message: 'Enter 18 or more.' }] })
  })

  it('reads the supported schema types (spec example, 2025-06-18)', () => {
    expect(field({ type: 'string', title: 'Display Name', description: 'Description text', minLength: 3, maxLength: 50, format: 'email' })).toEqual({
      name: 'f',
      type: 'string',
      title: 'Display Name',
      description: 'Description text',
      required: false,
      format: 'email',
      minLength: 3,
      maxLength: 50,
    })
    expect(field({ type: 'number', title: 'Display Name', description: 'Description text', minimum: 0, maximum: 100 })).toEqual({
      name: 'f',
      type: 'number',
      title: 'Display Name',
      description: 'Description text',
      required: false,
      minimum: 0,
      maximum: 100,
    })
    expect(field({ type: 'integer', minimum: 1, maximum: 10 })).toMatchObject({ type: 'integer', minimum: 1, maximum: 10 })
    expect(field({ type: 'boolean', title: 'Display Name', description: 'Description text', default: false })).toEqual({
      name: 'f',
      type: 'boolean',
      title: 'Display Name',
      description: 'Description text',
      required: false,
      default: false,
    })
    expect(field({ type: 'string', title: 'Display Name', description: 'Description text', enum: ['option1', 'option2', 'option3'], enumNames: ['Option 1', 'Option 2', 'Option 3'] })).toEqual({
      name: 'f',
      type: 'enum',
      title: 'Display Name',
      description: 'Description text',
      required: false,
      options: [{ value: 'option1', label: 'Option 1' }, { value: 'option2', label: 'Option 2' }, { value: 'option3', label: 'Option 3' }],
    })
  })

  it('reads defaults and the enum variants (spec example, 2025-11-25)', () => {
    expect(field({ type: 'string', title: 'Display Name', description: 'Description text', minLength: 3, maxLength: 50, format: 'email', default: 'user@example.com' }))
      .toMatchObject({ type: 'string', format: 'email', default: 'user@example.com' })
    expect(field({ type: 'number', title: 'Display Name', description: 'Description text', minimum: 0, maximum: 100, default: 50 }))
      .toMatchObject({ type: 'number', default: 50 })
    // Single-select without titles.
    expect(field({ type: 'string', title: 'Color Selection', description: 'Choose your favorite color', enum: ['Red', 'Green', 'Blue'], default: 'Red' })).toEqual({
      name: 'f',
      type: 'enum',
      title: 'Color Selection',
      description: 'Choose your favorite color',
      required: false,
      options: [{ value: 'Red', label: 'Red' }, { value: 'Green', label: 'Green' }, { value: 'Blue', label: 'Blue' }],
      default: 'Red',
    })
    // Single-select with titles.
    expect(field({
      type: 'string',
      title: 'Color Selection',
      description: 'Choose your favorite color',
      oneOf: [{ const: '#FF0000', title: 'Red' }, { const: '#00FF00', title: 'Green' }, { const: '#0000FF', title: 'Blue' }],
      default: '#FF0000',
    })).toMatchObject({
      type: 'enum',
      options: [{ value: '#FF0000', label: 'Red' }, { value: '#00FF00', label: 'Green' }, { value: '#0000FF', label: 'Blue' }],
      default: '#FF0000',
    })
    // Multi-select without titles.
    expect(field({
      type: 'array',
      title: 'Color Selection',
      description: 'Choose your favorite colors',
      minItems: 1,
      maxItems: 2,
      items: { type: 'string', enum: ['Red', 'Green', 'Blue'] },
      default: ['Red', 'Green'],
    })).toEqual({
      name: 'f',
      type: 'multi-enum',
      title: 'Color Selection',
      description: 'Choose your favorite colors',
      required: false,
      options: [{ value: 'Red', label: 'Red' }, { value: 'Green', label: 'Green' }, { value: 'Blue', label: 'Blue' }],
      minItems: 1,
      maxItems: 2,
      default: ['Red', 'Green'],
    })
    // Multi-select with titles.
    expect(field({
      type: 'array',
      title: 'Color Selection',
      description: 'Choose your favorite colors',
      minItems: 1,
      maxItems: 2,
      items: { anyOf: [{ const: '#FF0000', title: 'Red' }, { const: '#00FF00', title: 'Green' }, { const: '#0000FF', title: 'Blue' }] },
      default: ['#FF0000', '#00FF00'],
    })).toMatchObject({
      type: 'multi-enum',
      options: [{ value: '#FF0000', label: 'Red' }, { value: '#00FF00', label: 'Green' }, { value: '#0000FF', label: 'Blue' }],
      default: ['#FF0000', '#00FF00'],
    })
  })

  it('ignores `$schema` and other root annotations (spec example, 2025-11-25)', () => {
    const result = form({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      title: 'Contact',
      description: 'Contact details',
      additionalProperties: false,
      properties: { name: { type: 'string' } },
    })
    expect(result.fields.map(entry => entry.name)).toEqual(['name'])
  })

  it('reads an empty form (a plain confirmation) and a form without `properties`', () => {
    expect(form({ type: 'object', properties: {} })).toEqual({ fields: [] })
    expect(form({ type: 'object' })).toEqual({ fields: [] })
    expect(validateElicitationAnswer({ fields: [] }, {})).toEqual({ ok: true, content: {} })
    expect(validateElicitationAnswer({ fields: [] }, undefined)).toEqual({ ok: true, content: {} })
  })
})

describe('parseElicitationForm: unsupported schemas', () => {
  const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}`, { type: 'string' }]))
  const options = (count: number) => Array.from({ length: count }, (_, index) => `o${index}`)
  const prop = (property: unknown) => ({ type: 'object', properties: { f: property } })

  it.each<[string, unknown, string]>([
    ['null', null, 'not an object'],
    ['a string', 'object', 'not an object'],
    ['an array', [], 'not an object'],
    ['a number', 1, 'not an object'],
    ['no root type', { properties: {} }, 'not of type "object"'],
    ['a string root', { type: 'string' }, 'not of type "object"'],
    ['a union root type', { type: ['object', 'null'], properties: {} }, 'not of type "object"'],
    ['root $ref', { type: 'object', $ref: '#/$defs/x', properties: {} }, '"$ref"'],
    ['root allOf', { type: 'object', allOf: [], properties: {} }, '"allOf"'],
    ['root oneOf', { type: 'object', oneOf: [], properties: {} }, '"oneOf"'],
    ['root if', { type: 'object', if: {}, properties: {} }, '"if"'],
    ['root dependentRequired', { type: 'object', dependentRequired: {}, properties: {} }, '"dependentRequired"'],
    ['root patternProperties', { type: 'object', patternProperties: {} }, '"patternProperties"'],
    ['properties null', { type: 'object', properties: null }, 'not an object'],
    ['properties an array', { type: 'object', properties: [] }, 'not an object'],
    ['too many fields', { type: 'object', properties: many(ELICITATION_FIELDS_MAX + 1) }, `more than ${ELICITATION_FIELDS_MAX} fields`],
    ['required not a list', { type: 'object', properties: { a: { type: 'string' } }, required: 'a' }, 'not a list'],
    ['required unknown name', { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }, 'not a property'],
    ['required non-string', { type: 'object', properties: { a: { type: 'string' } }, required: [1] }, 'not a property'],
    ['required inherited name', { type: 'object', properties: { a: { type: 'string' } }, required: ['toString'] }, 'not a property'],
    ['a name with a digit first', { type: 'object', properties: { '1a': { type: 'string' } } }, 'field name'],
    ['a name with a space', { type: 'object', properties: { 'a b': { type: 'string' } } }, 'field name'],
    ['a name of 65 characters', { type: 'object', properties: { ['a'.repeat(65)]: { type: 'string' } } }, 'field name'],
    ['the name __proto__', JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'), 'field name'],
    ['an empty name', { type: 'object', properties: { '': { type: 'string' } } }, 'field name'],
    ['a boolean schema', prop(true), 'not a schema object'],
    ['a nested object', prop({ type: 'object', properties: {} }), '"properties"'],
    ['an object type', prop({ type: 'object' }), 'type that elicitation forms do not support'],
    ['a null type', prop({ type: 'null' }), 'type that elicitation forms do not support'],
    ['no type', prop({ title: 'x' }), 'type that elicitation forms do not support'],
    ['an enum without type', prop({ enum: ['a', 'b'] }), 'type that elicitation forms do not support'],
    ['a union of two types', prop({ type: ['string', 'integer'] }), 'type that elicitation forms do not support'],
    ['a union of three types', prop({ type: ['string', 'null', 'integer'] }), 'type that elicitation forms do not support'],
    ['a one-type list', prop({ type: ['string'] }), 'type that elicitation forms do not support'],
    ['a null-only list', prop({ type: ['null', 'null'] }), 'type that elicitation forms do not support'],
    ['a union of two schemas', prop({ anyOf: [{ type: 'string' }, { type: 'integer' }] }), '"anyOf"'],
    ['a union of three schemas', prop({ anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] }), '"anyOf"'],
    ['a nullable union of an enum class', prop({ anyOf: [{ $ref: '#/$defs/Color' }, { type: 'null' }], default: null }), '"$ref"'],
    ['a nullable nested object', prop({ anyOf: [{ type: 'object', properties: {} }, { type: 'null' }] }), '"properties"'],
    ['a nested nullable union', prop({ anyOf: [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, { type: 'null' }] }), '"anyOf"'],
    ['a nullable union of a type list', prop({ anyOf: [{ type: ['string', 'null'] }, { type: 'null' }] }), 'type that elicitation forms do not support'],
    ['a nullable union with a non-object branch', prop({ anyOf: ['string', { type: 'null' }] }), 'not a schema object'],
    ['a nullable union with an outer type', prop({ type: 'string', anyOf: [{ type: 'string' }, { type: 'null' }] }), '"type"'],
    ['a nullable union with outer bounds', prop({ anyOf: [{ type: 'string' }, { type: 'null' }], maxLength: 3 }), '"maxLength"'],
    ['a nullable union with both anyOf and oneOf', prop({ anyOf: [{ type: 'string' }, { type: 'null' }], oneOf: [{ type: 'string' }, { type: 'null' }] }), '"oneOf"'],
    ['a null branch with constraints', prop({ anyOf: [{ type: 'string' }, { type: 'null', enum: [null] }] }), '"anyOf"'],
    ['a property $ref', prop({ $ref: '#/$defs/Color' }), '"$ref"'],
    ['a property allOf', prop({ type: 'string', allOf: [{ minLength: 1 }] }), '"allOf"'],
    ['a property not', prop({ type: 'string', not: { const: 'x' } }), '"not"'],
    ['a property const', prop({ type: 'string', const: 'x' }), '"const"'],
    ['an enum on a number', prop({ type: 'number', enum: [1, 2] }), '"enum" with a type other than "string"'],
    ['oneOf on a boolean', prop({ type: 'boolean', oneOf: [{ const: true }] }), '"oneOf" with a type other than "string"'],
    ['an enum on an array', prop({ type: 'array', enum: [['a']], items: { type: 'string', enum: ['a'] } }), '"enum" with a type other than "string"'],
    ['enum and oneOf', prop({ type: 'string', enum: ['a'], oneOf: [{ const: 'a', title: 'A' }] }), 'both "enum" and "oneOf"'],
    ['an empty enum', prop({ type: 'string', enum: [] }), 'no options'],
    ['an enum that is not a list', prop({ type: 'string', enum: 'a' }), 'not a list'],
    ['a null enum', prop({ type: 'string', enum: null }), 'not a list'],
    ['a number option', prop({ type: 'string', enum: ['a', 1] }), 'not a non-empty string'],
    ['an empty option', prop({ type: 'string', enum: ['a', ''] }), 'not a non-empty string'],
    ['a blank option', prop({ type: 'string', enum: ['a', '  '] }), 'not a non-empty string'],
    ['a huge option', prop({ type: 'string', enum: ['x'.repeat(ELICITATION_VALUE_MAX_CHARS + 1)] }), 'not a non-empty string'],
    ['duplicate options', prop({ type: 'string', enum: ['a', 'a'] }), 'duplicate options'],
    ['too many options', prop({ type: 'string', enum: options(ELICITATION_OPTIONS_MAX + 1) }), `more than ${ELICITATION_OPTIONS_MAX} options`],
    ['a titled option without const', prop({ type: 'string', oneOf: [{ title: 'A' }] }), 'without "const"'],
    ['a titled option that is a string', prop({ type: 'string', oneOf: ['a'] }), 'without "const"'],
    ['a titled number const', prop({ type: 'string', oneOf: [{ const: 1, title: 'One' }] }), 'not a non-empty string'],
    ['titled options not a list', prop({ type: 'string', oneOf: {} }), 'not a list'],
    ['a negative minLength', prop({ type: 'string', minLength: -1 }), 'invalid "minLength"'],
    ['a fractional maxLength', prop({ type: 'string', maxLength: 1.5 }), 'invalid "maxLength"'],
    ['a string minLength', prop({ type: 'string', minLength: '3' }), 'invalid "minLength"'],
    ['minLength above maxLength', prop({ type: 'string', minLength: 5, maxLength: 4 }), '"minLength" above'],
    ['minLength above the value cap', prop({ type: 'string', minLength: ELICITATION_VALUE_MAX_CHARS + 1 }), 'more than'],
    ['a non-finite minimum', prop({ type: 'number', minimum: Number.POSITIVE_INFINITY }), 'invalid "minimum"'],
    ['a string maximum', prop({ type: 'number', maximum: '5' }), 'invalid "maximum"'],
    ['minimum above maximum', prop({ type: 'number', minimum: 2, maximum: 1 }), '"minimum" above'],
    ['no whole number in range', prop({ type: 'integer', minimum: 0.2, maximum: 0.8 }), 'no whole number'],
    ['a list without items', prop({ type: 'array' }), 'without option items'],
    ['a list of numbers', prop({ type: 'array', items: { type: 'number', enum: [1] } }), 'other than "string"'],
    ['a free list of strings', prop({ type: 'array', items: { type: 'string' } }), 'without options'],
    ['items with enum and anyOf', prop({ type: 'array', items: { enum: ['a'], anyOf: [{ const: 'a', title: 'A' }] } }), 'both "enum" and "anyOf"'],
    ['items with $ref', prop({ type: 'array', items: { $ref: '#/$defs/x' } }), '"$ref"'],
    ['items with oneOf', prop({ type: 'array', items: { oneOf: [{ const: 'a', title: 'A' }] } }), '"oneOf"'],
    ['nested lists', prop({ type: 'array', items: { type: 'array', items: { type: 'string', enum: ['a'] } } }), '"items"'],
    ['prefixItems', prop({ type: 'array', prefixItems: [], items: { type: 'string', enum: ['a'] } }), '"prefixItems"'],
    ['minItems above maxItems', prop({ type: 'array', minItems: 2, maxItems: 1, items: { type: 'string', enum: ['a', 'b'] } }), '"minItems" above'],
    ['minItems above the options', prop({ type: 'array', minItems: 3, items: { type: 'string', enum: ['a', 'b'] } }), 'more options than it offers'],
    ['a negative maxItems', prop({ type: 'array', maxItems: -1, items: { type: 'string', enum: ['a'] } }), 'invalid "maxItems"'],
  ])('refuses %s', (_label, schema, fragment) => {
    const text = reason(schema)
    expect(text).toContain(fragment)
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text.endsWith('.') || text.endsWith(')')).toBe(true)
  })

  it('refuses required fields no answer can fill', () => {
    expect(reason({ type: 'object', properties: { f: { type: 'string', maxLength: 0 } }, required: ['f'] })).toContain('allows no characters')
    expect(reason({ type: 'object', properties: { f: { type: 'array', maxItems: 0, items: { type: 'string', enum: ['a'] } } }, required: ['f'] })).toContain('allows no options')
    expect(field({ type: 'string', maxLength: 0 })).toMatchObject({ maxLength: 0, required: false })
  })

  it('never echoes an unsupported field name or a schema value', () => {
    const hostile = 'x'.repeat(80)
    expect(reason({ type: 'object', properties: { [hostile]: { type: 'string' } } })).not.toContain(hostile)
    expect(reason({ type: 'object', properties: { f: { type: 'secret-value-123' } } })).not.toContain('secret-value-123')
  })

  it('never throws on getters that throw', () => {
    const trap = { type: 'object', get properties(): unknown {
      throw new Error('boom')
    } }
    expect(parseElicitationForm(trap)).toEqual({ ok: false, reason: 'The requested schema could not be read.' })
    const proxy = new Proxy({}, { ownKeys: () => {
      throw new Error('boom')
    } })
    expect(parseElicitationForm({ type: 'object', properties: proxy }).ok).toBe(false)
  })
})

describe('parseElicitationForm: nullable fields (Pydantic / FastMCP `Optional[...]`)', () => {
  // The schema FastMCP sends for `class Profile(BaseModel)` with `nickname: Optional[str] = None`,
  // `age: Optional[int] = None`, `color: Optional[Literal['red', 'green']] = None`, `email: str` and
  // `team: Optional[str]` (required by pydantic, but null allowed).
  const FASTMCP = {
    properties: {
      nickname: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null, title: 'Nickname' },
      age: { anyOf: [{ minimum: 0, type: 'integer' }, { type: 'null' }], default: null, title: 'Age' },
      color: { anyOf: [{ enum: ['red', 'green'], type: 'string' }, { type: 'null' }], default: null, title: 'Color' },
      email: { format: 'email', title: 'Email', type: 'string' },
      team: { anyOf: [{ type: 'string' }, { type: 'null' }], title: 'Team' },
    },
    required: ['email', 'team'],
    title: 'Profile',
    type: 'object',
  }

  it('reads Optional fields as optional fields of their type', () => {
    expect(form(FASTMCP).fields).toEqual([
      { name: 'nickname', type: 'string', title: 'Nickname', description: null, required: false },
      { name: 'age', type: 'integer', title: 'Age', description: null, required: false, minimum: 0 },
      { name: 'color', type: 'enum', title: 'Color', description: null, required: false, options: [{ value: 'red', label: 'red' }, { value: 'green', label: 'green' }] },
      { name: 'email', type: 'string', title: 'Email', description: null, required: true, format: 'email' },
      { name: 'team', type: 'string', title: 'Team', description: null, required: false },
    ])
  })

  it('takes null answers as empty and validates the rest', () => {
    const parsed = form(FASTMCP)
    expect(validateElicitationAnswer(parsed, { nickname: null, age: null, color: null, email: 'ada@example.com', team: null }))
      .toEqual({ ok: true, content: { email: 'ada@example.com' } })
    expect(validateElicitationAnswer(parsed, { nickname: 'Ada', age: '36', color: 'green', email: 'ada@example.com', team: 'core' }))
      .toEqual({ ok: true, content: { nickname: 'Ada', age: 36, color: 'green', email: 'ada@example.com', team: 'core' } })
    expect(validateElicitationAnswer(parsed, { age: -1, color: 'blue', email: 'ada@example.com' })).toMatchObject({
      ok: false,
      issues: [{ field: 'age', code: 'too-small' }, { field: 'color', code: 'option' }],
    })
  })

  it('accepts either order, oneOf, and type lists', () => {
    expect(field({ anyOf: [{ type: 'null' }, { type: 'boolean' }] }, true)).toMatchObject({ type: 'boolean', required: false })
    expect(field({ oneOf: [{ type: 'number', maximum: 5 }, { type: 'null', title: 'Nothing' }] }, true)).toMatchObject({ type: 'number', maximum: 5, required: false })
    expect(field({ type: ['string', 'null'], minLength: 2, title: 'Nick' }, true)).toEqual({ name: 'f', type: 'string', title: 'Nick', description: null, required: false, minLength: 2 })
    expect(field({ type: ['null', 'integer'], default: 3 })).toMatchObject({ type: 'integer', required: false, default: 3 })
    expect(field({ type: ['string', 'null'], enum: ['a', null, 'b'], enumNames: ['A', 'None', 'B'] }).options).toEqual([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }])
    expect(field({ type: ['string', 'null'], oneOf: [{ const: 'a', title: 'A' }] })).toMatchObject({ type: 'enum', options: [{ value: 'a', label: 'A' }] })
    expect(field({ anyOf: [{ type: 'array', items: { type: 'string', enum: ['x', 'y'] }, maxItems: 1 }, { type: 'null' }] }, true))
      .toMatchObject({ type: 'multi-enum', required: false, maxItems: 1 })
    expect(field({ anyOf: [{ type: 'string', oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] }, { type: 'null' }] }))
      .toMatchObject({ type: 'enum', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })
  })

  it('lets the wrapper\'s title, description and default win (default null is no default)', () => {
    expect(field({ anyOf: [{ type: 'string', title: 'Inner', description: 'Inner text', default: 'inner' }, { type: 'null' }] }))
      .toMatchObject({ title: 'Inner', description: 'Inner text', default: 'inner' })
    expect(field({ anyOf: [{ type: 'string', title: 'Inner', description: 'Inner text', default: 'inner' }, { type: 'null' }], title: 'Outer', description: 'Outer text', default: 'outer' }))
      .toMatchObject({ title: 'Outer', description: 'Outer text', default: 'outer' })
    expect(field({ anyOf: [{ type: 'string', default: 'inner' }, { type: 'null' }], default: null })).not.toHaveProperty('default')
    expect(field({ type: ['string', 'null'], default: null })).not.toHaveProperty('default')
    expect(field({ anyOf: [{ type: 'string', title: 'Inner' }, { type: 'null' }], title: 5 })).toMatchObject({ title: 'Inner' })
    expect(field({ anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }], default: 0 })).not.toHaveProperty('default')
  })

  it('never reads a titled single-select as a nullable union', () => {
    expect(field({ type: 'string', oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] }, true)).toMatchObject({ type: 'enum', required: true })
  })
})

describe('parseElicitationForm: annotations, text and bounds', () => {
  it('ignores unknown annotation keys and validation keywords outside the subset', () => {
    expect(field({ 'type': 'string', 'examples': ['x'], 'readOnly': false, 'deprecated': true, 'x-ui': { widget: 'textarea' }, 'pattern': '^(a+)+$', '$comment': 'note' }))
      .toEqual({ name: 'f', type: 'string', title: null, description: null, required: false })
    expect(field({ type: 'number', multipleOf: 5, exclusiveMinimum: 0 })).toEqual({ name: 'f', type: 'number', title: null, description: null, required: false })
    expect(field({ type: 'array', uniqueItems: true, items: { type: 'string', enum: ['a'], description: 'x' } })).toMatchObject({ type: 'multi-enum' })
    expect(field({ type: 'string', items: { type: 'number' } })).toMatchObject({ type: 'string' })
  })

  it('keeps only the four formats (others read as plain text)', () => {
    for (const format of ['email', 'uri', 'date', 'date-time'])
      expect(field({ type: 'string', format })).toMatchObject({ format })
    for (const format of ['uuid', 'password', 'time', 'hostname', 'EMAIL', 5, null])
      expect(field({ type: 'string', format })).not.toHaveProperty('format')
  })

  it('accepts legacy enumNames only when they line up, and falls back to the value', () => {
    expect(field({ type: 'string', enum: ['a', 'b'], enumNames: ['A'] }).options).toEqual([{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }])
    expect(field({ type: 'string', enum: ['a', 'b'], enumNames: 'A,B' }).options).toEqual([{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }])
    expect(field({ type: 'string', enum: ['a', 'b'], enumNames: ['A', 7] }).options).toEqual([{ value: 'a', label: 'A' }, { value: 'b', label: 'b' }])
    expect(field({ type: 'array', items: { type: 'string', enum: ['a'], enumNames: ['Alpha'] } }).options).toEqual([{ value: 'a', label: 'Alpha' }])
    expect(field({ type: 'string', oneOf: [{ const: 'a' }, { const: 'b', title: '  ' }, { const: '\u0000\u0001x', title: 3 }] }).options)
      .toEqual([{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }, { value: '\u0000\u0001x', label: 'x' }])
    expect(field({ type: 'string', enum: ['\u0007 '] }).options).toEqual([{ value: '\u0007 ', label: 'Option 1' }])
  })

  it('cleans titles, descriptions and labels (plain text, one line, capped)', () => {
    const cleaned = field({
      type: 'string',
      title: '  Your\tname\r\n(please)\u0000\u202E  ',
      description: `Line one\nLine two\u2028three ${'d'.repeat(ELICITATION_TEXT_MAX_CHARS)}`,
    })
    expect(cleaned.title).toBe('Your name (please)')
    expect(cleaned.description).toHaveLength(ELICITATION_TEXT_MAX_CHARS)
    expect(cleaned.description!.startsWith('Line one Line two three d')).toBe(true)
    expect(cleaned.description!.endsWith('…')).toBe(true)
    expect(field({ type: 'string', title: '\u0000\u0001 \n', description: 42 })).toMatchObject({ title: null, description: null })
    expect(field({ type: 'string', title: `${'a'.repeat(ELICITATION_TEXT_MAX_CHARS - 2)}😀😀` }).title).toBe(`${'a'.repeat(ELICITATION_TEXT_MAX_CHARS - 2)}…`)
    const label = field({ type: 'string', oneOf: [{ const: 'a', title: `A\u0085B${'x'.repeat(600)}` }] }).options![0]!.label
    expect(label.startsWith('A B')).toBe(true)
    expect(label).toHaveLength(ELICITATION_TEXT_MAX_CHARS)
  })

  it('clamps maxLength to the value cap and maxItems to the options', () => {
    expect(field({ type: 'string', maxLength: 1_000_000 })).toMatchObject({ maxLength: ELICITATION_VALUE_MAX_CHARS })
    expect(field({ type: 'array', minItems: 0, maxItems: 9, items: { type: 'string', enum: ['a', 'b'] } })).toMatchObject({ minItems: 0, maxItems: 2 })
    expect(field({ type: 'number', minimum: -0 }).minimum).toBe(0)
    expect(Object.is(field({ type: 'number', minimum: -0 }).minimum, -0)).toBe(false)
  })

  it('keeps the property order and the required flags', () => {
    const result = form({
      type: 'object',
      properties: { 'zeta': { type: 'string' }, 'alpha': { type: 'boolean' }, '_x': { type: 'integer' }, 'a.b-c': { type: 'number' } },
      required: ['alpha', 'alpha', '_x'],
    })
    expect(result.fields.map(entry => [entry.name, entry.required])).toEqual([['zeta', false], ['alpha', true], ['_x', true], ['a.b-c', false]])
  })

  it('accepts property names like Object.prototype members as plain fields', () => {
    const result = form({ type: 'object', properties: { constructor: { type: 'string' }, toString: { type: 'boolean' } }, required: ['constructor'] })
    expect(result.fields.map(entry => entry.name)).toEqual(['constructor', 'toString'])
    expect(validateElicitationAnswer(result, {})).toEqual({ ok: false, issues: [{ field: 'constructor', code: 'required', message: 'This field is required.' }] })
    expect(validateElicitationAnswer(result, { constructor: 'x', toString: true })).toEqual({ ok: true, content: { constructor: 'x', toString: true } })
    expect(elicitationInitialValues(result)).toEqual({ constructor: '', toString: false })
  })
})

describe('parseElicitationForm: defaults', () => {
  it.each<[string, Record<string, unknown>, unknown, ElicitationValue | undefined]>([
    ['a string', { type: 'string' }, 'hello', 'hello'],
    ['a blank string', { type: 'string' }, '  ', undefined],
    ['a string above maxLength', { type: 'string', maxLength: 3 }, 'hello', undefined],
    ['a string below minLength', { type: 'string', minLength: 9 }, 'hello', undefined],
    ['a number for a string', { type: 'string' }, 5, undefined],
    ['a valid email', { type: 'string', format: 'email' }, ' user@example.com ', 'user@example.com'],
    ['an invalid email', { type: 'string', format: 'email' }, 'user', undefined],
    ['a real date', { type: 'string', format: 'date' }, '2024-02-29', '2024-02-29'],
    ['an unreal date', { type: 'string', format: 'date' }, '2023-02-29', undefined],
    ['a number', { type: 'number', minimum: 0, maximum: 100 }, 50, 50],
    ['a number out of range', { type: 'number', maximum: 10 }, 50, undefined],
    ['a numeric string', { type: 'number' }, '5', undefined],
    ['a fractional integer', { type: 'integer' }, 1.5, undefined],
    ['an integer', { type: 'integer' }, 2, 2],
    ['a boolean', { type: 'boolean' }, true, true],
    ['a boolean string', { type: 'boolean' }, 'true', undefined],
    ['null', { type: 'boolean' }, null, undefined],
    ['an option', { type: 'string', enum: ['a', 'b'] }, 'b', 'b'],
    ['a missing option', { type: 'string', enum: ['a', 'b'] }, 'c', undefined],
    ['options', { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] } }, ['c', 'a'], ['c', 'a']],
    ['an unknown option', { type: 'array', items: { type: 'string', enum: ['a'] } }, ['a', 'z'], undefined],
    ['duplicate options', { type: 'array', items: { type: 'string', enum: ['a', 'b'] } }, ['a', 'a'], undefined],
    ['too many options', { type: 'array', maxItems: 1, items: { type: 'string', enum: ['a', 'b'] } }, ['a', 'b'], undefined],
    ['an empty list', { type: 'array', items: { type: 'string', enum: ['a'] } }, [], undefined],
    ['a string for a list', { type: 'array', items: { type: 'string', enum: ['a'] } }, 'a', undefined],
  ])('%s', (_label, property, value, expected) => {
    const result = field({ ...property, default: value })
    if (expected === undefined)
      expect(result).not.toHaveProperty('default')
    else
      expect(result.default).toEqual(expected)
  })
})

describe('elicitationMessageText', () => {
  it('cleans and caps the request message', () => {
    expect(elicitationMessageText('Please provide your GitHub username')).toBe('Please provide your GitHub username')
    expect(elicitationMessageText('  Hello\r\nworld\u0000\u202E!  \n\n\n\nBye\t now  ')).toBe('Hello\nworld!\n\nBye  now')
    expect(elicitationMessageText('a\rb\u2028c\u0085d')).toBe('a\nb\nc\nd')
    for (const value of [undefined, null, 5, {}, ['x']])
      expect(elicitationMessageText(value)).toBe('')
    const long = elicitationMessageText('m'.repeat(ELICITATION_MESSAGE_MAX_CHARS + 50))
    expect(long).toHaveLength(ELICITATION_MESSAGE_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
    expect(elicitationMessageText('m'.repeat(ELICITATION_MESSAGE_MAX_CHARS))).toBe('m'.repeat(ELICITATION_MESSAGE_MAX_CHARS))
    const emoji = elicitationMessageText(`${'m'.repeat(ELICITATION_MESSAGE_MAX_CHARS - 2)}😀😀`)
    expect(emoji).toBe(`${'m'.repeat(ELICITATION_MESSAGE_MAX_CHARS - 2)}…`)
  })

  it('looks at a bounded prefix of a huge message', () => {
    const text = elicitationMessageText(`${'\u0000'.repeat(100_000)}visible`)
    expect(text).toBe('')
    expect(elicitationMessageText(`${'x'.repeat(1_000_000)}`)).toHaveLength(ELICITATION_MESSAGE_MAX_CHARS)
  })
})

describe('validateElicitationAnswer', () => {
  const FORM = form({
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 5 },
      email: { type: 'string', format: 'email' },
      site: { type: 'string', format: 'uri' },
      birthday: { type: 'string', format: 'date' },
      meeting: { type: 'string', format: 'date-time' },
      age: { type: 'integer', minimum: 18, maximum: 130 },
      ratio: { type: 'number', minimum: 0, maximum: 1 },
      subscribe: { type: 'boolean' },
      color: { type: 'string', enum: ['red', 'green'] },
      tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['a', 'b', 'c'] } },
      note: { type: 'string', minLength: 1 },
    },
    required: ['name'],
  })

  function check(name: string, value: unknown): { value: unknown } | { code: ElicitationIssueCode } {
    const result = validateElicitationAnswer(FORM, { name: 'Ada', [name]: value })
    if (result.ok)
      return { value: result.content[name] }
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]!.field).toBe(name)
    return { code: result.issues[0]!.code }
  }

  it.each<[string, unknown, { value: unknown } | { code: ElicitationIssueCode }]>([
    ['name', 'Ada', { value: 'Ada' }],
    ['name', ' Ada ', { value: ' Ada ' }],
    ['name', 'A', { code: 'too-short' }],
    ['name', 'Adaline', { code: 'too-long' }],
    ['name', '😀😀😀😀😀', { value: '😀😀😀😀😀' }],
    ['name', 5, { code: 'type' }],
    ['name', ['Ada'], { code: 'type' }],
    ['email', 'ada@example.com', { value: 'ada@example.com' }],
    ['email', ' ada@example.com ', { value: 'ada@example.com' }],
    ['email', 'Ada.Lovelace+tag@sub.example.co.uk', { value: 'Ada.Lovelace+tag@sub.example.co.uk' }],
    ['email', 'ada@münchen.de', { value: 'ada@münchen.de' }],
    ['email', 'ada', { code: 'format' }],
    ['email', 'ada@example', { code: 'format' }],
    ['email', 'ada@example.c', { code: 'format' }],
    ['email', 'a b@example.com', { code: 'format' }],
    ['email', 'ada@@example.com', { code: 'format' }],
    ['email', 'ada@exa_mple.com', { code: 'format' }],
    ['email', 'ada@example..com', { code: 'format' }],
    ['email', '<ada@example.com>', { code: 'format' }],
    ['email', `${'a'.repeat(65)}@example.com`, { code: 'format' }],
    ['email', `a@${'b'.repeat(250)}.com`, { code: 'format' }],
    ['site', 'https://example.com/a?b=1#c', { value: 'https://example.com/a?b=1#c' }],
    ['site', 'http://localhost:3000', { value: 'http://localhost:3000' }],
    ['site', 'HTTPS://EXAMPLE.COM', { value: 'HTTPS://EXAMPLE.COM' }],
    ['site', 'mailto:ada@example.com', { value: 'mailto:ada@example.com' }],
    ['site', 'urn:isbn:0451450523', { value: 'urn:isbn:0451450523' }],
    ['site', 'ftp://example.com', { code: 'format' }],
    ['site', 'example.com', { code: 'format' }],
    ['site', '//example.com', { code: 'format' }],
    ['site', 'https://', { code: 'format' }],
    ['site', 'http:example.com', { code: 'format' }],
    ['site', 'javascript:alert(1)', { code: 'format' }],
    ['site', 'https://exa mple.com', { code: 'format' }],
    ['site', 'mailto:', { code: 'format' }],
    ['site', 'urn:isbn', { code: 'format' }],
    ['birthday', '2024-02-29', { value: '2024-02-29' }],
    ['birthday', '2000-02-29', { value: '2000-02-29' }],
    ['birthday', '1900-02-29', { code: 'format' }],
    ['birthday', '2023-02-29', { code: 'format' }],
    ['birthday', '2026-04-31', { code: 'format' }],
    ['birthday', '2026-13-01', { code: 'format' }],
    ['birthday', '2026-00-10', { code: 'format' }],
    ['birthday', '2026-1-1', { code: 'format' }],
    ['birthday', '2026-10-22T00:00:00Z', { code: 'format' }],
    ['meeting', '2026-10-22T12:30:00Z', { value: '2026-10-22T12:30:00Z' }],
    ['meeting', '2026-10-22T12:30:00.123456+02:00', { value: '2026-10-22T12:30:00.123456+02:00' }],
    ['meeting', '2026-10-22t12:30:00z', { value: '2026-10-22t12:30:00z' }],
    ['meeting', '1998-12-31T23:59:60Z', { value: '1998-12-31T23:59:60Z' }],
    ['meeting', '1998-12-31T15:59:60-08:00', { value: '1998-12-31T15:59:60-08:00' }],
    ['meeting', '2026-10-22T12:30:60Z', { code: 'format' }],
    ['meeting', '2026-10-22T12:30Z', { code: 'format' }],
    ['meeting', '2026-10-22T12:30:00', { code: 'format' }],
    ['meeting', '2026-10-22 12:30:00Z', { code: 'format' }],
    ['meeting', '2026-10-22T24:00:00Z', { code: 'format' }],
    ['meeting', '2026-02-30T00:00:00Z', { code: 'format' }],
    ['meeting', '2026-10-22T12:30:00+24:00', { code: 'format' }],
    ['age', 30, { value: 30 }],
    ['age', '30', { value: 30 }],
    ['age', ' 42 ', { value: 42 }],
    ['age', '1e2', { value: 100 }],
    ['age', 17, { code: 'too-small' }],
    ['age', 131, { code: 'too-large' }],
    ['age', 30.5, { code: 'not-integer' }],
    ['age', '30.5', { code: 'not-integer' }],
    ['age', 'thirty', { code: 'type' }],
    ['age', '0x1F', { code: 'type' }],
    ['age', 'Infinity', { code: 'type' }],
    ['age', Number.NaN, { code: 'type' }],
    ['age', Number.POSITIVE_INFINITY, { code: 'type' }],
    ['age', true, { code: 'type' }],
    ['ratio', 0.5, { value: 0.5 }],
    ['ratio', '.5', { value: 0.5 }],
    ['ratio', '1e-3', { value: 0.001 }],
    ['ratio', '-0', { value: 0 }],
    ['ratio', 1.5, { code: 'too-large' }],
    ['ratio', -0.1, { code: 'too-small' }],
    ['subscribe', true, { value: true }],
    ['subscribe', false, { value: false }],
    ['subscribe', 'true', { code: 'type' }],
    ['subscribe', 1, { code: 'type' }],
    ['color', 'red', { value: 'red' }],
    ['color', 'Red', { code: 'option' }],
    ['color', 'blue', { code: 'option' }],
    ['color', 1, { code: 'type' }],
    ['tags', ['a'], { value: ['a'] }],
    ['tags', ['b', 'a'], { value: ['b', 'a'] }],
    ['tags', ['a', 'b', 'c'], { code: 'too-many' }],
    ['tags', ['a', 'a'], { code: 'option' }],
    ['tags', ['d'], { code: 'option' }],
    ['tags', 'a', { code: 'type' }],
    ['tags', [1], { code: 'type' }],
    ['note', `${'x'.repeat(ELICITATION_VALUE_MAX_CHARS)}`, { value: 'x'.repeat(ELICITATION_VALUE_MAX_CHARS) }],
    ['note', `${'x'.repeat(ELICITATION_VALUE_MAX_CHARS + 1)}`, { code: 'too-long' }],
  ])('%s = %j', (name, value, expected) => {
    expect(check(name, value)).toEqual(expected)
  })

  it('reports required fields and drops empty optional ones', () => {
    for (const empty of [undefined, null, '', '   '])
      expect(validateElicitationAnswer(FORM, { name: empty })).toEqual({ ok: false, issues: [{ field: 'name', code: 'required', message: 'This field is required.' }] })
    expect(validateElicitationAnswer(FORM, { name: 'Ada', email: '', age: ' ', tags: [], color: null, note: '' }))
      .toEqual({ ok: true, content: { name: 'Ada' } })
    const choices = form({
      type: 'object',
      properties: { pick: { type: 'string', enum: ['a'] }, picks: { type: 'array', items: { type: 'string', enum: ['a'] } }, flag: { type: 'boolean' } },
      required: ['pick', 'picks', 'flag'],
    })
    expect(validateElicitationAnswer(choices, { picks: [] })).toEqual({
      ok: false,
      issues: [
        { field: 'pick', code: 'required', message: 'Choose an option.' },
        { field: 'picks', code: 'required', message: 'Choose at least one option.' },
        { field: 'flag', code: 'required', message: 'This field is required.' },
      ],
    })
    expect(validateElicitationAnswer(choices, { pick: 'a', picks: ['a'], flag: false })).toEqual({ ok: true, content: { pick: 'a', picks: ['a'], flag: false } })
  })

  it('collects every issue in form order, then unknown fields (capped)', () => {
    const extra = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`extra${index}`, index]))
    const result = validateElicitationAnswer(FORM, { email: 'x', ...extra, age: 1 })
    expect(result.ok).toBe(false)
    if (result.ok)
      return
    expect(result.issues.slice(0, 3).map(issue => [issue.field, issue.code])).toEqual([['name', 'required'], ['email', 'format'], ['age', 'too-small']])
    expect(result.issues.slice(3)).toHaveLength(ELICITATION_FIELDS_MAX)
    expect(result.issues[3]).toEqual({ field: 'extra0', code: 'unknown-field', message: 'This field is not part of the form.' })
    expect(validateElicitationAnswer(FORM, { name: 'Ada', ['k'.repeat(100)]: 1 })).toMatchObject({ ok: false, issues: [{ field: 'k'.repeat(64), code: 'unknown-field' }] })
  })

  it('writes short English sentences with the bounds', () => {
    const bounded = form({
      type: 'object',
      properties: {
        one: { type: 'string', minLength: 1, maxLength: 1 },
        list: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', enum: ['a', 'b'] } },
        two: { type: 'array', minItems: 2, items: { type: 'string', enum: ['a', 'b'] } },
        num: { type: 'number', minimum: 1.5, maximum: 2.5 },
      },
    })
    const messages = (content: Record<string, unknown>) => {
      const result = validateElicitationAnswer(bounded, content)
      return result.ok ? [] : result.issues.map(issue => issue.message)
    }
    expect(messages({ one: 'ab', list: ['a', 'b'], two: ['a'], num: 3 })).toEqual([
      'Enter at most 1 character.',
      'Choose at most 1 option.',
      'Choose at least 2 options.',
      'Enter 2.5 or less.',
    ])
    expect(messages({ num: 1 })).toEqual(['Enter 1.5 or more.'])
    for (const [name, value] of [['email', 'x'], ['site', 'x'], ['birthday', 'x'], ['meeting', 'x'], ['age', 'x'], ['tags', ['z']]] as const) {
      const result = validateElicitationAnswer(FORM, { name: 'Ada', [name]: value })
      expect(result.ok).toBe(false)
      if (!result.ok)
        expect(result.issues[0]!.message).toMatch(/^[A-Z][^\n]{4,80}\.$/)
    }
  })

  it('refuses content that is not an object and never reads inherited or prototype keys', () => {
    for (const content of ['x', 5, true, [], [{ name: 'Ada' }]])
      expect(validateElicitationAnswer(FORM, content)).toEqual({ ok: false, issues: [{ field: '', code: 'type', message: 'The answer must be an object of field values.' }] })
    expect(validateElicitationAnswer(FORM, Object.create({ name: 'Ada' }))).toMatchObject({ ok: false, issues: [{ field: 'name', code: 'required' }] })
    const polluted = JSON.parse('{"name":"Ada","__proto__":{"polluted":true}}')
    expect(validateElicitationAnswer(FORM, polluted)).toMatchObject({ ok: false, issues: [{ field: '__proto__', code: 'unknown-field' }] })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('never throws on a malformed form', () => {
    for (const bad of [null, undefined, 5, 'x', {}, { fields: 'x' }, { fields: [null, 5, { name: 1 }, { name: 'a', type: 'weird' }] }]) {
      const result = validateElicitationAnswer(bad as unknown as ElicitationForm, { a: 'x', b: 1 })
      expect(result.ok).toBe(false)
    }
    expect(validateElicitationAnswer({ fields: [{ name: 'a', type: 'weird' } as unknown as ElicitationField] }, { a: 'x' }))
      .toEqual({ ok: false, issues: [{ field: 'a', code: 'type', message: 'This field cannot be answered.' }] })
    expect(validateElicitationAnswer({ fields: [{ name: 'a', type: 'enum', title: null, description: null, required: false }] }, { a: 'x' }))
      .toMatchObject({ ok: false, issues: [{ field: 'a', code: 'option' }] })
  })
})

describe('isSensitiveField', () => {
  const named = (name: string): ElicitationField => ({ name, type: 'string', title: null, description: null, required: false })
  const titled = (title: string): ElicitationField => ({ name: 'value', type: 'string', title, description: null, required: false })
  const described = (description: string): ElicitationField => ({ name: 'value', type: 'string', title: null, description, required: false })

  it.each([
    'password',
    'newPassword',
    'user_password',
    'PASSWORD',
    'passwd',
    'passcode',
    'passphrase',
    'secret',
    'clientSecret',
    'client_secret',
    'token',
    'accessToken',
    'access_token',
    'apiKey',
    'api_key',
    'apikey',
    'API-KEY',
    'X-Api-Key',
    'openaiApiKey',
    'privateKey',
    'private_key',
    'pin',
    'PIN',
    'userPIN',
    'pin_code',
    'pinCode',
    'otp',
    'otpCode',
    'totp',
    '2fa',
    '2FA_code',
    'twoFactorCode',
    'mfa',
    'cvv',
    'CVC',
    'cvv2',
    'cardNumber',
    'card_number',
    'creditCard',
    'ssn',
    'userSSN',
    'socialSecurityNumber',
    'iban',
    'IBAN',
  ])('flags the name %s', (name) => {
    expect(isSensitiveField(named(name))).toBe(true)
  })

  it.each([
    'Your PIN',
    'API key',
    'Api Key',
    'Credit card number',
    'Social security number',
    'One-time code (OTP)',
    'Bank IBAN',
    'Secret question answer',
    'Personal access token',
  ])('flags the title %j', (title) => {
    expect(isSensitiveField(titled(title))).toBe(true)
    expect(isSensitiveField(described(`Please enter: ${title}.`))).toBe(true)
  })

  it.each([
    'name',
    'email',
    'spin',
    'spinner',
    'pinned',
    'pinnedRepos',
    'Pinterest handle',
    'happiness',
    'pinyin',
    'tokens',
    'maxTokens',
    'Max tokens',
    'tokenizer',
    'secretary',
    'Secretary name',
    'keyboard',
    'passport number',
    'bypass mode',
    'api',
    'card',
    'option',
    'adopt',
    'potpie',
    'Company size',
    'description',
    'Choose your favorite color',
  ])('does not flag %j', (text) => {
    expect(isSensitiveField(named(text.replace(/\W+/g, '_')))).toBe(false)
    expect(isSensitiveField(titled(text))).toBe(false)
    expect(isSensitiveField(described(text))).toBe(false)
  })

  it('never throws on malformed fields', () => {
    for (const bad of [null, undefined, 5, 'password', [], { name: 5, title: {}, description: [] }])
      expect(isSensitiveField(bad as unknown as ElicitationField)).toBe(false)
    expect(isSensitiveField({ name: 'x', title: 'A'.repeat(100_000), description: null } as unknown as ElicitationField)).toBe(false)
  })
})

describe('elicitationInitialValues and coerceElicitationValue', () => {
  const KINDS = form({
    type: 'object',
    properties: {
      text: { type: 'string' },
      mail: { type: 'string', format: 'email' },
      when: { type: 'string', format: 'date-time' },
      day: { type: 'string', format: 'date' },
      count: { type: 'integer' },
      amount: { type: 'number' },
      flag: { type: 'boolean' },
      pick: { type: 'string', enum: ['a', 'b'] },
      picks: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
    },
  })
  const byName = (name: string) => KINDS.fields.find(entry => entry.name === name)!

  it('starts from empty values without defaults', () => {
    expect(elicitationInitialValues(KINDS)).toEqual({ text: '', mail: '', when: '', day: '', count: '', amount: '', flag: false, pick: '', picks: [] })
    expect(elicitationInitialValues(null as unknown as ElicitationForm)).toEqual({})
    expect(elicitationInitialValues({ fields: [5, { name: 'x', type: 'weird' }] } as unknown as ElicitationForm)).toEqual({ x: '' })
  })

  it('applies defaults as raw control values', () => {
    const defaults = form({
      type: 'object',
      properties: {
        text: { type: 'string', default: 'hi' },
        count: { type: 'integer', default: 3 },
        big: { type: 'number', default: 1e21 },
        flag: { type: 'boolean', default: true },
        pick: { type: 'string', enum: ['a', 'b'], default: 'b' },
        picks: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, default: ['b'] },
      },
    })
    const values = elicitationInitialValues(defaults)
    expect(values).toEqual({ text: 'hi', count: '3', big: '1e+21', flag: true, pick: 'b', picks: ['b'] })
    expect(values.picks).not.toBe(defaults.fields[5]!.default)
  })

  it.each<[string, ElicitationRawValue, ElicitationValue | undefined]>([
    ['text', '  kept as typed ', '  kept as typed '],
    ['text', '', undefined],
    ['text', '   ', undefined],
    ['text', null, undefined],
    ['text', undefined, undefined],
    ['text', true, true],
    ['text', ['x'], ['x']],
    ['mail', ' a@b.co ', 'a@b.co'],
    ['day', ' 2026-10-22 ', '2026-10-22'],
    ['when', '2026-10-22T12:30:00Z', '2026-10-22T12:30:00Z'],
    ['when', 'not a date', 'not a date'],
    ['when', '2026-02-30T10:00', '2026-02-30T10:00'],
    ['count', '12', 12],
    ['count', ' 1.5 ', 1.5],
    ['count', 'abc', 'abc'],
    ['count', '', undefined],
    ['amount', '-2e3', -2000],
    ['amount', false, false],
    ['flag', true, true],
    ['flag', false, false],
    ['flag', 'true', true],
    ['flag', 'false', false],
    ['flag', 'yes', 'yes'],
    ['pick', 'a', 'a'],
    ['pick', ' a ', ' a '],
    ['pick', '', undefined],
    ['picks', ['a', 'b'], ['a', 'b']],
    ['picks', [], undefined],
    ['picks', 'a', ['a']],
  ])('coerces %s %j', (name, raw, expected) => {
    expect(coerceElicitationValue(byName(name), raw)).toEqual(expected)
  })

  it('turns a local datetime-local value into RFC 3339 UTC and back', () => {
    const when = byName('when')
    const coerced = coerceElicitationValue(when, '2026-10-22T14:30')
    expect(typeof coerced).toBe('string')
    expect(Date.parse(coerced as string)).toBe(new Date(2026, 9, 22, 14, 30).getTime())
    expect(validateElicitationAnswer(KINDS, { when: coerced })).toEqual({ ok: true, content: { when: coerced } })
    const precise = coerceElicitationValue(when, '2026-10-22T14:30:15.25')
    expect(Date.parse(precise as string)).toBe(new Date(2026, 9, 22, 14, 30, 15, 250).getTime())
    const withDefault = field({ type: 'string', format: 'date-time', default: '2026-10-22T12:30:00Z' })
    const initial = elicitationInitialValues({ fields: [withDefault] }).f as string
    expect(initial).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(coerceElicitationValue(withDefault, initial)).toBe('2026-10-22T12:30:00Z')
    const offset = field({ type: 'string', format: 'date-time', default: '2026-10-22T12:30:45.5+02:00' })
    const offsetInitial = elicitationInitialValues({ fields: [offset] }).f as string
    expect(offsetInitial).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/)
    expect(Date.parse(coerceElicitationValue(offset, offsetInitial) as string)).toBe(Date.parse('2026-10-22T12:30:45.5+02:00'))
  })

  it('never throws on malformed input', () => {
    for (const bad of [null, undefined, 5, 'x', { type: 'weird' }])
      expect(() => coerceElicitationValue(bad as unknown as ElicitationField, 'x')).not.toThrow()
    expect(coerceElicitationValue(byName('text'), 5 as unknown as ElicitationRawValue)).toBeUndefined()
  })
})

describe('round trips: parse → initial values → coerce → validate', () => {
  const SCHEMA = {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', minLength: 2, default: 'Ada' },
      email: { type: 'string', format: 'email', default: 'ada@example.com' },
      site: { type: 'string', format: 'uri', default: 'https://example.com' },
      born: { type: 'string', format: 'date', default: '1815-12-10' },
      meeting: { type: 'string', format: 'date-time', default: '2026-10-22T09:15:00Z' },
      age: { type: 'integer', minimum: 0, default: 36 },
      ratio: { type: 'number', default: 0.25 },
      subscribe: { type: 'boolean', default: true },
      color: { type: 'string', oneOf: [{ const: '#FF0000', title: 'Red' }, { const: '#00FF00', title: 'Green' }], default: '#00FF00' },
      tags: { type: 'array', items: { anyOf: [{ const: 'math', title: 'Math' }, { const: 'poetry', title: 'Poetry' }] }, default: ['poetry', 'math'] },
      empty: { type: 'string' },
    },
    required: ['name', 'email', 'subscribe', 'tags'],
  }

  function submit(parsed: ElicitationForm, raw: Record<string, ElicitationRawValue>) {
    const content: Record<string, ElicitationValue> = {}
    for (const entry of parsed.fields) {
      const value = coerceElicitationValue(entry, raw[entry.name])
      if (value !== undefined)
        content[entry.name] = value
    }
    return validateElicitationAnswer(parsed, content)
  }

  it('submits the defaults unchanged', () => {
    const parsed = form(SCHEMA)
    const result = submit(parsed, elicitationInitialValues(parsed))
    expect(result).toEqual({
      ok: true,
      content: {
        name: 'Ada',
        email: 'ada@example.com',
        site: 'https://example.com',
        born: '1815-12-10',
        meeting: '2026-10-22T09:15:00Z',
        age: 36,
        ratio: 0.25,
        subscribe: true,
        color: '#00FF00',
        tags: ['poetry', 'math'],
      },
    })
  })

  it('reports the empty required fields of a form without defaults', () => {
    const withoutDefault = (property: Record<string, unknown>) => Object.fromEntries(Object.entries(property).filter(([key]) => key !== 'default'))
    const parsed = form({ ...SCHEMA, properties: Object.fromEntries(Object.entries(SCHEMA.properties).map(([name, property]) => [name, withoutDefault(property)])) })
    expect(submit(parsed, elicitationInitialValues(parsed))).toEqual({
      ok: false,
      issues: [
        { field: 'name', code: 'required', message: 'This field is required.' },
        { field: 'email', code: 'required', message: 'This field is required.' },
        { field: 'tags', code: 'required', message: 'Choose at least one option.' },
      ],
    })
  })

  it('submits edited values typed into the controls', () => {
    const parsed = form(SCHEMA)
    const raw = { ...elicitationInitialValues(parsed), name: 'Grace', age: '85', ratio: '1e-1', email: ' grace@example.org ', tags: ['math'], empty: 'x' }
    expect(submit(parsed, raw)).toMatchObject({ ok: true, content: { name: 'Grace', age: 85, ratio: 0.1, email: 'grace@example.org', tags: ['math'], empty: 'x' } })
  })
})

describe('the zod mirror (`mcpElicitationFormSchema`) accepts every parsed form', () => {
  it('accepts the specification examples and the bounds', () => {
    const forms = [
      form({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }),
      form({
        type: 'object',
        properties: {
          a: { type: 'string', title: 't'.repeat(900), description: 'd'.repeat(900), maxLength: 1e9, minLength: 0, format: 'date-time', default: '2026-10-22T09:15:00Z' },
          b: { type: 'number', minimum: -1e300, maximum: 1e300, default: 0 },
          c: { type: 'array', minItems: 0, maxItems: 1000, items: { type: 'string', enum: Array.from({ length: ELICITATION_OPTIONS_MAX }, (_, index) => `${'v'.repeat(ELICITATION_VALUE_MAX_CHARS - 3)}${index}`) } },
        },
      }),
    ]
    for (const parsed of forms)
      expect(mcpElicitationFormSchema.safeParse(parsed).success).toBe(true)
  })
})

// ---------- fuzzing ----------

const LEAVES: readonly unknown[] = [null, true, false, 0, -1, 1.5, 3, 100, 1e300, Number.MAX_SAFE_INTEGER + 2, '', ' ', 'a', 'red', 'object', 'string', 'number', 'integer', 'boolean', 'array', 'email', 'uri', 'date', 'date-time', '2026-10-22', 'x@y.zz', 'https://a.example', '\u0000\u202E', '😀', 'password']
const NAMES = ['name', 'email', 'age', 'tags', 'a.b-c', '_x', '__proto__', 'constructor', 'toString', '1bad', 'with space', 'x'.repeat(64), 'y'.repeat(65), '', 'apiKey', 'f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10']
const KEYS = ['type', 'title', 'description', 'default', 'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'enumNames', 'oneOf', 'anyOf', 'items', 'minItems', 'maxItems', '$ref', 'const', 'properties', 'required', 'pattern', 'x-extra', '__proto__']

function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

function randomText(random: () => number, max: number): string {
  const pieces = ['a', 'Z', ' ', '\n', '\r\n', '\t', '\u0000', '\u0085', '\u202E', '\u2066', '\uD83D', '\uDE00', '😀', 'ü', '.', '@', 'password', 'pin', 'https://', '-']
  let text = ''
  const count = Math.floor(random() * max)
  for (let index = 0; index < count; index++)
    text += pieces[Math.floor(random() * pieces.length)]
  return text
}

function randomJson(random: () => number, depth: number): unknown {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  const roll = random()
  if (depth > 3 || roll < 0.45)
    return random() < 0.2 ? randomText(random, 12) : pick(LEAVES)
  if (roll < 0.65)
    return Array.from({ length: Math.floor(random() * 5) }, () => randomJson(random, depth + 1))
  const object: Record<string, unknown> = {}
  for (let index = Math.floor(random() * 5); index > 0; index--)
    define(object, pick(KEYS), randomJson(random, depth + 1))
  return object
}

function randomOptions(random: () => number, titled: boolean): unknown[] {
  const count = random() < 0.03 ? ELICITATION_OPTIONS_MAX + 1 : Math.floor(random() * 6)
  return Array.from({ length: count }, (_, index) => {
    const value = random() < 0.05 ? randomJson(random, 3) : random() < 0.05 ? 'dup' : `o${index}`
    return titled ? (random() < 0.05 ? value : { const: value, title: random() < 0.3 ? randomText(random, 8) : `Option ${index}` }) : value
  })
}

function randomProperty(random: () => number): unknown {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  const kind = pick(['string', 'format', 'number', 'integer', 'boolean', 'enum', 'oneOf', 'multi', 'multiTitled', 'random'])
  let property: Record<string, unknown>
  switch (kind) {
    case 'string':
      property = { type: 'string', minLength: pick([undefined, 0, 2, 5, -1]), maxLength: pick([undefined, 3, 10, 1e9]) }
      break
    case 'format':
      property = { type: 'string', format: pick(['email', 'uri', 'date', 'date-time', 'uuid']) }
      break
    case 'number':
    case 'integer':
      property = { type: kind, minimum: pick([undefined, 0, 1.5, -10]), maximum: pick([undefined, 1, 10, 1e300]) }
      break
    case 'boolean':
      property = { type: 'boolean' }
      break
    case 'enum':
      property = { type: 'string', enum: randomOptions(random, false), enumNames: random() < 0.5 ? randomOptions(random, false) : undefined }
      break
    case 'oneOf':
      property = { type: 'string', oneOf: randomOptions(random, true) }
      break
    case 'multi':
      property = { type: 'array', items: { type: 'string', enum: randomOptions(random, false) }, minItems: pick([undefined, 0, 1, 3]), maxItems: pick([undefined, 1, 2, 50]) }
      break
    case 'multiTitled':
      property = { type: 'array', items: { anyOf: randomOptions(random, true) }, minItems: pick([undefined, 1]), maxItems: pick([undefined, 2]) }
      break
    default:
      return randomJson(random, 1)
  }
  for (const key of Object.keys(property)) {
    if (property[key] === undefined)
      delete property[key]
  }
  if (random() < 0.5)
    property.title = randomText(random, 30)
  if (random() < 0.3)
    property.description = random() < 0.1 ? 'd'.repeat(700) : randomText(random, 60)
  if (random() < 0.5)
    property.default = random() < 0.5 ? randomJson(random, 2) : pick(['o1', ['o0', 'o1'], 2, true, 'x@y.zz', '2026-10-22T09:15:00Z'])
  if (random() < 0.15)
    define(property, pick(KEYS), randomJson(random, 2))
  const roll = random()
  if (roll < 0.1)
    return { [pick(['anyOf', 'oneOf'])]: random() < 0.5 ? [property, { type: 'null' }] : [{ type: 'null' }, property], ...(random() < 0.5 ? { default: null, title: randomText(random, 10) } : {}) }
  if (roll < 0.15 && typeof property.type === 'string')
    return { ...property, type: random() < 0.5 ? [property.type, 'null'] : ['null', property.type] }
  return property
}

function randomSchema(random: () => number): unknown {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  if (random() < 0.1)
    return randomJson(random, 0)
  const properties: Record<string, unknown> = {}
  const count = random() < 0.05 ? ELICITATION_FIELDS_MAX + 2 : Math.floor(random() * 8)
  for (let index = 0; index < count; index++)
    define(properties, random() < 0.8 ? `f${index}` : pick(NAMES), randomProperty(random))
  const schema: Record<string, unknown> = { type: random() < 0.95 ? 'object' : pick(['array', 'string', 5]), properties }
  if (random() < 0.6)
    schema.required = [...Object.keys(properties).filter(() => random() < 0.5), ...(random() < 0.05 ? ['missing'] : [])]
  if (random() < 0.08)
    define(schema, pick(['$ref', 'anyOf', 'title', '$schema', 'additionalProperties']), randomJson(random, 2))
  return schema
}

function checkForm(parsed: ElicitationForm): void {
  expect(parsed.fields.length).toBeLessThanOrEqual(ELICITATION_FIELDS_MAX)
  expect(new Set(parsed.fields.map(entry => entry.name)).size).toBe(parsed.fields.length)
  expect(mcpElicitationFormSchema.safeParse(parsed).success).toBe(true)
  for (const entry of parsed.fields) {
    expect(ELICITATION_FIELD_NAME_PATTERN.test(entry.name)).toBe(true)
    expect(entry.name).not.toBe('__proto__')
    for (const text of [entry.title, entry.description]) {
      if (text === null)
        continue
      expect(text.length).toBeGreaterThan(0)
      expect(text.length).toBeLessThanOrEqual(ELICITATION_TEXT_MAX_CHARS)
      expect(text).toBe(text.trim())
      expect(hasInvisible(text)).toBe(false)
    }
    if (entry.type === 'enum' || entry.type === 'multi-enum') {
      const options = entry.options ?? []
      expect(options.length).toBeGreaterThan(0)
      expect(options.length).toBeLessThanOrEqual(ELICITATION_OPTIONS_MAX)
      expect(new Set(options.map(option => option.value)).size).toBe(options.length)
      for (const option of options) {
        expect(option.label.length).toBeGreaterThan(0)
        expect(option.label.length).toBeLessThanOrEqual(ELICITATION_TEXT_MAX_CHARS)
        expect(hasInvisible(option.label)).toBe(false)
      }
    }
    else {
      expect(entry).not.toHaveProperty('options')
    }
    if (entry.default !== undefined) {
      const single: ElicitationForm = { fields: [{ ...entry, required: true }] }
      expect(validateElicitationAnswer(single, { [entry.name]: entry.default })).toEqual({ ok: true, content: { [entry.name]: entry.default } })
    }
    expect(typeof isSensitiveField(entry)).toBe('boolean')
  }
}

function checkAnswer(parsed: ElicitationForm, content: unknown): void {
  const result = validateElicitationAnswer(parsed, content)
  if (result.ok) {
    const names = new Set(parsed.fields.map(entry => entry.name))
    for (const [name, value] of Object.entries(result.content)) {
      expect(names.has(name)).toBe(true)
      expect(mcpElicitationValueSchema.safeParse(value).success).toBe(true)
    }
    for (const entry of parsed.fields) {
      if (entry.required)
        expect(Object.hasOwn(result.content, entry.name)).toBe(true)
    }
  }
  else {
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues.length).toBeLessThanOrEqual(parsed.fields.length + ELICITATION_FIELDS_MAX)
    for (const issue of result.issues) {
      expect(ISSUE_CODES).toContain(issue.code)
      expect(issue.field.length).toBeLessThanOrEqual(64)
      expect(issue.message.length).toBeGreaterThan(0)
    }
  }
}

// Seeded fuzz loops run several times slower on CI runners than locally: a generous timeout above the time budget.
describe('fuzzing', { timeout: 30_000 }, () => {
  it('parses random schemas without throwing and keeps every invariant', () => {
    const random = prng(0xE11C)
    const started = Date.now()
    let supported = 0
    for (let iteration = 0; iteration < 3000; iteration++) {
      const schema = randomSchema(random)
      const result = parseElicitationForm(schema)
      if (!result.ok) {
        expect(result.reason.length).toBeGreaterThan(0)
        expect(result.reason.length).toBeLessThanOrEqual(300)
        continue
      }
      supported++
      checkForm(result.form)
      const raw = elicitationInitialValues(result.form)
      const content: Record<string, unknown> = {}
      for (const entry of result.form.fields) {
        const value = coerceElicitationValue(entry, random() < 0.8 ? raw[entry.name] : (randomJson(random, 2) as ElicitationRawValue))
        if (value !== undefined)
          content[entry.name] = value
      }
      checkAnswer(result.form, content)
      checkAnswer(result.form, randomJson(random, 0))
      const mixed = randomJson(random, 1)
      checkAnswer(result.form, typeof mixed === 'object' && mixed !== null && !Array.isArray(mixed) ? { ...content, ...mixed } : content)
    }
    expect(supported).toBeGreaterThan(500)
    expect(Date.now() - started).toBeLessThan(20_000)
  })

  it('cleans random messages and answers random forms without throwing', () => {
    const random = prng(0x5EC2)
    const started = Date.now()
    for (let iteration = 0; iteration < 3000; iteration++) {
      const message = random() < 0.02 ? randomText(random, 3000) : randomText(random, 200)
      const text = elicitationMessageText(message)
      expect(text.length).toBeLessThanOrEqual(ELICITATION_MESSAGE_MAX_CHARS)
      expect(hasInvisible(text, true)).toBe(false)
      expect(text).toBe(text.trim())
      expect(text).not.toContain('\n\n\n')
      const value = randomJson(random, 0)
      expect(() => elicitationMessageText(value)).not.toThrow()
      expect(() => parseElicitationForm(value)).not.toThrow()
      expect(() => validateElicitationAnswer(value as ElicitationForm, randomJson(random, 0))).not.toThrow()
      expect(() => elicitationInitialValues(value as ElicitationForm)).not.toThrow()
      expect(() => coerceElicitationValue(value as ElicitationField, randomJson(random, 1) as ElicitationRawValue)).not.toThrow()
      expect(typeof isSensitiveField(value as ElicitationField)).toBe('boolean')
    }
    expect(Date.now() - started).toBeLessThan(20_000)
  })
})
