// Error helpers of the MCP manager: configuration problems (never retried) and the mapping of connection failures to
// `HarnessErrorInit`s shown in `McpServer.error` (API.md 2.2: an MCP server is an upstream service).
import type { HarnessErrorInit } from '@harness-forge/shared'
import { HarnessError, isHarnessError } from '@harness-forge/shared'

/** Longest error message kept for a server status. */
const MESSAGE_MAX_CHARS = 500

/** Codes of problems a retry cannot fix (bad configuration, missing trust). */
const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set(['validation_error', 'forbidden'])

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

/** A configuration problem of an MCP server (missing setting, invalid URL): shown as is, never retried. */
export function mcpConfigError(message: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message })
}

/** True when retrying the connection cannot help. */
export function isPermanentMcpError(error: unknown): boolean {
  return isHarnessError(error) && NON_RETRYABLE_CODES.has(error.code)
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

/** The first error code (`code` / `errno` string) found on `error` or its causes. */
function errorCode(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < 5; depth++) {
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
 * `HarnessErrorInit` of a failed connection: HarnessErrors keep their code, network and process failures are
 * `provider_unreachable`, everything else `provider_error` (with the upstream HTTP status when known). `redact` masks
 * secrets that may appear in upstream messages.
 */
export function connectionErrorInit(error: unknown, redact: (text: string) => string): HarnessErrorInit {
  if (isHarnessError(error)) {
    const init = error.toJSON().error
    return { ...init, message: redact(init.message) }
  }
  const message = redact(errorMessage(error))
  const status = upstreamStatus(error)
  if (isConnectionFailure(error) && (status === undefined || status >= 500))
    return { code: 'provider_unreachable', message, action: 'retry', ...(status === undefined ? {} : { status }) }
  return { code: 'provider_error', message, ...(status === undefined ? {} : { status }) }
}
