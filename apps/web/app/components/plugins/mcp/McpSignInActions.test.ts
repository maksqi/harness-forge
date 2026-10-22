// McpSignInActions (Phase 14, ADR-059; docs/UI.md 8.8, 8.14, 10.10; W14.7): the Sign in / Sign out controls of a plugin's
// MCP server row: Sign in for a needs-auth server that can sign in ("Signing in…" while it runs), Sign out… for a
// signed-in one behind the confirmation, the inline error, nothing otherwise.
import type { McpServer } from '@harness-forge/shared'
import type { Ref } from 'vue'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { testIds } from '~/utils/testids'
import { mcpAuthInfo, mcpServer, mcpServerNeedsAuth } from '~/utils/testing/fixtures'
import McpSignInActions from './McpSignInActions.vue'

const mocks = vi.hoisted(() => ({ start: vi.fn(), signOut: vi.fn(), busyKey: null as unknown as Ref<string | null> }))
vi.mock('~/composables/useMcpSignIn', async importOriginal => ({
  ...await importOriginal<typeof import('~/composables/useMcpSignIn')>(),
  useMcpSignIn: () => ({ start: mocks.start, signOut: mocks.signOut, complete: vi.fn(), busyKey: mocks.busyKey }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

const plugin = (overrides: Partial<McpServer>) => mcpServerNeedsAuth({ pluginId: 'seed-oauth-kit', editable: false, ...overrides })

beforeEach(() => {
  mocks.start.mockReset()
  mocks.signOut.mockReset()
  mocks.busyKey = ref(null)
})

afterEach(() => {
  document.body.replaceChildren()
})

async function settle() {
  for (let round = 0; round < 4; round++) {
    await flushPromises()
    await nextTick()
  }
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

describe('mcpSignInActions', () => {
  it('signs a needs-auth plugin server in, shows "Signing in…" while it runs', async () => {
    mocks.start.mockResolvedValue('redirected')
    mount(McpSignInActions, { props: { server: plugin({}) }, attachTo: document.body })
    const button = byTestId(testIds.mcpSignIn)!
    expect(button.dataset.serverId).toBe('linear')
    expect(button.getAttribute('aria-label')).toBe('Sign in to Linear')
    button.click()
    await settle()
    expect(mocks.start).toHaveBeenCalledWith({ kind: 'global', serverId: 'linear' }, { name: 'Linear' })
    mocks.busyKey.value = 'global:linear'
    await settle()
    expect(byTestId(testIds.mcpSignIn)!.textContent?.trim()).toBe('Signing in…')
    expect((byTestId(testIds.mcpSignIn) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a refused sign-in inline', async () => {
    mocks.start.mockRejectedValue(new HarnessError({ code: 'provider_unreachable', message: 'Can\'t reach the authorization server.' }))
    mount(McpSignInActions, { props: { server: plugin({}) }, attachTo: document.body })
    byTestId(testIds.mcpSignIn)!.click()
    await settle()
    const alert = byTestId(testIds.mcpSignInError)!
    expect(alert.dataset.code).toBe('provider_unreachable')
    expect(alert.dataset.serverId).toBe('linear')
    expect(alert.textContent).toContain('Can\'t reach the authorization server.')
  })

  it('signs a signed-in plugin server out after the confirmation', async () => {
    mocks.signOut.mockResolvedValue(undefined)
    mount(McpSignInActions, { props: { server: plugin({ status: 'connected', tools: ['mcp__linear__a'], auth: mcpAuthInfo() }) }, attachTo: document.body })
    expect(byTestId(testIds.mcpSignIn)).toBeNull()
    byTestId(testIds.mcpSignOut)!.click()
    await settle()
    expect(document.body.querySelector('[data-slot="confirm-dialog"]')!.textContent).toContain('Sign out of Linear?')
    document.body.querySelector<HTMLElement>('[data-action="mcp-sign-out-confirm"]')!.click()
    await settle()
    expect(mocks.signOut).toHaveBeenCalledWith({ kind: 'global', serverId: 'linear' }, 'Linear')
    expect(document.body.querySelector('[data-slot="confirm-dialog"]')).toBeNull()
  })

  it('renders nothing for a server without a sign-in (stdio, an Authorization header, not signed in)', () => {
    mount(McpSignInActions, { props: { server: mcpServer() }, attachTo: document.body })
    mount(McpSignInActions, { props: { server: plugin({ transport: { type: 'http', url: 'https://x.example.com/mcp', headers: { Authorization: { set: true, hint: null, source: 'stored' } }, oauth: null } }) }, attachTo: document.body })
    expect(byTestId(testIds.mcpSignIn)).toBeNull()
    expect(byTestId(testIds.mcpSignOut)).toBeNull()
  })
})
