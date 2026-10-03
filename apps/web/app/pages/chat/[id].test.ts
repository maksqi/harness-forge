// The chat page (docs/UI.md 6, 7.21; Phase 8): ChatView sits inside ChatWorkspace, which gets the chat id and the
// session's project from the registry (null until the session knows one); a malformed id shows "Chat not found"
// without the workspace frame.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, reactive, ref } from 'vue'
import ChatWorkspace from '~/components/workspace/ChatWorkspace.vue'
import { chatId, projectId } from '~/utils/testing/fixtures'
import ChatPage from './[id].vue'

const mocks = vi.hoisted(() => ({
  route: null as null | { params: Record<string, string | string[]> },
  /** The project the fake session reports. */
  project: null as null | { value: string | null },
  ids: null as null | { value: string[] },
}))

vi.mock('~/components/workspace/nuxt-imports', () => ({ useHead: vi.fn() }))
vi.mock('~/components/chat/nuxt-imports', () => ({
  useRoute: () => mocks.route,
  useColorMode: () => ({ value: 'dark' }),
  useRouter: vi.fn(),
  navigateTo: vi.fn(),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => ({}), useApiFetch: () => vi.fn() }))
// The registry as the page reads it: one session per id the stand-in ChatView registered.
vi.mock('~/composables/useChatSession', () => ({
  useChatSessionRegistry: () => ({
    ids: mocks.ids,
    get: (id: string) => (mocks.ids!.value.includes(id)
      ? { projectId: computed(() => mocks.project!.value), notFound: ref(false), summary: ref(null) }
      : undefined),
  }),
}))
// ChatView belongs to W2.2 / W8.9; this stand-in registers its session and renders the header slot.
vi.mock('~/components/chat/ChatView.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      name: 'ChatView',
      props: { chatId: { type: String, required: true } },
      setup(props, { slots }) {
        mocks.ids!.value = [props.chatId]
        return () => render('div', { 'data-slot': 'chat-view', 'data-chat-id': props.chatId }, slots.header?.({ scrolled: false, title: 'Chat', loading: false, projectId: mocks.project!.value }))
      },
    }),
  }
})
vi.mock('~/components/chat/ChatHeader.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      name: 'ChatHeader',
      props: ['chatId', 'title', 'scrolled', 'loading', 'projectId'],
      setup: props => () => render('header', { 'data-slot': 'chat-header', 'data-project-id': props.projectId ?? 'none' }),
    }),
  }
})

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  mocks.route = reactive({ params: { id: chatId(1) } })
  mocks.project = ref<string | null>(null)
  mocks.ids = ref<string[]>([])
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function mountPage() {
  return mount(defineComponent({ setup: () => () => h(ChatPage) }), { attachTo: document.body })
}

describe('chat page: workspace frame (Phase 8)', () => {
  it('wraps ChatView in ChatWorkspace with the chat id and the session\'s project', async () => {
    mocks.project!.value = projectId(1)
    const wrapper = mountPage()
    await flushPromises()
    const workspace = wrapper.getComponent(ChatWorkspace)
    expect(workspace.props()).toEqual({ chatId: chatId(1), projectId: projectId(1) })
    expect(workspace.get('[data-slot="chat-view"]').attributes('data-chat-id')).toBe(chatId(1))
    expect(wrapper.get('[data-slot="chat-header"]').attributes('data-project-id')).toBe(projectId(1))

    mocks.project!.value = null
    await flushPromises()
    expect(workspace.props('projectId')).toBeNull()
  })

  it('shows "Chat not found" for a malformed id, without the frame', async () => {
    mocks.route = reactive({ params: { id: 'not-a-chat' } })
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.findComponent(ChatWorkspace).exists()).toBe(false)
    expect(wrapper.text()).toContain('not found')
  })
})
