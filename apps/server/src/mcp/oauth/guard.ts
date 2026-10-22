// The URL guard of MCP OAuth (Phase 14, ADR-059; W14.1-T4; ARCHITECTURE.md 6.39 / 10.14). On top of the AI SDK's own
// guard (`auth()` refuses private and loopback literals and pins DNS for every cross-origin OAuth URL, as long as no
// custom `fetch` is passed: the harness never passes one), the harness checks:
//
// - the authorization server a server's protected-resource metadata names (`validateAuthorizationServerURL`): `https:`
//   on a public host, unless it shares the MCP server's origin or both are loopback (a local test server);
// - the authorization URL handed to the browser: `http(s):` only, no credentials;
// - the protected resource of the metadata (`validateResourceURL`): the SDK's own rule (same origin, a path prefix of
//   the MCP URL), copied so the provider can also tell "no OAuth metadata at all" apart (`McpOAuthGuardError` reason
//   `no-oauth`: "This server asked for sign-in but does not support OAuth.").
// The same authorization-server rule decides whether the token revocation may reach an endpoint (`revoke.ts`).
// Messages never quote a URL query.
import { classifyAddress } from '../../security/ssrf.ts'

/** The message of a server that answers 401 but publishes no OAuth metadata (the clearer error of a sign-in start). */
export const NO_OAUTH_MESSAGE = 'This server asked for sign-in but does not support OAuth.'
/** The message of an authorization server the guard refuses. */
export const AUTHORIZATION_SERVER_REFUSED_MESSAGE = 'The authorization server of this MCP server is not allowed: it must use https on a public address, or share the MCP server\'s address.'
/** The message of an authorization URL that is not http(s). */
export const AUTHORIZATION_URL_REFUSED_MESSAGE = 'The authorization server answered with an authorization URL that is not an http or https address.'
/** The message of protected-resource metadata that names another resource. */
export const RESOURCE_MISMATCH_MESSAGE = 'The OAuth metadata of this MCP server names another resource.'

export type McpOAuthGuardReason = 'no-oauth' | 'authorization-server' | 'authorization-url' | 'resource'

const GUARD_MESSAGES: Readonly<Record<McpOAuthGuardReason, string>> = {
  'no-oauth': NO_OAUTH_MESSAGE,
  'authorization-server': AUTHORIZATION_SERVER_REFUSED_MESSAGE,
  'authorization-url': AUTHORIZATION_URL_REFUSED_MESSAGE,
  'resource': RESOURCE_MISMATCH_MESSAGE,
}

/** A refusal of the guard (thrown from the provider's validation members; the sign-in maps it to a safe answer). */
export class McpOAuthGuardError extends Error {
  override readonly name = 'McpOAuthGuardError'
  readonly reason: McpOAuthGuardReason

  constructor(reason: McpOAuthGuardReason) {
    super(GUARD_MESSAGES[reason])
    this.reason = reason
  }
}

/** True for `McpOAuthGuardError` (also across module copies: checked by name). */
export function isMcpOAuthGuardError(error: unknown): error is McpOAuthGuardError {
  return error instanceof McpOAuthGuardError || (error instanceof Error && error.name === 'McpOAuthGuardError' && 'reason' in error)
}

function parse(value: string | URL): URL | null {
  try {
    return new URL(String(value))
  }
  catch {
    return null
  }
}

function isHttp(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/** The host name of a URL: lowercase, without IPv6 brackets and a trailing dot. */
export function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '')
}

/** `localhost`, `*.localhost`, 127.0.0.0/8 and `::1` (RFC 8252 7.3 / RFC 6761 6.3). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '')
  if (host === 'localhost' || host.endsWith('.localhost'))
    return true
  return isIpLiteral(host) && classifyAddress(host) === 'loopback'
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/** A host that is never a public authorization server: an IP literal that is not public, or a local-only name. */
function isNonPublicHost(host: string): boolean {
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    return true
  return isIpLiteral(host) && classifyAddress(host) !== 'public'
}

/**
 * True when an MCP server at `serverUrl` may use the authorization server (or one of its endpoints) at `endpointUrl`:
 * the same origin; or both loopback; or `https:` on a public host (no credentials in the URL).
 */
export function isAllowedAuthorizationServer(serverUrl: string | URL, endpointUrl: string | URL): boolean {
  const server = parse(serverUrl)
  const endpoint = parse(endpointUrl)
  if (server === null || endpoint === null || !isHttp(server) || !isHttp(endpoint))
    return false
  if (endpoint.username !== '' || endpoint.password !== '')
    return false
  if (endpoint.origin === server.origin)
    return true
  if (isLoopbackHostname(hostnameOf(server)) && isLoopbackHostname(hostnameOf(endpoint)))
    return true
  return endpoint.protocol === 'https:' && !isNonPublicHost(hostnameOf(endpoint))
}

/** `OAuthClientProvider.validateAuthorizationServerURL`: throws `McpOAuthGuardError` (`authorization-server`). */
export function validateAuthorizationServerUrl(serverUrl: string | URL, authorizationServerUrl: string | URL): void {
  if (!isAllowedAuthorizationServer(serverUrl, authorizationServerUrl))
    throw new McpOAuthGuardError('authorization-server')
}

/** The authorization URL handed to the browser (its href): http(s) without credentials, else `McpOAuthGuardError`. */
export function checkAuthorizationUrl(value: string | URL): string {
  const url = parse(value)
  if (url === null || !isHttp(url) || url.hostname === '' || url.username !== '' || url.password !== '')
    throw new McpOAuthGuardError('authorization-url')
  return url.href
}

/**
 * The SDK's resource check (`checkResourceAllowed` of `@ai-sdk/mcp`): the metadata's `resource` must share the MCP
 * URL's origin and be a path prefix of it.
 */
export function isResourceAllowed(requested: string | URL, configured: string | URL): boolean {
  const requestedUrl = parse(requested)
  const configuredUrl = parse(configured)
  if (requestedUrl === null || configuredUrl === null || requestedUrl.origin !== configuredUrl.origin)
    return false
  if (requestedUrl.pathname.length < configuredUrl.pathname.length)
    return false
  const requestedPath = requestedUrl.pathname.endsWith('/') ? requestedUrl.pathname : `${requestedUrl.pathname}/`
  const configuredPath = configuredUrl.pathname.endsWith('/') ? configuredUrl.pathname : `${configuredUrl.pathname}/`
  return requestedPath.startsWith(configuredPath)
}

/**
 * `OAuthClientProvider.validateResourceURL` (the SDK hands the MCP URL and the metadata's `resource`): no metadata →
 * `McpOAuthGuardError` `no-oauth` (the server publishes no protected-resource metadata, so it cannot be signed in to);
 * a resource the MCP URL does not fall under → `resource`; else the resource URL sent to the authorization server.
 */
export function selectResourceUrl(serverUrl: string | URL, resource: string | undefined): URL {
  if (resource === undefined || resource === '')
    throw new McpOAuthGuardError('no-oauth')
  if (!isResourceAllowed(serverUrl, resource))
    throw new McpOAuthGuardError('resource')
  return new URL(resource)
}

/** `url` without its query and fragment (for messages and logs). */
export function withoutQuery(url: string): string {
  const parsed = parse(url)
  if (parsed === null)
    return url.replace(/[?#].*$/s, '')
  return `${parsed.origin}${parsed.pathname}`
}
