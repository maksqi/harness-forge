// ChatNavRow's status dot (docs/UI.md 5.10; Phase 14, C54): `input` ("Needs your input", a running MCP tool call waits for
// the user's answer) shows the warning dot of `approval` with its own label and keeps `data-status="input"` for e2e.
import type { ChatListStatus } from '~/stores/chats'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { testIds } from '~/utils/testids'
import { chatSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ChatNavRow from './ChatNavRow.vue'
import { byTestId, mountInShell, settle } from './testing'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  mocks.api = createMockApi()
  stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function row(status: ChatListStatus | null) {
  const wrapper = mountInShell({ render: () => h('ul', [h(ChatNavRow, { chat: chatSummary({ title: 'Fix the login bug' }), active: false, status })]) })
  await settle()
  return wrapper
}

describe('chatNavRow status dot', () => {
  it('shows `input` as the warning dot labelled "Needs your input"', async () => {
    const wrapper = await row('input')
    const dot = byTestId(testIds.chatStatusDot)!
    expect(dot.dataset.status).toBe('input')
    expect(dot.querySelector('.bg-warning')).not.toBeNull()
    expect(dot.querySelector('.sr-only')?.textContent).toBe('Needs your input')
    wrapper.unmount()
  })

  it('keeps the other states as they were', async () => {
    const wrapper = await row('approval')
    const dot = byTestId(testIds.chatStatusDot)!
    expect(dot.dataset.status).toBe('approval')
    expect(dot.querySelector('.sr-only')?.textContent).toBe('Needs approval')
    wrapper.unmount()
    const idle = await row(null)
    expect(byTestId(testIds.chatStatusDot)).toBeNull()
    idle.unmount()
  })
})
