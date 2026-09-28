// JSON requests for model listings and credential checks. Requests go through `rt.fetch` with `rt.signal`; failures
// become `APICallError`s (the error class of the AI SDK packages), so `mapError` and the host treat listing errors and
// chat errors alike.
import type { ProviderRuntime } from '@harness-forge/plugin-sdk'
import { APICallError } from '@ai-sdk/provider'

export interface JsonRequestInit {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Serialized as JSON. */
  body?: unknown
}

/** Maximum number of characters of a failed response body kept on the error. */
const ERROR_BODY_MAX_CHARS = 8192

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : undefined
    return cause ? `${error.message} (${cause})` : error.message
  }
  return String(error)
}

function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  return headers
}

/** 408, 409, 429 and 5xx are worth a retry (same rule as the AI SDK). */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

/** Best-effort vendor message of an error body (`{ error: { message } }`, `{ error: "..." }`, `{ message }`, `{ detail }`). */
function vendorMessage(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body !== 'object' || body === null)
      return undefined
    const record = body as Record<string, unknown>
    const error = record.error
    if (typeof error === 'string')
      return error
    if (typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>).message === 'string')
      return (error as Record<string, string>).message
    for (const key of ['message', 'detail'] as const) {
      if (typeof record[key] === 'string')
        return record[key]
    }
  }
  catch {}
  return undefined
}

/**
 * Sends a request and returns the parsed JSON body. Non-2xx responses, network failures and invalid JSON throw an
 * `APICallError` (`statusCode`, `responseHeaders`, `responseBody`, `url`); an abort is rethrown unchanged.
 */
export async function requestJson(rt: ProviderRuntime, url: string, init: JsonRequestInit = {}): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers }
  let body: string | undefined
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.body)
  }

  let response: Response
  try {
    response = await rt.fetch(url, { method: init.method ?? 'GET', headers, body, signal: rt.signal })
  }
  catch (error) {
    if (isAbortError(error))
      throw error
    throw new APICallError({
      message: `Cannot connect to API: ${describe(error)}`,
      url,
      requestBodyValues: init.body,
      cause: error,
      isRetryable: true,
    })
  }

  const text = await response.text()
  if (!response.ok) {
    throw new APICallError({
      message: vendorMessage(text) ?? `HTTP ${response.status}`,
      url,
      requestBodyValues: init.body,
      statusCode: response.status,
      responseHeaders: headersOf(response),
      responseBody: text.slice(0, ERROR_BODY_MAX_CHARS),
      isRetryable: isRetryableStatus(response.status),
    })
  }
  try {
    return JSON.parse(text) as unknown
  }
  catch (error) {
    throw new APICallError({
      message: 'The response is not valid JSON.',
      url,
      requestBodyValues: init.body,
      statusCode: response.status,
      responseHeaders: headersOf(response),
      responseBody: text.slice(0, ERROR_BODY_MAX_CHARS),
      cause: error,
      isRetryable: false,
    })
  }
}

/** A plain error for a 2xx listing whose shape is not the documented one. */
export function unexpectedListing(providerName: string): Error {
  return new Error(`${providerName} returned an unexpected model list.`)
}

/** The first `APICallError` status of an error, if any. */
export function statusOf(error: unknown): number | undefined {
  return APICallError.isInstance(error) ? error.statusCode : undefined
}
