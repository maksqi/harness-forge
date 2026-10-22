// Web search in the transcript (Phase 14; docs/UI.md 7.35, 11.10): the parts C54 completes in P14-0b (`isWebSearchPart`,
// which ToolPart mounts WebSearchToolBody through, and the sources row's chips); W14.9 owns the module and extends this
// file (`webSearchView`, the avatars, the trigger's name).
import type { ToolPartLike } from '../chat-format'
import { describe, expect, it } from 'vitest'
import { isWebSearchPart, sourceAvatar, sourceChips, sourcesTriggerName } from './web-search'

function part(type: string, providerExecuted?: boolean): ToolPartLike {
  return { type, toolCallId: 'call_1', state: 'output-available', input: {}, output: {}, ...(providerExecuted === undefined ? {} : { providerExecuted }) } as ToolPartLike
}

describe('isWebSearchPart', () => {
  it('is the builtin search_web or a provider-executed native search tool', () => {
    expect(isWebSearchPart(part('tool-search_web'))).toBe(true)
    expect(isWebSearchPart(part('tool-web_search', true))).toBe(true)
    expect(isWebSearchPart(part('tool-google_search', true))).toBe(true)
    expect(isWebSearchPart(part('tool-browser_search', true))).toBe(true)
    // A function tool named like a native search tool, or another provider-executed tool, is not.
    expect(isWebSearchPart(part('tool-web_search'))).toBe(false)
    expect(isWebSearchPart(part('tool-code_execution', true))).toBe(false)
    expect(isWebSearchPart(part('tool-read_file'))).toBe(false)
    expect(isWebSearchPart(part('tool-web_search', true), ['google_search'])).toBe(false)
  })
})

describe('sources chips', () => {
  it('keeps the first unique http(s) domains in order and counts the rest', () => {
    expect(sourceChips(['https://www.a.com/1', 'https://a.com/2', 'http://b.org', 'ftp://c.net', 'https://d.io', 'https://e.dev'])).toEqual({ domains: ['a.com', 'b.org', 'd.io'], more: 1 })
    expect(sourceChips([], 3)).toEqual({ domains: [], more: 0 })
    expect(sourcesTriggerName(6, { domains: ['a.com', 'b.org'], more: 3 })).toBe('6 sources: a.com, b.org and 3 more')
    expect(sourcesTriggerName(1, { domains: ['a.com'], more: 0 })).toBe('1 source: a.com')
  })

  it('gives a domain a stable letter avatar', () => {
    expect(sourceAvatar('github.com')).toEqual(sourceAvatar('github.com'))
    expect(sourceAvatar('github.com').letter).toBe('G')
    expect(['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']).toContain(sourceAvatar('example.org').token)
  })
})
