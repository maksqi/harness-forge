// The changes panel stubs (docs/UI.md 7.21, 10.5, 13.9; C20, P8-0b): each accepts its frozen props, renders its root
// test id with the documented data attributes and emits its frozen events. W8.8 implements them behind these contracts.
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useChangesPanel } from '~/composables/useChangesPanel'
import { testIds } from '~/utils/testids'
import { changesRow, chatId, projectId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ChangesEmpty from './ChangesEmpty.vue'
import ChangesFileDiff from './ChangesFileDiff.vue'
import ChangesFileRow from './ChangesFileRow.vue'
import ChangesPanel from './ChangesPanel.vue'
import ChangesToggle from './ChangesToggle.vue'
import RevertFileDialog from './RevertFileDialog.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  useChangesPanel().setOpen(false)
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function inTooltips(render: () => ReturnType<typeof h>) {
  return mount(defineComponent({ setup: () => () => h(TooltipProvider, null, { default: render }) }), { attachTo: document.body })
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

describe('changesToggle (stub)', () => {
  it('renders nothing for a chat without a project', () => {
    inTooltips(() => h(ChangesToggle, { chatId: chatId(1), projectId: null }))
    expect(byTestId(testIds.changesToggle)).toBeNull()
  })

  it('renders the toggle of a project chat and toggles the shared panel state, without loading anything', async () => {
    const wrapper = inTooltips(() => h(ChangesToggle, { chatId: chatId(1), projectId: projectId(1) }))
    const toggle = wrapper.get(`[data-testid="${testIds.changesToggle}"]`)
    expect(toggle.attributes()).toMatchObject({ 'data-state': 'closed', 'data-count': '0', 'aria-pressed': 'false', 'aria-label': 'Show changes' })
    await toggle.trigger('click')
    expect(useChangesPanel().open.value).toBe(true)
    expect(toggle.attributes()).toMatchObject({ 'data-state': 'open', 'aria-pressed': 'true', 'aria-label': 'Hide changes' })
    await flushPromises()
    expect(api.changes.list).not.toHaveBeenCalled()
  })
})

describe('changesPanel (stub)', () => {
  it.each(['pane', 'sheet'] as const)('renders its root with the view and emits close (%s)', async (variant) => {
    const closed: string[] = []
    const wrapper = inTooltips(() => h(ChangesPanel, { chatId: chatId(1), projectId: projectId(1), variant, onClose: () => closed.push(variant) }))
    const panel = wrapper.get(`[data-testid="${testIds.changesPanel}"]`)
    expect(panel.attributes()).toMatchObject({ 'data-view': 'chat', 'data-state': 'loading' })
    expect(panel.get('h2').text()).toBe('Changes')
    await panel.get(`[data-testid="${testIds.changesClose}"]`).trigger('click')
    expect(closed).toEqual([variant])
  })
})

describe('changesFileRow (stub)', () => {
  it('renders the row with its data attributes and emits update:open and revert', async () => {
    const row = changesRow({ path: 'src/parser.ts', changedOutside: true })
    const wrapper = mount(ChangesFileRow, { props: { chatId: chatId(1), view: 'chat', row, open: false } })
    const root = wrapper.get(`[data-testid="${testIds.changesFile}"]`)
    expect(root.attributes()).toMatchObject({ 'data-path': 'src/parser.ts', 'data-status': 'modified', 'data-state': 'closed', 'data-conflict': 'true' })
    await root.get('button[aria-expanded]').trigger('click')
    expect(wrapper.emitted('update:open')).toEqual([[true]])
    const revert = root.get(`[data-testid="${testIds.changesFileRevert}"]`)
    expect(revert.attributes()).toMatchObject({ 'data-path': 'src/parser.ts', 'aria-label': 'Revert src/parser.ts' })
    await revert.trigger('click')
    expect(wrapper.emitted('revert')).toEqual([[row]])
    expect(wrapper.find('[data-slot="changes-diff"]').exists()).toBe(false)
  })

  it('shows the diff while open and offers no Revert for a row that is not revertible', () => {
    const wrapper = mount(ChangesFileRow, { props: { chatId: chatId(1), view: 'git', row: changesRow({ status: 'conflicted', revertible: false }), open: true } })
    const root = wrapper.get(`[data-testid="${testIds.changesFile}"]`)
    expect(root.attributes('data-state')).toBe('open')
    expect(root.attributes('data-conflict')).toBeUndefined()
    expect(root.find(`[data-testid="${testIds.changesFileRevert}"]`).exists()).toBe(false)
    expect(wrapper.getComponent(ChangesFileDiff).props()).toEqual({ chatId: chatId(1), view: 'git', path: 'src/index.ts' })
  })
})

describe('changesFileDiff (stub)', () => {
  it('renders the loading frame without fetching', async () => {
    const wrapper = mount(ChangesFileDiff, { props: { chatId: chatId(1), view: 'chat', path: 'src/index.ts' } })
    expect(wrapper.get('[data-slot="changes-diff"]').attributes('data-state')).toBe('loading')
    await flushPromises()
    expect(api.changes.diff).not.toHaveBeenCalled()
  })
})

describe('changesEmpty (stub)', () => {
  it.each([
    ['none', 'No file changes in this chat yet.'],
    ['clean', 'No changes since the last commit.'],
    ['not-a-repo', 'This project isn\'t a Git repository.'],
    ['git-missing', 'Git isn\'t installed on the server.'],
    ['folder-unavailable', 'The project folder wasn\'t found.'],
  ] as const)('renders %s', (reason, text) => {
    const wrapper = mount(ChangesEmpty, { props: { reason } })
    const root = wrapper.get(`[data-testid="${testIds.changesEmpty}"]`)
    expect(root.attributes('data-reason')).toBe(reason)
    expect(root.text()).toBe(text)
  })
})

describe('revertFileDialog (stub)', () => {
  it('is closed without a row, and asks "Revert {name}?" with changes-revert-confirm on the confirm button', async () => {
    const closed = inTooltips(() => h(RevertFileDialog, { open: true, chatId: chatId(1), view: 'chat', row: null }))
    await flushPromises()
    expect(byTestId(testIds.changesRevertConfirm)).toBeNull()
    closed.unmount()

    const updates: boolean[] = []
    inTooltips(() => h(RevertFileDialog, {
      'open': true,
      'chatId': chatId(1),
      'view': 'chat',
      'row': changesRow({ path: 'src/parser.ts' }),
      'expectedSha': null,
      'onUpdate:open': (value: boolean) => updates.push(value),
    }))
    await flushPromises()
    expect(document.body.textContent).toContain('Revert parser.ts?')
    const confirm = byTestId(testIds.changesRevertConfirm)!
    expect(confirm.textContent?.trim()).toBe('Revert file')
    confirm.click()
    expect(updates).toEqual([false])
    expect(api.changes.revert).not.toHaveBeenCalled()
  })
})
