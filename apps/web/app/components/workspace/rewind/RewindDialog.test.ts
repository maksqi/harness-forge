// RewindDialog (docs/UI.md 7.22, 10.5, 13.9; C20 stub): closed by default, the rewind-dialog content once opened with a
// message id, and update:open from Cancel. W8.9 implements the preview, the restore and the result toasts.
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { testIds } from '~/utils/testids'
import { chatId, messageId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import RewindDialog from './RewindDialog.vue'

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
  document.body.replaceChildren()
})

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.rewindDialog}"]`)
}

function mountDialog(initial: { open: boolean, messageId: string | null }) {
  const state = ref(initial)
  const updates: boolean[] = []
  const wrapper = mount(defineComponent({
    setup: () => () => h(RewindDialog, {
      'open': state.value.open,
      'chatId': chatId(1),
      'messageId': state.value.messageId,
      'onUpdate:open': (value: boolean) => {
        updates.push(value)
        state.value = { ...state.value, open: value }
      },
    }),
  }), { attachTo: document.body })
  return { wrapper, state, updates }
}

describe('rewindDialog (stub)', () => {
  it('renders nothing while closed or without a message', async () => {
    mountDialog({ open: false, messageId: messageId('u1') })
    await flushPromises()
    expect(dialog()).toBeNull()
    mountDialog({ open: true, messageId: null })
    await flushPromises()
    expect(dialog()).toBeNull()
  })

  it('opens on a message with its title and text, and Cancel closes it without a request', async () => {
    const { updates } = mountDialog({ open: true, messageId: messageId('u1') })
    await flushPromises()
    expect(dialog()?.dataset.state).toBe('loading')
    expect(dialog()?.textContent).toContain('Rewind files to here?')
    expect(dialog()?.textContent).toContain('The conversation stays as it is.')
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Cancel')!
    cancel.click()
    await flushPromises()
    expect(updates).toEqual([false])
    expect(api.changes.rewindPreview).not.toHaveBeenCalled()
  })
})
