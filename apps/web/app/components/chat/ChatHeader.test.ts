import type { Mock } from 'vitest'
import { createServerEvent } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick } from 'vue'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useProjectTrustStore } from '~/stores/project-trust'
import { useProjectsStore } from '~/stores/projects'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary } from '~/utils/testing/fixtures'
import ChatHeader from './ChatHeader.vue'

const mock = vi.hoisted(() => ({
  rename: null as unknown as Mock,
  exportChat: null as unknown as Mock,
  remove: null as unknown as Mock,
  move: null as unknown as Mock,
}))

vi.mock('~/components/app-shell/chat-nav/chat-actions', () => ({
  useChatActions: () => ({ rename: mock.rename, exportChat: mock.exportChat, remove: mock.remove }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => ({}), useApiFetch: () => vi.fn() }))
// The move action and the project components belong to W7.9; these stand-ins keep their frozen contracts (docs/UI.md
// 10.4, 11.4).
vi.mock('~/components/projects/move-chat', () => ({ useMoveChat: () => mock.move }))
vi.mock('~/components/projects/ChatProjectChip.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      name: 'ChatProjectChip',
      props: { chatId: { type: String, required: true }, projectId: { type: String, default: null } },
      setup: props => () => render('button', { 'type': 'button', 'data-testid': 'chat-project-chip', 'data-chat-id': props.chatId, 'data-value': props.projectId }),
    }),
  }
})
vi.mock('~/components/projects/ProjectMenuItems.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  const { DropdownMenuCheckboxItem } = await import('@/components/ui/dropdown-menu')
  const { useProjectsStore: projectsStore } = await import('~/stores/projects')
  return {
    default: define({
      name: 'ProjectMenuItems',
      props: { modelValue: { type: String, default: null }, includeNone: { type: Boolean, default: true } },
      emits: ['select'],
      setup(props, { emit }) {
        const projects = projectsStore()
        const item = (value: string | null, label: string) => render(DropdownMenuCheckboxItem, {
          'modelValue': props.modelValue === value,
          'data-testid': 'project-option',
          'data-value': value ?? 'none',
          'onSelect': () => emit('select', value),
        }, () => label)
        return () => [
          ...(props.includeNone ? [item(null, 'No project')] : []),
          ...projects.items.map(project => item(project.id, project.name)),
        ]
      },
    }),
  }
})

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'

/** Unmounted after each test, so an open menu never outlives its test. */
const mounted: Array<{ unmount: () => void }> = []

function mountHeader(props: { title: string | null, scrolled?: boolean, loading?: boolean, projectId?: string | null }) {
  const wrapper = mount({
    render: () => h(SidebarProvider, null, {
      default: () => h(TooltipProvider, null, { default: () => h(ChatHeader, { chatId: CHAT_ID, ...props }) }),
    }),
  }, { attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
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
  mock.move = vi.fn(async () => {})
  setActivePinia(createPinia())
})

afterEach(() => {
  for (const wrapper of mounted.splice(0))
    wrapper.unmount()
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

  it('lists Share… after Show thinking', async () => {
    const wrapper = mountHeader({ title: 'Chat' })
    await openMenu(wrapper)
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'))
    expect(items.map(item => item.textContent?.trim())).toEqual([
      'Rename',
      'Show thinking',
      'Share…',
      'Export as Markdown',
      'Export as JSON',
      'Delete',
    ])
  })

  it('opens the Share dialog for this chat once the menu closed and its trigger has focus again', async () => {
    const wrapper = mountHeader({ title: 'Chat' })
    const ui = useUiStore()
    await openMenu(wrapper)
    menuItem(testIds.chatMenuShare).click()
    for (let round = 0; round < 5; round++) {
      await flushPromises()
      await nextTick()
    }
    expect(document.body.querySelector(`[data-testid="${testIds.chatMenuShare}"]`)).toBeNull()
    expect(ui.shareChatId).toBe(CHAT_ID)
    // The Share dialog returns focus to whatever had it when it opened: the menu trigger.
    expect(document.activeElement).toBe(wrapper.get(`[data-testid="${testIds.chatMenuTrigger}"]`).element)
    expect(mock.rename).not.toHaveBeenCalled()
    expect(wrapper.find(`[data-testid="${testIds.chatTitleInput}"]`).exists()).toBe(false)
  })

  it('shows the project chip between the title and the menu only while the chat has a project', () => {
    expect(mountHeader({ title: 'Chat' }).find(`[data-testid="${testIds.chatProjectChip}"]`).exists()).toBe(false)
    expect(mountHeader({ title: 'Chat', projectId: null }).find(`[data-testid="${testIds.chatProjectChip}"]`).exists()).toBe(false)

    const wrapper = mountHeader({ title: 'Chat', projectId: projectId(1) })
    const chip = wrapper.get(`[data-testid="${testIds.chatProjectChip}"]`)
    expect(chip.attributes()).toMatchObject({ 'data-chat-id': CHAT_ID, 'data-value': projectId(1) })
    const order = [...wrapper.get(`[data-testid="${testIds.chatHeader}"]`).element.querySelectorAll('[data-testid]')].map(node => node.getAttribute('data-testid'))
    expect(order.indexOf(testIds.chatTitle)).toBeLessThan(order.indexOf(testIds.chatProjectChip))
    expect(order.indexOf(testIds.chatProjectChip)).toBeLessThan(order.indexOf(testIds.chatMenuTrigger))
  })

  it('mounts the changes toggle between the project chip and the menu, only in a project chat (Phase 8)', () => {
    expect(mountHeader({ title: 'Chat', projectId: null }).find(`[data-testid="${testIds.changesToggle}"]`).exists()).toBe(false)

    const wrapper = mountHeader({ title: 'Chat', projectId: projectId(1) })
    const toggle = wrapper.get(`[data-testid="${testIds.changesToggle}"]`)
    expect(toggle.attributes()).toMatchObject({ 'data-state': 'closed', 'data-count': '0', 'aria-label': 'Show changes' })
    const order = [...wrapper.get(`[data-testid="${testIds.chatHeader}"]`).element.querySelectorAll('[data-testid]')].map(node => node.getAttribute('data-testid'))
    expect(order.indexOf(testIds.chatProjectChip)).toBeLessThan(order.indexOf(testIds.changesToggle))
    expect(order.indexOf(testIds.changesToggle)).toBeLessThan(order.indexOf(testIds.chatMenuTrigger))
  })
})

describe('chatHeader: project trust chip (Phase 11, P11-0b mount)', () => {
  it('shows the trust chip right after the project chip while the project has items to review', async () => {
    const wrapper = mountHeader({ title: 'Chat', projectId: projectId(1) })
    expect(wrapper.find(`[data-testid="${testIds.projectTrustChip}"]`).exists()).toBe(false)
    useProjectTrustStore().applyEvent(createServerEvent('project-trust.changed', { projectId: projectId(1), pending: 2 }, 1))
    await nextTick()
    expect(wrapper.get(`[data-testid="${testIds.projectTrustChip}"]`).attributes('data-count')).toBe('2')
    const order = [...wrapper.get(`[data-testid="${testIds.chatHeader}"]`).element.querySelectorAll('[data-testid]')].map(node => node.getAttribute('data-testid'))
    expect(order.indexOf(testIds.chatProjectChip)).toBeLessThan(order.indexOf(testIds.projectTrustChip))
    expect(order.indexOf(testIds.projectTrustChip)).toBeLessThan(order.indexOf(testIds.chatMenuTrigger))
    expect(mountHeader({ title: 'Chat', projectId: null }).find(`[data-testid="${testIds.projectTrustChip}"]`).exists()).toBe(false)
  })
})

describe('chatHeader: move to project', () => {
  const P1 = projectId(1)
  const P2 = projectId(2)

  function withProjects() {
    useProjectsStore().items = [projectSummary({ id: P1, name: 'Website' }), projectSummary({ id: P2, name: 'Notes', path: '/srv/workspaces/notes' })]
  }

  async function openMove(wrapper: ReturnType<typeof mountHeader>) {
    await openMenu(wrapper)
    menuItem(testIds.chatMenuMove).click()
    for (let round = 0; round < 3 && !document.body.querySelector(`[data-testid="${testIds.projectOption}"]`); round++) {
      await flushPromises()
      await nextTick()
    }
  }

  function options(): HTMLElement[] {
    return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.projectOption}"]`)]
  }

  it('lists Move to project right after Rename while a project exists', async () => {
    withProjects()
    const wrapper = mountHeader({ title: 'Chat' })
    await openMenu(wrapper)
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'))
    expect(items.map(item => item.textContent?.trim())).toEqual([
      'Rename',
      'Move to project',
      'Show thinking',
      'Share…',
      'Export as Markdown',
      'Export as JSON',
      'Delete',
    ])
    expect(menuItem(testIds.chatMenuMove).getAttribute('aria-haspopup')).toBe('menu')
  })

  it('offers no move without any project', async () => {
    const wrapper = mountHeader({ title: 'Chat' })
    await openMenu(wrapper)
    expect(document.body.querySelector(`[data-testid="${testIds.chatMenuMove}"]`)).toBeNull()
  })

  it('moves the chat through useMoveChat: into a project, and out of it', async () => {
    withProjects()
    const wrapper = mountHeader({ title: 'Chat', projectId: P1 })
    await openMove(wrapper)
    expect(options().map(option => option.getAttribute('data-value'))).toEqual(['none', P1, P2])
    // The current project is checked.
    expect(options().find(option => option.getAttribute('data-value') === P1)!.getAttribute('data-state')).toBe('checked')
    options().find(option => option.getAttribute('data-value') === P2)!.click()
    await flushPromises()
    expect(mock.move).toHaveBeenCalledWith(CHAT_ID, P2)

    await openMove(wrapper)
    options().find(option => option.getAttribute('data-value') === 'none')!.click()
    await flushPromises()
    expect(mock.move).toHaveBeenLastCalledWith(CHAT_ID, null)
    expect(mock.move).toHaveBeenCalledTimes(2)
  })
})
