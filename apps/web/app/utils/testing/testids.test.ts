// The data-testid contract (docs/UI.md 13): every id is unique, its key is the camelCase of the id, the Phase 12 group
// (UI.md 13.13, C46-T1) holds its 70 ids after the Phase 11 group, and the Phase 14 group (UI.md 13.14, C54-T1) its 45
// ids after the Phase 12 group.
import { describe, expect, it } from 'vitest'
import { testIds } from '../testids'

function camelCase(id: string): string {
  return id.replace(/-([a-z\d])/g, (_, char: string) => char.toUpperCase())
}

describe('testIds', () => {
  it('has unique kebab-case ids keyed by their camelCase', () => {
    const entries = Object.entries(testIds)
    expect(new Set(entries.map(([, id]) => id)).size).toBe(entries.length)
    for (const [key, id] of entries) {
      expect(id, key).toMatch(/^[a-z][a-z\d]*(?:-[a-z\d]+)*$/)
      expect(key, id).toBe(camelCase(id))
    }
  })

  it('holds the 70 ids of the Claude Code ecosystem (Phase 12)', () => {
    const keys = Object.keys(testIds)
    const phase12 = keys.slice(keys.indexOf('pluginHook') + 1, keys.indexOf('customizationForkAgent') + 1)
    expect(phase12).toHaveLength(70)
    expect(phase12[0]).toBe('pluginsMarketplaces')
    expect(phase12.at(-1)).toBe('customizationForkAgent')
    expect(phase12).toEqual(expect.arrayContaining([
      'marketplaceInstallDialog',
      'installTabGithub',
      'pluginUpdateAvailable',
      'claudeImportDialog',
      'claudeImportSelectAll',
      'projectFileEditor',
      'projectFileDiscardConfirm',
      'hookType',
      'hookPrompt',
      'settingsHookModel',
      'settingsModelAlias',
    ]))
  })

  it('ends with the 45 ids of MCP 2.0 and web search (Phase 14, UI.md 13.14)', () => {
    const keys = Object.keys(testIds)
    const phase14 = keys.slice(keys.indexOf('customizationForkAgent') + 1)
    expect(phase14).toHaveLength(45)
    expect(phase14[0]).toBe('mcpSignIn')
    expect(phase14.at(-1)).toBe('settingsSearchTestResult')
    expect(phase14.map(key => testIds[key as keyof typeof testIds])).toEqual([
      'mcp-sign-in',
      'mcp-sign-out',
      'mcp-sign-in-error',
      'mcp-oauth-section',
      'mcp-oauth-client-id',
      'mcp-oauth-client-secret',
      'mcp-oauth-scopes',
      'mcp-oauth-redirect-uri',
      'project-mcp-sign-in',
      'project-mcp-sign-out',
      'oauth-callback',
      'oauth-callback-error',
      'oauth-callback-retry',
      'oauth-callback-back',
      'mention-menu-section',
      'mention-menu-resource',
      'elicitation-card',
      'elicitation-message',
      'elicitation-field',
      'elicitation-field-error',
      'elicitation-submit',
      'elicitation-decline',
      'elicitation-dismiss',
      'elicitation-countdown',
      'elicitation-result',
      'elicitation-jump',
      'composer-web-search',
      'web-search-unavailable',
      'web-search-setup',
      'web-search-tool',
      'web-search-result',
      'sources-chip',
      'source-item',
      'settings-nav-search',
      'web-search-settings',
      'settings-search-native',
      'settings-search-default',
      'settings-search-backend',
      'settings-search-key',
      'settings-search-key-input',
      'settings-search-key-save',
      'settings-search-key-remove',
      'settings-search-max-results',
      'settings-search-test',
      'settings-search-test-result',
    ])
  })
})
