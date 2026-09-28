import { describe, expect, it } from 'vitest'
import { afterLoginPath, authRedirectFor, loginPath, safeRedirectPath } from './redirect'

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
})
