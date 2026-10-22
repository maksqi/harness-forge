// Settings → Web search rules (docs/UI.md 9.15, 15): key row order, Max results, the Test search line.
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import {
  CORE_SEARCH_PLUGIN_PATH,
  keyRowOrder,
  MAX_RESULTS_ERROR,
  parseMaxResults,
  testErrorText,
  testResultText,
  WEB_SEARCH_KEY_URLS,
} from './web-search-settings'

describe('keyRowOrder', () => {
  it('puts the selected backend first, the others in their usual order', () => {
    expect(keyRowOrder('brave')).toEqual(['brave', 'tavily', 'exa'])
    expect(keyRowOrder('tavily')).toEqual(['tavily', 'brave', 'exa'])
    expect(keyRowOrder('exa')).toEqual(['exa', 'brave', 'tavily'])
  })
})

describe('parseMaxResults', () => {
  it('accepts whole numbers from 1 to 10 (surrounding spaces ignored)', () => {
    expect(parseMaxResults('1')).toEqual({ value: 1 })
    expect(parseMaxResults(' 10 ')).toEqual({ value: 10 })
    expect(parseMaxResults('05')).toEqual({ value: 5 })
  })

  it('refuses anything else with one message', () => {
    expect(MAX_RESULTS_ERROR).toBe('Enter a whole number from 1 to 10.')
    for (const text of ['', '0', '11', '2.5', '-1', 'five', '1e1', '100'])
      expect(parseMaxResults(text)).toEqual({ error: MAX_RESULTS_ERROR })
  })
})

describe('testResultText', () => {
  it('says how many results came from which API in how long', () => {
    expect(testResultText({ ok: true, backend: 'brave', results: 5, ms: 412 })).toBe('5 results from Brave Search in 412 ms')
    expect(testResultText({ ok: true, backend: 'tavily', results: 1, ms: 1204 })).toBe('1 result from Tavily in 1,204 ms')
    expect(testResultText({ ok: true, backend: 'exa', results: 0, ms: 90 })).toBe('0 results from Exa in 90 ms')
  })
})

describe('testErrorText', () => {
  it('maps a rejected key, the rate limit and an unreachable API; else the server message', () => {
    const error = (code: HarnessError['code'], message: string, status?: number) => new HarnessError({ code, message, ...(status === undefined ? {} : { status }) })
    expect(testErrorText(error('provider_error', 'The search key was rejected.', 401), 'brave')).toBe('Brave Search rejected the key.')
    expect(testErrorText(error('provider_error', 'The search key was rejected.', 403), 'exa')).toBe('Exa rejected the key.')
    expect(testErrorText(error('provider_error', 'The search key was rejected.'), 'tavily')).toBe('Tavily rejected the key.')
    expect(testErrorText(error('provider_error', 'Tavily answered HTTP 500.', 500), 'tavily')).toBe('Tavily answered HTTP 500.')
    expect(testErrorText(error('provider_error', 'Exa answered with more than 1 MB.'), 'exa')).toBe('Exa answered with more than 1 MB.')
    expect(testErrorText(error('rate_limited', 'Too many requests.'), 'brave')).toBe('Brave Search is limiting requests. Try again later.')
    expect(testErrorText(error('provider_unreachable', 'fetch failed'), 'exa')).toBe('Couldn\'t reach Exa.')
    expect(testErrorText(error('provider_not_configured', 'Add a key for Brave Search first.'), 'brave')).toBe('Add a key for Brave Search first.')
    // Anything unknown never shows raw exception text.
    expect(testErrorText(new Error('socket hang up at 10.0.0.1'), 'brave')).not.toContain('10.0.0.1')
  })
})

describe('links', () => {
  it('opens only the vendors\' https pages and the plugin page', () => {
    expect(Object.values(WEB_SEARCH_KEY_URLS).every(url => url.startsWith('https://'))).toBe(true)
    expect(Object.keys(WEB_SEARCH_KEY_URLS)).toEqual(['brave', 'tavily', 'exa'])
    expect(CORE_SEARCH_PLUGIN_PATH).toBe('/plugins/core-search')
  })
})
