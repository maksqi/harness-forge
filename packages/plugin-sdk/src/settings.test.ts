import type { SettingsSchema } from '@harness-forge/shared'
import { flattenValidationIssues, settingsSchemaSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { settingsValuesSchema } from './settings.ts'

const schema: SettingsSchema = settingsSchemaSchema.parse({
  type: 'object',
  required: ['name', 'token', 'mode', 'tags'],
  properties: {
    name: { type: 'string', title: 'Name', pattern: '^[a-z]+$' },
    token: { type: 'string', title: 'Token', format: 'secret' },
    optionalToken: { type: 'string', title: 'Optional token', format: 'secret' },
    endpoint: { type: 'string', title: 'Endpoint', format: 'url' },
    notes: { type: 'string', title: 'Notes', format: 'multiline' },
    mode: { type: 'string', title: 'Mode', enum: ['fast', 'slow'], default: 'fast' },
    count: { type: 'integer', title: 'Count', minimum: 1, maximum: 10, default: 3 },
    ratio: { type: 'number', title: 'Ratio', minimum: 0, maximum: 1 },
    enabled: { type: 'boolean', title: 'Enabled', default: false },
    tags: { type: 'array', title: 'Tags', items: { type: 'string' } },
    colors: { type: 'array', title: 'Colors', items: { type: 'string', enum: ['red', 'blue'] }, default: ['red'] },
  },
})

function paths(result: ReturnType<ReturnType<typeof settingsValuesSchema>['safeParse']>): string[] {
  expect(result.success).toBe(false)
  return flattenValidationIssues(result.error!).map(issue => issue.path.join('.'))
}

describe('settingsValuesSchema', () => {
  const valid = { name: 'abc', token: 'secret-1', tags: ['x'] }

  it('applies defaults and keeps given values', () => {
    expect(settingsValuesSchema(schema).parse(valid)).toEqual({
      name: 'abc',
      token: 'secret-1',
      mode: 'fast',
      count: 3,
      enabled: false,
      tags: ['x'],
      colors: ['red'],
    })
  })

  it('returns defaults as copies', () => {
    const colors = settingsValuesSchema(schema).parse(valid).colors as string[]
    colors.push('blue')
    expect(settingsValuesSchema(schema).parse(valid).colors).toEqual(['red'])
    expect(schema.properties.colors?.default).toEqual(['red'])
  })

  it('requires required values with the property title', () => {
    const result = settingsValuesSchema(schema).safeParse({})
    expect(paths(result).sort()).toEqual(['name', 'tags', 'token'])
    expect(result.error?.issues.find(issue => issue.path[0] === 'name')?.message).toBe('Name is required.')
  })

  it('rejects blank required values', () => {
    expect(paths(settingsValuesSchema(schema).safeParse({ ...valid, name: '  ' }))).toContain('name')
    expect(paths(settingsValuesSchema(schema).safeParse({ ...valid, token: '' }))).toEqual(['token'])
    expect(paths(settingsValuesSchema(schema).safeParse({ ...valid, tags: [] }))).toEqual(['tags'])
  })

  it('validates every property type', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: 'ABC' }, 'name'],
      [{ endpoint: 'ftp://example.com' }, 'endpoint'],
      [{ mode: 'medium' }, 'mode'],
      [{ mode: '' }, 'mode'],
      [{ count: 0 }, 'count'],
      [{ count: 11 }, 'count'],
      [{ count: 2.5 }, 'count'],
      [{ ratio: 1.5 }, 'ratio'],
      [{ ratio: '0.5' }, 'ratio'],
      [{ enabled: 'yes' }, 'enabled'],
      [{ tags: ['a', 'a'] }, 'tags'],
      [{ tags: [''] }, 'tags.0'],
      [{ colors: ['green'] }, 'colors.0'],
      [{ unknown: 1 }, ''],
      [{ notes: null }, 'notes'],
    ]
    for (const [change, path] of cases)
      expect(paths(settingsValuesSchema(schema).safeParse({ ...valid, ...change })), JSON.stringify(change)).toContain(path)
  })

  it('accepts empty optional text fields and valid values', () => {
    const values = { ...valid, endpoint: '', notes: '', ratio: 0.5, enabled: true, colors: [], optionalToken: '' }
    expect(settingsValuesSchema(schema).parse(values)).toMatchObject(values)
    expect(settingsValuesSchema(schema).parse({ ...valid, endpoint: 'https://example.com/api', notes: 'line 1\nline 2' })).toBeTruthy()
  })

  it('lets stored secrets satisfy required', () => {
    const { token: _token, ...withoutToken } = valid
    expect(paths(settingsValuesSchema(schema).safeParse(withoutToken))).toEqual(['token'])
    expect(settingsValuesSchema(schema, { secretsSet: ['token'] }).safeParse(withoutToken).success).toBe(true)
    // Clearing a required secret is still rejected.
    expect(paths(settingsValuesSchema(schema, { secretsSet: ['token'] }).safeParse({ ...valid, token: '' }))).toEqual(['token'])
  })

  it('validates PUT patches with partial', () => {
    const partial = settingsValuesSchema(schema, { partial: true })
    expect(partial.parse({})).toEqual({})
    expect(partial.parse({ count: 5 })).toEqual({ count: 5 })
    expect(partial.parse({ ratio: null, optionalToken: '' })).toEqual({ ratio: null, optionalToken: '' })
    expect(paths(partial.safeParse({ name: null }))).toEqual(['name'])
    expect(paths(partial.safeParse({ token: '' }))).toEqual(['token'])
    expect(paths(partial.safeParse({ count: 50 }))).toEqual(['count'])
    expect(paths(partial.safeParse({ nope: true }))).toEqual([''])
  })

  it('handles an empty schema', () => {
    const empty = settingsValuesSchema({ type: 'object', properties: {} })
    expect(empty.parse({})).toEqual({})
    expect(empty.safeParse({ a: 1 }).success).toBe(false)
  })
})
