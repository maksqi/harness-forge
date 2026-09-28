// Typed API client over the route table (API.md section 3.4). Works in browsers and in Node (inject `fetch`).
import type { z } from 'zod'
import type { HarnessErrorInit } from '../errors.ts'
import type { ApiModule, ApiRouteDef, ApiRouteKey, ApiRoutes } from './routes.ts'
import { HarnessError, harnessErrorEnvelopeSchema } from '../errors.ts'
import { API_ROUTE_KEYS, apiRoutes } from './routes.ts'

/** `RequestInit['credentials']`, spelled out so the type does not depend on the DOM lib. */
export type ApiCredentials = 'omit' | 'same-origin' | 'include'

export interface ApiClientOptions {
  /** Default `/api`. Node callers pass an absolute URL (`http://127.0.0.1:8899/api`). */
  baseUrl?: string
  /** Default `globalThis.fetch`; the web wraps it (401 `unauthorized` -> `/login`). */
  fetch?: typeof globalThis.fetch
  /** Default `same-origin` (the SPA and the API share an origin). */
  credentials?: ApiCredentials
}

// ---------- input and result types ----------

/** `{}`: an input with only optional keys is assignable to it. */
type EmptyObject = Record<never, never>

type ParamsInput<R> = R extends { params: infer P extends z.ZodType } ? { params: z.input<P> } : { params?: undefined }

type QueryInput<R> = R extends { query: infer Q extends z.ZodType }
  ? (EmptyObject extends z.input<Q> ? { query?: z.input<Q> } : { query: z.input<Q> })
  : { query?: undefined }

type BodyInput<R> = R extends { body: infer B extends z.ZodType, form: z.ZodType }
  ? { body: z.input<B>, form?: undefined } | { form: FormData, body?: undefined }
  : R extends { form: z.ZodType }
    ? { form: FormData, body?: undefined }
    : R extends { body: infer B extends z.ZodType }
      ? (EmptyObject extends z.input<B> ? { body?: z.input<B>, form?: undefined } : { body: z.input<B>, form?: undefined })
      : { body?: undefined, form?: undefined }

interface CallOptions {
  signal?: AbortSignal
  /** Extra request headers (override the defaults). */
  headers?: Record<string, string>
}

/**
 * Input of `client.<module>.<action>(input)`: `params` when the route has path params, `query`, `body` (JSON) or
 * `form` (multipart; routes with both accept either), plus `signal` and `headers`.
 */
export type ApiCallInput<R extends ApiRouteDef> = ParamsInput<R> & QueryInput<R> & BodyInput<R> & CallOptions

/** zod schema -> parsed JSON (typed, not re-validated at runtime); `'empty'` -> void; streams and binary -> `Response`. */
export type ApiCallResult<R extends ApiRouteDef> = R['response'] extends z.ZodType
  ? z.output<R['response']>
  : R['response'] extends 'empty'
    ? void
    : Response

type HasRequiredKeys<T> = EmptyObject extends T ? false : true

export type ApiCallFunction<R extends ApiRouteDef> = HasRequiredKeys<ApiCallInput<R>> extends true
  ? (input: ApiCallInput<R>) => Promise<ApiCallResult<R>>
  : (input?: ApiCallInput<R>) => Promise<ApiCallResult<R>>

/** `client.<module>.<action>(input)` for every route key `<module>.<action>`. */
export type ApiClient = {
  [M in ApiModule]: {
    [K in ApiRouteKey as K extends `${M}.${infer A}` ? A : never]: ApiCallFunction<ApiRoutes[K]>
  }
}

/** Input of a route `K` (for wrappers and tests). */
export type ApiInput<K extends ApiRouteKey> = ApiCallInput<ApiRoutes[K]>
/** Result of a route `K`. */
export type ApiResult<K extends ApiRouteKey> = ApiCallResult<ApiRoutes[K]>

// ---------- URLs ----------

type UrlInput<R> = ParamsInput<R> & QueryInput<R>
type UrlArgs<R> = HasRequiredKeys<UrlInput<R>> extends true
  ? [input: UrlInput<R>, baseUrl?: string]
  : [input?: UrlInput<R>, baseUrl?: string]

interface LooseInput {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
  form?: FormData
  signal?: AbortSignal
  headers?: Record<string, string>
}

function invalidInput(message: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message })
}

function encodeSegment(value: string, key: string, name: string): string {
  const encoded = encodeURIComponent(value)
  // The URL parser would resolve dot segments and change the route.
  if (encoded === '' || encoded === '.' || encoded === '..')
    throw invalidInput(`Invalid path parameter "${name}" for ${key}.`)
  return encoded
}

function buildPath(key: string, template: string, params: Record<string, unknown> | undefined): string {
  return template
    .split('/')
    .map((part) => {
      if (part === '*') {
        const value = params?.path
        if (typeof value !== 'string' || value === '')
          throw invalidInput(`Missing path parameter "path" for ${key}.`)
        return value.split('/').map(segment => encodeSegment(segment, key, 'path')).join('/')
      }
      if (!part.startsWith(':'))
        return part
      const name = part.slice(1)
      const value = params?.[name]
      if (value === undefined || value === null || value === '')
        throw invalidInput(`Missing path parameter "${name}" for ${key}.`)
      return encodeSegment(String(value), key, name)
    })
    .join('/')
}

function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query)
    return ''
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null)
      continue
    for (const item of Array.isArray(value) ? value : [value])
      search.append(name, String(item))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function buildUrl(key: ApiRouteKey, input: LooseInput | undefined, baseUrl: string): string {
  const route: ApiRouteDef = apiRoutes[key]
  return `${normalizeBaseUrl(baseUrl)}${buildPath(key, route.path, input?.params)}${buildQuery(input?.query)}`
}

/**
 * URL of a route for `<img src>`, `EventSource` and downloads: `apiUrl('icons.get', { params: { slug } })` ->
 * `/api/icons/lobe/<slug>`. Path params are URL-encoded; the rest path keeps `/` and encodes each segment.
 */
export function apiUrl<K extends ApiRouteKey>(key: K, ...args: UrlArgs<ApiRoutes[K]>): string {
  const [input, baseUrl = '/api'] = args
  return buildUrl(key, input as LooseInput | undefined, baseUrl)
}

// ---------- client ----------

const ACCEPT_BY_RESPONSE = {
  'empty': 'application/json',
  'sse': 'text/event-stream',
  'ui-message-stream': 'text/event-stream',
  'binary': '*/*',
} as const

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

function parseEnvelope(text: string): HarnessErrorInit | undefined {
  try {
    const parsed = harnessErrorEnvelopeSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data.error : undefined
  }
  catch {
    return undefined
  }
}

async function readError(response: Response): Promise<HarnessError> {
  const requestId = response.headers.get('x-request-id') ?? undefined
  let text = ''
  try {
    text = await response.text()
  }
  catch {}
  const init = parseEnvelope(text)
  if (init)
    return new HarnessError(init, { requestId })
  return new HarnessError(
    {
      code: 'internal_error',
      message: `Unexpected response from the server (HTTP ${response.status}).`,
      ...(requestId ? { details: { requestId } } : {}),
    },
    { requestId },
  )
}

async function readJson(response: Response, key: string): Promise<unknown> {
  const requestId = response.headers.get('x-request-id') ?? undefined
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  }
  catch (error) {
    throw new HarnessError(
      { code: 'internal_error', message: `The server sent an invalid JSON response for ${key}.` },
      { cause: error, requestId },
    )
  }
}

async function callRoute(
  key: ApiRouteKey,
  input: LooseInput | undefined,
  options: Required<Pick<ApiClientOptions, 'baseUrl' | 'credentials'>> & Pick<ApiClientOptions, 'fetch'>,
): Promise<unknown> {
  const route: ApiRouteDef = apiRoutes[key]
  const url = buildUrl(key, input, options.baseUrl)
  const headers: Record<string, string> = {
    accept: typeof route.response === 'string' ? ACCEPT_BY_RESPONSE[route.response] : 'application/json',
  }
  let body: string | FormData | undefined
  if (input?.form !== undefined) {
    // The runtime sets the multipart boundary header.
    body = input.form
  }
  else if (route.body) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(input?.body ?? {})
  }
  for (const [name, value] of Object.entries(input?.headers ?? {}))
    headers[name.toLowerCase()] = value

  const fetchImpl = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: route.method,
      headers,
      body,
      credentials: options.credentials,
      signal: input?.signal,
    })
  }
  catch (error) {
    if (isAbort(error, input?.signal))
      throw error
    throw new HarnessError({ code: 'internal_error', message: 'Could not reach the server.' }, { cause: error })
  }

  if (!response.ok)
    throw await readError(response)
  if (typeof route.response !== 'string')
    return readJson(response, key)
  if (route.response === 'empty') {
    await response.body?.cancel().catch(() => {})
    return undefined
  }
  return response
}

/**
 * Creates the typed client: one function per route, `client.<module>.<action>(input?)`. JSON bodies are sent with
 * `Content-Type: application/json`, multipart bodies (`form`) as given; cookies follow `credentials` (default
 * `same-origin`). A non-2xx response throws a `HarnessError` parsed from the envelope (with `requestId` from
 * `X-Request-Id`); a network failure or a non-envelope body throws `internal_error`; an aborted request rethrows the
 * abort error.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const resolved = {
    baseUrl: options.baseUrl ?? '/api',
    credentials: options.credentials ?? 'same-origin',
    fetch: options.fetch,
  } as const
  const client: Record<string, Record<string, (input?: LooseInput) => Promise<unknown>>> = {}
  for (const key of API_ROUTE_KEYS) {
    const [module = '', action = ''] = key.split('.')
    const group = client[module] ?? (client[module] = {})
    group[action] = input => callRoute(key, input, resolved)
  }
  return client as unknown as ApiClient
}
