// Default mapping of provider call errors to `HarnessError` (API.md 2.3, PROVIDERS.md "Error mapping"), applied after
// `ProviderDefinition.mapError`: 401 / 403 -> `auth_invalid`; 429 -> `rate_limited` (+ `retryAfterMs`); 404 ->
// `model_not_found`; context-length errors -> `context_overflow`; network failures and timeouts ->
// `provider_unreachable`; everything else -> `provider_error`. Errors are read by duck typing (AI SDK `APICallError`,
// `RetryError`, fetch `TypeError`s with a `cause`, `DOMException`s), so copies of the error classes from other package
// versions work too. Messages are written here, never copied from the upstream answer (which may echo a key); a short
// redacted upstream excerpt goes to `details.upstream`.
import type { HarnessErrorInit } from '@harness-forge/shared'

/** Node / undici network error codes that mean "cannot reach the provider". */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
])

const CONTEXT_PATTERN = /context[ _-]?(?:length|window|limit)|maximum context|prompt is too long|input is too long|too many (?:input )?tokens|exceeds? the (?:maximum|max)(?: number of)? tokens|reduce the length of the (?:messages|prompt)|request too large/i
const CONTEXT_CODES = new Set(['context_length_exceeded', 'request_too_large'])

/** Maximum length of `details.upstream`. */
const UPSTREAM_MAX_CHARS = 300

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

/** What the mapping needs to know about an error, whatever its class. */
export interface ProviderErrorFacts {
  /** Upstream HTTP status. */
  status?: number
  /** Response headers with lowercase names. */
  headers: Record<string, string>
  /** Node network error code found in the cause chain. */
  networkCode?: string
  /** A guard or fetch timeout. */
  timeout: boolean
  /** Aborted without a timeout (a stopped run). */
  aborted: boolean
  /** Lowercase vendor codes / types of the error body. */
  codes: Set<string>
  /** Error message and vendor messages (for pattern checks, never sent). */
  text: string
  /** The vendor message, else the error message (redacted before use). */
  upstream?: string
  /** Request URL, when known. */
  url?: string
}

/** The error, then its `lastError` (RetryError), `cause` and `errors` (AggregateError) links, without cycles. */
function chainOf(error: unknown): JsonRecord[] {
  const chain: JsonRecord[] = []
  const queue: unknown[] = [error]
  while (queue.length > 0 && chain.length < 12) {
    const current = queue.shift()
    if (!isRecord(current) || chain.includes(current))
      continue
    chain.push(current)
    queue.push(current.lastError, current.cause)
    if (Array.isArray(current.errors))
      queue.push(...current.errors.slice(0, 4))
  }
  return chain
}

function httpStatusOf(record: JsonRecord): number | undefined {
  const status = record.statusCode ?? record.status
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim().startsWith('{'))
    return undefined
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return undefined
  }
}

function addCode(codes: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim() !== '')
    codes.add(value.trim().toLowerCase())
}

/** Vendor messages of the usual body shapes (`{ error: { message } }`, `{ error: "..." }`, `{ message }`, `{ detail }`). */
function vendorMessages(body: unknown): string[] {
  if (!isRecord(body))
    return []
  const error = body.error
  const candidates = [
    typeof error === 'string' ? error : isRecord(error) ? error.message : undefined,
    body.message,
    body.detail,
  ]
  return candidates.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
}

function lowercaseHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {}
  if (value instanceof Headers) {
    value.forEach((header, key) => {
      headers[key.toLowerCase()] = header
    })
    return headers
  }
  if (isRecord(value)) {
    for (const [key, header] of Object.entries(value)) {
      if (typeof header === 'string')
        headers[key.toLowerCase()] = header
    }
  }
  return headers
}

/** Reads the facts of any thrown value. */
export function providerErrorFacts(error: unknown): ProviderErrorFacts {
  const chain = chainOf(error)
  const facts: ProviderErrorFacts = { headers: {}, timeout: false, aborted: false, codes: new Set(), text: '' }
  const texts: string[] = []
  for (const record of chain) {
    const name = typeof record.name === 'string' ? record.name : ''
    if (name === 'TimeoutError')
      facts.timeout = true
    else if (name === 'AbortError' || name === 'ResponseAborted')
      facts.aborted = true
    if (typeof record.code === 'string' && NETWORK_CODES.has(record.code))
      facts.networkCode ??= record.code
    if (typeof record.code === 'string' && record.code === 'ABORT_ERR')
      facts.aborted = true
    const status = httpStatusOf(record)
    if (status !== undefined && facts.status === undefined) {
      facts.status = status
      facts.headers = lowercaseHeaders(record.responseHeaders ?? record.headers)
      const body = parseJson(record.responseBody) ?? (isRecord(record.data) ? record.data : undefined)
      if (isRecord(body)) {
        addCode(facts.codes, body.code)
        addCode(facts.codes, body.type)
        if (isRecord(body.error)) {
          addCode(facts.codes, body.error.code)
          addCode(facts.codes, body.error.type)
        }
      }
      const messages = vendorMessages(body)
      texts.push(...messages)
      facts.upstream ??= messages[0]
    }
    if (typeof record.url === 'string')
      facts.url ??= record.url
    if (typeof record.message === 'string' && record.message !== '')
      texts.push(record.message)
  }
  const first = chain[0]
  if (facts.upstream === undefined && first && typeof first.message === 'string' && first.message.trim() !== '')
    facts.upstream = first.message
  if (typeof error === 'string') {
    texts.push(error)
    facts.upstream ??= error
  }
  facts.text = texts.join('\n').toLowerCase()
  return facts
}

/** `retry-after-ms`, then `retry-after` (seconds or an HTTP date), in milliseconds. */
export function retryAfterMs(headers: Record<string, string>, now: number = Date.now()): number | undefined {
  const milliseconds = headers['retry-after-ms']?.trim()
  if (milliseconds && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0)
    return Math.round(Number(milliseconds))
  const value = headers['retry-after']?.trim()
  if (!value)
    return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds))
    return Math.max(0, Math.round(seconds * 1000))
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

function originOf(url: string | undefined): string | undefined {
  if (!url)
    return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  }
  catch {
    return undefined
  }
}

/** Masks key-like tokens and long opaque strings, collapses whitespace and caps the length. */
export function redactUpstream(text: string, redactText: (text: string) => string = value => value): string {
  const masked = redactText(text)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk|gsk|xai)[-_][\w\-*]{4,}/g, '[redacted]')
    .replace(/\bAIza[\w\-*]{8,}/g, '[redacted]')
    .replace(/[\w\-*]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return masked.length > UPSTREAM_MAX_CHARS ? `${masked.slice(0, UPSTREAM_MAX_CHARS - 3)}...` : masked
}

export interface DefaultMappingOptions {
  providerId: string
  /** UI name used in messages. */
  providerName: string
  /** Masks registered secrets (`deps.redactor.redactText`). */
  redactText?: (text: string) => string
  now?: number
}

/** The default mapping (API.md 2.3) of an error that `definition.mapError` did not handle. */
export function defaultProviderError(error: unknown, options: DefaultMappingOptions): HarnessErrorInit {
  const facts = providerErrorFacts(error)
  const name = options.providerName
  const init = (code: HarnessErrorInit['code'], message: string, extra: Partial<HarnessErrorInit> = {}): HarnessErrorInit => {
    const result: HarnessErrorInit = { code, message, providerId: options.providerId, ...extra }
    if (facts.status !== undefined)
      result.status = facts.status
    if (facts.upstream !== undefined) {
      const upstream = redactUpstream(facts.upstream, options.redactText)
      if (upstream !== '')
        result.details = { upstream }
    }
    return result
  }

  const status = facts.status
  if (status === undefined && (facts.networkCode !== undefined || facts.timeout)) {
    const origin = originOf(facts.url)
    const message = facts.timeout
      ? `${name} did not respond in time.`
      : `Cannot reach ${name}${origin ? ` at ${origin}` : ''}. Check the network connection and the base URL.`
    return init('provider_unreachable', message, { action: 'retry' })
  }
  if (status === undefined && facts.aborted)
    return init('provider_error', `The request to ${name} was aborted.`)
  if (status === 401)
    return init('auth_invalid', `${name} rejected the credentials (HTTP 401). Check the API key in Settings > Providers.`, { action: 'configure-provider' })
  if (status === 403)
    return init('auth_invalid', `${name} refused the request (HTTP 403). Check the API key and its permissions.`, { action: 'configure-provider' })
  if (status === 429) {
    const wait = retryAfterMs(facts.headers, options.now)
    const message = wait === undefined
      ? `${name} rate limit reached. Try again shortly.`
      : `${name} rate limit reached. Try again in ${Math.max(1, Math.ceil(wait / 1000))} s.`
    return init('rate_limited', message, { action: 'retry', ...(wait === undefined ? {} : { retryAfterMs: wait }) })
  }
  if ((status === 400 || status === 413 || status === undefined) && ([...facts.codes].some(code => CONTEXT_CODES.has(code)) || CONTEXT_PATTERN.test(facts.text)))
    return init('context_overflow', 'The request is too long for the context window of this model. Shorten the conversation or remove attachments.')
  if (status === 404)
    return init('model_not_found', `The model was not found at ${name}. Refresh the model list or pick another model.`, { action: 'refresh-models' })
  return init('provider_error', status === undefined ? `${name} returned an error.` : `${name} returned an error (HTTP ${status}).`, { action: 'retry' })
}
