import type { ToolPartLike } from '../chat-format'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { toolSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { TOOL_BODY_PREVIEW_CHARS } from '../chat-format'
import ToolPart from './ToolPart.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => vi.fn() }))
vi.mock('~/components/chat/nuxt-imports', () => ({
  useColorMode: () => ({ value: 'dark' }),
  useRoute: () => ({ path: '/', fullPath: '/', params: {}, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), currentRoute: { value: { path: '/' } } }),
  navigateTo: vi.fn(),
}))

function part(overrides: Partial<ToolPartLike> & Pick<ToolPartLike, 'state'>): ToolPartLike {
  return { type: 'tool-web_fetch', toolCallId: 'call_1', input: { url: 'https://nuxt.com/docs' }, ...overrides } as ToolPartLike
}

function mountPart(toolPart: ToolPartLike, streaming = true) {
  return mount({
    render: () => h(TooltipProvider, null, { default: () => h(ToolPart, { part: toolPart, streaming }) }),
  }, { attachTo: document.body })
}

function row(wrapper: ReturnType<typeof mountPart>) {
  return wrapper.get(`[data-testid="${testIds.toolRow}"]`)
}

beforeEach(() => {
  mock.api = createMockApi()
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('toolPart: row states', () => {
  it('shows name, first argument and a spinner while running', () => {
    const wrapper = mountPart(part({ state: 'input-available' }))
    expect(row(wrapper).attributes()).toMatchObject({ 'data-tool-name': 'web_fetch', 'data-state': 'input-available', 'data-status': 'running' })
    expect(row(wrapper).text()).toContain('web_fetch')
    expect(row(wrapper).text()).toContain('"https://nuxt.com/docs"')
    expect(row(wrapper).find('[role="status"]').exists()).toBe(true)
  })

  it('stops spinning when the message is no longer streaming', () => {
    const wrapper = mountPart(part({ state: 'input-available' }), false)
    expect(row(wrapper).attributes('data-status')).toBe('stopped')
    expect(row(wrapper).text()).toContain('Stopped')
  })

  it('marks success, errors and denials', () => {
    expect(row(mountPart(part({ state: 'output-available', output: { ok: true } }))).attributes('data-status')).toBe('done')
    expect(row(mountPart(part({ state: 'output-error', errorText: 'boom' }))).attributes('data-status')).toBe('error')
    const denied = mountPart(part({ state: 'output-denied', approval: { id: 'a1', approved: false } }))
    expect(row(denied).attributes('data-status')).toBe('denied')
    expect(row(denied).text()).toContain('Denied')
  })

  it('shows MCP tools by tool name with a server badge', () => {
    const wrapper = mountPart({ type: 'dynamic-tool', toolName: 'mcp__docs__search', toolCallId: 'c', state: 'output-available', input: { q: 'x' }, output: 'y' })
    expect(row(wrapper).attributes('data-tool-name')).toBe('mcp__docs__search')
    expect(row(wrapper).text()).toContain('search')
    expect(row(wrapper).text()).toContain('docs')
    expect(row(wrapper).text()).not.toContain('mcp__')
  })

  it('never opens by itself; a click shows input and output', async () => {
    const wrapper = mountPart(part({ state: 'output-available', output: { title: 'Nuxt' } }))
    const closed = wrapper.get(`[data-testid="${testIds.toolRowOutput}"]`)
    expect(closed.attributes('hidden')).toBeDefined()
    expect(closed.text()).toBe('')
    await row(wrapper).get('button').trigger('click')
    await flushPromises()
    const body = wrapper.get(`[data-testid="${testIds.toolRowOutput}"]`)
    expect(body.attributes('hidden')).toBeUndefined()
    expect(body.text()).toContain('"url": "https://nuxt.com/docs"')
    expect(body.text()).toContain('"title": "Nuxt"')
  })
})

describe('toolPart: 4 KB previews', () => {
  it('caps the output at 4 KB with "Show all" and notes server truncation', async () => {
    const output = `${'x'.repeat(TOOL_BODY_PREVIEW_CHARS * 2)}…[truncated]`
    const wrapper = mountPart(part({ state: 'output-available', output }))
    await row(wrapper).get('button').trigger('click')
    await flushPromises()
    const block = wrapper.get('[data-slot="tool-value"][data-label="output"]')
    expect(block.get('pre').text()).toHaveLength(TOOL_BODY_PREVIEW_CHARS)
    expect(block.text()).toContain('Truncated by server')
    await block.get('[data-action="show-all"]').trigger('click')
    expect(block.get('pre').text()).toBe(output)
    expect(block.find('[data-action="show-all"]').exists()).toBe(false)
  })
})

describe('toolPart: approval card', () => {
  const requested = () => part({ state: 'approval-requested', approval: { id: 'appr_1' } })

  it('renders under the row with the source plugin and the arguments', () => {
    usePluginsStore().tools = [toolSummary({ name: 'web_fetch', pluginId: 'core-tools' })]
    const wrapper = mountPart(requested())
    expect(row(wrapper).text()).toContain('Needs approval')
    const card = wrapper.get(`[data-testid="${testIds.toolApproval}"]`)
    expect(card.attributes('data-tool-name')).toBe('web_fetch')
    expect(card.attributes('role')).toBe('group')
    expect(card.text()).toContain('Allow web_fetch?')
    expect(card.text()).toContain('from core-tools')
    expect(card.text()).toContain('"url": "https://nuxt.com/docs"')
  })

  it('allow + "Always allow" emits one decision with alwaysAllow', async () => {
    const wrapper = mount(ToolPart, {
      props: { part: requested(), streaming: false },
      global: { stubs: { Tooltip: { template: '<div><slot /></div>' } } },
      attachTo: document.body,
    })
    await wrapper.get(`[data-testid="${testIds.toolApprovalAlways}"]`).trigger('click')
    await wrapper.get(`[data-testid="${testIds.toolApprovalAllow}"]`).trigger('click')
    await wrapper.get(`[data-testid="${testIds.toolApprovalAllow}"]`).trigger('click')
    expect(wrapper.emitted('approval')).toEqual([[{ id: 'appr_1', approved: true, toolName: 'web_fetch', alwaysAllow: true }]])
  })

  it('deny ignores "Always allow"', async () => {
    const wrapper = mount(ToolPart, { props: { part: requested(), streaming: false }, attachTo: document.body })
    await wrapper.get(`[data-testid="${testIds.toolApprovalAlways}"]`).trigger('click')
    await wrapper.get(`[data-testid="${testIds.toolApprovalDeny}"]`).trigger('click')
    expect(wrapper.emitted('approval')).toEqual([[{ id: 'appr_1', approved: false, toolName: 'web_fetch', alwaysAllow: false }]])
  })

  it('shows a request left in an older message as superseded, without a card', () => {
    const wrapper = mount({
      render: () => h(TooltipProvider, null, { default: () => h(ToolPart, { part: requested(), streaming: false, superseded: true }) }),
    }, { attachTo: document.body })
    expect(wrapper.find(`[data-testid="${testIds.toolApproval}"]`).exists()).toBe(false)
    expect(row(wrapper).attributes('data-status')).toBe('denied')
    expect(row(wrapper).text()).toContain('Denied')
  })

  it('collapses into the row status once decided', () => {
    const wrapper = mountPart(part({ state: 'approval-responded', approval: { id: 'appr_1', approved: true } }))
    expect(wrapper.find(`[data-testid="${testIds.toolApproval}"]`).exists()).toBe(false)
    expect(row(wrapper).attributes('data-status')).toBe('running')
  })
})
