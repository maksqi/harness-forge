import { describe, expect, it } from 'vitest'
import { effectiveEffort, effortOptions } from './effort'

describe('effort options', () => {
  it('offers Auto plus the listed efforts in canonical order', () => {
    expect(effortOptions({ reasoningEfforts: ['auto', 'high', 'low', 'medium'] })).toEqual(['auto', 'low', 'medium', 'high'])
    expect(effortOptions({ reasoningEfforts: ['max', 'off', 'high'] })).toEqual(['auto', 'off', 'high', 'max'])
  })

  it('is empty (menu hidden) without effort control', () => {
    expect(effortOptions({ reasoningEfforts: [] })).toEqual([])
    expect(effortOptions({ reasoningEfforts: ['auto'] })).toEqual([])
    expect(effortOptions(undefined)).toEqual([])
    expect(effortOptions(null)).toEqual([])
  })

  it('treats an effort the model does not offer as auto', () => {
    const options = effortOptions({ reasoningEfforts: ['low', 'high'] })
    expect(effectiveEffort('high', options)).toBe('high')
    expect(effectiveEffort('max', options)).toBe('auto')
    expect(effectiveEffort('medium', [])).toBe('auto')
  })
})
