// The pure rules of the composer's web search toggle (Phase 14, ADR-062, ADR-063; docs/UI.md 7.35, 11.10): the resolver
// call with `mode: 'auto'` (the server's rule), who searches, the tooltip, the toggle's state / mode / reason, the
// announcement, the setup path and the composer's resolver input (open point 5).
import type { WebSearchResolution, WebSearchUnavailableReason } from '@harness-forge/shared'
import type { ComposerWebSearchState } from './web-search'
import { WEB_SEARCH_UNAVAILABLE_REASONS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import {
  composerWebSearchInput,
  WEB_SEARCH_BACKEND_LABELS,
  WEB_SEARCH_REASON_TEXT,
  WEB_SEARCH_SETUP_PATH,
  WEB_SEARCH_SHORTCUT_KEYS,
  webSearchAnnouncement,
  webSearchAvailability,
  webSearchToggleMode,
  webSearchToggleState,
  webSearchTooltip,
  webSearchUnavailableReason,
  webSearchVia,
} from './web-search'

const base: ComposerWebSearchState = { toolMode: 'ask', modelWebSearch: null, modelTools: true, preferNative: true, builtinAvailable: false }

function availability(overrides: Partial<ComposerWebSearchState> = {}): WebSearchResolution {
  return webSearchAvailability(composerWebSearchInput({ ...base, ...overrides }))
}

describe('composer web search rules', () => {
  it('asks the shared resolver what turning search on would do (each reason of the composer)', () => {
    expect(availability({ modelWebSearch: 'native' })).toEqual({ kind: 'native', exclusive: false })
    expect(availability({ builtinAvailable: true })).toEqual({ kind: 'builtin' })
    // The composer counts one function tool while tools are on, so a Gemini 2.x model (exclusive) cannot search natively.
    expect(availability({ modelWebSearch: 'exclusive' })).toEqual({ kind: 'unavailable', reason: 'tools-conflict' })
    expect(availability({ modelWebSearch: 'exclusive', builtinAvailable: true })).toEqual({ kind: 'builtin' })
    expect(availability({ modelTools: false })).toEqual({ kind: 'unavailable', reason: 'tools-unsupported' })
    expect(availability()).toEqual({ kind: 'unavailable', reason: 'no-backend' })
    expect(availability({ toolMode: 'off', modelWebSearch: 'native' })).toEqual({ kind: 'unavailable', reason: 'tool-mode-off' })
    // With the setting off the model's own search is never used.
    expect(availability({ modelWebSearch: 'native', preferNative: false })).toEqual({ kind: 'unavailable', reason: 'no-backend' })
    expect(availability({ modelWebSearch: 'native', preferNative: false, builtinAvailable: true })).toEqual({ kind: 'builtin' })
    // Plan, Accept edits and Auto allow search (read-only).
    for (const toolMode of ['plan', 'edits', 'auto'] as const)
      expect(availability({ toolMode, modelWebSearch: 'native' }).kind).toBe('native')
  })

  it('builds the resolver input of open point 5', () => {
    expect(composerWebSearchInput({ ...base, modelWebSearch: undefined })).toEqual({
      toolMode: 'ask',
      native: null,
      preferNative: true,
      builtinAvailable: false,
      modelTools: true,
      functionTools: 1,
    })
    expect(composerWebSearchInput({ ...base, toolMode: 'off', modelWebSearch: 'exclusive' })).toMatchObject({ native: 'exclusive', functionTools: 0 })
  })

  it('names who searches, and says it in the tooltip with the shortcut while Alt shortcuts are on', () => {
    expect(webSearchVia({ kind: 'native', exclusive: false }, 'Anthropic', 'brave')).toBe('Anthropic')
    expect(webSearchVia({ kind: 'builtin' }, 'Anthropic', 'tavily')).toBe('Tavily')
    expect(webSearchVia({ kind: 'builtin' }, 'Anthropic', null)).toBeNull()
    expect(webSearchVia({ kind: 'unavailable', reason: 'no-backend' }, 'Anthropic', 'brave')).toBeNull()
    expect(WEB_SEARCH_BACKEND_LABELS).toEqual({ brave: 'Brave Search', tavily: 'Tavily', exa: 'Exa' })
    expect(webSearchTooltip(true, 'Brave Search', false)).toBe('Web search on · Brave Search')
    expect(webSearchTooltip(true, null, false)).toBe('Web search on')
    expect(webSearchTooltip(false, 'Anthropic', false)).toBe('Web search off')
    expect(webSearchTooltip(false, null, true)).toBe('Web search off (Alt+W)')
    expect(WEB_SEARCH_SHORTCUT_KEYS).toBe('alt+code:KeyW')
  })

  it('maps the resolution to the toggle\'s data-state, data-mode and reason', () => {
    const unavailable: WebSearchResolution = { kind: 'unavailable', reason: 'tool-mode-off' }
    expect(webSearchToggleState(false, { kind: 'builtin' })).toBe('off')
    expect(webSearchToggleState(true, { kind: 'native', exclusive: true })).toBe('on')
    // A pressed toggle that cannot search stays pressed but reads unavailable.
    expect(webSearchToggleState(true, unavailable)).toBe('unavailable')
    expect(webSearchToggleState(false, { kind: 'off' })).toBe('unavailable')
    expect(webSearchToggleMode({ kind: 'native', exclusive: false })).toBe('native')
    expect(webSearchToggleMode({ kind: 'builtin' })).toBe('builtin')
    expect(webSearchToggleMode(unavailable)).toBeUndefined()
    expect(webSearchUnavailableReason(unavailable)).toBe('tool-mode-off')
    expect(webSearchUnavailableReason({ kind: 'off' })).toBe('no-backend')
    expect(webSearchUnavailableReason({ kind: 'builtin' })).toBeNull()
  })

  it('has the popover text of every reason, the announcements and the setup path', () => {
    expect(Object.keys(WEB_SEARCH_REASON_TEXT).sort()).toEqual([...WEB_SEARCH_UNAVAILABLE_REASONS].sort())
    const reasons: WebSearchUnavailableReason[] = [...WEB_SEARCH_UNAVAILABLE_REASONS]
    for (const reason of reasons)
      expect(WEB_SEARCH_REASON_TEXT[reason].endsWith('.')).toBe(true)
    expect(WEB_SEARCH_REASON_TEXT['no-backend']).toBe('This model has no web search of its own. Add a search key in Settings → Web search.')
    expect(webSearchAnnouncement(true)).toBe('Web search on')
    expect(webSearchAnnouncement(false)).toBe('Web search off')
    expect(WEB_SEARCH_SETUP_PATH).toBe('/settings/search')
  })
})
