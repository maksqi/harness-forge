// Web search in the transcript (Phase 14; docs/UI.md 7.35, 11.10): the parts C54 completes in P14-0b (`isWebSearchPart`,
// which ToolPart mounts WebSearchToolBody through, and the sources row's chips); W14.9 owns the module and extends this
// file (`webSearchView`, the avatars, the trigger's name).
// W14.9: the view of builtin and provider-executed rows (never `encryptedContent`), the row's words, the share kinds.
import type { ToolPartLike } from '../chat-format'
import { describe, expect, it } from 'vitest'
import { searchWebOutput, searchWebResult } from '~/utils/testing/fixtures'
import {
  isWebSearchPart,
  shareWebSearchKind,
  SOURCE_AVATAR_CLASSES,
  SOURCE_AVATAR_TOKENS,
  sourceAvatar,
  sourceChips,
  sourcesTriggerName,
  stripEncryptedContent,
  webSearchResultsText,
  webSearchRowLabel,
  webSearchView,
} from './web-search'

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

describe('webSearchView (W14.9)', () => {
  it('reads a search_web output: the query, the search API and each valid result', () => {
    const view = webSearchView({ query: 'ignored' }, searchWebOutput({
      results: [
        searchWebResult(),
        { title: 'Bad', url: 'javascript:alert(1)', snippet: 'x', published: null },
        searchWebResult({ title: '  Docs\n  page ', url: 'https://www.docs.example.org/start', snippet: 'Getting started.', published: null }),
      ],
    }), false)
    expect(view).toEqual({
      query: 'harness forge',
      backend: 'Brave Search',
      native: false,
      results: [
        { title: 'Harness Forge', url: 'https://example.com/harness-forge', domain: 'example.com', snippet: 'A self-hosted chat and agent harness.', published: '2026-10-01' },
        { title: 'Docs page', url: 'https://www.docs.example.org/start', domain: 'docs.example.org', snippet: 'Getting started.', published: null },
      ],
    })
    expect(webSearchView({}, searchWebOutput({ backend: 'tavily', results: [] }), false)?.backend).toBe('Tavily')
  })

  it('shows the input\'s query while a search_web call runs; nothing parses → null', () => {
    expect(webSearchView({ query: 'mcp authorization' }, undefined, false)).toEqual({ query: 'mcp authorization', backend: null, results: [], native: false })
    expect(webSearchView({}, undefined, false)).toBeNull()
    expect(webSearchView('x', '…[truncated]', false)).toBeNull()
  })

  it('reads provider-executed outputs without encryptedContent', () => {
    // Anthropic and the mock: an array of results, the query in the input.
    const anthropic = webSearchView({ query: 'weather in Lisbon' }, [
      { type: 'web_search_result', url: 'https://weather.example.com/lisbon', title: 'Lisbon weather', pageAge: '2 days ago', encryptedContent: 'SECRET' },
      { type: 'web_search_result', url: 'https://weather.example.com/lisbon', title: 'Duplicate', pageAge: null, encryptedContent: 'SECRET' },
      { type: 'web_search_result', url: 'ftp://files.example.com', title: 'No', pageAge: null },
      { type: 'web_search_result', url: 'https://news.example.org/', title: null, pageAge: null },
    ], true)
    expect(anthropic).toEqual({
      query: 'weather in Lisbon',
      backend: null,
      native: true,
      results: [
        { title: 'Lisbon weather', url: 'https://weather.example.com/lisbon', domain: 'weather.example.com', snippet: '', published: '2 days ago' },
        { title: 'news.example.org', url: 'https://news.example.org/', domain: 'news.example.org', snippet: '', published: null },
      ],
    })
    expect(JSON.stringify(anthropic)).not.toContain('SECRET')
    // OpenAI and xAI: the query in the output's action, the sources as URLs.
    const openai = webSearchView({}, { action: { type: 'search', queries: ['mcp oauth', 'pkce'] }, sources: [{ type: 'url', url: 'https://modelcontextprotocol.io/a' }, { type: 'api', name: 'oai-weather' }] }, true)
    expect(openai?.query).toBe('mcp oauth')
    expect(openai?.results.map(result => result.domain)).toEqual(['modelcontextprotocol.io'])
    expect(webSearchView({}, { action: { type: 'search', query: 'one' } }, true)?.query).toBe('one')
    // Groq: nothing to read, still the native note.
    expect(webSearchView({}, {}, true)).toEqual({ query: null, backend: null, results: [], native: true })
  })

  it('removes encryptedContent from raw values at any depth', () => {
    expect(stripEncryptedContent([{ url: 'u', encryptedContent: 'x', nested: { encryptedContent: 'y', keep: 1 } }]))
      .toEqual([{ url: 'u', nested: { keep: 1 } }])
    expect(stripEncryptedContent('text')).toBe('text')
  })

  it('words the row and recognizes shared search rows by name', () => {
    expect(webSearchRowLabel(true)).toBe('Searching the web…')
    expect(webSearchRowLabel(false)).toBe('Searched the web')
    expect(webSearchResultsText(0)).toBe('No results')
    expect(webSearchResultsText(1)).toBe('1 result')
    expect(webSearchResultsText(8)).toBe('8 results')
    expect(shareWebSearchKind('search_web')).toBe('builtin')
    expect(shareWebSearchKind('web_search')).toBe('native')
    expect(shareWebSearchKind('google_search')).toBe('native')
    expect(shareWebSearchKind('read_file')).toBeNull()
  })

  it('gives each avatar token a literal class', () => {
    for (const token of SOURCE_AVATAR_TOKENS)
      expect(SOURCE_AVATAR_CLASSES[token]).toBe(`bg-${token}/15 text-${token}`)
  })
})
