// Best-effort RFC 7009 token revocation of an MCP sign-out (Phase 14, ADR-059; W14.1-T5; ARCHITECTURE.md 6.39): the
// authorization server's metadata (RFC 8414 `/.well-known/oauth-authorization-server`, then OpenID discovery) names
// its `revocation_endpoint`; the refresh token (else the access token) is posted there as a form with the client's
// authentication (`client_secret_basic` or `client_secret_post` for a client with a secret, the `client_id` for a public
// client). Every request goes through `safeFetch` (GET for the metadata, POST for the revocation: never a redirect,
// small caps, 10 s in all) and every URL must pass the authorization-server rule of `guard.ts` against the MCP server's
// URL (https on a public host, or the MCP server's origin, or loopback for a loopback server; the `safeFetch` of a
// loopback pair allows loopback). The result is only an outcome for a `debug` log line: a failure never fails the
// sign-out, and no token, secret or URL query is ever logged.
import type { OAuthAuthorizationServerInformation, OAuthClientInformation, OAuthTokens } from '@ai-sdk/mcp'
import type { SafeFetch } from '../../security/types.ts'
import { Buffer } from 'node:buffer'
import { hostnameOf, isAllowedAuthorizationServer, isLoopbackHostname } from './guard.ts'

/** The time budget of a whole revocation (metadata + POST). */
export const MCP_OAUTH_REVOKE_TIMEOUT_MS = 10_000
/** The cap of a metadata document. */
const METADATA_MAX_BYTES = 65_536
/** The cap of a revocation answer (never read beyond the status). */
const ANSWER_MAX_BYTES = 4096

export type RevokeOutcome = 'revoked' | 'no-token' | 'unsupported' | 'refused' | 'failed'

export interface RevokeInput {
  /** The MCP server URL (the endpoint rule's reference). */
  readonly mcpUrl: string
  /** The authorization server pin of the record. */
  readonly as: OAuthAuthorizationServerInformation
  readonly tokens: OAuthTokens | undefined
  /** The OAuth client the tokens were issued to (with its secret for a confidential client). */
  readonly client: OAuthClientInformation
}

export interface RevokeOptions {
  /** The `safeFetch` to use; `allowLoopback` is true only when the MCP server and the endpoint are both loopback. */
  readonly fetchFor: (allowLoopback: boolean) => SafeFetch
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !URL.canParse(value))
    return null
  return new URL(value)
}

/** The metadata URLs of an issuer (RFC 8414 path insertion, then OpenID discovery). */
function metadataUrls(base: URL): URL[] {
  const path = base.pathname.replace(/\/+$/, '')
  const urls = [new URL(`/.well-known/oauth-authorization-server${path}`, base.origin)]
  if (path !== '')
    urls.push(new URL('/.well-known/oauth-authorization-server', base.origin))
  urls.push(new URL(`${path}/.well-known/openid-configuration`, base.origin))
  return urls
}

function loopbackPair(mcpUrl: string, url: URL): boolean {
  const mcp = parseUrl(mcpUrl)
  return mcp !== null && isLoopbackHostname(hostnameOf(mcp)) && isLoopbackHostname(hostnameOf(url))
}

/** Revokes the refresh token (else the access token); see the module comment. Never rejects. */
export async function revokeTokens(input: RevokeInput, options: RevokeOptions): Promise<RevokeOutcome> {
  const token = input.tokens?.refresh_token ?? input.tokens?.access_token
  if (token === undefined || token === '')
    return 'no-token'
  const timeout = AbortSignal.timeout(options.timeoutMs ?? MCP_OAUTH_REVOKE_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])
  try {
    const base = parseUrl(input.as.issuer) ?? parseUrl(input.as.authorizationServerUrl)
    if (base === null || !isAllowedAuthorizationServer(input.mcpUrl, base))
      return 'unsupported'
    let metadata: Record<string, unknown> | null = null
    for (const url of metadataUrls(base)) {
      if (!isAllowedAuthorizationServer(input.mcpUrl, url))
        continue
      const fetchMetadata = options.fetchFor(loopbackPair(input.mcpUrl, url))
      const answer = await fetchMetadata(url.href, { maxBytes: METADATA_MAX_BYTES, maxRedirects: 0, signal, headers: { accept: 'application/json' } }).catch(() => null)
      if (answer === null || answer.status !== 200)
        continue
      try {
        const parsed = JSON.parse(new TextDecoder().decode(answer.body)) as unknown
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>
          break
        }
      }
      catch {}
    }
    const endpoint = parseUrl(metadata?.revocation_endpoint)
    if (endpoint === null || !isAllowedAuthorizationServer(input.mcpUrl, endpoint))
      return 'unsupported'
    const supported: unknown = metadata?.revocation_endpoint_auth_methods_supported
    const methods = Array.isArray(supported) ? supported.filter((value): value is string => typeof value === 'string') : []
    const params = new URLSearchParams({ token, token_type_hint: input.tokens?.refresh_token === undefined ? 'access_token' : 'refresh_token' })
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' }
    const secret = input.client.client_secret
    if (secret !== undefined && secret !== '' && (methods.length === 0 || methods.includes('client_secret_basic'))) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(input.client.client_id)}:${encodeURIComponent(secret)}`).toString('base64')}`
    }
    else {
      params.set('client_id', input.client.client_id)
      if (secret !== undefined && secret !== '')
        params.set('client_secret', secret)
    }
    const post = options.fetchFor(loopbackPair(input.mcpUrl, endpoint))
    const answer = await post(endpoint.href, { method: 'POST', body: params.toString(), headers, maxBytes: ANSWER_MAX_BYTES, maxRedirects: 0, signal })
    return answer.status === 200 ? 'revoked' : 'refused'
  }
  catch {
    return 'failed'
  }
}
