// Error mapping of the builtin providers (`ProviderDefinition.mapError`, PROVIDERS.md "Error mapping"). Errors come
// from the AI SDK packages (`APICallError`, `RetryError`, stream errors) and from `requestJson`; they are read by
// duck typing so copies of the error classes from other package versions work too. Messages are written here (never
// copied from the vendor, which may echo parts of the key); a redacted vendor excerpt goes to `details.upstream`.
import type { HarnessErrorInit } from '@harness-forge/plugin-sdk'
import type { JsonRecord } from './json.ts'
import { arrayOf, isRecord, recordOf, stringOf } from './json.ts'

export interface ProviderLabel {
  id: string
  /** Vendor name used in messages ("Anthropic", "OpenAI", ...). */
  name: string
}

/** What `mapError` needs to know about an error, whatever its class. */
export interface ErrorFacts {
  /** Upstream HTTP status (or the HTTP-equivalent status of a stream error). */
  status?: number
  /** Lowercase vendor codes, types, statuses and reasons found on the error and in its body. */
  codes: ReadonlySet<string>
  /** Lowercase haystack of the error message and the vendor messages of the body. */
  text: string
  /** The vendor message, when the body has one (else the error message). */
  upstreamMessage?: string
  /** Response headers with lowercase names. */
  headers: Readonly<Record<string, string>>
  /** Parsed JSON error body (or the parsed `data` of the error). */
  body?: unknown
  /** Request URL. */
  url?: string
  /** Model id of the failed request, when its body carried one. */
  modelId?: string
  /** Node network error code found in the cause chain (`ECONNREFUSED`, `ENOTFOUND`, ...). */
  networkCode?: string
}

/** A vendor quirk: returns a mapping, or `undefined` to fall through to the next rule. */
export type ErrorRule = (facts: ErrorFacts, provider: ProviderLabel) => HarnessErrorInit | undefined

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
  'UND_ERR_SOCKET',
  'ConnectionRefused',
  'FailedToOpenSocket',
])

const AUTH_CODES = new Set([
  'invalid_api_key',
  'invalidapikey',
  'authentication_error',
  'invalid_authentication_error',
  'permission_error',
  'api_key_invalid',
  'unauthenticated',
  'permission_denied',
])
const AUTH_PATTERN = /incorrect api key|invalid api key|api key not valid|api key is invalid|invalid x-api-key|authentication fails?\b|invalid authentication|token expired or incorrect|no auth credentials|missing authentication|login fail/

const BILLING_CODES = new Set([
  'insufficient_quota',
  'billing_error',
  'insufficient_balance',
  'arrearage',
  'exceeded_current_quota_error',
  'payment_required',
  'billing_hard_limit_reached',
  'billing_not_active',
])
const BILLING_PATTERN = /insufficient (?:account )?balance|balance (?:is )?(?:insufficient|not enough|too low)|credit balance is too low|credits? (?:are |is |have been )?(?:exhausted|insufficient|depleted)|insufficient credits|out of credits|(?:does not|doesn't) have (?:any )?credits|payment required|arrearage|in arrears|overdue|billing (?:hard )?limit|spending limit/

const RATE_CODES = new Set([
  'rate_limit_exceeded',
  'rate_limit_error',
  'rate_limit_reached_error',
  'resource_exhausted',
  'throttling',
  'too_many_requests',
  'engine_overloaded_error',
])

const CONTEXT_CODES = new Set(['context_length_exceeded', 'request_too_large'])
const CONTEXT_PATTERN = /context[ _]length|context window|context limit|maximum context|prompt is too long|prompt too long|input (?:is )?too long|input length and|input token count|too many (?:input )?tokens|model token limit|exceeds? the (?:maximum|max) number of tokens|reduce the length of the (?:messages|prompt)|range of input length|request too large/

const MODEL_CODES = new Set(['model_not_found', 'not_found_error', 'modelnotfound'])
const MODEL_PATTERN = /\bmodel\b[^.\n]{1,100}\b(?:does not exist|doesn't exist|not found|not exist|is not available|not available)|no such model|unknown model|invalid model|is not a valid model|model not found|no endpoints found for/

const OVERLOADED_CODES = new Set(['overloaded_error'])

const RETRY_DELAY_PATTERN = /^(\d+(?:\.\d+)?)s$/

// ---------- fact extraction ----------

function isHarnessErrorLike(value: unknown): boolean {
  return value instanceof Error && value.name === 'HarnessError'
}

/** The error, then `lastError` (RetryError) / `cause` links, without cycles. */
function chainOf(error: unknown): JsonRecord[] {
  const chain: JsonRecord[] = []
  let current: unknown = error
  while (typeof current === 'object' && current !== null && chain.length < 8) {
    const record = current as JsonRecord
    if (chain.includes(record))
      break
    chain.push(record)
    current = record.lastError ?? record.cause
  }
  return chain
}

function httpStatusOf(record: JsonRecord): number | undefined {
  const status = record.statusCode ?? record.status
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}

/** Depth-limited search for a Node network error code (also inside `AggregateError.errors`). */
function findNetworkCode(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || typeof value !== 'object' || value === null)
    return undefined
  const record = value as JsonRecord
  if (typeof record.code === 'string' && NETWORK_CODES.has(record.code))
    return record.code
  for (const nested of [record.cause, record.lastError, ...arrayOf(record.errors)]) {
    const code = findNetworkCode(nested, depth + 1)
    if (code)
      return code
  }
  return undefined
}

function parseBody(record: JsonRecord): unknown {
  const text = record.responseBody
  if (typeof text === 'string' && text.trim().startsWith('{')) {
    try {
      return JSON.parse(text) as unknown
    }
    catch {}
  }
  return isRecord(record.data) ? record.data : undefined
}

function addCode(codes: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim() !== '')
    codes.add(value.trim().toLowerCase())
  else if (typeof value === 'number' && Number.isFinite(value))
    codes.add(String(value))
}

/** Vendor codes of the usual error body shapes (OpenAI, Anthropic, Google, xAI, Z.ai, MiniMax). */
function collectCodes(codes: Set<string>, body: unknown): void {
  const root = recordOf(body)
  if (!root)
    return
  for (const key of ['code', 'type', 'status'] as const)
    addCode(codes, root[key])
  const error = recordOf(root.error)
  if (error) {
    for (const key of ['code', 'type', 'status'] as const)
      addCode(codes, error[key])
    for (const detail of arrayOf(error.details))
      addCode(codes, recordOf(detail)?.reason)
  }
  addCode(codes, recordOf(root.base_resp)?.status_code)
}

/** Vendor messages of the usual error body shapes. */
function vendorMessages(body: unknown): string[] {
  const root = recordOf(body)
  if (!root)
    return []
  const error = root.error
  const messages = [
    typeof error === 'string' ? stringOf(error) : stringOf(recordOf(error)?.message),
    stringOf(root.message),
    stringOf(root.detail),
    stringOf(recordOf(root.base_resp)?.status_msg),
  ]
  return messages.filter((message): message is string => message !== undefined)
}

function lowercaseHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, header] of Object.entries(recordOf(value) ?? {})) {
    if (typeof header === 'string')
      headers[key.toLowerCase()] = header
  }
  return headers
}

/** Reads everything `mapError` needs from an error; `undefined` for non-objects and `HarnessError`s. */
export function errorFacts(error: unknown): ErrorFacts | undefined {
  const chain = chainOf(error)
  if (chain.length === 0 || chain.some(isHarnessErrorLike))
    return undefined
  const primary = chain.find(record => httpStatusOf(record) !== undefined)
    ?? chain.find(record => typeof record.url === 'string')
    ?? chain[0]
  if (!primary)
    return undefined

  const body = parseBody(primary)
  const codes = new Set<string>()
  addCode(codes, primary.code)
  addCode(codes, primary.type)
  collectCodes(codes, body)

  const message = typeof primary.message === 'string' ? primary.message : ''
  const upstream = vendorMessages(body)
  const request = recordOf(primary.requestBodyValues)
  const facts: ErrorFacts = {
    codes,
    text: [message, ...upstream].join('\n').toLowerCase(),
    headers: lowercaseHeaders(primary.responseHeaders),
  }
  const status = httpStatusOf(primary)
  if (status !== undefined)
    facts.status = status
  const upstreamMessage = upstream[0] ?? stringOf(message)
  if (upstreamMessage !== undefined)
    facts.upstreamMessage = upstreamMessage
  if (body !== undefined)
    facts.body = body
  if (typeof primary.url === 'string')
    facts.url = primary.url
  if (typeof request?.model === 'string')
    facts.modelId = request.model
  const networkCode = findNetworkCode(error)
  if (networkCode !== undefined)
    facts.networkCode = networkCode
  return facts
}

// ---------- helpers ----------

/** Replaces key-like tokens and long opaque strings, collapses whitespace, caps the length. */
export function redact(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk|gsk|xai)[-_][\w\-*]{4,}/g, '[redacted]')
    .replace(/\bAIza[\w\-*]{8,}/g, '[redacted]')
    .replace(/[\w\-*]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** The origin of a URL, if parsable. */
export function originOf(url: string | undefined): string | undefined {
  if (!url)
    return undefined
  try {
    return new URL(url).origin
  }
  catch {
    return undefined
  }
}

/** Google `RetryInfo.retryDelay` (`"34s"`, `"1.5s"`) in milliseconds. */
function googleRetryDelayMs(body: unknown): number | undefined {
  for (const detail of arrayOf(recordOf(recordOf(body)?.error)?.details)) {
    const seconds = stringOf(recordOf(detail)?.retryDelay)?.match(RETRY_DELAY_PATTERN)?.[1]
    if (seconds !== undefined)
      return Math.round(Number(seconds) * 1000)
  }
  return undefined
}

/** `retry-after-ms`, `retry-after` (seconds or HTTP date) or Google `RetryInfo`, in milliseconds. */
export function retryAfterMs(facts: ErrorFacts, now: number = Date.now()): number | undefined {
  const milliseconds = facts.headers['retry-after-ms']?.trim()
  if (milliseconds && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0)
    return Math.round(Number(milliseconds))
  const retryAfter = facts.headers['retry-after']?.trim()
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds))
      return Math.max(0, Math.round(seconds * 1000))
    const date = Date.parse(retryAfter)
    if (!Number.isNaN(date))
      return Math.max(0, date - now)
  }
  return googleRetryDelayMs(facts.body)
}

/** Builds the mapping with `providerId`, the upstream status and a redacted upstream excerpt. */
export function mapped(
  facts: ErrorFacts,
  provider: ProviderLabel,
  init: Pick<HarnessErrorInit, 'code' | 'message'> & Partial<Pick<HarnessErrorInit, 'action' | 'retryAfterMs'>>,
): HarnessErrorInit {
  const result: HarnessErrorInit = { code: init.code, message: init.message, providerId: provider.id }
  if (facts.status !== undefined)
    result.status = facts.status
  if (init.action !== undefined)
    result.action = init.action
  if (init.retryAfterMs !== undefined)
    result.retryAfterMs = init.retryAfterMs
  if (facts.upstreamMessage)
    result.details = { upstream: redact(facts.upstreamMessage) }
  return result
}

/** True when one of `codes` (lowercase) is in `candidates`. */
export function hasCode(codes: ReadonlySet<string>, candidates: ReadonlySet<string>): boolean {
  for (const code of codes) {
    if (candidates.has(code))
      return true
  }
  return false
}

// ---------- common rules ----------

export function isBillingError(facts: ErrorFacts): boolean {
  return facts.status === 402 || hasCode(facts.codes, BILLING_CODES) || BILLING_PATTERN.test(facts.text)
}

function unreachable(facts: ErrorFacts, provider: ProviderLabel): HarnessErrorInit | undefined {
  if (facts.networkCode === undefined || facts.status !== undefined)
    return undefined
  const origin = originOf(facts.url)
  return mapped(facts, provider, {
    code: 'provider_unreachable',
    message: `Cannot reach ${provider.name}${origin ? ` at ${origin}` : ''}. Check the network connection and the base URL.`,
    action: 'retry',
  })
}

function billing(facts: ErrorFacts, provider: ProviderLabel): HarnessErrorInit | undefined {
  if (!isBillingError(facts))
    return undefined
  return mapped(facts, provider, {
    code: 'provider_error',
    message: `${provider.name} rejected the request because the account balance, credits or quota are exhausted.`,
  })
}

function auth(facts: ErrorFacts, provider: ProviderLabel): HarnessErrorInit | undefined {
  const forbidden = facts.status === 403
  if (facts.status !== 401 && !forbidden && !hasCode(facts.codes, AUTH_CODES) && !AUTH_PATTERN.test(facts.text))
    return undefined
  return mapped(facts, provider, {
    code: 'auth_invalid',
    message: forbidden
      ? `The ${provider.name} API key is not allowed to make this request. Check the key and its permissions.`
      : `The ${provider.name} API key was rejected. Check the key in Settings > Providers.`,
    action: 'configure-provider',
  })
}

function contextOverflow(facts: ErrorFacts, provider: ProviderLabel): HarnessErrorInit | undefined {
  if (facts.status !== 413 && !hasCode(facts.codes, CONTEXT_CODES) && !CONTEXT_PATTERN.test(facts.text))
    return undefined
  return mapped(facts, provider, {
    code: 'context_overflow',
    message: 'The request is too long for the context window of this model. Shorten the conversation or remove attachments.',
  })
}

function rateLimited(facts: ErrorFacts, provider: ProviderLabel): HarnessErrorInit | undefined {
  if (facts.status !== 429 && !hasCode(facts.codes, RATE_CODES))
    return undefined
  const wait = retryAfterMs(facts)
  return mapped(facts, provider, {
    code: 'rate_limited',
    message: wait === undefined
      ? `${provider.name} rate limit reached. Try again shortly.`
      : `${provider.name} rate limit reached. Try again in ${Math.max(1, Math.ceil(wait / 1000))} s.`,
    action: 'retry',
    retryAfterMs: wait,
  })
}

function modelNotFound(facts: ErrorFacts, provider: ProviderLabel): HarnessErrorInit | undefined {
  // A 5xx "model is currently not available" is transient: left to the default mapping.
  const serverError = facts.status !== undefined && facts.status >= 500
  if (facts.status !== 404 && !hasCode(facts.codes, MODEL_CODES) && (serverError || !MODEL_PATTERN.test(facts.text)))
    return undefined
  return mapped(facts, provider, {
    code: 'model_not_found',
    message: facts.modelId
      ? `The model "${facts.modelId}" was not found at ${provider.name}. Refresh the model list or pick another model.`
      : `The model was not found at ${provider.name}. Refresh the model list or pick another model.`,
    action: 'refresh-models',
  })
}

/** Rules every provider shares, in precedence order. */
const COMMON_RULES: readonly ErrorRule[] = [unreachable, billing, auth, contextOverflow, rateLimited, modelNotFound]

/**
 * Maps an error of a builtin provider: vendor rules first, then the common rules (network -> billing -> auth ->
 * context -> rate limit -> model). `undefined` leaves the error to the host's default mapping.
 */
export function mapProviderError(error: unknown, provider: ProviderLabel, rules: readonly ErrorRule[] = []): HarnessErrorInit | undefined {
  const facts = errorFacts(error)
  if (!facts)
    return undefined
  for (const rule of [...rules, ...COMMON_RULES]) {
    const result = rule(facts, provider)
    if (result)
      return result
  }
  return undefined
}

// ---------- reusable vendor rules ----------

/** HTTP 529 / `overloaded_error` (Anthropic API and Anthropic-compatible APIs). */
export const overloadedRule: ErrorRule = (facts, provider) => {
  if (facts.status !== 529 && !hasCode(facts.codes, OVERLOADED_CODES))
    return undefined
  return mapped(facts, provider, {
    code: 'provider_error',
    message: `${provider.name} is temporarily overloaded. Try again in a moment.`,
    action: 'retry',
  })
}

/** HTTP 402 with a vendor-specific message. */
export function paymentRequiredRule(message: string): ErrorRule {
  return (facts, provider) => (facts.status === 402 ? mapped(facts, provider, { code: 'provider_error', message }) : undefined)
}
