import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { hookData, styleEntry } from '~/utils/testing/fixtures'
import { automaticStyle, refusalOf, resolveStyleQuery, styleOptions } from './output-style'

describe('refusalOf', () => {
  it('maps a hook-blocked conflict with its record', () => {
    const error = new HarnessError({ code: 'conflict', message: 'Do not paste keys.', details: { reason: 'hook-blocked', hook: hookData({ event: 'UserPromptSubmit', outcome: 'blocked', toolCallId: undefined, toolName: undefined }) } })
    expect(refusalOf(error)).toEqual({ code: 'hook-blocked', reason: 'Do not paste keys.', event: 'UserPromptSubmit', source: 'project', command: null })
  })

  it('maps a hook-blocked conflict without a valid record and an untrusted conflict', () => {
    const blocked = new HarnessError({ code: 'conflict', message: 'Blocked.', details: { reason: 'hook-blocked', hook: { id: 'x' } } })
    expect(refusalOf(blocked)).toEqual({ code: 'hook-blocked', reason: 'Blocked.', event: null, source: null, command: null })
    const untrusted = new HarnessError({ code: 'conflict', message: 'Approve it first.', details: { reason: 'untrusted' } })
    expect(refusalOf(untrusted)).toMatchObject({ code: 'untrusted', reason: 'Approve it first.' })
  })

  it('is null for other errors', () => {
    expect(refusalOf(new HarnessError({ code: 'conflict', message: 'Busy', details: { reason: 'run-active' } }))).toBeNull()
    expect(refusalOf(new HarnessError({ code: 'not_found', message: 'Gone' }))).toBeNull()
    expect(refusalOf(null)).toBeNull()
    expect(refusalOf(new Error('boom'))).toBeNull()
  })
})

describe('the style options (P11-0b first versions)', () => {
  it('lists the built-ins first, then the active styles of the catalog', () => {
    const options = styleOptions([styleEntry(), styleEntry({ name: 'off-style', state: 'off' })])
    expect(options.map(option => option.name)).toEqual(['default', 'explanatory', 'learning', 'terse'])
    expect(options[3]).toMatchObject({ label: 'Terse', source: 'project', available: true })
    expect(automaticStyle('terse', 'default', options)?.name).toBe('terse')
    expect(automaticStyle(null, 'learning', options)?.name).toBe('learning')
    expect(resolveStyleQuery('auto', options)).toEqual({ style: null })
    expect(resolveStyleQuery('TERSE', options)).toEqual({ style: 'terse' })
    expect(resolveStyleQuery('nope', options)).toHaveProperty('error')
  })
})
