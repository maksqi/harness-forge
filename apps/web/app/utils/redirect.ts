// Login redirects (docs/UI.md 6): `/login?redirect=<path>` accepts only in-app paths. Auto-imported (utils/).

export const LOGIN_PATH = '/login'

/** Control characters (C0 and DEL) never belong in a redirect target. */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7F)
      return true
  }
  return false
}

/**
 * The `?redirect=` value when it is a safe in-app path: a string starting with a single `/` (not `//` or `/\`,
 * which browsers treat as another origin) without control characters. Anything else yields null. Repeated query
 * values use the first one.
 */
export function safeRedirectPath(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw[1] === '/' || raw[1] === '\\' || hasControlChars(raw))
    return null
  return raw
}

/** True for `/login` and its query / hash variants. */
export function isLoginPath(path: string): boolean {
  return path === LOGIN_PATH || /^\/login[?#/]/.test(path)
}

/** `/login`, with `?redirect=<path>` when `redirect` is a safe in-app path other than `/` or the login page. */
export function loginPath(redirect?: string | null): string {
  const target = safeRedirectPath(redirect)
  if (!target || target === '/' || isLoginPath(target))
    return LOGIN_PATH
  return `${LOGIN_PATH}?redirect=${encodeURIComponent(target)}`
}

/** Where to go after a successful login: the safe `?redirect=` target, else `/`. */
export function afterLoginPath(redirect: unknown): string {
  const target = safeRedirectPath(redirect)
  return target && !isLoginPath(target) ? target : '/'
}

export interface AuthRedirectTarget {
  path: string
  fullPath: string
  query: Record<string, unknown>
}

export interface AuthRedirectState {
  /** A password is configured and there is no session (`AuthStatus.enabled && !authenticated`). */
  requiresLogin: boolean
  /** The status is known and grants access (`AuthStatus.authenticated`). */
  authenticated: boolean
}

/**
 * The decision of the global auth middleware for one navigation (docs/UI.md 6): pages redirect to
 * `/login?redirect=<path>` when a login is required; `/login` redirects to the `?redirect=` target (or `/`) when
 * already authenticated and stays put otherwise (including when the auth status is unknown). Null = no redirect.
 */
export function authRedirectFor(to: AuthRedirectTarget, auth: AuthRedirectState): string | null {
  if (to.path === LOGIN_PATH)
    return auth.authenticated ? afterLoginPath(to.query.redirect) : null
  return auth.requiresLogin ? loginPath(to.fullPath) : null
}
