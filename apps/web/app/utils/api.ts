// The fetch wrapper behind `$api` (docs/API.md 2.2, 3.4): a 401 whose envelope code is `unauthorized` means the
// session is gone and triggers the login redirect. Only that code redirects: `auth_invalid` (a provider rejected
// its key) is a 502 and never does, and the login request itself answers 401 for a wrong password.
// Auto-imported (utils/).
import { harnessErrorEnvelopeSchema } from '@harness-forge/shared'

/** The endpoint whose 401 means "wrong password", not "session expired". */
export const LOGIN_ENDPOINT = '/api/auth/login'

export interface ApiFetchOptions {
  /** The underlying fetch; default `globalThis.fetch` (resolved per call so tests can stub it). */
  fetch?: typeof globalThis.fetch
  /** Called for every 401 `unauthorized` response except the login request's; `url` is the request URL. */
  onUnauthorized: (url: string) => void
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string')
    return input
  return input instanceof URL ? input.href : input.url
}

function requestPath(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname
  }
  catch {
    return url
  }
}

/** True when the response is a 401 with the `unauthorized` envelope code (read from a clone; the body stays unread). */
export async function isUnauthorizedResponse(response: Response): Promise<boolean> {
  if (response.status !== 401)
    return false
  try {
    const parsed = harnessErrorEnvelopeSchema.safeParse(await response.clone().json())
    return parsed.success && parsed.data.error.code === 'unauthorized'
  }
  catch {
    return false
  }
}

/**
 * Wraps `fetch` for `createApiClient`: responses pass through unchanged (the client still throws its
 * `HarnessError`); a 401 `unauthorized` outside the login request also calls `onUnauthorized`.
 */
export function createApiFetch(options: ApiFetchOptions): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await (options.fetch ?? globalThis.fetch)(input, init)
    if (response.status === 401) {
      const url = requestUrl(input)
      if (requestPath(url) !== LOGIN_ENDPOINT && await isUnauthorizedResponse(response))
        options.onUnauthorized(url)
    }
    return response
  }
}
