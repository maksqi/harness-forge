import type { SettingsSchema } from '@harness-forge/shared'
import { settingsSchemaSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import {
  cloneValues,
  defaultValueOf,
  hasDefaultValues,
  sameValue,
  schemaFieldKind,
  settingsChanged,
  settingsFormValues,
  settingsPatch,
  storedSecretHints,
  storedSecretKeys,
  validateSettingsValues,
  valuesWithDefaults,
} from './schema-form'

const schema: SettingsSchema = settingsSchemaSchema.parse({
  type: 'object',
  required: ['token', 'name'],
  properties: {
    name: { type: 'string', title: 'Name' },
    token: { type: 'string', title: 'Token', format: 'secret' },
    spare: { type: 'string', title: 'Spare token', format: 'secret' },
    endpoint: { type: 'string', title: 'Endpoint', format: 'url' },
    notes: { type: 'string', title: 'Notes', format: 'multiline' },
    mode: { type: 'string', title: 'Mode', enum: ['a', 'b'], default: 'a' },
    count: { type: 'integer', title: 'Count', minimum: 1, maximum: 10 },
    ratio: { type: 'number', title: 'Ratio', maximum: 1 },
    on: { type: 'boolean', title: 'On' },
    colors: { type: 'array', title: 'Colors', items: { type: 'string', enum: ['red', 'blue'] }, default: ['red'] },
    tags: { type: 'array', title: 'Tags', items: { type: 'string' } },
  },
})

describe('schema form rules', () => {
  it('maps every property to a control', () => {
    expect(Object.values(schema.properties).map(schemaFieldKind)).toEqual([
      'text',
      'secret',
      'secret',
      'url',
      'multiline',
      'select',
      'integer',
      'number',
      'boolean',
      'checkboxes',
      'tags',
    ])
  })

  it('builds form values from a settings view: non-secret values only, switches default to off', () => {
    const view = {
      schema,
      values: { name: 'x', mode: 'b', colors: ['blue'], unknown: 1, count: null },
      secrets: { token: { set: true, hint: 'sk-…1', source: 'stored' as const }, spare: { set: false, hint: null, source: null } },
    }
    expect(settingsFormValues(view)).toEqual({ name: 'x', mode: 'b', colors: ['blue'], on: false })
    expect(settingsFormValues({ schema: null, values: { a: 1 } })).toEqual({})
    expect(storedSecretKeys(view)).toEqual(['token'])
    expect(storedSecretHints(view)).toEqual({ token: 'sk-…1' })
  })

  it('knows the defaults for "Reset to defaults" and leaves secrets alone', () => {
    expect(defaultValueOf(schema.properties.mode!)).toBe('a')
    expect(defaultValueOf(schema.properties.name!)).toBe('')
    expect(defaultValueOf(schema.properties.tags!)).toEqual([])
    expect(defaultValueOf(schema.properties.on!)).toBe(false)
    expect(defaultValueOf(schema.properties.count!)).toBeUndefined()
    const reset = valuesWithDefaults(schema, { name: 'x', token: 'typed', mode: 'b', count: 4, colors: [], tags: ['t'] })
    expect(reset).toEqual({ name: '', token: 'typed', endpoint: '', notes: '', mode: 'a', on: false, colors: ['red'], tags: [] })
    expect(hasDefaultValues(schema, reset)).toBe(true)
    expect(hasDefaultValues(schema, { ...reset, count: 2 })).toBe(false)
    expect(hasDefaultValues(schema, { mode: 'a', colors: ['red'], on: false })).toBe(true)
  })

  it('validates with settingsValuesSchema and words the messages', () => {
    const valid = { name: 'n', mode: 'a' }
    expect(validateSettingsValues(schema, valid, ['token'])).toBeNull()
    expect(validateSettingsValues(schema, valid)?.fields).toEqual({ token: 'Token is required.' })
    expect(validateSettingsValues(schema, { ...valid, name: ' ', token: 'x' })?.fields).toEqual({ name: 'Name is required.' })
    expect(validateSettingsValues(schema, { ...valid, count: 12, ratio: 3, endpoint: 'nope' }, ['token'])?.fields).toEqual({
      count: 'Enter a number from 1 to 10.',
      ratio: 'Enter a number of at most 1.',
      endpoint: 'Enter an absolute http:// or https:// URL.',
    })
    expect(validateSettingsValues(schema, { ...valid, count: 1.5 }, ['token'])?.fields.count).toBe('Enter a whole number.')
    expect(validateSettingsValues(schema, { ...valid, count: 'abc' }, ['token'])?.fields.count).toBe('Enter a whole number.')
    expect(validateSettingsValues(schema, { ...valid, colors: ['green'] }, ['token'])?.fields.colors).toBe('Choose values from the list.')
    // Unknown keys never reach the validator.
    expect(validateSettingsValues(schema, { ...valid, extra: true }, ['token'])).toBeNull()
  })

  it('sends only what changed: null removes, secrets only when replaced or cleared', () => {
    const baseline = { name: 'n', mode: 'a', count: 3, on: false, colors: ['red'], tags: ['x'] }
    expect(settingsPatch(schema, baseline, baseline)).toEqual({})
    expect(settingsChanged(schema, baseline, baseline)).toBe(false)
    expect(settingsPatch(schema, { ...baseline, count: undefined, tags: [], notes: '', token: 'sk-2', spare: '' }, baseline)).toEqual({
      count: null,
      tags: [],
      token: 'sk-2',
      spare: '',
    })
    // An empty text field equals an unset one; an unset list without a default equals an empty one.
    expect(settingsPatch(schema, { ...baseline, endpoint: '' }, baseline)).toEqual({})
    expect(settingsPatch(schema, { name: 'n', mode: 'a', count: 3, on: false, colors: ['red'], tags: [] }, { ...baseline, tags: undefined })).toEqual({})
    // A list with a default that is emptied is an explicit choice.
    expect(settingsPatch(schema, { ...baseline, colors: [] }, baseline)).toEqual({ colors: [] })
    expect(settingsPatch(schema, { ...baseline, name: '' }, baseline)).toEqual({ name: null })
    expect(settingsChanged(schema, { ...baseline, on: true }, baseline)).toBe(true)
  })

  it('copies and compares reactive values', () => {
    const source = reactive({ a: ['x'], b: { c: 1 } })
    const copy = cloneValues(source)
    expect(copy).toEqual({ a: ['x'], b: { c: 1 } })
    copy.a.push('y')
    expect(source.a).toEqual(['x'])
    expect(sameValue({ a: undefined, b: 1 }, { b: 1 })).toBe(true)
    expect(sameValue(['a'], ['a', 'b'])).toBe(false)
  })
})
