import { describe, expect, it } from 'vitest'
import { errorActions, errorDetailsText, errorTitle, GENERIC_ERROR_MESSAGE, toHarnessErrorView } from './harness-error'

describe('toHarnessErrorView', () => {
  it('reads envelopes, init objects and envelope JSON', () => {
    const init = { code: 'auth_invalid', message: 'Key rejected', status: 401, providerId: 'anthropic', action: 'configure-provider' }
    expect(toHarnessErrorView(init)).toEqual(init)
    expect(toHarnessErrorView({ error: init })).toEqual(init)
    expect(toHarnessErrorView(JSON.stringify({ error: init }))).toEqual(init)
    expect(toHarnessErrorView(new Error(JSON.stringify({ error: init })))).toEqual(init)
  })

  it('reads the response body of an API call error', () => {
    const error = Object.assign(new Error('Bad gateway'), {
      responseBody: JSON.stringify({ error: { code: 'provider_error', message: 'Upstream failed' } }),
    })
    expect(toHarnessErrorView(error)).toEqual({ code: 'provider_error', message: 'Upstream failed' })
  })

  it('never shows raw messages of unknown errors', () => {
    expect(toHarnessErrorView(new Error('TypeError: x is undefined at line 3'))).toEqual({
      code: 'internal_error',
      message: GENERIC_ERROR_MESSAGE,
    })
    expect(toHarnessErrorView(undefined).code).toBe('internal_error')
    expect(toHarnessErrorView('not json').code).toBe('internal_error')
  })
})

describe('errorTitle', () => {
  it('fills in the provider', () => {
    const error = { code: 'auth_invalid', message: '', providerId: 'anthropic' }
    expect(errorTitle(error, 'Anthropic (Claude)')).toBe('Anthropic (Claude) rejected the API key')
    expect(errorTitle(error)).toBe('Anthropic rejected the API key')
    expect(errorTitle({ code: 'auth_invalid', message: '' })).toBe('The provider rejected the API key')
    expect(errorTitle({ code: 'provider_not_configured', message: '' }, 'OpenAI')).toBe('No API key for OpenAI')
  })

  it('has specific copy for a running response and a default for unknown codes', () => {
    expect(errorTitle({ code: 'conflict', message: '', details: { reason: 'run-active' } }))
      .toBe('A response is already running in this chat.')
    expect(errorTitle({ code: 'something_new', message: '' })).toBe('Something went wrong')
  })
})

describe('errorActions', () => {
  it('lets the envelope action win', () => {
    expect(errorActions({ code: 'internal_error', message: '', action: 'login' })).toEqual(['login'])
    expect(errorActions({ code: 'internal_error', message: '', action: 'bogus' })).toEqual(['retry'])
  })

  it('maps codes to actions', () => {
    expect(errorActions({ code: 'provider_not_configured', message: '' })).toEqual(['configure-provider'])
    expect(errorActions({ code: 'model_not_found', message: '' })).toEqual(['refresh-models'])
    expect(errorActions({ code: 'rate_limited', message: '' })).toEqual(['retry'])
    expect(errorActions({ code: 'plugin_error', message: '', details: { pluginId: 'dice' } })).toEqual(['view-logs'])
    expect(errorActions({ code: 'plugin_error', message: '' })).toEqual(['retry'])
    expect(errorActions({ code: 'context_overflow', message: '' })).toEqual([])
  })
})

describe('errorDetailsText', () => {
  it('prefers the short upstream text', () => {
    expect(errorDetailsText({ code: 'provider_error', message: '', details: { upstream: 'overloaded' } })).toBe('overloaded')
    expect(errorDetailsText({ code: 'internal_error', message: '', details: { requestId: 'r1' } })).toContain('"requestId": "r1"')
    expect(errorDetailsText({ code: 'internal_error', message: '' })).toBeNull()
  })
})
