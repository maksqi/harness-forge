// Error helpers of the MCP manager: configuration problems (never retried) and the mapping of connection failures to
// `HarnessErrorInit`s shown in `McpServer.error` (API.md 2.2: an MCP server is an upstream service).
//
// Phase 14 (ADR-059, C51-T2; COMPLETE and FROZEN after P14-0b): an auth failure (`isAuthRequired`: `McpAuthRequired` of
// the connect-mode provider, `UnauthorizedError` / an OAuth error of `@ai-sdk/mcp`, or an upstream HTTP 401, also as a
// cause) is the permanent `auth_invalid { status: 401 }` (`authRequiredInit`): the managers show the status `needs-auth`
// and never retry it with backoff. A network failure stays `provider_unreachable` (retried), anything else
// `provider_error`.
import type { HarnessErrorInit } from '@harness-forge/shared'
import { MCPClientOAuthError, UnauthorizedError } from '@ai-sdk/mcp'
import { HarnessError, isHarnessError } from '@harness-forge/shared'
import { isMcpAuthRequired } from './oauth/types.ts'

/** Longest error message kept for a server status. */
const MESSAGE_MAX_CHARS = 500

/** Codes of problems a retry cannot fix (bad configuration, missing trust, Phase 14: a needed sign-in). */
const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set(['validation_error', 'forbidden', 'auth_invalid'])

/** Node / undici error codes of network failures and process start failures. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ENOENT',
  'EACCES',
  'EPERM',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
])

/** Message fragments of connection failures reported by `@ai-sdk/mcp` and `fetch`. */
const UNREACHABLE_PATTERNS = [
  /timed out/i,
  /connection closed/i,
  /closed client/i,
  /not connected/i,
  /fetch failed/i,
  /socket hang up/i,
  /aborted/i,
]

/** How deep `cause` chains are followed. */
const CAUSE_DEPTH = 5

/** The `McpServer.error` message of a server that needs a sign-in (status `needs-auth`). */
export const NEEDS_AUTH_MESSAGE = 'The MCP server needs a sign-in.'
/**
 * The message of a server that answered 401 although it sends an `Authorization` header: it cannot sign in (the sign-in
 * routes answer 400), the header has to be fixed (open point 6).
 */
export const HEADER_REJECTED_MESSAGE = 'The MCP server rejected its Authorization header.'

/** A configuration problem of an MCP server (missing setting, invalid URL): shown as is, never retried. */
export function mcpConfigError(message: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message })
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

/** The first error code (`code` / `errno` string) found on `error` or its causes. */
function errorCode(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < CAUSE_DEPTH; depth++) {
    const record = recordOf(current)
    if (record === null)
      return null
    if (typeof record.code === 'string')
      return record.code
    current = record.cause
  }
  return null
}

/** An upstream HTTP status (`statusCode` of `MCPClientError`, `status` of a response error), when known. */
function upstreamStatus(error: unknown): number | undefined {
  const record = recordOf(error)
  const value = record?.statusCode ?? record?.status
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

/** One error (not its causes) says that the server needs credentials. */
function isAuthFailure(error: unknown): boolean {
  if (isMcpAuthRequired(error) || error instanceof UnauthorizedError || MCPClientOAuthError.isInstance(error))
    return true
  if (error instanceof Error && error.name === 'UnauthorizedError')
    return true
  if (isHarnessError(error))
    return error.code === 'auth_invalid'
  return upstreamStatus(error) === 401
}

/**
 * True when connecting to (or calling) an MCP server failed because it needs credentials (Phase 14, ADR-059):
 * `McpAuthRequired` (the connect-mode provider has no usable token record), `UnauthorizedError` or any OAuth error of
 * `@ai-sdk/mcp` (a refused refresh, a refused authorization server), a `HarnessError` `auth_invalid`, or an upstream
 * HTTP 401 (a server with an `Authorization` header, which has no auth provider); causes are followed.
 */
export function isAuthRequired(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    if (isAuthFailure(current))
      return true
    current = recordOf(current)?.cause
  }
  return false
}

/**
 * The permanent `HarnessErrorInit` of a server that needs a sign-in: `auth_invalid` with the upstream status 401. The
 * message is fixed (never an upstream text, which may echo a header) unless the error is an `McpAuthRequired`, whose
 * message never holds a token or a URL query; `header` = the server sends an `Authorization` header (it cannot sign in).
 */
export function authRequiredInit(error: unknown, redact: (text: string) => string, options: { header?: boolean } = {}): HarnessErrorInit {
  let message = options.header === true ? HEADER_REJECTED_MESSAGE : NEEDS_AUTH_MESSAGE
  if (options.header !== true && isMcpAuthRequired(error) && error.message.trim() !== '')
    message = redact(errorMessage(error))
  return { code: 'auth_invalid', message, status: 401 }
}

/** True when retrying the connection cannot help (Phase 14: also a server that needs a sign-in). */
export function isPermanentMcpError(error: unknown): boolean {
  return (isHarnessError(error) && NON_RETRYABLE_CODES.has(error.code)) || isAuthRequired(error)
}

/** The message of anything thrown, trimmed and capped (never empty). */
export function errorMessage(error: unknown): string {
  let message = ''
  if (error instanceof Error)
    message = error.message
  else if (typeof error === 'string')
    message = error
  message = message.replace(/\s+/g, ' ').trim()
  if (message === '')
    message = error instanceof Error && error.name && error.name !== 'Error' ? error.name : 'Unknown error'
  return message.length > MESSAGE_MAX_CHARS ? `${message.slice(0, MESSAGE_MAX_CHARS)}...` : message
}

/** True for failures of the connection itself (the client should reconnect), not of one tool. */
export function isConnectionFailure(error: unknown): boolean {
  const code = errorCode(error)
  if (code !== null && UNREACHABLE_CODES.has(code))
    return true
  const message = error instanceof Error ? error.message : String(error)
  return UNREACHABLE_PATTERNS.some(pattern => pattern.test(message))
}

/**
 * `HarnessErrorInit` of a failed connection: HarnessErrors keep their code, auth failures are `auth_invalid` (status
 * 401, `authRequiredInit`), network and process failures are `provider_unreachable`, everything else `provider_error`
 * (with the upstream HTTP status when known). `redact` masks secrets that may appear in upstream messages.
 */
export function connectionErrorInit(error: unknown, redact: (text: string) => string): HarnessErrorInit {
  if (isHarnessError(error)) {
    const init = error.toJSON().error
    return { ...init, message: redact(init.message) }
  }
  if (isAuthRequired(error))
    return authRequiredInit(error, redact)
  const message = redact(errorMessage(error))
  const status = upstreamStatus(error)
  if (isConnectionFailure(error) && (status === undefined || status >= 500))
    return { code: 'provider_unreachable', message, action: 'retry', ...(status === undefined ? {} : { status }) }
  return { code: 'provider_error', message, ...(status === undefined ? {} : { status }) }
}
