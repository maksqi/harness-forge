// ChatProjectChip (docs/UI.md 7.20, 10.4; W7.9-T4): nothing for a null or unknown project, else the chip with data-value
// and data-state ok | missing; its menu moves the chat through useMoveChat and links to Settings -> Projects.
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NuxtLinkStub } from '~/components/app-shell/chat-nav/testing'
import { useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { chatId, chatSummary, projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ChatProjectChip from './ChatProjectChip.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { custom: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.toast.custom.mockReset()
  stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
  const projects = useProjectsStore()
  projects.items = [
    projectSummary({ id: projectId(1), name: 'Website' }),
    projectSummary({ id: projectId(2), name: 'Old', path: '/srv/workspaces/old', available: false, issue: 'The folder does not exist.' }),
  ]
  projects.loaded = true
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const root = `[data-testid="${testIds.chatProjectChip}"]`

function mountChip(project: string | null) {
  return mount(ChatProjectChip, {
    props: { chatId: chatId(1), projectId: project },
    attachTo: document.body,
    global: { plugins: [pinia], stubs: { NuxtLink: NuxtLinkStub } },
  })
}

describe('chatProjectChip', () => {
  it('renders nothing for a chat without a project or with an unknown one', () => {
    const none = mountChip(null)
    expect(none.find(root).exists()).toBe(false)
    none.unmount()
    const unknown = mountChip(projectId(9))
    expect(unknown.find(root).exists()).toBe(false)
    unknown.unmount()
  })

  it('shows the project name with data-state ok, or the warning icon and missing when the folder is gone', () => {
    const ok = mountChip(projectId(1))
    const chip = ok.get(root)
    expect(chip.attributes('data-value')).toBe(projectId(1))
    expect(chip.attributes('data-state')).toBe('ok')
    expect(chip.attributes('aria-label')).toBe('Project: Website')
    expect(chip.attributes('aria-haspopup')).toBe('menu')
    expect(chip.text()).toContain('Website')
    // Icon-only below sm, the name stays for screen readers through the label.
    expect(chip.get('span.truncate').classes()).toContain('max-sm:sr-only')
    expect(chip.classes()).toContain('max-w-56')
    expect(ok.props()).toEqual({ chatId: chatId(1), projectId: projectId(1) })
    ok.unmount()

    const missing = mountChip(projectId(2))
    expect(missing.get(root).attributes('data-state')).toBe('missing')
    expect(missing.get(root).attributes('aria-label')).toBe('Project: Old, folder not found')
    expect(missing.find('svg.text-warning').exists()).toBe(true)
    missing.unmount()
  })

  it('opens a menu with the move items (the current project checked) and Project settings; a pick moves the chat', async () => {
    api.chats.list.mockResolvedValueOnce({ items: [chatSummary({ id: chatId(1), projectId: projectId(1) })], nextCursor: null })
    await useChatsStore().fetchPage()
    const wrapper = mountChip(projectId(1))
    wrapper.get(root).element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    const options = [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.projectOption}"]`)]
    expect(options.map(option => [option.dataset.value, option.dataset.state])).toEqual([
      ['none', 'unchecked'],
      [projectId(2), 'unchecked'],
      [projectId(1), 'checked'],
    ])
    const settings = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Project settings'))
    expect(settings?.getAttribute('href')).toBe('/settings/projects')

    api.chats.update.mockResolvedValueOnce(chatSummary({ id: chatId(1), projectId: null }))
    options[0]!.click()
    await flushPromises()
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { projectId: null } })
    expect((mocks.toast.custom.mock.lastCall?.[1] as { componentProps: { title: string } }).componentProps.title).toBe('Moved out of Website')
    wrapper.unmount()
  })
})
