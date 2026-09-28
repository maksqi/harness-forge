import { describe, expect, it } from 'vitest'
import { MAX_LISTED_MODELS, sanitizeListing, sanitizeModelInfo } from './listing.ts'

describe('sanitizeModelInfo', () => {
  it('keeps valid models and drops unknown keys', () => {
    expect(sanitizeModelInfo({ id: 'm', name: 'M', extra: true, capabilities: { tools: true, fancy: 1 }, cost: { input: 1, per: 'x' } }))
      .toEqual({ id: 'm', name: 'M', capabilities: { tools: true }, cost: { input: 1 } })
  })

  it('salvages the valid fields of a partially invalid model', () => {
    expect(sanitizeModelInfo({ id: 'm', name: 'M', contextWindow: -5, cost: { input: -1 }, reasoningEfforts: ['low', 'bogus'] }))
      .toEqual({ id: 'm', name: 'M' })
  })

  it('drops entries without a valid id', () => {
    expect(sanitizeModelInfo({ name: 'no id' })).toBeNull()
    expect(sanitizeModelInfo({ id: '' })).toBeNull()
    expect(sanitizeModelInfo({ id: 'bad\u0000id' })).toBeNull()
    expect(sanitizeModelInfo('m')).toBeNull()
  })
})

describe('sanitizeListing', () => {
  it('dedupes by id (first wins), skips garbage and caps the size', () => {
    expect(sanitizeListing([{ id: 'a', name: 'first' }, { id: 'a', name: 'second' }, null, { id: 'b' }]))
      .toEqual([{ id: 'a', name: 'first' }, { id: 'b' }])
    expect(sanitizeListing('nope')).toEqual([])
    const many = Array.from({ length: MAX_LISTED_MODELS + 10 }, (_, index) => ({ id: `m${index}` }))
    expect(sanitizeListing(many)).toHaveLength(MAX_LISTED_MODELS)
  })
})
