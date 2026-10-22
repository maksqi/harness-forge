// The MCP servers a plugin declares (docs/UI.md 8.8; Phase 14, ADR-059, 8.14): the status rows with Restart, the ids the
// MCP API does not know yet, and (W14.7) the sign-in of plugin and Claude Code plugin servers: Sign in for a needs-auth
// server, "Signed in" with the token tooltip and Sign out… behind the confirmation, the refused Authorization header.
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
import { mcpAuthInfo, mcpAuthStart, mcpServer, mcpServerNeedsAuth } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import PluginMcpServerList from './PluginMcpServerList.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  assign: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('~/components/oauth/location', () => ({ assignLocation: mocks.assign }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

const plugin = (overrides: Partial<McpServer> = {}) => mcpServer({ pluginId: 'seed-oauth-kit', editable: false, ...overrides })

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.assign.mockReset()
  mocks.toast.success.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  window.history.replaceState(null, '', '/plugins/seed-oauth-kit')
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
  window.history.replaceState(null, '', '/')
})

function mountList(servers: McpServer[], missing: string[] = []) {
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, { default: () => h(PluginMcpServerList, { servers, missing }) }),
  })
  return mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
}

async function settle() {
  for (let round = 0; round < 4; round++) {
    await flushPromises()
    await nextTick()
  }
}

function row(id: string): HTMLElement {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.mcpServerRow}"][data-server-id="${id}"]`)!
}

function byTestId(id: string, root: ParentNode = document.body): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

describe('pluginMcpServerList', () => {
  it('lists the servers with status and Restart; unknown ids without controls', async () => {
    api.mcp.reconnect.mockResolvedValue(plugin({ status: 'connected' }))
    mountList([plugin({ status: 'error', error: { code: 'provider_unreachable', message: 'spawn ENOENT' } })], ['later'])
    expect(row('github').textContent).toContain('Error: spawn ENOENT')
    expect(byTestId(testIds.mcpStatus, row('github'))!.dataset.status).toBe('error')
    expect(row('later').textContent).toContain('Status is not available yet.')
    expect(byTestId(testIds.mcpRestart, row('later'))).toBeNull()
    expect(byTestId(testIds.mcpSignIn)).toBeNull()
    byTestId(testIds.mcpRestart, row('github'))!.click()
    await settle()
    expect(api.mcp.reconnect).toHaveBeenCalledWith({ params: { id: 'github' } })
  })

  it('a needs-auth plugin server signs in through its own row (same tab)', async () => {
    api.mcpAuth.start.mockResolvedValue(mcpAuthStart())
    mountList([mcpServerNeedsAuth({ pluginId: 'seed-oauth-kit', editable: false })])
    expect(row('linear').textContent).toContain('Sign in required')
    const signIn = byTestId(testIds.mcpSignIn, row('linear'))!
    expect(signIn.getAttribute('aria-label')).toBe('Sign in to Linear')
    signIn.click()
    await settle()
    expect(api.mcpAuth.start).toHaveBeenCalledWith({ params: { id: 'linear' }, body: { returnTo: '/plugins/seed-oauth-kit' } })
    expect(mocks.assign).toHaveBeenCalledWith(mcpAuthStart().authorizationUrl)
    expect(byTestId(testIds.mcpSignIn, row('linear'))!.textContent?.trim()).toBe('Signing in…')
  })

  it('a refused sign-in shows the inline error in the row', async () => {
    api.mcpAuth.start.mockRejectedValue(new HarnessError({ code: 'provider_error', message: 'Linear can\'t sign in: the server sent no sign-in information.' }))
    mountList([mcpServerNeedsAuth({ pluginId: 'seed-oauth-kit', editable: false })])
    byTestId(testIds.mcpSignIn, row('linear'))!.click()
    await settle()
    const alert = byTestId(testIds.mcpSignInError, row('linear'))!
    expect(alert.dataset.code).toBe('provider_error')
    expect(alert.textContent).toContain('the server sent no sign-in information.')
  })

  it('a signed-in plugin server reads "Signed in" with the token tooltip and signs out after the confirmation', async () => {
    const signedIn = plugin({ auth: mcpAuthInfo({ expiresAt: null }) })
    usePluginsStore().mcp = [signedIn]
    api.mcpAuth.signOut.mockResolvedValue(plugin({ status: 'needs-auth', tools: [], auth: mcpAuthInfo({ signedIn: false, expiresAt: null, scope: null, client: null, issuer: null }) }))
    mountList([signedIn])
    const status = row('github').querySelector('p')!
    expect(status.textContent?.trim()).toBe('Connected · 1 tool · Signed in')
    expect(status.getAttribute('title')).toBe('Signed in · token renews automatically')
    expect(byTestId(testIds.mcpSignIn)).toBeNull()
    byTestId(testIds.mcpSignOut, row('github'))!.click()
    await settle()
    expect(document.body.querySelector('[data-slot="confirm-dialog"]')!.textContent).toContain('Sign out of GitHub?')
    expect(api.mcpAuth.signOut).not.toHaveBeenCalled()
    document.body.querySelector<HTMLElement>('[data-action="mcp-sign-out-confirm"]')!.click()
    await settle()
    expect(api.mcpAuth.signOut).toHaveBeenCalledWith({ params: { id: 'github' } })
    expect(mocks.toast.success).toHaveBeenCalledWith('Signed out of GitHub.')
  })

  it('a needs-auth server with an Authorization header names it and offers no Sign in', () => {
    mountList([plugin({ status: 'needs-auth', tools: [], transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: { set: true, hint: null, source: 'stored' } }, oauth: null } })])
    expect(row('github').textContent).toContain('The server rejected its Authorization header.')
    expect(byTestId(testIds.mcpSignIn)).toBeNull()
  })
})
