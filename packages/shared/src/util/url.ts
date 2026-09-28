// URL helpers shared by the schemas. Isomorphic: uses only the WHATWG `URL` global.
import { hasControlChars } from './text.ts'

export interface HttpUrlOptions {
  /** Allowed protocols (default `http:` and `https:`). */
  protocols?: readonly string[]
  /** Allow `user:password@` credentials (default false). */
  credentials?: boolean
  /** Allow a query string (default true). */
  query?: boolean
  /** Allow a fragment (default true). */
  fragment?: boolean
}

const HTTP_PROTOCOLS = ['http:', 'https:'] as const

/**
 * Parses an absolute http(s) URL. Returns `null` for relative URLs, other protocols, whitespace or control
 * characters, and for credentials / query / fragment when the options forbid them.
 */
export function parseHttpUrl(value: string, options: HttpUrlOptions = {}): URL | null {
  if (value.length === 0 || value.length > 2048 || /\s/.test(value) || hasControlChars(value))
    return null
  if (!URL.canParse(value))
    return null
  const url = new URL(value)
  const protocols: readonly string[] = options.protocols ?? HTTP_PROTOCOLS
  if (!protocols.includes(url.protocol) || url.hostname === '')
    return null
  if (options.credentials !== true && (url.username !== '' || url.password !== ''))
    return null
  if (options.query === false && value.includes('?'))
    return null
  if (options.fragment === false && value.includes('#'))
    return null
  return url
}

/** True for an absolute http(s) URL without credentials. */
export function isHttpUrl(value: string): boolean {
  return parseHttpUrl(value) !== null
}
