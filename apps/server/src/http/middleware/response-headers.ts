// Changing the headers of the response after `await next()`. Owner: W1.1.
import type { AppContext } from '../types.ts'

/**
 * Runs `apply` on the headers of `c.res`. A response whose headers are immutable (for example one returned by
 * `fetch()`) is re-wrapped once (same status, headers and body stream) and `apply` runs on the copy.
 */
export function updateResponseHeaders(c: AppContext, apply: (headers: Headers) => void): void {
  try {
    apply(c.res.headers)
  }
  catch (error) {
    if (!(error instanceof TypeError))
      throw error
    c.res = new Response(c.res.body, c.res)
    apply(c.res.headers)
  }
}

/** Sets a header unless the response already has it (routes may set their own value). */
export function setHeaderIfAbsent(headers: Headers, name: string, value: string): void {
  if (!headers.has(name))
    headers.set(name, value)
}
