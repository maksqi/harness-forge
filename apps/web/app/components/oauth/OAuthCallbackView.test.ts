// OAuthCallbackView (Phase 14, ADR-059; docs/UI.md 2.20, 8.14, 10.10; W14.7-T5): each state of the callback page — the
// query is read once and removed before the POST, `working` (role="status"), `success` (the toast and a replace
// navigation to `returnTo` or the fallback), and `error` (role="alert", focused, `data-code`, the plain text; a used or
// expired link; a page without a state; Try again only when the answer names its server; Back to MCP servers).
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { testIds } from '~/utils/testids'
import { mcpAuthCallbackResult, mcpAuthStart, mcpServer, projectId, projectMcpList, projectMcpServer } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import OAuthCallbackView from './OAuthCallbackView.vue'

const STATE = 'sampleState0000000000001'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  query: {} as Record<string, unknown>,
  calls: [] as string[],
  replace: vi.fn(),
  navigateTo: vi.fn(),
  assign: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('~/components/settings/nuxt-imports', () => ({
  useRoute: () => ({ query: mocks.query, fullPath: '/oauth/callback' }),
  useRouter: () => ({ replace: mocks.replace }),
  navigateTo: mocks.navigateTo,
}))
vi.mock('~/components/oauth/location', () => ({ assignLocation: mocks.assign }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.calls = []
  mocks.query = {}
  mocks.replace.mockReset().mockImplementation(async () => {
    mocks.calls.push('replace')
  })
  mocks.navigateTo.mockReset().mockResolvedValue(undefined)
  mocks.assign.mockReset()
  mocks.toast.success.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function mountView() {
  return mount(OAuthCallbackView, { attachTo: document.body, global: { plugins: [pinia] } })
}

async function settle(rounds = 4) {
  for (let round = 0; round < rounds; round++) {
    await flushPromises()
    await nextTick()
  }
}

function root(): HTMLElement {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.oauthCallback}"]`)!
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

describe('oAuthCallbackView', () => {
  it('works with a role="status" line, removes the query before the POST, then goes back with a toast', async () => {
    mocks.query = { code: 'sample-code', state: STATE, iss: 'https://auth.example.com' }
    let finish: (value: unknown) => void = () => {}
    api.mcpAuth.callback.mockImplementation(() => {
      mocks.calls.push('post')
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    api.mcp.list.mockResolvedValue({ items: [mcpServer({ id: 'linear', name: 'Linear' })] })
    mountView()
    expect(root().dataset.state).toBe('working')
    expect(root().querySelector('[role="status"]')!.textContent?.trim()).toBe('Finishing sign-in…')
    await settle()
    expect(mocks.replace).toHaveBeenCalledWith({ query: {} })
    expect(mocks.calls).toEqual(['replace', 'post'])
    expect(api.mcpAuth.callback).toHaveBeenCalledWith({ body: { state: STATE, code: 'sample-code', iss: 'https://auth.example.com' } })
    // The code and the state are never rendered.
    expect(document.body.innerHTML).not.toContain('sample-code')
    expect(document.body.innerHTML).not.toContain(STATE)

    finish(mcpAuthCallbackResult({ returnTo: '/chat/abc' }))
    await settle()
    expect(root().dataset.state).toBe('success')
    expect(mocks.toast.success).toHaveBeenCalledWith('Signed in to Linear.')
    expect(mocks.navigateTo).toHaveBeenCalledWith('/chat/abc', { replace: true })
  })

  it('without returnTo a project server goes back to the projects settings', async () => {
    mocks.query = { code: 'sample-code', state: STATE }
    api.mcpAuth.callback.mockResolvedValue(mcpAuthCallbackResult({ target: { kind: 'project', projectId: projectId(1), serverId: 'docs' }, returnTo: null }))
    api.projectMcp.list.mockResolvedValue(projectMcpList({ items: [projectMcpServer({ id: 'docs', name: 'Docs', transport: 'http', state: 'connected', missingVariables: [] })], variables: [] }))
    mountView()
    await settle()
    expect(mocks.toast.success).toHaveBeenCalledWith('Signed in to Docs.')
    expect(mocks.navigateTo).toHaveBeenCalledWith('/settings/projects', { replace: true })
  })

  it('a used or expired link shows its own text with Back to MCP servers only', async () => {
    mocks.query = { code: 'sample-code', state: STATE }
    api.mcpAuth.callback.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'This sign-in link was already used or expired.', details: { reason: 'stale' } }))
    mountView()
    await settle()
    expect(root().dataset.state).toBe('error')
    const card = byTestId(testIds.oauthCallbackError)!
    expect(card.getAttribute('role')).toBe('alert')
    expect(card.dataset.code).toBe('conflict')
    expect(card.textContent).toContain('Sign-in failed')
    expect(card.textContent).toContain('This sign-in link was already used or expired.')
    expect(document.activeElement).toBe(card)
    expect(byTestId(testIds.oauthCallbackRetry)).toBeNull()
    byTestId(testIds.oauthCallbackBack)!.click()
    expect(mocks.navigateTo).toHaveBeenCalledWith('/plugins/core-mcp', { replace: true })
  })

  it('a provider error posts the error and shows the server\'s text as plain text; Try again starts a new sign-in', async () => {
    mocks.query = { error: 'access_denied', error_description: 'The user denied the request.', state: STATE }
    api.mcpAuth.callback.mockRejectedValue(new HarnessError({ code: 'auth_invalid', message: 'Linear answered: access_denied (<b>The user denied the request.</b>)', details: { serverId: 'linear' } }))
    api.mcpAuth.start.mockResolvedValue(mcpAuthStart())
    mountView()
    await settle()
    expect(api.mcpAuth.callback).toHaveBeenCalledWith({ body: { state: STATE, error: 'access_denied', errorDescription: 'The user denied the request.' } })
    const card = byTestId(testIds.oauthCallbackError)!
    expect(card.dataset.code).toBe('auth_invalid')
    expect(card.textContent).toContain('Linear answered: access_denied (<b>The user denied the request.</b>)')
    expect(card.querySelector('b')).toBeNull()
    byTestId(testIds.oauthCallbackRetry)!.click()
    await settle()
    expect(api.mcpAuth.start).toHaveBeenCalledWith({ params: { id: 'linear' }, body: { returnTo: '/plugins/core-mcp' } })
    expect(mocks.assign).toHaveBeenCalledWith(mcpAuthStart().authorizationUrl)
    expect((byTestId(testIds.oauthCallbackRetry) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a failed Try again shows its own error', async () => {
    mocks.query = { error: 'access_denied', state: STATE }
    api.mcpAuth.callback.mockRejectedValue(new HarnessError({ code: 'auth_invalid', message: 'Denied.', details: { serverId: 'docs', projectId: projectId(1) } }))
    api.mcpAuth.projectStart.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'Approve the server first.', details: { reason: 'untrusted' } }))
    mountView()
    await settle()
    byTestId(testIds.oauthCallbackRetry)!.click()
    await settle()
    expect(api.mcpAuth.projectStart).toHaveBeenCalledWith({ params: { id: projectId(1), serverId: 'docs' }, body: { returnTo: '/settings/projects' } })
    expect(byTestId(testIds.oauthCallbackError)!.dataset.code).toBe('conflict')
  })

  it('a page without a state posts nothing and explains itself', async () => {
    mocks.query = { code: 'sample-code' }
    mountView()
    await settle()
    expect(mocks.replace).toHaveBeenCalledWith({ query: {} })
    expect(api.mcpAuth.callback).not.toHaveBeenCalled()
    expect(root().dataset.state).toBe('error')
    const card = byTestId(testIds.oauthCallbackError)!
    expect(card.dataset.code).toBe('validation_error')
    expect(card.textContent).toContain('This page finishes a sign-in to an MCP server. Start it from the MCP servers list.')
    byTestId(testIds.oauthCallbackBack)!.click()
    expect(mocks.navigateTo).toHaveBeenCalledWith('/plugins/core-mcp', { replace: true })
  })

  it('reads the query once: a later change does not post again', async () => {
    mocks.query = { code: 'sample-code', state: STATE }
    api.mcpAuth.callback.mockResolvedValue(mcpAuthCallbackResult())
    api.mcp.list.mockResolvedValue({ items: [] })
    mountView()
    mocks.query = { code: 'other-code', state: 'otherState00000000000001' }
    await settle()
    expect(api.mcpAuth.callback).toHaveBeenCalledTimes(1)
    expect(api.mcpAuth.callback).toHaveBeenCalledWith({ body: { state: STATE, code: 'sample-code' } })
    // Unknown server name: the id stands in.
    expect(mocks.toast.success).toHaveBeenCalledWith('Signed in to linear.')
  })
})
