// The pre-sign-in probe of MCP OAuth (Phase 14, ADR-059; W14.1-T4; open point 12): one unauthenticated request to the
// MCP server URL only (an `initialize` POST for Streamable HTTP, the event-stream GET for SSE), with the global `fetch`,
// `redirect: 'error'` and a 20 s timeout (the transport keeps the `WWW-Authenticate` parameters private, so the sign-in
// reads them here): a 401 with `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` gives `auth()` the metadata
// URL and the scopes to ask for. Every authorization-server URL goes through `auth()` and its guard, never through
// here. The answer's body is never read (an SSE answer is cut right after the headers); nothing is logged.
import { appVersion } from '../../paths.ts'

/** The probe's timeout (the MCP connect timeout). */
export const MCP_OAUTH_PROBE_TIMEOUT_MS = 20_000

/** The protocol version the probe's `initialize` names (the server answers before it negotiates anything). */
const PROBE_PROTOCOL_VERSION = '2025-11-25'

export interface McpProbeResult {
  /** The HTTP status of the answer. */
  readonly status: number
  /** The server asked for credentials (401). */
  readonly unauthorized: boolean
  /** `resource_metadata` of a Bearer challenge (an absolute URL), when the server named one. */
  readonly resourceMetadataUrl?: URL
  /** `scope` of a Bearer challenge, when the server named one. */
  readonly scope?: string
}

export interface McpProbeOptions {
  /** Default `MCP_OAUTH_PROBE_TIMEOUT_MS`. */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/**
 * The parameters of a `WWW-Authenticate: Bearer …` challenge, as `@ai-sdk/mcp` reads them (`extractWWWAuthenticateParams`):
 * `resource_metadata` (when it parses as a URL) and `scope`; nothing for another scheme.
 */
export function readBearerChallenge(header: string | null): { resourceMetadataUrl?: URL, scope?: string } {
  if (header === null)
    return {}
  const [type, rest] = header.split(' ')
  if (type === undefined || type.toLowerCase() !== 'bearer' || !rest)
    return {}
  const metadata = header.match(/(?:^|[,\s])resource_metadata="([^"]*)"/i)?.[1]
  const scope = header.match(/(?:^|[,\s])scope="([^"]*)"/i)?.[1]
  let resourceMetadataUrl: URL | undefined
  if (metadata !== undefined && URL.canParse(metadata))
    resourceMetadataUrl = new URL(metadata)
  return {
    ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
    ...(scope === undefined || scope.trim() === '' ? {} : { scope: scope.trim() }),
  }
}

function clientVersion(): string {
  try {
    return appVersion()
  }
  catch {
    return '0.0.0'
  }
}

/**
 * Probes an MCP server without credentials (see the module comment). `headers` are the server's configured headers
 * (never an `Authorization` header: such a server does not sign in). Rejects on a network failure, a redirect or the
 * timeout.
 */
export async function probeMcpServer(type: 'http' | 'sse', url: string, headers: Readonly<Record<string, string>>, options: McpProbeOptions = {}): Promise<McpProbeResult> {
  const controller = new AbortController()
  const timeout = AbortSignal.timeout(options.timeoutMs ?? MCP_OAUTH_PROBE_TIMEOUT_MS)
  const signal = AbortSignal.any([controller.signal, timeout, ...(options.signal ? [options.signal] : [])])
  const init: RequestInit = type === 'http'
    ? {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'mcp-protocol-version': PROBE_PROTOCOL_VERSION },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: { protocolVersion: PROBE_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'harness-forge', version: clientVersion() } },
        }),
      }
    : { method: 'GET', headers: { ...headers, accept: 'text/event-stream' } }
  const response = await fetch(url, { ...init, redirect: 'error', signal })
  try {
    const challenge = response.status === 401 ? readBearerChallenge(response.headers.get('www-authenticate')) : {}
    return { status: response.status, unauthorized: response.status === 401, ...challenge }
  }
  finally {
    // The body is never read: a stream answer (SSE) would stay open otherwise.
    controller.abort()
    await response.body?.cancel().catch(() => {})
  }
}
