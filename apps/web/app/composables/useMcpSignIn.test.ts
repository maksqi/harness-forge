// useMcpSignIn (Phase 14, ADR-059; docs/UI.md 8.14, 11.10; W14.7-T3): the start through the store (no fresh auth), the
// return path (the current location through `safeRedirectPath`, never the callback page), the same-tab navigation to
// an http(s) authorization URL only, the "Signed in" / "Signed out" toasts, `complete` with the target's refetch, and
// `busyKey`.
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginsStore } from '~/stores/plugins'
import { useProjectMcpStore } from '~/stores/project-mcp'
import { mcpAuthCallbackResult, mcpAuthStart, mcpServer, mcpServerNeedsAuth, projectId, projectMcpList, projectMcpServer } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { mcpSignInKey, safeAuthorizationUrl, signInReturnTo, useMcpSignIn } from './useMcpSignIn'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  assign: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('~/components/oauth/location', () => ({ assignLocation: mocks.assign }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

const P1 = projectId(1)

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.assign.mockReset()
  mocks.toast.success.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  window.history.replaceState(null, '', '/plugins/core-mcp?tab=mcp')
})

afterEach(() => {
  disposePinia(pinia)
  window.history.replaceState(null, '', '/')
})

describe('useMcpSignIn: helpers', () => {
  it('keys a target by its kind, project and server', () => {
    expect(mcpSignInKey({ kind: 'global', serverId: 'linear' })).toBe('global:linear')
    expect(mcpSignInKey({ kind: 'project', projectId: 'prj_a000000000000001', serverId: 'docs' })).toBe('project:prj_a000000000000001:docs')
  })

  it('keeps a safe in-app return path, never the callback page or another origin', () => {
    expect(signInReturnTo(undefined, '/chat/abc?x=1#m')).toBe('/chat/abc?x=1#m')
    expect(signInReturnTo('/settings/projects', '/chat/abc')).toBe('/settings/projects')
    expect(signInReturnTo('//evil.example.com/x', '/chat/abc')).toBeUndefined()
    expect(signInReturnTo('/\\evil.example.com', null)).toBeUndefined()
    expect(signInReturnTo('https://evil.example.com/', null)).toBeUndefined()
    expect(signInReturnTo('/a b', null)).toBeUndefined()
    expect(signInReturnTo(`/${'a'.repeat(600)}`, null)).toBeUndefined()
    expect(signInReturnTo('/oauth/callback?code=x', null)).toBeUndefined()
    expect(signInReturnTo('/OAuth/Callback', null)).toBeUndefined()
    expect(signInReturnTo(undefined, null)).toBeUndefined()
    // The default is the current location (the SPA's route.fullPath).
    expect(signInReturnTo(undefined)).toBe('/plugins/core-mcp?tab=mcp')
  })

  it('navigates only to http(s) authorization URLs', () => {
    expect(safeAuthorizationUrl('https://auth.example.com/authorize?state=s')).toBe('https://auth.example.com/authorize?state=s')
    expect(safeAuthorizationUrl('http://127.0.0.1:9000/authorize')).toBe('http://127.0.0.1:9000/authorize')
    expect(safeAuthorizationUrl('javascript:alert(1)')).toBeNull()
    expect(safeAuthorizationUrl('data:text/html,hi')).toBeNull()
    expect(safeAuthorizationUrl('/relative')).toBeNull()
    expect(safeAuthorizationUrl(null)).toBeNull()
  })
})

describe('useMcpSignIn: start', () => {
  it('starts a global sign-in with the current path and goes to the authorization URL in the same tab', async () => {
    api.mcpAuth.start.mockResolvedValue(mcpAuthStart())
    const signIn = useMcpSignIn()
    const pending = signIn.start({ kind: 'global', serverId: 'linear' }, { name: 'Linear' })
    expect(signIn.busyKey.value).toBe('global:linear')
    await expect(pending).resolves.toBe('redirected')
    expect(api.mcpAuth.start).toHaveBeenCalledWith({ params: { id: 'linear' }, body: { returnTo: '/plugins/core-mcp?tab=mcp' } })
    expect(mocks.assign).toHaveBeenCalledWith(mcpAuthStart().authorizationUrl)
    // The page is leaving: the row stays busy.
    expect(signIn.busyKey.value).toBe('global:linear')
    // Back from the authorization server through the back-forward cache: idle again.
    window.dispatchEvent(new Event('pageshow'))
    expect(signIn.busyKey.value).toBeNull()
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })

  it('starts a project sign-in with an explicit return path', async () => {
    api.mcpAuth.projectStart.mockResolvedValue(mcpAuthStart())
    await expect(useMcpSignIn().start({ kind: 'project', projectId: P1, serverId: 'docs' }, { returnTo: '/settings/projects' })).resolves.toBe('redirected')
    expect(api.mcpAuth.projectStart).toHaveBeenCalledWith({ params: { id: P1, serverId: 'docs' }, body: { returnTo: '/settings/projects' } })
  })

  it('omits the return path on the callback page itself', async () => {
    window.history.replaceState(null, '', '/oauth/callback')
    api.mcpAuth.start.mockResolvedValue(mcpAuthStart())
    await useMcpSignIn().start({ kind: 'global', serverId: 'linear' })
    expect(api.mcpAuth.start).toHaveBeenCalledWith({ params: { id: 'linear' }, body: {} })
  })

  it('an answer without an authorization URL is a sign-in that already works: toast, no navigation', async () => {
    api.mcpAuth.start.mockResolvedValue(mcpAuthStart({ authorizationUrl: null }))
    const signIn = useMcpSignIn()
    await expect(signIn.start({ kind: 'global', serverId: 'linear' }, { name: 'Linear' })).resolves.toBe('authorized')
    expect(mocks.toast.success).toHaveBeenCalledWith('Signed in to Linear.')
    expect(mocks.assign).not.toHaveBeenCalled()
    expect(signIn.busyKey.value).toBeNull()
  })

  it('refuses an authorization URL that is not http(s) and frees the row', async () => {
    api.mcpAuth.start.mockResolvedValue({ ...mcpAuthStart(), authorizationUrl: 'javascript:alert(1)' })
    const signIn = useMcpSignIn()
    await expect(signIn.start({ kind: 'global', serverId: 'linear' }, { name: 'Linear' })).rejects.toMatchObject({ code: 'provider_error' })
    expect(mocks.assign).not.toHaveBeenCalled()
    expect(signIn.busyKey.value).toBeNull()
  })

  it('throws a refused start and frees the row', async () => {
    api.mcpAuth.start.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'The server is disabled.', details: { reason: 'disabled' } }))
    const signIn = useMcpSignIn()
    await expect(signIn.start({ kind: 'global', serverId: 'linear' })).rejects.toMatchObject({ code: 'conflict' })
    expect(signIn.busyKey.value).toBeNull()
    expect(mocks.assign).not.toHaveBeenCalled()
  })
})

describe('useMcpSignIn: sign-out and complete', () => {
  it('signs a global or project server out with a toast', async () => {
    api.mcpAuth.signOut.mockResolvedValue(mcpServerNeedsAuth())
    api.mcpAuth.projectSignOut.mockResolvedValue(projectMcpServer({ id: 'docs', transport: 'http', state: 'needs-auth', missingVariables: [] }))
    const signIn = useMcpSignIn()
    await signIn.signOut({ kind: 'global', serverId: 'linear' }, 'Linear')
    expect(api.mcpAuth.signOut).toHaveBeenCalledWith({ params: { id: 'linear' } })
    expect(mocks.toast.success).toHaveBeenLastCalledWith('Signed out of Linear.')
    await signIn.signOut({ kind: 'project', projectId: P1, serverId: 'docs' })
    expect(api.mcpAuth.projectSignOut).toHaveBeenCalledWith({ params: { id: P1, serverId: 'docs' } })
    expect(mocks.toast.success).toHaveBeenLastCalledWith('Signed out of docs.')
  })

  it('a failed sign-out throws and shows no toast', async () => {
    api.mcpAuth.signOut.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'Unknown server.' }))
    await expect(useMcpSignIn().signOut({ kind: 'global', serverId: 'linear' }, 'Linear')).rejects.toMatchObject({ code: 'not_found' })
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })

  it('completes a callback and refetches the list of its target', async () => {
    const body = { state: 'sampleState0000000000001', code: 'sample-code' }
    api.mcpAuth.callback.mockResolvedValueOnce(mcpAuthCallbackResult())
    api.mcp.list.mockResolvedValue({ items: [mcpServer({ id: 'linear', name: 'Linear' })] })
    const signIn = useMcpSignIn()
    await expect(signIn.complete(body)).resolves.toEqual(mcpAuthCallbackResult())
    expect(api.mcpAuth.callback).toHaveBeenCalledWith({ body })
    expect(usePluginsStore().mcp.map(server => server.name)).toEqual(['Linear'])

    api.mcpAuth.callback.mockResolvedValueOnce(mcpAuthCallbackResult({ target: { kind: 'project', projectId: P1, serverId: 'docs' }, returnTo: null }))
    api.projectMcp.list.mockResolvedValue(projectMcpList({ items: [projectMcpServer({ id: 'docs', name: 'Docs', transport: 'http', state: 'connected', missingVariables: [] })], variables: [] }))
    await signIn.complete(body)
    expect(useProjectMcpStore().byId(P1, 'docs')?.name).toBe('Docs')
  })

  it('a failed refetch still answers the callback; a refused callback throws', async () => {
    const body = { state: 'sampleState0000000000001', error: 'access_denied' }
    api.mcpAuth.callback.mockResolvedValueOnce(mcpAuthCallbackResult())
    api.mcp.list.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Database is locked.' }))
    await expect(useMcpSignIn().complete(body)).resolves.toEqual(mcpAuthCallbackResult())
    api.mcpAuth.callback.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'This sign-in link was already used or expired.', details: { reason: 'stale' } }))
    await expect(useMcpSignIn().complete(body)).rejects.toMatchObject({ code: 'conflict' })
  })
})
