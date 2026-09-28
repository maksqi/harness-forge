import type { McpServer } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import McpServersPanel from './McpServersPanel.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), plain: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(toasts.plain, toasts) }))

function mcpServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'github',
    name: 'GitHub',
    pluginId: 'core-mcp',
    editable: true,
    transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: { set: true, hint: 'ghp_…9fQ2', source: 'stored' } } },
    policy: 'ask',
    enabled: true,
    status: 'connected',
    error: null,
    tools: Array.from({ length: 12 }, (_, index) => `mcp__github__tool_${index}`),
    connectedAt: 1_759_000_000_000,
    ...overrides,
  }
}

const github = mcpServer()
const everything = mcpServer({
  id: 'everything',
  name: 'Everything',
  transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: {} },
  status: 'error',
  error: { code: 'provider_unreachable', message: 'spawn npx ENOENT' },
  tools: [],
  connectedAt: null,
})
const slack = mcpServer({ id: 'slack', name: 'Slack', transport: { type: 'sse', url: 'https://slack.example.com/sse', headers: {} }, status: 'connecting', tools: [], connectedAt: null })
const paused = mcpServer({ id: 'paused', name: 'Paused', enabled: false, status: 'disabled', tools: [], connectedAt: null })
const acme = mcpServer({ id: 'acme-docs', name: 'Acme docs search', pluginId: 'acme-docs', editable: false, tools: ['mcp__acme-docs__search'] })

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  for (const fn of Object.values(toasts))
    fn.mockReset()
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function mountPanel(pluginId?: string) {
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(McpServersPanel, pluginId === undefined ? {} : { pluginId }),
    }),
  })
  return mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
}

async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round++) {
    await flushPromises()
    await nextTick()
  }
}

function all(selector: string, root: ParentNode = document.body): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)]
}

function one(selector: string, root: ParentNode = document.body): HTMLElement | null {
  return root.querySelector<HTMLElement>(selector)
}

function byTestId(id: string, root: ParentNode = document.body): HTMLElement | null {
  return one(`[data-testid="${id}"]`, root)
}

function row(id: string): HTMLElement {
  const found = one(`[data-testid="${testIds.mcpServerRow}"][data-server-id="${id}"]`)
  if (!found)
    throw new Error(`no row for ${id}`)
  return found
}

async function openMenu(id: string) {
  const trigger = one(`[data-action="mcp-menu"][data-server-id="${id}"]`)!
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await settle()
}

describe('mcpServersPanel', () => {
  it('shows skeleton rows while loading, then the servers of the plugin with their status', async () => {
    let resolveList: (value: { items: McpServer[] }) => void = () => {}
    api.mcp.list.mockImplementation(() => new Promise((resolve) => {
      resolveList = resolve
    }))
    mountPanel()
    await settle()
    expect(byTestId(testIds.mcpPanel)!.dataset.pluginId).toBe('core-mcp')
    expect(one('[aria-label="Loading MCP servers"]')).not.toBeNull()

    resolveList({ items: [github, everything, slack, paused, acme] })
    await settle()
    expect(one('[aria-label="Loading MCP servers"]')).toBeNull()
    const rows = all(`[data-testid="${testIds.mcpServerRow}"]`)
    expect(rows.map(item => item.dataset.serverId)).toEqual(['github', 'everything', 'slack', 'paused'])

    const statuses = rows.map((item) => {
      const status = byTestId(testIds.mcpStatus, item)!
      return [status.dataset.status, status.textContent?.trim(), one('[data-slot="status-dot"]', item)!.dataset.status]
    })
    expect(statuses).toEqual([
      ['connected', 'Connected · 12 tools', 'ok'],
      ['error', 'Error: spawn npx ENOENT', 'error'],
      ['connecting', 'Connecting…', 'running'],
      ['disabled', 'Disabled', 'off'],
    ])
    expect(one('[data-slot="mcp-transport-badge"]', row('github'))!.textContent?.trim()).toBe('HTTP')
    expect(one('[data-slot="mcp-transport-badge"]', row('everything'))!.textContent?.trim()).toBe('stdio')
    expect(one('[data-slot="mcp-transport-badge"]', row('slack'))!.textContent?.trim()).toBe('SSE')
    // Restart is off for a disabled server; the stored header value never reaches the page.
    expect((byTestId(testIds.mcpRestart, row('paused')) as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId(testIds.mcpRestart, row('github')) as HTMLButtonElement).disabled).toBe(false)
    expect(byTestId(testIds.mcpAdd)).not.toBeNull()
  })

  it('does not refetch a list the store already has', async () => {
    usePluginsStore().mcp = [github]
    usePluginsStore().mcpLoaded = true
    mountPanel()
    await settle()
    expect(api.mcp.list).not.toHaveBeenCalled()
    expect(all(`[data-testid="${testIds.mcpServerRow}"]`)).toHaveLength(1)
  })

  it('shows servers of another plugin read-only: restart only, no switch, menu or add', async () => {
    api.mcp.list.mockResolvedValue({ items: [github, acme] })
    api.mcp.reconnect.mockResolvedValue({ ...acme, status: 'connected' })
    mountPanel('acme-docs')
    await settle()
    const rows = all(`[data-testid="${testIds.mcpServerRow}"]`)
    expect(rows.map(item => item.dataset.serverId)).toEqual(['acme-docs'])
    expect(byTestId(testIds.mcpEnabled, rows[0])).toBeNull()
    expect(one('[data-action="mcp-menu"]', rows[0])).toBeNull()
    expect(byTestId(testIds.mcpAdd)).toBeNull()
    byTestId(testIds.mcpRestart, rows[0])!.click()
    await settle()
    expect(api.mcp.reconnect).toHaveBeenCalledWith({ params: { id: 'acme-docs' } })
    expect(toasts.success).toHaveBeenCalledWith('Acme docs search connected')
  })

  it('switches a server off and back through PATCH /mcp/:id', async () => {
    api.mcp.list.mockResolvedValue({ items: [github] })
    api.mcp.update.mockImplementation(async ({ params, body }: { params: { id: string }, body: { enabled: boolean } }) => ({
      ...github,
      id: params.id,
      enabled: body.enabled,
      status: body.enabled ? 'connecting' : 'disabled',
      tools: [],
    }))
    mountPanel()
    await settle()
    const toggle = byTestId(testIds.mcpEnabled, row('github'))!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    toggle.click()
    await settle()
    expect(api.mcp.update).toHaveBeenCalledWith({ params: { id: 'github' }, body: { enabled: false } })
    expect(byTestId(testIds.mcpStatus, row('github'))!.textContent?.trim()).toBe('Disabled')
    expect(byTestId(testIds.mcpEnabled, row('github'))!.getAttribute('aria-checked')).toBe('false')
  })

  it('reverts the switch and reports a failed toggle', async () => {
    api.mcp.list.mockResolvedValue({ items: [github] })
    api.mcp.update.mockRejectedValue(new HarnessError({ code: 'provider_error', message: 'Upstream failed' }))
    mountPanel()
    await settle()
    byTestId(testIds.mcpEnabled, row('github'))!.click()
    await settle()
    expect(toasts.error).toHaveBeenCalledWith(expect.any(String), { description: 'Upstream failed' })
    expect(byTestId(testIds.mcpEnabled, row('github'))!.getAttribute('aria-checked')).toBe('true')
  })

  it('restarts a server and reports a failed connection', async () => {
    api.mcp.list.mockResolvedValue({ items: [everything] })
    api.mcp.reconnect.mockResolvedValue({ ...everything, error: { code: 'provider_unreachable', message: 'spawn npx ENOENT' } })
    mountPanel()
    await settle()
    const restart = byTestId(testIds.mcpRestart, row('everything'))!
    expect(restart.getAttribute('aria-label')).toBe('Restart Everything')
    restart.click()
    await settle()
    expect(api.mcp.reconnect).toHaveBeenCalledWith({ params: { id: 'everything' } })
    expect(toasts.error).toHaveBeenCalledWith('Could not connect Everything', { description: 'spawn npx ENOENT' })
  })

  it('deletes a server after the confirmation', async () => {
    api.mcp.list.mockResolvedValue({ items: [github, everything] })
    api.mcp.remove.mockResolvedValue(undefined)
    mountPanel()
    await settle()
    await openMenu('github')
    expect(byTestId(testIds.mcpEdit)).not.toBeNull()
    byTestId(testIds.mcpDelete)!.click()
    await settle(5)
    expect(one('[data-slot="confirm-dialog"]')!.textContent).toContain('Delete GitHub?')
    expect(api.mcp.remove).not.toHaveBeenCalled()
    one('[data-action="mcp-delete-confirm"]')!.click()
    await settle(5)
    expect(api.mcp.remove).toHaveBeenCalledWith({ params: { id: 'github' } })
    expect(all(`[data-testid="${testIds.mcpServerRow}"]`).map(item => item.dataset.serverId)).toEqual(['everything'])
    expect(toasts.success).toHaveBeenCalledWith('Deleted GitHub')
  })

  it('opens the edit dialog from the row menu with the server loaded', async () => {
    api.mcp.list.mockResolvedValue({ items: [github] })
    mountPanel()
    await settle()
    await openMenu('github')
    byTestId(testIds.mcpEdit)!.click()
    await settle(5)
    const dialog = byTestId(testIds.mcpDialog)!
    expect(dialog.dataset.mode).toBe('edit')
    expect((one('[data-field="name"]', dialog) as HTMLInputElement).value).toBe('GitHub')
    expect((one('[data-field="id"]', dialog) as HTMLInputElement).readOnly).toBe(true)
  })

  it('shows the empty state and opens the add dialog', async () => {
    api.mcp.list.mockResolvedValue({ items: [acme] })
    mountPanel()
    await settle()
    expect(all(`[data-testid="${testIds.mcpServerRow}"]`)).toHaveLength(0)
    expect(byTestId(testIds.mcpPanel)!.textContent).toContain('No MCP servers yet.')
    expect(byTestId(testIds.mcpDialog)).toBeNull()
    byTestId(testIds.mcpAdd)!.click()
    await settle(5)
    expect(byTestId(testIds.mcpDialog)!.dataset.mode).toBe('create')
  })

  it('shows a load error with Retry', async () => {
    api.mcp.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Database is locked' }))
    mountPanel()
    await settle()
    const alert = one('[data-slot="mcp-load-error"]')!
    expect(alert.textContent).toContain('Database is locked')
    api.mcp.list.mockResolvedValue({ items: [github] })
    one('[data-action="retry"]', alert)!.click()
    await settle()
    expect(one('[data-slot="mcp-load-error"]')).toBeNull()
    expect(all(`[data-testid="${testIds.mcpServerRow}"]`)).toHaveLength(1)
  })
})
