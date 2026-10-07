// Pure helpers of the Marketplaces page (Phase 12, ADR-054; docs/UI.md 8.13, 11.9; C46 signatures, W12.8 additions).
import type { MarketplaceEntryView } from './marketplaces'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import { marketplaceEntry, marketplaceId, marketplaceList, marketplaceSummary, pluginSummary, pluginUpdate } from '~/utils/testing/fixtures'
import {
  addErrorText,
  categoriesOf,
  chipName,
  conflictReasonOf,
  ENTRY_STATE_WORDS,
  entryState,
  entryStatusText,
  filterEntries,
  forEachLimited,
  MARKETPLACE_INPUT_ERROR,
  MARKETPLACE_INPUT_KINDS,
  middleTruncate,
  offeredVersion,
  OFFICIAL_MARKETPLACE,
  parseMarketplaceInput,
  queryText,
  showsOfficialSuggestion,
  sourceOfInput,
  sourceText,
  SUGGESTION_DISMISSED_KEY,
  updatesText,
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

describe('marketplaces helpers (W12.8 additions)', () => {
  const official = { name: 'claude-plugins-official', title: 'x', description: 'y', source: { type: 'github', repo: OFFICIAL_MARKETPLACE } } as const

  it('offers the three add kinds with their placeholders', () => {
    expect(MARKETPLACE_INPUT_KINDS.map(kind => [kind.value, kind.label])).toEqual([['github', 'GitHub'], ['url', 'URL'], ['folder', 'Folder on this server']])
    expect(MARKETPLACE_INPUT_KINDS.map(kind => kind.placeholder)).toEqual(['owner/repo#ref', 'https://example.com/marketplace.json', '/srv/marketplaces/acme'])
  })

  it('writes the state line and the state words of an entry', () => {
    const base = view()
    expect(ENTRY_STATE_WORDS).toEqual({ available: 'Available', installed: 'Installed', update: 'Update available', unsupported: 'Unsupported' })
    expect(entryStatusText(base)).toBe('')
    expect(entryStatusText({ ...base, state: 'installed' })).toBe('Installed')
    expect(entryStatusText({ ...base, state: 'update', update: pluginUpdate({ availableVersion: '1.3.0' }) })).toBe('Installed · Update to 1.3.0')
    expect(entryStatusText({ ...base, state: 'update', entry: marketplaceEntry({ version: null }), update: pluginUpdate({ availableVersion: null }) })).toBe('Installed · Update available')
    expect(entryStatusText({ ...base, state: 'unsupported', entry: marketplaceEntry({ source: { kind: 'git', text: 'x' }, supported: false }) })).toBe('Unsupported source (git)')
    expect(offeredVersion({ ...base, update: null })).toBe('1.2.0')
  })

  it('names chips and counts updates', () => {
    expect(chipName(marketplaceSummary())).toBe('claude-plugins-official, 2 plugins')
    expect(chipName(marketplaceSummary({ plugins: 1, updates: 2, lastError: { code: 'provider_error', message: 'x' } }))).toBe('claude-plugins-official, 1 plugin, 2 updates, last refresh failed')
    expect(updatesText(1)).toBe('· 1 update')
    expect(updatesText(3)).toBe('· 3 updates')
  })

  it('shows the official suggestion only while it is suggested, not added and not dismissed', () => {
    expect(showsOfficialSuggestion(null, false)).toBe(false)
    expect(showsOfficialSuggestion(marketplaceList({ items: [], suggestions: [official] }), false)).toBe(true)
    expect(showsOfficialSuggestion(marketplaceList({ items: [], suggestions: [official] }), true)).toBe(false)
    expect(showsOfficialSuggestion(marketplaceList({ items: [], suggestions: [] }), false)).toBe(false)
    // Added under another name or case: the repository decides.
    expect(showsOfficialSuggestion(marketplaceList({ items: [marketplaceSummary({ name: 'x', source: { type: 'github', repo: 'Anthropics/Claude-Plugins-Official' } })], suggestions: [official] }), false)).toBe(false)
    expect(showsOfficialSuggestion(marketplaceList({ items: [marketplaceSummary({ id: marketplaceId(2), name: 'acme', source: { type: 'github', repo: 'acme/tools' } })], suggestions: [official] }), false)).toBe(true)
  })

  it('maps the add errors: the server message, "Try again in {n} min" after a 429, the 409 reason', () => {
    expect(addErrorText(new HarnessError({ code: 'not_found', message: 'No marketplace.json there.' }))).toBe('No marketplace.json there.')
    expect(addErrorText(new HarnessError({ code: 'rate_limited', message: 'GitHub rate limit reached', retryAfterMs: 125_000 }))).toBe('GitHub rate limit reached. Try again in 3 min')
    expect(addErrorText(new HarnessError({ code: 'rate_limited', message: 'Slow down.' }))).toBe('Slow down.')
    expect(conflictReasonOf(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'exists' } }))).toBe('exists')
    expect(conflictReasonOf(new HarnessError({ code: 'conflict', message: 'x' }))).toBeNull()
    expect(conflictReasonOf(new HarnessError({ code: 'validation_error', message: 'x', details: { reason: 'exists' } }))).toBeNull()
  })

  it('reads query values and shortens long lines in the middle', () => {
    expect(queryText('a')).toBe('a')
    expect(queryText(['b', 'c'])).toBe('b')
    expect(queryText(undefined)).toBe('')
    expect(queryText(3)).toBe('')
    expect(middleTruncate('short')).toBe('short')
    const long = `github.com/${'a'.repeat(60)}@3f2a9c1`
    const cut = middleTruncate(long, 30)
    expect(cut).toHaveLength(30)
    expect(cut.startsWith('github.com/')).toBe(true)
    expect(cut.endsWith('@3f2a9c1')).toBe(true)
    expect(cut).toContain('…')
  })

  it('runs at most `limit` tasks at a time and swallows their failures', async () => {
    let running = 0
    let peak = 0
    const seen: number[] = []
    await forEachLimited([1, 2, 3, 4, 5, 6, 7], 4, async (item) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 1))
      seen.push(item)
      running -= 1
      if (item === 3)
        throw new Error('boom')
    })
    expect(peak).toBe(4)
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7])
    const task = vi.fn()
    await forEachLimited([], 4, task)
    expect(task).not.toHaveBeenCalled()
  })
})
