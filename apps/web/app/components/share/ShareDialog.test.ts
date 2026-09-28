import type { VueWrapper } from '@vue/test-utils'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import ShareDialog from './ShareDialog.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
// The ui store imports the chats and settings stores, which reach the typed client through useApi ('#imports').
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

/** Lets promises, Vue updates and reka-ui's deferred work settle. */
async function settle() {
  for (let round = 0; round < 3; round++) {
    await flushPromises()
    await nextTick()
  }
}

/** The dialog content renders in a portal under <body>. */
function dialog() {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.shareDialog}"]`)
}

beforeEach(async () => {
  mocks.api = createMockApi()
  pinia = createPinia()
  setActivePinia(pinia)
  wrapper = mount(ShareDialog, { attachTo: document.body, global: { plugins: [pinia] } })
  await settle()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

describe('shareDialog', () => {
  it('stays closed until ui.openShare(chatId) and then shows that chat', async () => {
    expect(dialog()).toBeNull()
    useUiStore().openShare('chat-1')
    await settle()
    const content = dialog()!
    expect(content.getAttribute('role')).toBe('dialog')
    expect(content.dataset.chatId).toBe('chat-1')
    expect(content.textContent).toContain('Share chat')
  })

  it('closes with ui.closeShare() and clears ui.shareChatId when the user closes it', async () => {
    const ui = useUiStore()
    ui.openShare('chat-1')
    await settle()
    ui.closeShare()
    await settle()
    expect(dialog()).toBeNull()

    ui.openShare('chat-2')
    await settle()
    expect(dialog()?.dataset.chatId).toBe('chat-2')
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(ui.shareChatId).toBeNull()
    expect(dialog()).toBeNull()
  })
})
