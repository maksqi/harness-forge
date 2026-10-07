import type { DataImportResult } from '@harness-forge/shared'
// DataImportResultPanel, Phase 10 (docs/UI.md 9.8, ADR-044): a backup restore that brought personal definitions back
// says how many were restored, kept and failed; an import without them shows no such line. Phase 11: output styles are
// personal definitions too ("{n} personal definitions restored"). Phase 12: the commands turned off are counted.
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

describe('dataImportResultPanel turned-off line (Phase 12, W12.10-T4)', () => {
  const turnedOff = (r: DataImportResult) => mount(DataImportResultPanel, { props: { result: r } }).find('[data-slot="data-import-turned-off"]')

  it('counts the commands a restore turned off', () => {
    expect(turnedOff(result({ customizations: { imported: 3, skipped: 0, failed: 0, turnedOff: 2 } })).text()).toBe('2 commands turned off (they run shell lines)')
    expect(turnedOff(result({ customizations: { imported: 1, skipped: 0, failed: 0, turnedOff: 1 } })).text()).toBe('1 command turned off (it runs shell lines)')
  })

  it('shows nothing for none and for results without the count', () => {
    expect(turnedOff(result({ customizations: { imported: 3, skipped: 0, failed: 0, turnedOff: 0 } })).exists()).toBe(false)
    expect(turnedOff(result({ customizations: { imported: 3, skipped: 0, failed: 0 } })).exists()).toBe(false)
    expect(turnedOff(result()).exists()).toBe(false)
  })
})
