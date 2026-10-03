import type { QueueItem } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { messageId, queueItem } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import QueuedMessages from './QueuedMessages.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => createMockApi() }))

let pinia: ReturnType<typeof createPinia>

const first = queueItem()
const second = queueItem({ id: messageId('queued2'), text: 'Check the lexer too\nand the parser' })
const third = queueItem({ id: messageId('queued3'), text: '/compact keep numbers', turnOnly: true })
const withFiles = queueItem({
  id: messageId('queued4'),
  message: {
    id: messageId('queued4'),
    role: 'user',
    parts: [
      { type: 'text', text: 'See the screenshots' },
      { type: 'file', mediaType: 'image/png', filename: 'a.png', url: '/api/files/file_a000000000000000' },
      { type: 'file', mediaType: 'image/png', filename: 'b.png', url: '/api/files/file_b000000000000000' },
    ],
  },
})

interface State {
  items: QueueItem[]
  waitingForApproval: boolean
  cancelling: string[]
}

function mountQueue(initial: Partial<State> = {}) {
  const state = reactive<State>({ items: [first, second], waitingForApproval: false, cancelling: [], ...initial })
  const events = { cancel: [] as string[], edit: [] as string[] }
  const wrapper = mount({
    render: () => h(TooltipProvider, null, {
      default: () => h(QueuedMessages, {
        items: state.items,
        waitingForApproval: state.waitingForApproval,
        cancelling: state.cancelling,
        onCancel: (id: string) => events.cancel.push(id),
        onEdit: (id: string) => events.edit.push(id),
      }),
    }),
  }, { attachTo: document.body, global: { plugins: [pinia] } })
  const root = () => wrapper.find(`[data-testid="${testIds.queuedMessages}"]`)
  const rows = () => wrapper.findAll(`[data-testid="${testIds.queuedMessage}"]`)
  const cancelButtons = () => wrapper.findAll<HTMLButtonElement>(`[data-testid="${testIds.queuedMessageCancel}"]`)
  const editButtons = () => wrapper.findAll<HTMLButtonElement>(`[data-testid="${testIds.queuedMessageEdit}"]`)
  return { wrapper, state, events, root, rows, cancelButtons, editButtons }
}

/** A matchMedia that answers `(max-width: 767px)` with `phone`. */
function stubPhone(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 767px)' ? phone : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

describe('queuedMessages', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    disposePinia(pinia)
    document.body.replaceChildren()
  })

  it('lists the queued messages with the header, the first line, files and server commands', () => {
    const { wrapper, root, rows } = mountQueue({ items: [first, second, third, withFiles] })
    expect(root().attributes()).toMatchObject({ 'data-count': '4', 'data-state': 'queued' })
    expect(root().text()).toContain('Queued · 4 · sent at the next step')
    expect(wrapper.get('ul').attributes('aria-label')).toBe('Queued messages')
    expect(rows().map(row => [row.attributes('data-message-id'), row.attributes('data-state')])).toEqual([
      [first.id, 'queued'],
      [second.id, 'queued'],
      [third.id, 'queued'],
      [withFiles.id, 'queued'],
    ])
    expect(rows()[0]!.text()).toContain('Also update the README')
    // Only the first line of the text.
    expect(rows()[1]!.text()).toContain('Check the lexer too')
    expect(rows()[1]!.text()).not.toContain('and the parser')
    expect(rows()[2]!.text()).toContain('Runs after this response')
    expect(rows()[0]!.text()).not.toContain('Runs after this response')
    expect(rows()[3]!.text()).toContain('2 files attached')
    expect(rows()[3]!.text()).toContain('See the screenshots')
    const edit = rows()[0]!.get(`[data-testid="${testIds.queuedMessageEdit}"]`)
    const cancel = rows()[0]!.get(`[data-testid="${testIds.queuedMessageCancel}"]`)
    expect(edit.attributes('aria-label')).toBe('Edit queued message')
    expect(cancel.attributes('aria-label')).toBe('Cancel queued message')
    wrapper.unmount()
  })

  it('says when the messages wait for an approval', () => {
    const { wrapper, root } = mountQueue({ waitingForApproval: true })
    expect(root().attributes('data-state')).toBe('approval')
    expect(root().text()).toContain('Sent after you answer the approval')
    expect(root().text()).not.toContain('sent at the next step')
    wrapper.unmount()
  })

  it('emits edit and cancel with the message id; a cancelling row shows a spinner and blocks both', async () => {
    const { wrapper, state, events, rows, cancelButtons, editButtons } = mountQueue()
    await editButtons()[1]!.trigger('click')
    await cancelButtons()[0]!.trigger('click')
    expect(events).toEqual({ edit: [second.id], cancel: [first.id] })

    state.cancelling = [first.id]
    await nextTick()
    expect(rows()[0]!.attributes()).toMatchObject({ 'data-state': 'cancelling', 'aria-busy': 'true' })
    expect(rows()[0]!.find('.animate-spin').exists()).toBe(true)
    expect(cancelButtons()[0]!.attributes('aria-disabled')).toBe('true')
    expect(editButtons()[0]!.attributes('aria-disabled')).toBe('true')
    await cancelButtons()[0]!.trigger('click')
    await editButtons()[0]!.trigger('click')
    expect(events).toEqual({ edit: [second.id], cancel: [first.id] })
    expect(rows()[1]!.attributes('data-state')).toBe('queued')
    wrapper.unmount()
  })

  it('after a cancel moves focus to the next row\'s Cancel, else the previous one, else the textarea', async () => {
    const { wrapper, state, cancelButtons } = mountQueue({ items: [first, second, third] })
    cancelButtons()[0]!.element.focus()
    await cancelButtons()[0]!.trigger('click')
    state.items = [second, third]
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(cancelButtons()[0]!.element)
    expect(cancelButtons()[0]!.element.closest('li')!.dataset.messageId).toBe(second.id)

    cancelButtons()[1]!.element.focus()
    await cancelButtons()[1]!.trigger('click')
    state.items = [second]
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(cancelButtons()[0]!.element)

    const ui = useUiStore()
    const before = ui.composerFocusRequest
    await cancelButtons()[0]!.trigger('click')
    // The cancel is still in flight: nothing moves yet.
    state.cancelling = [second.id]
    await nextTick()
    expect(ui.composerFocusRequest).toBe(before)
    state.items = []
    state.cancelling = []
    await nextTick()
    await nextTick()
    expect(ui.composerFocusRequest).toBe(before + 1)
    wrapper.unmount()
  })

  it('leaves the focus alone when it is elsewhere', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    const { wrapper, state, cancelButtons } = mountQueue()
    await cancelButtons()[0]!.trigger('click')
    outside.focus()
    state.items = [second]
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(outside)
    wrapper.unmount()
  })

  it('on phones shows two rows, then "Show {n} more"', async () => {
    stubPhone(true)
    const { wrapper, state, rows } = mountQueue({ items: [first, second, third, withFiles] })
    expect(rows()).toHaveLength(2)
    const more = wrapper.get('[data-slot="queued-messages-more"]')
    expect(more.text()).toBe('Show 2 more')
    await more.trigger('click')
    expect(rows()).toHaveLength(4)
    expect(wrapper.find('[data-slot="queued-messages-more"]').exists()).toBe(false)

    state.items = [first]
    await nextTick()
    state.items = [first, second, third]
    await nextTick()
    expect(rows()).toHaveLength(2)
    expect(wrapper.get('[data-slot="queued-messages-more"]').text()).toBe('Show 1 more')
    wrapper.unmount()
  })

  it('shows every row on wider screens', () => {
    stubPhone(false)
    const { wrapper, rows } = mountQueue({ items: [first, second, third, withFiles] })
    expect(rows()).toHaveLength(4)
    expect(wrapper.find('[data-slot="queued-messages-more"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders nothing while the queue is empty', () => {
    const { wrapper, root } = mountQueue({ items: [] })
    expect(root().exists()).toBe(false)
    wrapper.unmount()
  })
})
