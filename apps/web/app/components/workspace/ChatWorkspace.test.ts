// ChatWorkspace (docs/UI.md 7.21, 10.5, 12, 14): the always-present ResizablePanelGroup (toggling never remounts the
// chat view), the pane at >= 1024px (handle, <aside> labelled by the panel's h2, px sizes, the stored width restored and
// written only for a user resize), the right sheet below 1024px (never opening by itself), Alt+C (registered with a
// project only, focusing the active view tab), Close returning focus to the toggle, and the palette target.
import type { MockApi } from '~/utils/testing/mock-api'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, onMounted, ref } from 'vue'
import { ResizableHandle, ResizablePanel } from '@/components/ui/resizable'
import { CHANGES_WIDTH_KEY, useChangesPanel } from '~/composables/useChangesPanel'
import { useShortcuts } from '~/composables/useShortcuts'
import { testIds } from '~/utils/testids'
import { chatChanges, chatId, projectId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { useChangesTarget } from './changes/changes-context'
import ChangesPanel from './changes/ChangesPanel.vue'
import ChatWorkspace from './ChatWorkspace.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { custom: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let storage: Storage
let mounts = 0

/** A matchMedia whose `(min-width: 1024px)` answer the test controls. */
function stubViewport(desktop: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>()
  const state = { desktop }
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(min-width: 1024px)' ? state.desktop : false
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  return {
    set(next: boolean) {
      state.desktop = next
      for (const listener of listeners)
        listener({ matches: next })
    },
  }
}

/** The chat view stand-in: counts its mounts and holds the header toggle (focus target). */
const FakeChatView = defineComponent({
  setup() {
    onMounted(() => {
      mounts++
    })
    return () => h('div', { 'data-slot': 'chat-view' }, [h('button', { 'data-testid': testIds.changesToggle }, 'toggle'), h('textarea', { 'data-slot': 'composer' })])
  },
})

function mountWorkspace(project: string | null = projectId(1)) {
  const projectRef = ref(project)
  const wrapper = mount(defineComponent({
    setup: () => () => h(ChatWorkspace, { chatId: chatId(1), projectId: projectRef.value }, { default: () => h(FakeChatView) }),
  }), { attachTo: document.body })
  return { wrapper, projectRef }
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

function pressAltC(target: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', { key: 'ç', code: 'KeyC', altKey: true, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'target', { value: target })
  useShortcuts().handleKeydown(event)
  return event
}

beforeEach(() => {
  storage = stubLocalStorage()
  api = createMockApi()
  mocks.api = api
  api.changes.list.mockResolvedValue(chatChanges())
  pinia = createPinia()
  setActivePinia(pinia)
  mounts = 0
  const panel = useChangesPanel()
  panel.setOpen(false)
  panel.view.value = 'chat'
  panel.width.value = 440
})

afterEach(() => {
  useChangesPanel().setOpen(false)
  disposePinia(pinia)
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

// Unmount every tree after each test (before the next one changes the shared panel state).
enableAutoUnmount(afterEach)

describe('chatWorkspace: layout', () => {
  it('renders only the chat panel without a project: no Alt+C, no palette target', async () => {
    stubViewport(true)
    const { wrapper } = mountWorkspace(null)
    useChangesPanel().setOpen(true)
    await flushPromises()
    expect(wrapper.find('[data-slot="chat-workspace"] [data-slot="chat-view"]').exists()).toBe(true)
    expect(wrapper.findAllComponents(ResizablePanel)).toHaveLength(1)
    expect(byTestId(testIds.changesResize)).toBeNull()
    expect(byTestId(testIds.changesPanel)).toBeNull()
    expect(useShortcuts().list().map(def => def.id)).not.toContain('toggle-changes')
    expect(useChangesTarget().value).toBeNull()
  })

  it('adds the handle and the <aside> pane when open at >= 1024px, without remounting the chat view', async () => {
    stubViewport(true)
    const { wrapper } = mountWorkspace()
    await flushPromises()
    expect(mounts).toBe(1)
    expect(byTestId(testIds.changesPanel)).toBeNull()
    const chatPanel = wrapper.findAllComponents(ResizablePanel)[0]!
    expect(chatPanel.props()).toMatchObject({ order: 1, minSize: 40 })

    useChangesPanel().setOpen(true)
    await flushPromises()
    const handle = byTestId(testIds.changesResize)!
    expect(handle.getAttribute('aria-label')).toBe('Resize changes')
    const aside = document.body.querySelector('aside')!
    expect(aside.getAttribute('aria-labelledby')).toBe('hf-changes-heading')
    expect(aside.querySelector('#hf-changes-heading')?.textContent?.trim()).toBe('Changes')
    expect(wrapper.getComponent(ChangesPanel).props()).toEqual({ chatId: chatId(1), projectId: projectId(1), variant: 'pane' })
    const pane = wrapper.findAllComponents(ResizablePanel)[1]!
    expect(pane.props()).toMatchObject({ order: 2, sizeUnit: 'px', defaultSize: 440, minSize: 320, maxSize: 720 })

    useChangesPanel().setOpen(false)
    await flushPromises()
    expect(document.body.querySelector('aside')).toBeNull()
    expect(byTestId(testIds.changesResize)).toBeNull()
    expect(mounts).toBe(1)
  })

  it('restores the stored width in px and stores only widths the user chose', async () => {
    stubViewport(true)
    useChangesPanel().width.value = 600
    const { wrapper } = mountWorkspace()
    useChangesPanel().setOpen(true)
    await flushPromises()
    const pane = wrapper.findAllComponents(ResizablePanel)[1]!
    expect(pane.props('defaultSize')).toBe(600)

    // The window forced a smaller pane: not stored.
    pane.vm.$emit('resize', 456, 600)
    expect(useChangesPanel().width.value).toBe(600)

    // A drag.
    const handle = wrapper.getComponent(ResizableHandle)
    handle.vm.$emit('dragging', true)
    pane.vm.$emit('resize', 512.4, 456)
    handle.vm.$emit('dragging', false)
    expect(useChangesPanel().width.value).toBe(512)
    expect(storage.getItem(CHANGES_WIDTH_KEY)).toBe('512')

    // Arrow keys on the focused handle.
    byTestId(testIds.changesResize)!.dispatchEvent(new FocusEvent('focus'))
    pane.vm.$emit('resize', 900, 512)
    expect(useChangesPanel().width.value).toBe(720)
    byTestId(testIds.changesResize)!.dispatchEvent(new FocusEvent('blur'))
    pane.vm.$emit('resize', 400, 720)
    expect(useChangesPanel().width.value).toBe(720)
  })

  it('uses a right sheet below 1024px, never opening by itself', async () => {
    useChangesPanel().setOpen(true)
    const viewport = stubViewport(false)
    const { wrapper } = mountWorkspace()
    await flushPromises()
    // A stored "open" from a wide window does not cover the chat on a phone.
    expect(useChangesPanel().open.value).toBe(false)
    expect(byTestId(testIds.changesPanel)).toBeNull()

    useChangesPanel().setOpen(true)
    await flushPromises()
    const content = document.body.querySelector<HTMLElement>('[data-slot="sheet-content"]')!
    expect(content.dataset.side).toBe('right')
    expect(content.className).toContain('data-[side=right]:w-full')
    expect(content.className).toContain('data-[side=right]:sm:max-w-lg')
    expect(content.getAttribute('aria-labelledby')).toBe('hf-changes-heading')
    expect(content.querySelector('[data-slot="sheet-close"]')).toBeNull()
    expect(wrapper.getComponent(ChangesPanel).props('variant')).toBe('sheet')
    expect(document.body.querySelector('aside')).toBeNull()
    expect(mounts).toBe(1)

    // Close: the panel closes and focus returns to the toggle.
    byTestId(testIds.changesClose)!.click()
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(useChangesPanel().open.value).toBe(false)
    expect(document.activeElement).toBe(byTestId(testIds.changesToggle))

    // Narrowing the window closes an open pane instead of turning it into a modal sheet.
    viewport.set(true)
    useChangesPanel().setOpen(true)
    await flushPromises()
    expect(document.body.querySelector('aside')).not.toBeNull()
    viewport.set(false)
    await flushPromises()
    expect(useChangesPanel().open.value).toBe(false)
  })
})

describe('chatWorkspace: Alt+C, Close and the palette target', () => {
  it('registers Alt+C with a project, opens with focus on the active tab and closes again', async () => {
    stubViewport(true)
    const { projectRef, wrapper } = mountWorkspace()
    await flushPromises()
    const def = useShortcuts().list().find(item => item.id === 'toggle-changes')!
    expect(def).toMatchObject({ keys: 'alt+code:KeyC', group: 'Chat', alt: true, allowInInputs: true, description: 'Show or hide changes' })
    expect(useChangesTarget().value).toEqual({ chatId: chatId(1), projectId: projectId(1) })

    const composer = document.body.querySelector('textarea')!
    composer.focus()
    const event = pressAltC(composer)
    expect(event.defaultPrevented).toBe(true)
    await flushPromises()
    expect(useChangesPanel().open.value).toBe(true)
    const activeTab = document.body.querySelector(`[data-testid="${testIds.changesViewOption}"][data-state="active"]`)
    expect(document.activeElement).toBe(activeTab)

    // Alt+C from inside the pane closes it and returns focus to the toggle.
    pressAltC(activeTab!)
    await flushPromises()
    expect(useChangesPanel().open.value).toBe(false)
    expect(document.activeElement).toBe(byTestId(testIds.changesToggle))

    projectRef.value = null
    await flushPromises()
    expect(useShortcuts().list().map(item => item.id)).not.toContain('toggle-changes')
    expect(useChangesTarget().value).toBeNull()
    projectRef.value = projectId(2)
    await flushPromises()
    expect(useChangesTarget().value).toEqual({ chatId: chatId(1), projectId: projectId(2) })
    wrapper.unmount()
    expect(useShortcuts().list().map(item => item.id)).not.toContain('toggle-changes')
    expect(useChangesTarget().value).toBeNull()
  })

  it('leaves Alt+C to another open dialog, and obeys the altShortcuts setting', async () => {
    stubViewport(true)
    mountWorkspace()
    await flushPromises()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const input = document.createElement('input')
    dialog.append(input)
    document.body.append(dialog)
    input.focus()
    expect(pressAltC(input).defaultPrevented).toBe(false)
    expect(useChangesPanel().open.value).toBe(false)

    const registry = useShortcuts()
    registry.setAltEnabled(() => false)
    try {
      expect(pressAltC().defaultPrevented).toBe(false)
      expect(useChangesPanel().open.value).toBe(false)
    }
    finally {
      registry.setAltEnabled(() => true)
    }
  })

  it('close in the pane closes it and returns focus to the toggle; a toggle click keeps focus where it is', async () => {
    stubViewport(true)
    mountWorkspace()
    await flushPromises()
    const toggle = byTestId(testIds.changesToggle)!
    toggle.focus()
    useChangesPanel().toggle()
    await flushPromises()
    expect(document.activeElement).toBe(toggle)

    byTestId(testIds.changesClose)!.focus()
    byTestId(testIds.changesClose)!.click()
    await flushPromises()
    expect(useChangesPanel().open.value).toBe(false)
    expect(document.activeElement).toBe(toggle)
    await nextTick()
  })
})
