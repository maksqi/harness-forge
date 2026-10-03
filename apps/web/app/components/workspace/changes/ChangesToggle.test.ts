// ChangesToggle (docs/UI.md 7.21, 10.5, 14.2): nothing without a project; the count pill ("9+" above 9), the label,
// aria-pressed / aria-controls and data attributes; it loads the chat's changes once on mount (again after a move to
// another project) and toggles the shared panel state.
import type { MockApi } from '~/utils/testing/mock-api'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useChangesPanel } from '~/composables/useChangesPanel'
import { testIds } from '~/utils/testids'
import { chatChangeFile, chatChanges, chatId, projectId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ChangesToggle from './ChangesToggle.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  stubLocalStorage()
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  useChangesPanel().setOpen(false)
})

afterEach(() => {
  useChangesPanel().setOpen(false)
  disposePinia(pinia)
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

// Unmount every tree after each test (before the next one changes the shared panel state).
enableAutoUnmount(afterEach)

function files(count: number) {
  return Array.from({ length: count }, (_, index) => chatChangeFile({ path: `src/file-${index}.ts` }))
}

function mountToggle(project: string | null = projectId(1)) {
  const projectRef = ref(project)
  const wrapper = mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, { default: () => h(ChangesToggle, { chatId: chatId(1), projectId: projectRef.value }) }),
  }), { attachTo: document.body })
  return { wrapper, projectRef }
}

function toggle(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.changesToggle}"]`)
}

describe('changesToggle', () => {
  it('renders and loads nothing for a chat without a project', async () => {
    mountToggle(null)
    await flushPromises()
    expect(toggle()).toBeNull()
    expect(api.changes.list).not.toHaveBeenCalled()
  })

  it('loads the chat\'s changes once on mount and shows the count', async () => {
    api.changes.list.mockResolvedValue(chatChanges({ files: [...files(3), chatChangeFile({ path: 'same.ts', status: 'unchanged' })] }))
    mountToggle()
    await flushPromises()
    expect(api.changes.list).toHaveBeenCalledTimes(1)
    expect(api.changes.list).toHaveBeenCalledWith({ params: { id: chatId(1) }, signal: expect.any(AbortSignal) })
    const button = toggle()!
    expect(button.dataset).toMatchObject({ state: 'closed', count: '3' })
    expect(button.getAttribute('aria-label')).toBe('Show changes, 3 files changed')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.hasAttribute('aria-controls')).toBe(false)
    const pill = button.querySelector('[data-slot="changes-count"]')!
    expect(pill.textContent?.trim()).toBe('3')
    expect(pill.getAttribute('aria-hidden')).toBe('true')
  })

  it('hides the pill at 0, says "1 file changed" and caps the pill at "9+"', async () => {
    api.changes.list.mockResolvedValueOnce(chatChanges({ files: [] }))
    const first = mountToggle()
    await flushPromises()
    expect(toggle()!.getAttribute('aria-label')).toBe('Show changes')
    expect(toggle()!.querySelector('[data-slot="changes-count"]')).toBeNull()
    first.wrapper.unmount()

    api.changes.list.mockResolvedValueOnce(chatChanges({ files: files(1) }))
    const second = mountToggle()
    await flushPromises()
    expect(toggle()!.getAttribute('aria-label')).toBe('Show changes, 1 file changed')
    second.wrapper.unmount()

    api.changes.list.mockResolvedValueOnce(chatChanges({ files: files(12) }))
    mountToggle()
    await flushPromises()
    expect(toggle()!.dataset.count).toBe('12')
    expect(toggle()!.querySelector('[data-slot="changes-count"]')!.textContent?.trim()).toBe('9+')
  })

  it('toggles the shared panel state: aria-pressed, aria-controls, "Hide changes"', async () => {
    api.changes.list.mockResolvedValue(chatChanges())
    mountToggle()
    await flushPromises()
    toggle()!.click()
    await flushPromises()
    const panel = useChangesPanel()
    expect(panel.open.value).toBe(true)
    expect(panel.focusRequest.value).toBe(0)
    expect(toggle()!.dataset.state).toBe('open')
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true')
    expect(toggle()!.getAttribute('aria-controls')).toBe('hf-changes-panel')
    expect(toggle()!.getAttribute('aria-label')).toBe('Hide changes')
    toggle()!.click()
    await flushPromises()
    expect(panel.open.value).toBe(false)
  })

  it('loads again, forced, when the chat moves to another project; a failed load leaves the toggle usable', async () => {
    api.changes.list.mockRejectedValueOnce(new Error('offline'))
    const { projectRef } = mountToggle()
    await flushPromises()
    expect(toggle()!.dataset.count).toBe('0')
    api.changes.list.mockResolvedValueOnce(chatChanges({ files: files(2), projectId: projectId(2) }))
    projectRef.value = projectId(2)
    await flushPromises()
    expect(api.changes.list).toHaveBeenCalledTimes(2)
    expect(toggle()!.dataset.count).toBe('2')
  })
})
