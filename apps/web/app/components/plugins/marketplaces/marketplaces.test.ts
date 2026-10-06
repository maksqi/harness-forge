// Pure helpers of the Marketplaces page (Phase 12, ADR-054; docs/UI.md 8.13, 11.9; C46 signatures).
import type { MarketplaceEntryView } from './marketplaces'
import { describe, expect, it } from 'vitest'
import { marketplaceEntry, marketplaceId, pluginSummary, pluginUpdate } from '~/utils/testing/fixtures'
import {
  categoriesOf,
  entryState,
  filterEntries,
  MARKETPLACE_INPUT_ERROR,
  OFFICIAL_MARKETPLACE,
  parseMarketplaceInput,
  sourceOfInput,
  sourceText,
  SUGGESTION_DISMISSED_KEY,
} from './marketplaces'

function view(overrides: Partial<MarketplaceEntryView['entry']> = {}): MarketplaceEntryView {
  return {
    marketplaceId: marketplaceId(1),
    marketplaceName: 'claude-plugins-official',
    entry: marketplaceEntry(overrides),
    state: 'available',
    pluginId: null,
    installedVersion: null,
    update: null,
  }
}

describe('marketplaces helpers', () => {
  it('names the official marketplace and the dismissal key', () => {
    expect(OFFICIAL_MARKETPLACE).toBe('anthropics/claude-plugins-official')
    expect(SUGGESTION_DISMISSED_KEY).toBe('hf-marketplace-suggestion-dismissed')
  })

  it.each([
    ['anthropics/claude-plugins-official', { kind: 'github', repo: 'anthropics/claude-plugins-official' }],
    ['acme/tools#v2', { kind: 'github', repo: 'acme/tools', ref: 'v2' }],
    ['https://github.com/acme/tools', { kind: 'github', repo: 'acme/tools' }],
    ['https://example.com/marketplace.json', { kind: 'url', url: 'https://example.com/marketplace.json' }],
    ['/srv/marketplaces/acme', { kind: 'folder', path: '/srv/marketplaces/acme' }],
    ['http://example.com/marketplace.json', { error: MARKETPLACE_INPUT_ERROR }],
    ['', { error: MARKETPLACE_INPUT_ERROR }],
  ])('reads the input %j', (text, expected) => {
    expect(parseMarketplaceInput(text)).toEqual(expected)
  })

  it('turns a usable input into a marketplace source', () => {
    expect(sourceOfInput({ kind: 'github', repo: 'acme/tools', ref: 'v2' })).toEqual({ type: 'github', repo: 'acme/tools', ref: 'v2' })
    expect(sourceOfInput({ kind: 'url', url: 'https://example.com/marketplace.json' })).toEqual({ type: 'url', url: 'https://example.com/marketplace.json' })
    expect(sourceOfInput({ kind: 'folder', path: '/srv/m' })).toEqual({ type: 'path', path: '/srv/m' })
    expect(sourceOfInput({ error: 'x' })).toBeNull()
  })

  it('states an entry against the installed plugins and the updates', () => {
    const plugins = [pluginSummary({ id: 'review-kit' })]
    expect(entryState(marketplaceEntry(), marketplaceId(1), plugins, [])).toBe('available')
    expect(entryState(marketplaceEntry({ supported: false }), marketplaceId(1), plugins, [])).toBe('unsupported')
    expect(entryState(marketplaceEntry({ installedPluginId: 'review-kit' }), marketplaceId(1), plugins, [])).toBe('installed')
    expect(entryState(marketplaceEntry({ installedPluginId: 'review-kit' }), marketplaceId(1), plugins, [pluginUpdate()])).toBe('update')
    expect(entryState(marketplaceEntry({ installedPluginId: 'review-kit', updateAvailable: true }), marketplaceId(1), plugins, [])).toBe('update')
  })

  it('writes the source line of a marketplace and of an entry', () => {
    expect(sourceText({ type: 'github', repo: 'acme/tools' }, '0123456789abcdef0123456789abcdef01234567')).toBe('github.com/acme/tools@0123456')
    expect(sourceText({ type: 'github', repo: 'acme/tools', ref: 'v2' })).toBe('github.com/acme/tools#v2')
    expect(sourceText({ type: 'url', url: 'https://example.com/m/marketplace.json' })).toBe('example.com/m/marketplace.json')
    expect(sourceText({ type: 'path', path: '/srv/m' })).toBe('/srv/m')
    expect(sourceText({ kind: 'relative', text: './plugins/x' })).toBe('In this marketplace')
    expect(sourceText({ kind: 'github', text: 'acme/x@v1' })).toBe('GitHub acme/x@v1')
    expect(sourceText({ kind: 'npm', text: '@acme/x' })).toBe('npm @acme/x')
    expect(sourceText({ kind: 'archive', text: 'https://cdn.example.com/x.zip' })).toBe('Archive cdn.example.com')
  })

  it('filters by search text and category and lists the categories', () => {
    const entries = [
      view(),
      view({ name: 'db-mcp', description: 'Database tools', category: 'data', tags: ['sql'] }),
      view({ name: 'misc', description: null, category: null, tags: [] }),
    ]
    expect(filterEntries(entries, 'SQL', null).map(entry => entry.entry.name)).toEqual(['db-mcp'])
    expect(filterEntries(entries, '', 'development').map(entry => entry.entry.name)).toEqual(['review-kit'])
    expect(filterEntries(entries, 'review', 'data')).toEqual([])
    expect(categoriesOf(entries)).toEqual(['data', 'development'])
  })
})
