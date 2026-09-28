import type { Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import ChatHeader from './ChatHeader.vue'

const mock = vi.hoisted(() => ({
  rename: null as unknown as Mock,
  exportChat: null as unknown as Mock,
  remove: null as unknown as Mock,
}))

vi.mock('~/components/app-shell/chat-nav/chat-actions', () => ({
  useChatActions: () => ({ rename: mock.rename, exportChat: mock.exportChat, remove: mock.remove }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => ({}), useApiFetch: () => vi.fn() }))

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'

function mountHeader(props: { title: string | null, scrolled?: boolean, loading?: boolean }) {
  return mount({
    render: () => h(SidebarProvider, null, {
      default: () => h(TooltipProvider, null, { default: () => h(ChatHeader, { chatId: CHAT_ID, ...props }) }),
    }),
  }, { attachTo: document.body })
}

async function openMenu(wrapper: ReturnType<typeof mountHeader>) {
  const trigger = wrapper.get(`[data-testid="${testIds.chatMenuTrigger}"]`)
  await trigger.trigger('pointerdown', { button: 0, ctrlKey: false, pointerType: 'mouse' })
  await flushPromises()
  if (!document.body.querySelector(`[data-testid="${testIds.chatMenuRename}"]`)) {
    await trigger.trigger('keydown', { key: 'Enter' })
    await flushPromises()
  }
}

function menuItem(testId: string): HTMLElement {
  const item = document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  expect(item, testId).not.toBeNull()
  return item!
}

beforeEach(() => {
  mock.rename = vi.fn(async () => true)
  mock.exportChat = vi.fn(async () => {})
  mock.remove = vi.fn()
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('chatHeader', () => {
  it('shows the title and a border only once the transcript scrolled', () => {
    const top = mountHeader({ title: 'Refactor auth flow' })
    const header = top.get(`[data-testid="${testIds.chatHeader}"]`)
    expect(header.attributes('data-scrolled')).toBe('false')
    expect(header.classes()).toContain('border-transparent')
    expect(top.get(`[data-testid="${testIds.chatTitle}"]`).text()).toBe('Refactor auth flow')

    const scrolled = mountHeader({ title: 'Refactor auth flow', scrolled: true })
    expect(scrolled.get(`[data-testid="${testIds.chatHeader}"]`).classes()).toContain('border-border')
  })

  it('shows "New chat" for an untitled chat, but nothing while it loads', () => {
    expect(mountHeader({ title: null }).get(`[data-testid="${testIds.chatTitle}"]`).text()).toBe('New chat')
    expect(mountHeader({ title: null, loading: true }).get(`[data-testid="${testIds.chatTitle}"]`).text()).toBe('')
  })

  it('renames inline from the title', async () => {
    const wrapper = mountHeader({ title: 'Old title' })
    await wrapper.get(`[data-testid="${testIds.chatTitle}"]`).trigger('click')
    const input = wrapper.get<HTMLInputElement>(`[data-testid="${testIds.chatTitleInput}"]`)
    expect(input.element.value).toBe('Old title')
    await input.setValue('New title')
    await input.trigger('keydown', { key: 'Enter' })
    expect(mock.rename).toHaveBeenCalledWith(CHAT_ID, 'New title')
    expect(wrapper.find(`[data-testid="${testIds.chatTitleInput}"]`).exists()).toBe(false)
  })

  it('offers Show thinking, exports and delete in the menu', async () => {
    const wrapper = mountHeader({ title: 'Chat' })
    const ui = useUiStore()
    expect(ui.showThinking).toBe(false)

    await openMenu(wrapper)
    const thinking = menuItem(testIds.chatMenuThinking)
    expect(thinking.getAttribute('data-state')).toBe('unchecked')
    thinking.click()
    await flushPromises()
    expect(ui.showThinking).toBe(true)

    await openMenu(wrapper)
    menuItem(testIds.chatMenuExportMd).click()
    await flushPromises()
    expect(mock.exportChat).toHaveBeenCalledWith(CHAT_ID, 'md')

    await openMenu(wrapper)
    menuItem(testIds.chatMenuDelete).click()
    await flushPromises()
    expect(mock.remove).toHaveBeenCalledWith(CHAT_ID)
  })
})
