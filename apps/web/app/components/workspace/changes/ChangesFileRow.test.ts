// ChangesFileRow (docs/UI.md 7.21, 10.5, 14.2): the accordion button (aria-expanded / aria-controls), the status tile
// with its sr-only text, the path (a rename reads `{origPath} → {path}`), `+a −d` read as diffStatsLabel, the
// "changed outside this chat" mark, Revert (not for rows that are not revertible) and the lazy diff while open.
import type { MockApi } from '~/utils/testing/mock-api'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testIds } from '~/utils/testids'
import { changesRow, chatId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ChangesFileDiff from './ChangesFileDiff.vue'
import ChangesFileRow from './ChangesFileRow.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

// Unmount every tree after each test (before the next one changes the shared panel state).
enableAutoUnmount(afterEach)

describe('changesFileRow', () => {
  it('renders the row with its data attributes and emits update:open and revert', async () => {
    const row = changesRow({ path: 'src/parser.ts', additions: 12, deletions: 3, changedOutside: true })
    const wrapper = mount(ChangesFileRow, { props: { chatId: chatId(1), view: 'chat', row, open: false } })
    const root = wrapper.get(`[data-testid="${testIds.changesFile}"]`)
    expect(root.attributes()).toMatchObject({ 'data-path': 'src/parser.ts', 'data-status': 'modified', 'data-state': 'closed', 'data-conflict': 'true' })
    const button = root.get('button[aria-expanded]')
    expect(button.attributes('aria-expanded')).toBe('false')
    expect(button.attributes('aria-controls')).toBeUndefined()
    expect(button.attributes('title')).toBe('src/parser.ts')
    // The spoken name: status, path, counts, conflict.
    expect(button.text().replace(/\u200E/g, '')).toBe('MModified src/parser.ts+12−3, 12 lines added, 3 removed, changed outside this chat')
    expect(button.get('[data-slot="changes-counts"]').attributes('aria-hidden')).toBe('true')
    expect(button.find('[data-slot="changes-conflict"]').exists()).toBe(true)
    await button.trigger('click')
    expect(wrapper.emitted('update:open')).toEqual([[true]])

    const revert = root.get(`[data-testid="${testIds.changesFileRevert}"]`)
    expect(revert.attributes()).toMatchObject({ 'data-path': 'src/parser.ts', 'aria-label': 'Revert src/parser.ts' })
    expect(revert.classes()).toEqual(expect.arrayContaining(['pointer-coarse:size-10', 'pointer-coarse:opacity-100']))
    await revert.trigger('click')
    expect(wrapper.emitted('revert')).toEqual([[row]])
    expect(wrapper.findComponent(ChangesFileDiff).exists()).toBe(false)
  })

  it('shows the diff while open (aria-controls) and offers no Revert for a row that is not revertible', () => {
    api.changes.diff.mockReturnValue(new Promise(() => {}))
    const wrapper = mount(ChangesFileRow, { props: { chatId: chatId(1), view: 'git', row: changesRow({ status: 'conflicted', revertible: false, additions: null, deletions: null }), open: true } })
    const root = wrapper.get(`[data-testid="${testIds.changesFile}"]`)
    expect(root.attributes('data-state')).toBe('open')
    expect(root.attributes('data-conflict')).toBeUndefined()
    expect(root.find(`[data-testid="${testIds.changesFileRevert}"]`).exists()).toBe(false)
    const button = root.get('button[aria-expanded]')
    expect(button.attributes('aria-expanded')).toBe('true')
    const region = root.get(`#${CSS.escape(button.attributes('aria-controls')!)}`)
    expect(region.findComponent(ChangesFileDiff).props()).toEqual({ chatId: chatId(1), view: 'git', path: 'src/index.ts' })
    expect(button.find('[data-slot="changes-counts"]').exists()).toBe(false)
    expect(button.text()).toContain('Conflicted')
  })

  it('reads a rename as origPath → path, with the status tile of each status', () => {
    const wrapper = mount(ChangesFileRow, { props: { chatId: chatId(1), view: 'git', row: changesRow({ path: 'src/lexer.ts', origPath: 'src/lex.ts', status: 'renamed', additions: null, deletions: null }), open: false } })
    const button = wrapper.get('button[aria-expanded]')
    expect(button.attributes('title')).toBe('src/lex.ts → src/lexer.ts')
    const tile = button.get('[data-slot="changes-status"]')
    expect(tile.classes()).toContain('bg-info/15')
    expect(tile.get('[aria-hidden="true"]').text()).toBe('R')
    expect(tile.get('.sr-only').text()).toBe('Renamed')
  })

  it('shows only the known side of the counts', () => {
    const added = mount(ChangesFileRow, { props: { chatId: chatId(1), view: 'chat', row: changesRow({ status: 'added', additions: 10, deletions: 0 }), open: false } })
    expect(added.get('[data-slot="changes-counts"]').text()).toBe('+10')
    expect(added.text()).toContain('10 lines added')
    const removed = mount(ChangesFileRow, { props: { chatId: chatId(1), view: 'chat', row: changesRow({ status: 'deleted', additions: 0, deletions: 4 }), open: false } })
    expect(removed.get('[data-slot="changes-counts"]').text()).toBe('−4')
    expect(removed.text()).toContain('4 lines removed')
  })
})
