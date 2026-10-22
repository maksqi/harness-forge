// Phase 14 record readers (W14.6): MCP tool names, search queries (input, output, OpenAI / xAI actions), the lenient
// `search_web` output reader and the elicitation records of MCP tool outputs.
import { searchWebOutputSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { ELICITATION_RECORDS, SEARCH_RESULTS } from './records.test-util.ts'
import { elicitationRecordsOf, isMcpToolName, queryText, searchQueryOf, searchWebOutputOf, WEB_SEARCH_BACKEND_LABELS } from './records.ts'

describe('isMcpToolName', () => {
  it('accepts mcp__<server>__<tool> names only', () => {
    expect(isMcpToolName('mcp__fake__ask')).toBe(true)
    expect(isMcpToolName('mcp__')).toBe(false)
    expect(isMcpToolName('search_web')).toBe(false)
    expect(isMcpToolName('web_search')).toBe(false)
  })
})

describe('queryText / searchQueryOf', () => {
  it('flattens a query to one line without control characters, capped at 400 code points', () => {
    expect(queryText('  weather\n\tin   Lisbon\u0007 ')).toBe('weather in Lisbon')
    expect(queryText('   ')).toBeNull()
    expect(queryText(42)).toBeNull()
    expect(Array.from(queryText('😀'.repeat(500))!)).toHaveLength(400)
  })

  it('reads the input query, then the output query, then the action query or queries', () => {
    expect(searchQueryOf({ query: 'from input' }, { query: 'from output' })).toBe('from input')
    expect(searchQueryOf({}, { query: 'from output' })).toBe('from output')
    expect(searchQueryOf({}, { action: { type: 'search', query: 'from action' } })).toBe('from action')
    expect(searchQueryOf({}, { action: { type: 'search', queries: ['first', 2, 'second'] } })).toBe('first, second')
    expect(searchQueryOf({ query: '  ' }, { action: { type: 'openPage', url: 'https://example.com' } })).toBeNull()
    expect(searchQueryOf(undefined, [{ type: 'web_search_result' }])).toBeNull()
    expect(searchQueryOf('query', null)).toBeNull()
  })
})

describe('searchWebOutputOf', () => {
  it('copies the query, the backend and the valid results field by field', () => {
    const output = searchWebOutputOf({
      query: 'mcp  authorization',
      backend: 'tavily',
      results: [
        { ...SEARCH_RESULTS[0], extra: 'dropped' },
        { title: 'Script', url: 'javascript:alert(1)', snippet: '', published: null },
        { title: 'x'.repeat(301), url: 'https://example.com', snippet: '', published: null },
        'not a result',
        SEARCH_RESULTS[1],
      ],
    })
    expect(output).toEqual({ query: 'mcp authorization', backend: 'tavily', results: SEARCH_RESULTS })
    expect(searchWebOutputSchema.parse(output)).toEqual(output)
  })

  it('keeps at most 10 results and answers null for values that are not a search output', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ title: `R${index}`, url: `https://example.com/${index}`, snippet: '', published: null }))
    expect(searchWebOutputOf({ query: 'q', backend: 'exa', results: many })?.results.map(result => result.title)).toEqual(many.slice(0, 10).map(result => result.title))
    for (const value of [null, 'text', [], { query: 'q', backend: 'bing', results: [] }, { query: 'q', backend: 'brave' }, { truncated: true, originalBytes: 70000, preview: '{"query"' }])
      expect(searchWebOutputOf(value)).toBeNull()
  })

  it('names every backend', () => {
    expect(WEB_SEARCH_BACKEND_LABELS).toEqual({ brave: 'Brave Search', tavily: 'Tavily', exa: 'Exa' })
  })
})

describe('elicitationRecordsOf', () => {
  it('splits an MCP output into its valid records (five fields each) and the rest', () => {
    const output = {
      content: [{ type: 'text', text: 'ok' }],
      elicitations: [
        { ...ELICITATION_RECORDS[0], content: { name: 'VALUE-SENTINEL' } },
        { id: 'eli_bad', message: 'x', fields: [], action: 'accept', reason: 'user' },
        { ...ELICITATION_RECORDS[1], action: 'maybe' },
        ELICITATION_RECORDS[1],
      ],
    }
    const split = elicitationRecordsOf(output)
    expect(split).toEqual({ records: ELICITATION_RECORDS, rest: { content: [{ type: 'text', text: 'ok' }] } })
    expect(JSON.stringify(split)).not.toContain('VALUE-SENTINEL')
  })

  it('answers null without an elicitations key and no records for a value that is not a list', () => {
    expect(elicitationRecordsOf({ content: [] })).toBeNull()
    expect(elicitationRecordsOf('text')).toBeNull()
    expect(elicitationRecordsOf([ELICITATION_RECORDS[0]])).toBeNull()
    expect(elicitationRecordsOf({ elicitations: 'nope', structuredContent: { a: 1 } })).toEqual({ records: [], rest: { structuredContent: { a: 1 } } })
  })
})
