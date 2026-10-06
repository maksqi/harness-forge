// The data-testid contract (docs/UI.md 13): every id is unique, its key is the camelCase of the id, and the Phase 12 group
// (UI.md 13.13, C46-T1) holds its 70 ids after the Phase 11 group.
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

  it('ends with the 70 ids of the Claude Code ecosystem (Phase 12)', () => {
    const keys = Object.keys(testIds)
    const phase12 = keys.slice(keys.indexOf('pluginHook') + 1)
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
})
