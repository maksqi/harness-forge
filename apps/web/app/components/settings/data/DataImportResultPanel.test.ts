import type { DataImportResult } from '@harness-forge/shared'
// DataImportResultPanel, Phase 10 (docs/UI.md 9.8, ADR-044): a backup restore that brought personal definitions back
// says how many were restored, kept and failed; an import without them shows no such line. Phase 11: output styles are
// personal definitions too ("{n} personal definitions restored").
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import DataImportResultPanel from './DataImportResultPanel.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

function result(overrides: Partial<DataImportResult> = {}): DataImportResult {
  return {
    kind: 'backup',
    counts: { imported: 1, copied: 0, skipped: 0, failed: 0, filesImported: 0, filesReused: 0, filesMissing: 0 },
    settingsRestored: true,
    items: [],
    warnings: [],
    ...overrides,
  }
}

const line = (r: DataImportResult) => mount(DataImportResultPanel, { props: { result: r } }).find('[data-slot="data-import-customizations"]')

describe('dataImportResultPanel customizations line', () => {
  it('is absent when nothing was restored', () => {
    expect(line(result()).exists()).toBe(false)
  })

  it('counts restored, kept and failed definitions', () => {
    expect(line(result({ customizations: { imported: 3, skipped: 1, failed: 2 } })).text()).toBe('3 personal definitions restored · 1 kept · 2 failed')
  })

  it('uses the singular for one and leaves out zero counts', () => {
    expect(line(result({ customizations: { imported: 1, skipped: 0, failed: 0 } })).text()).toBe('1 personal definition restored')
  })
})
