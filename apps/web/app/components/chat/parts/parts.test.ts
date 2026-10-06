import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useProvidersStore } from '~/stores/providers'
import { testIds } from '~/utils/testids'
import { providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { CHAT_VIEW_ACTIONS } from '../chat-context'
import ErrorPart from './ErrorPart.vue'
import FilePart from './FilePart.vue'
import NoticePart from './NoticePart.vue'
import ReasoningPart from './ReasoningPart.vue'
import SourcesPart from './SourcesPart.vue'

const mock = vi.hoisted(() => ({ api: null as unknown, push: null as unknown as ReturnType<typeof vi.fn> }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => vi.fn() }))
vi.mock('~/components/chat/nuxt-imports', () => ({
  useColorMode: () => ({ value: 'dark' }),
  useRoute: () => ({ path: '/chat/x', fullPath: '/chat/x', params: {}, query: {} }),
  useRouter: () => ({ push: mock.push, replace: vi.fn(), currentRoute: { value: { path: '/chat/x' } } }),
  navigateTo: vi.fn(),
}))

function withShell(render: () => ReturnType<typeof h>, provide: Record<symbol, unknown> = {}) {
  return mount({ render: () => h(TooltipProvider, null, { default: render }) }, { attachTo: document.body, global: { provide } })
}

beforeEach(() => {
  mock.api = createMockApi()
  mock.push = vi.fn()
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('reasoningPart', () => {
  it('shows "Thinking… Ns" with a live count while it streams', async () => {
    vi.useFakeTimers()
    const wrapper = withShell(() => h(ReasoningPart, { part: { type: 'reasoning', text: 'step 1', state: 'streaming' }, streaming: true, showThinking: false }))
    const row = wrapper.get(`[data-testid="${testIds.reasoningRow}"]`)
    expect(row.attributes('data-state')).toBe('streaming')
    expect(row.attributes('data-expanded')).toBe('false')
    expect(row.text()).toContain('Thinking… 1s')
    expect(row.find('.hf-shimmer-text').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(row.text()).toContain('Thinking… 4s')
  })

  it('shows "Thought for Ns" from metadata after a reload, collapsed', () => {
    const wrapper = withShell(() => h(ReasoningPart, { part: { type: 'reasoning', text: 'secret plan', state: 'done' }, streaming: false, showThinking: false, durationMs: 12_300 }))
    const row = wrapper.get(`[data-testid="${testIds.reasoningRow}"]`)
    expect(row.attributes('data-state')).toBe('done')
    expect(row.text()).toContain('Thought for 12s')
    expect(wrapper.text()).not.toContain('secret plan')
  })

  it('falls back to "Thought" and expands with Show thinking', async () => {
    const wrapper = withShell(() => h(ReasoningPart, { part: { type: 'reasoning', text: 'the **plan**', state: 'done' }, streaming: false, showThinking: true }))
    await flushPromises()
    const row = wrapper.get(`[data-testid="${testIds.reasoningRow}"]`)
    expect(row.text()).toContain('Thought')
    expect(row.attributes('data-expanded')).toBe('true')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(wrapper.text()).toContain('plan')
  })
})

describe('errorPart', () => {
  it('links "Open settings" to the provider dialog', async () => {
    useProvidersStore().items = [providerSummary({ id: 'anthropic', name: 'Anthropic (Claude)' })]
    const wrapper = withShell(() => h(ErrorPart, {
      error: { error: { code: 'provider_not_configured', message: 'Add a key.', providerId: 'anthropic', action: 'configure-provider' } },
    }))
    const alert = wrapper.get(`[data-testid="${testIds.chatError}"]`)
    expect(alert.attributes('data-code')).toBe('provider_not_configured')
    expect(alert.text()).toContain('No API key for Anthropic (Claude)')
    const action = wrapper.get(`[data-testid="${testIds.chatErrorAction}"]`)
    expect(action.attributes('data-action')).toBe('configure-provider')
    await action.trigger('click')
    expect(mock.push).toHaveBeenCalledWith('/settings/providers?configure=anthropic')
  })

  it('reads envelope JSON from a stream error and retries', async () => {
    const onRetry = vi.fn()
    const streamError = new Error(JSON.stringify({ error: { code: 'provider_unreachable', message: 'Timed out', providerId: 'ollama' } }))
    const wrapper = withShell(() => h(ErrorPart, { error: streamError, onRetry }))
    expect(wrapper.text()).toContain('Can\'t reach ollama')
    await wrapper.get('[data-action="retry"]').trigger('click')
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('offers "Choose model" for unknown models', async () => {
    const openModelPicker = vi.fn()
    const wrapper = withShell(
      () => h(ErrorPart, { error: { code: 'model_not_found', message: 'Unknown model', providerId: 'openai' } }),
      { [CHAT_VIEW_ACTIONS as symbol]: { openModelPicker } },
    )
    expect(wrapper.find('[data-action="refresh-models"]').exists()).toBe(true)
    await wrapper.get('[data-action="choose-model"]').trigger('click')
    expect(openModelPicker).toHaveBeenCalledOnce()
  })
})

describe('sourcesPart', () => {
  it('merges sources into one row and links only http(s) URLs', async () => {
    const wrapper = withShell(() => h(SourcesPart, {
      parts: [
        { type: 'source-url', sourceId: 's1', url: 'https://www.nuxt.com/docs', title: 'Nuxt docs' },
        { type: 'source-url', sourceId: 's2', url: 'javascript:alert(1)', title: 'Evil' },
        { type: 'source-document', sourceId: 's3', mediaType: 'application/pdf', title: 'Spec', filename: 'spec.pdf' },
      ],
    }))
    const trigger = wrapper.get(`[data-testid="${testIds.sourcesRow}"]`)
    expect(trigger.text()).toContain('3 sources')
    await trigger.trigger('click')
    await flushPromises()
    const links = wrapper.findAll('a')
    expect(links).toHaveLength(1)
    expect(links[0]!.attributes()).toMatchObject({ href: 'https://www.nuxt.com/docs', target: '_blank', rel: 'noopener noreferrer' })
    expect(wrapper.text()).toContain('nuxt.com')
    expect(wrapper.text()).toContain('Evil')
    expect(wrapper.text()).toContain('spec.pdf')
  })
})

describe('filePart', () => {
  it('renders images as thumbnails and other files as chips', () => {
    const image = withShell(() => h(FilePart, { part: { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: '/api/files/file_a000000000000001' } }))
    expect(image.get(`[data-testid="${testIds.fileChip}"]`).find('img').attributes('src')).toBe('/api/files/file_a000000000000001')
    const pdf = withShell(() => h(FilePart, { part: { type: 'file', mediaType: 'application/pdf', filename: 'spec.pdf', url: '/api/files/file_b000000000000001' } }))
    expect(pdf.get(`[data-testid="${testIds.fileChip}"]`).text()).toContain('spec.pdf')
    const unsafe = withShell(() => h(FilePart, { part: { type: 'file', mediaType: 'image/png', filename: 'x.png', url: 'javascript:alert(1)' } }))
    expect(unsafe.find('img').exists()).toBe(false)
  })
})

describe('noticePart', () => {
  it('names what happened with a per-code icon and reads warnings as warnings', () => {
    const wrapper = mount(NoticePart, { props: { notice: { level: 'warning', code: 'attachments-unsupported', message: 'This model cannot read the attached file, so it was not sent.' } } })
    const row = wrapper.get('[data-slot="notice-part"]')
    expect(row.attributes('data-code')).toBe('attachments-unsupported')
    expect(row.attributes('data-level')).toBe('warning')
    expect(row.text()).toBe('Warning: This model cannot read the attached file, so it was not sent.')
    expect(row.find('svg').classes().join(' ')).toMatch(/paperclip/)
    expect(row.find('svg').classes()).toContain('text-warning')
  })

  it('uses its own icons for the other codes and muted info notices', () => {
    const icons = (['context-trimmed', 'approvals-superseded', 'tools-unsupported'] as const).map((code) => {
      const wrapper = mount(NoticePart, { props: { notice: { level: 'info', code, message: 'm' } } })
      expect(wrapper.text()).toBe('m')
      expect(wrapper.find('svg').classes()).not.toContain('text-warning')
      return wrapper.find('svg').classes().join(' ')
    })
    expect(icons[0]).toMatch(/fold-vertical/)
    expect(icons[1]).toMatch(/ban/)
    expect(icons[2]).toMatch(/wrench/)
  })

  it('shows the Phase 11 notices with their icons and the server\'s text', () => {
    const cases = [
      ['output-style-unavailable', 'warning', 'The output style "terse" is not available, so the default style was used.', /feather/],
      ['hook-continuation-limit', 'info', 'Stopped after 5 hook continuations in a row.', /webhook/],
      ['project-mcp-unavailable', 'warning', 'The project MCP server "memory" is not ready, so its tools were not sent.', /server-off/],
    ] as const
    for (const [code, level, message, icon] of cases) {
      const wrapper = mount(NoticePart, { props: { notice: { level, code, message } } })
      const row = wrapper.get('[data-slot="notice-part"]')
      expect(row.attributes()).toMatchObject({ 'data-code': code, 'data-level': level })
      expect(row.text()).toContain(message)
      expect(row.find('svg').classes().join(' ')).toMatch(icon)
      // Outside a chat view (no CHAT_VIEW_ACTIONS) there is no action.
      expect(row.find('[data-slot="notice-action"]').exists()).toBe(false)
    }
  })

  it('opens the project\'s MCP servers from a project-mcp-unavailable notice inside a chat view', async () => {
    const openProjectMcp = vi.fn()
    const actions = { openModelPicker: vi.fn(), openProjectTrust: vi.fn(), openProjectMcp }
    const notice = { level: 'warning', code: 'project-mcp-unavailable', message: 'The project MCP server "memory" is not ready, so its tools were not sent.' } as const
    const wrapper = mount(NoticePart, { props: { notice }, global: { provide: { [CHAT_VIEW_ACTIONS as symbol]: actions } } })
    const action = wrapper.get('[data-slot="notice-action"]')
    expect(action.element.tagName).toBe('BUTTON')
    expect(action.text()).toBe('MCP servers…')
    await action.trigger('click')
    expect(openProjectMcp).toHaveBeenCalledTimes(1)
    expect(openProjectMcp).toHaveBeenCalledWith()
    const other = mount(NoticePart, { props: { notice: { level: 'info', code: 'hook-continuation-limit', message: 'Stopped.' } }, global: { provide: { [CHAT_VIEW_ACTIONS as symbol]: actions } } })
    expect(other.find('[data-slot="notice-action"]').exists()).toBe(false)
  })
})
