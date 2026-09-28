// Bounded HTTP downloads of the npm source (the npm registry is a fixed, trusted host; URL installs go through the
// SSRF-guarded `SafeFetch` instead, see url.ts). Every request has a timeout, never follows redirects on its own
// (`redirect: 'manual'`; a redirect is an upstream error), and reads at most `maxBytes` of body: a declared
// `Content-Length` above the cap fails before reading, a streamed body is cut off as soon as it passes the cap.
import { isHarnessError } from '@harness-forge/shared'
import { megabytes, tooLarge, upstreamError } from './errors.ts'

export interface CappedFetchOptions {
  maxBytes: number
  timeoutMs: number
  headers?: Record<string, string>
  /** What is being downloaded, for messages ("the npm registry"). */
  what: string
}

export interface CappedResponse {
  status: number
  headers: Headers
  body: Uint8Array
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError')
      return 'the request timed out'
    const cause = (error as { cause?: unknown }).cause
    const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined
    return typeof code === 'string' ? code : 'network error'
  }
  return 'network error'
}

async function readBody(response: Response, maxBytes: number, what: string): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw tooLarge(`The download from ${what} is larger than ${megabytes(maxBytes)}.`, maxBytes)
  }
  if (response.body === null)
    return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw tooLarge(`The download from ${what} is larger than ${megabytes(maxBytes)}.`, maxBytes)
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** GET `url` with a timeout and a body cap. Network failures are `provider_unreachable`; redirects `provider_error`. */
export async function cappedFetch(fetchImpl: typeof globalThis.fetch, url: string, options: CappedFetchOptions): Promise<CappedResponse> {
  const signal = AbortSignal.timeout(options.timeoutMs)
  let response: Response
  try {
    response = await fetchImpl(url, { method: 'GET', headers: options.headers, redirect: 'manual', signal })
  }
  catch (error) {
    throw upstreamError('provider_unreachable', `Cannot reach ${options.what}: ${reason(error)}.`)
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {})
    const what = options.what.charAt(0).toUpperCase() + options.what.slice(1)
    throw upstreamError('provider_error', `${what} answered with an unexpected redirect (HTTP ${response.status}).`, response.status)
  }
  try {
    return { status: response.status, headers: response.headers, body: await readBody(response, options.maxBytes, options.what) }
  }
  catch (error) {
    if (isHarnessError(error))
      throw error
    throw upstreamError('provider_unreachable', `The download from ${options.what} failed: ${reason(error)}.`)
  }
}
