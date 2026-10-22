// WebSearchToolBody (Phase 14, ADR-062, ADR-063; docs/UI.md 7.35, 10.10, 14): the C54 stub's contract (props, the root
// test id with `data-mode` and `data-state`) and W14.9's body: the query, "{n} results · {search API}" or the native note,
// the results (a letter avatar, the title as an http(s) link described by its domain, the snippet as plain text), never
// `encryptedContent`, nothing for an unparsable value.
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { searchWebOutput, searchWebResult } from '~/utils/testing/fixtures'
import WebSearchToolBody from './WebSearchToolBody.vue'

beforeEach(() => {
  // Store-free (also on share pages): no Pinia at all.
  setActivePinia(undefined)
})

afterEach(() => {
  document.body.replaceChildren()
})

function mountBody(props: { input: unknown, output: unknown, native: boolean, running: boolean }) {
  return mount(WebSearchToolBody, { props, attachTo: document.body })
}

describe('webSearchToolBody', () => {
  it('accepts its props and marks the mode and the state', async () => {
    const wrapper = mountBody({ input: { query: 'harness forge' }, output: undefined, native: false, running: true })
    const root = wrapper.get(`[data-testid="${testIds.webSearchTool}"]`)
    expect(root.attributes('data-mode')).toBe('builtin')
    expect(root.attributes('data-state')).toBe('running')
    // A running builtin call shows its query only.
    expect(wrapper.get('[data-slot="web-search-query"]').text()).toBe('harness forge')
    expect(wrapper.find(`[data-testid="${testIds.webSearchResult}"]`).exists()).toBe(false)
    await wrapper.setProps({ output: searchWebOutput(), running: false, native: true })
    expect(root.attributes('data-mode')).toBe('native')
    expect(root.attributes('data-state')).toBe('done')
    await wrapper.setProps({ output: undefined, running: false, native: false })
    expect(root.attributes('data-state')).toBe('error')
  })

  it('a search_web output: the query, "{n} results · {search API}" and each result as plain text with a safe link', () => {
    const output = searchWebOutput({
      results: [
        searchWebResult({ title: '<img src=x onerror=alert(1)>', snippet: '<b>bold</b> snippet' }),
        searchWebResult({ title: 'Docs', url: 'https://docs.example.org/start', snippet: 'Getting started.', published: null }),
      ],
    })
    const wrapper = mountBody({ input: { query: 'harness forge' }, output, native: false, running: false })
    expect(wrapper.get('[data-slot="web-search-query"]').text()).toBe('harness forge')
    expect(wrapper.get('[data-slot="web-search-summary"]').text()).toBe('2 results · Brave Search')
    const list = wrapper.get('ul')
    expect(list.attributes('aria-label')).toBe('Search results')
    const results = wrapper.findAll(`[data-testid="${testIds.webSearchResult}"]`)
    expect(results.map(result => result.attributes('data-domain'))).toEqual(['example.com', 'docs.example.org'])
    const link = results[0]!.get('a')
    expect(link.attributes()).toMatchObject({ href: 'https://example.com/harness-forge', target: '_blank', rel: 'noopener noreferrer' })
    expect(link.text()).toBe('<img src=x onerror=alert(1)>')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    expect(results[0]!.text()).toContain('<b>bold</b> snippet')
    expect(results[0]!.text()).toContain('2026-10-01')
    expect(document.getElementById(link.attributes('aria-describedby')!)?.textContent).toBe('example.com')
    // The letter avatar is hidden from screen readers and uses a chart token.
    const avatar = results[0]!.get('[data-slot="avatar"]')
    expect(avatar.attributes('aria-hidden')).toBe('true')
    expect(avatar.text()).toBe('E')
    expect(avatar.get('[data-slot="avatar-fallback"]').classes().some(name => /^bg-chart-[1-5]\/15$/.test(name))).toBe(true)
  })

  it('no results: "No results · {search API}" and no list', () => {
    const wrapper = mountBody({ input: {}, output: searchWebOutput({ backend: 'exa', results: [] }), native: false, running: false })
    expect(wrapper.get('[data-slot="web-search-summary"]').text()).toBe('No results · Exa')
    expect(wrapper.find('ul').exists()).toBe(false)
  })

  it('a provider-executed search: the query, the native note, titles and links, never encryptedContent', () => {
    const output = [
      { type: 'web_search_result', url: 'https://weather.example.com/lisbon', title: 'Lisbon weather', pageAge: null, encryptedContent: 'ENCRYPTED-PAGE' },
    ]
    const wrapper = mountBody({ input: { query: 'weather in Lisbon' }, output, native: true, running: false })
    const root = wrapper.get(`[data-testid="${testIds.webSearchTool}"]`)
    expect(root.attributes('data-mode')).toBe('native')
    expect(wrapper.get('[data-slot="web-search-query"]').text()).toBe('weather in Lisbon')
    expect(wrapper.get('[data-slot="web-search-summary"]').text()).toBe('The model\'s provider ran this search.')
    expect(wrapper.get(`[data-testid="${testIds.webSearchResult}"] a`).text()).toBe('Lisbon weather')
    expect(root.html()).not.toContain('ENCRYPTED-PAGE')
  })

  it('an unparsable value renders nothing inside the root', () => {
    const wrapper = mountBody({ input: 'x', output: '…[truncated]', native: false, running: false })
    expect(wrapper.get(`[data-testid="${testIds.webSearchTool}"]`).element.children).toHaveLength(0)
  })
})
