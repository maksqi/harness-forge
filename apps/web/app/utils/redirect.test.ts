import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { accessBlockedMessage, afterLoginPath, authRedirectFor, isSharePath, loginPath, safeRedirectPath } from './redirect'

const TOKEN = '0bN3aK9xQ7fLm2PzRt5_uV-wXy8zAb1Cd2Ef3G'

function route(fullPath: string) {
  const url = new URL(fullPath, 'http://localhost')
  return { path: url.pathname, fullPath, query: Object.fromEntries(url.searchParams) }
}

describe('redirect helpers', () => {
  it('accepts only in-app paths', () => {
    expect(safeRedirectPath('/chat/abc?x=1')).toBe('/chat/abc?x=1')
    expect(safeRedirectPath(['/plugins', '/other'])).toBe('/plugins')
    expect(safeRedirectPath('//evil.example')).toBeNull()
    expect(safeRedirectPath('/\\evil.example')).toBeNull()
    expect(safeRedirectPath('https://evil.example')).toBeNull()
    expect(safeRedirectPath('javascript:alert(1)')).toBeNull()
    expect(safeRedirectPath('/ok\nno')).toBeNull()
    expect(safeRedirectPath(undefined)).toBeNull()
  })

  it('builds the login path with a safe redirect', () => {
    expect(loginPath('/plugins?filter=tools')).toBe('/login?redirect=%2Fplugins%3Ffilter%3Dtools')
    expect(loginPath('/')).toBe('/login')
    expect(loginPath('/login?redirect=%2F')).toBe('/login')
    expect(loginPath('//evil.example')).toBe('/login')
  })

  it('goes to the redirect target after login, never back to /login', () => {
    expect(afterLoginPath('/settings/general')).toBe('/settings/general')
    expect(afterLoginPath('/login')).toBe('/')
    expect(afterLoginPath('//evil.example')).toBe('/')
  })
})

describe('authRedirectFor', () => {
  const noPassword = { requiresLogin: false, authenticated: true }
  const needsLogin = { requiresLogin: true, authenticated: false }
  const unknown = { requiresLogin: false, authenticated: false }

  it('sends pages to /login when a login is required', () => {
    expect(authRedirectFor(route('/chat/abc'), needsLogin)).toBe('/login?redirect=%2Fchat%2Fabc')
    expect(authRedirectFor(route('/'), needsLogin)).toBe('/login')
    expect(authRedirectFor(route('/chat/abc'), noPassword)).toBeNull()
    expect(authRedirectFor(route('/chat/abc'), unknown)).toBeNull()
  })

  it('leaves /login when already authenticated and stays while the status is unknown', () => {
    expect(authRedirectFor(route('/login?redirect=%2Fplugins'), noPassword)).toBe('/plugins')
    expect(authRedirectFor(route('/login?redirect=%2F%2Fevil.example'), noPassword)).toBe('/')
    expect(authRedirectFor(route('/login'), needsLogin)).toBeNull()
    expect(authRedirectFor(route('/login'), unknown)).toBeNull()
  })

  it('never sends the public share page to /login, whatever the auth state', () => {
    for (const state of [needsLogin, noPassword, unknown]) {
      expect(authRedirectFor(route(`/share/${TOKEN}`), state)).toBeNull()
      expect(authRedirectFor(route(`/share/${TOKEN}?utm=x#top`), state)).toBeNull()
      expect(authRedirectFor(route('/SHARE/whatever'), state)).toBeNull()
    }
    // Only the share page itself is public: look-alike paths still need a login.
    expect(authRedirectFor(route('/shares'), needsLogin)).toBe('/login?redirect=%2Fshares')
    expect(authRedirectFor(route('/settings/data'), needsLogin)).toBe('/login?redirect=%2Fsettings%2Fdata')
  })
})

describe('isSharePath', () => {
  it('matches /share/<token> only', () => {
    expect(isSharePath(`/share/${TOKEN}`)).toBe(true)
    expect(isSharePath('/share/not-a-token')).toBe(true)
    expect(isSharePath('/Share/x')).toBe(true)
    expect(isSharePath('/share')).toBe(false)
    expect(isSharePath('/shares')).toBe(false)
    expect(isSharePath('/shared/x')).toBe(false)
    expect(isSharePath('/chat/share/x')).toBe(false)
    expect(isSharePath('/login?redirect=/share/x')).toBe(false)
    expect(isSharePath('')).toBe(false)
  })
})

describe('accessBlockedMessage', () => {
  it('returns the server message when the auth status is refused (e.g. the DNS rebinding guard)', () => {
    const message = 'Without a password this server only answers requests addressed to localhost or 127.0.0.1 (DNS rebinding protection).'
    expect(accessBlockedMessage(new HarnessError({ code: 'forbidden', message }))).toBe(message)
    expect(accessBlockedMessage({ error: { code: 'forbidden', message } })).toBe(message)
  })

  it('ignores fresh-auth refusals and every other failure', () => {
    expect(accessBlockedMessage(new HarnessError({ code: 'forbidden', message: 'x', action: 'login' }))).toBeNull()
    expect(accessBlockedMessage(new HarnessError({ code: 'not_implemented', message: 'x' }))).toBeNull()
    expect(accessBlockedMessage(new TypeError('Failed to fetch'))).toBeNull()
  })
})
