// Error envelope, error codes and the `HarnessError` class (API.md section 2).
import { z } from 'zod'

// ---------- codes and actions ----------

/** Every error code of the HTTP API (API.md table 2.2). */
export const HARNESS_ERROR_CODES = [
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'provider_not_configured',
  'auth_invalid',
  'rate_limited',
  'model_not_found',
  'context_overflow',
  'provider_unreachable',
  'provider_error',
  'plugin_error',
  'internal_error',
  'not_implemented',
] as const

export const harnessErrorCodeSchema = z.enum(HARNESS_ERROR_CODES)
export type HarnessErrorCode = z.infer<typeof harnessErrorCodeSchema>

/** UI hints carried by an error (`action`). */
export const HARNESS_ERROR_ACTIONS = ['configure-provider', 'refresh-models', 'login', 'retry'] as const

export const harnessErrorActionSchema = z.enum(HARNESS_ERROR_ACTIONS)
export type HarnessErrorAction = z.infer<typeof harnessErrorActionSchema>

/**
 * HTTP status of our response for each code (API.md table 2.2). The envelope `status` field is something else: the
 * status reported by an upstream service.
 */
export const errorStatusByCode = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  provider_not_configured: 400,
  auth_invalid: 502,
  rate_limited: 429,
  model_not_found: 404,
  context_overflow: 400,
  provider_unreachable: 502,
  provider_error: 502,
  plugin_error: 500,
  internal_error: 500,
  not_implemented: 501,
} as const satisfies Record<HarnessErrorCode, number>

/** Every HTTP status an error response can have. */
export type HarnessErrorHttpStatus = (typeof errorStatusByCode)[HarnessErrorCode]

// ---------- envelope ----------

/**
 * Plain JSON error object: DTO fields (`lastError`, `metadata.error`, ...), the envelope content and the return type
 * of a provider's `mapError()`.
 */
export const harnessErrorInitSchema = z.strictObject({
  code: harnessErrorCodeSchema,
  /** Human readable, English, safe to show; never contains secrets. */
  message: z.string(),
  /** HTTP status reported by an upstream service (provider, MCP server, npm registry, install URL). */
  status: z.int().min(100).max(599).optional(),
  /** Provider involved, when any. */
  providerId: z.string().min(1).max(200).optional(),
  /** For `rate_limited`: how long to wait (also sent as `Retry-After` in seconds, rounded up). */
  retryAfterMs: z.number().min(0).optional(),
  /** UI hint. */
  action: harnessErrorActionSchema.optional(),
  /** Code-specific details (API.md section 2.3). */
  details: z.unknown().optional(),
})
export type HarnessErrorInit = z.infer<typeof harnessErrorInitSchema>

/** Body of every non-2xx response, and the JSON inside an in-stream `errorText`. */
export const harnessErrorEnvelopeSchema = z.strictObject({ error: harnessErrorInitSchema })
export type HarnessErrorEnvelope = z.infer<typeof harnessErrorEnvelopeSchema>

// ---------- details by code (API.md section 2.3) ----------

/** One flattened zod issue of a `validation_error`. */
export const validationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  code: z.string(),
})
export type ValidationIssue = z.infer<typeof validationIssueSchema>

export const validationErrorDetailsSchema = z.object({ issues: z.array(validationIssueSchema) })
export type ValidationErrorDetails = z.infer<typeof validationErrorDetailsSchema>

/**
 * `busy`: another maintenance operation (bulk import, delete-all, key rotation, file cleanup) is running (ADR-024,
 * ADR-034, ADR-035); `only-version`: a message without another version cannot be deleted (ADR-030); `env-key`: the
 * master key comes from `HF_MASTER_KEY` and can only be rotated offline with the `rotate-key` CLI (ADR-034);
 * `key-mismatch`: the master key does not match the stored key check, so a rotation would lose the secrets (ADR-034).
 */
export const conflictReasonSchema = z.enum(['run-active', 'exists', 'stale', 'disabled', 'env-password', 'insecure-bind', 'busy', 'only-version', 'env-key', 'key-mismatch'])
export type ConflictReason = z.infer<typeof conflictReasonSchema>

export const conflictDetailsSchema = z.object({ reason: conflictReasonSchema, chatId: z.string().optional() })
export type ConflictDetails = z.infer<typeof conflictDetailsSchema>

export const payloadTooLargeDetailsSchema = z.object({ limitBytes: z.int().min(0) })
export type PayloadTooLargeDetails = z.infer<typeof payloadTooLargeDetailsSchema>

export const pluginErrorPhaseSchema = z.enum(['load', 'setup', 'dispose', 'hook', 'tool', 'build', 'install'])
export type PluginErrorPhase = z.infer<typeof pluginErrorPhaseSchema>

export const pluginErrorDetailsSchema = z.object({ pluginId: z.string(), phase: pluginErrorPhaseSchema.optional() })
export type PluginErrorDetails = z.infer<typeof pluginErrorDetailsSchema>

export const internalErrorDetailsSchema = z.object({ requestId: z.string() })
export type InternalErrorDetails = z.infer<typeof internalErrorDetailsSchema>

/** Details of the other codes: omitted, or a short redacted upstream message. */
export const upstreamErrorDetailsSchema = z.object({ upstream: z.string().optional() })
export type UpstreamErrorDetails = z.infer<typeof upstreamErrorDetailsSchema>

// ---------- HarnessError ----------

export interface HarnessErrorOptions {
  /** The original error (kept for logs; never serialized). */
  cause?: unknown
  /** Client side: the `X-Request-Id` of the failed response. */
  requestId?: string
}

const GENERIC_MESSAGE = 'An unexpected error occurred.'
const KNOWN_CODES: ReadonlySet<string> = new Set(HARNESS_ERROR_CODES)

/**
 * Throwable form of `HarnessErrorInit`. Thrown by services and routes on the server (rendered by the error handler as
 * an envelope with status `errorStatusByCode[code]`) and by `createApiClient` on every non-2xx response.
 */
export class HarnessError extends Error implements HarnessErrorInit {
  declare readonly code: HarnessErrorCode
  declare readonly status?: number
  declare readonly providerId?: string
  declare readonly retryAfterMs?: number
  declare readonly action?: HarnessErrorAction
  declare readonly details?: unknown
  /** Client side: `X-Request-Id` of the failed response. */
  declare readonly requestId?: string

  /** An unknown `code` (possible from untyped plugin code) becomes `internal_error`. */
  constructor(init: HarnessErrorInit, options: HarnessErrorOptions = {}) {
    super(init.message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = KNOWN_CODES.has(init.code) ? init.code : 'internal_error'
    if (init.status !== undefined)
      this.status = init.status
    if (init.providerId !== undefined)
      this.providerId = init.providerId
    if (init.retryAfterMs !== undefined)
      this.retryAfterMs = init.retryAfterMs
    if (init.action !== undefined)
      this.action = init.action
    if (init.details !== undefined)
      this.details = init.details
    if (options.requestId !== undefined)
      this.requestId = options.requestId
  }

  /** HTTP status of the error response: `errorStatusByCode[code]` (never the upstream `status`). */
  get httpStatus(): HarnessErrorHttpStatus {
    return errorStatusByCode[this.code]
  }

  /** The envelope `{ error: HarnessErrorInit }`; undefined fields are omitted, `requestId` and `cause` never included. */
  toJSON(): HarnessErrorEnvelope {
    const error: HarnessErrorInit = { code: this.code, message: this.message }
    if (this.status !== undefined)
      error.status = this.status
    if (this.providerId !== undefined)
      error.providerId = this.providerId
    if (this.retryAfterMs !== undefined)
      error.retryAfterMs = this.retryAfterMs
    if (this.action !== undefined)
      error.action = this.action
    if (this.details !== undefined)
      error.details = this.details
    return { error }
  }

  /**
   * Normalizes anything thrown into a `HarnessError`:
   * - a `HarnessError` is returned as is;
   * - a `HarnessErrorInit` or envelope object, or its JSON string;
   * - an error whose `responseBody` (AI SDK `APICallError`) or `message` is envelope JSON (`useChat` errors);
   * - a `HarnessError` created by another copy of this module;
   * - anything else becomes `internal_error` with a generic message (the original is kept as `cause` only, so its
   *   message never reaches a response).
   */
  static from(input: unknown): HarnessError {
    if (input instanceof HarnessError)
      return input
    const init = readErrorInit(input, 0)
    if (init)
      return new HarnessError(init, { cause: input, requestId: readRequestId(input) })
    return new HarnessError({ code: 'internal_error', message: GENERIC_MESSAGE }, { cause: input })
  }
}

Object.defineProperty(HarnessError.prototype, 'name', {
  value: 'HarnessError',
  writable: true,
  configurable: true,
  enumerable: false,
})

/** True for a `HarnessError` (including one created by another copy of this module). */
export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof HarnessError
    || (value instanceof Error && value.name === 'HarnessError' && KNOWN_CODES.has(String((value as { code?: unknown }).code)))
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{'))
    return undefined
  try {
    return JSON.parse(trimmed) as unknown
  }
  catch {
    return undefined
  }
}

function readRequestId(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null)
    return undefined
  const requestId = (input as { requestId?: unknown }).requestId
  return typeof requestId === 'string' ? requestId : undefined
}

const INIT_KEYS = ['code', 'message', 'status', 'providerId', 'retryAfterMs', 'action', 'details'] as const

function readErrorInit(input: unknown, depth: number): HarnessErrorInit | undefined {
  if (depth > 3)
    return undefined
  if (typeof input === 'string')
    return readErrorInit(parseJsonObject(input), depth + 1)
  if (typeof input !== 'object' || input === null)
    return undefined

  const envelope = harnessErrorEnvelopeSchema.safeParse(input)
  if (envelope.success)
    return envelope.data.error
  const init = harnessErrorInitSchema.safeParse(input)
  if (init.success)
    return init.data

  const record = input as Record<string, unknown>
  if (isHarnessError(input)) {
    const picked: Record<string, unknown> = {}
    for (const key of INIT_KEYS) {
      if (record[key] !== undefined)
        picked[key] = record[key]
    }
    const foreign = harnessErrorInitSchema.safeParse(picked)
    if (foreign.success)
      return foreign.data
  }
  for (const key of ['responseBody', 'message'] as const) {
    const value = record[key]
    if (typeof value === 'string') {
      const nested = readErrorInit(value, depth + 1)
      if (nested)
        return nested
    }
  }
  return undefined
}

// ---------- validation errors ----------

interface IssueLike {
  readonly code: string
  readonly message: string
  readonly path: readonly PropertyKey[]
  readonly issues?: readonly IssueLike[]
}

function pushIssues(issues: readonly IssueLike[], base: readonly PropertyKey[], out: ValidationIssue[]): void {
  for (const issue of issues) {
    const path = [...base, ...issue.path]
    // Record keys and map / set elements carry their own nested issues: report those instead of the wrapper.
    if ((issue.code === 'invalid_key' || issue.code === 'invalid_element') && issue.issues && issue.issues.length > 0) {
      pushIssues(issue.issues, path, out)
      continue
    }
    out.push({
      path: path.map(segment => (typeof segment === 'number' ? segment : String(segment))),
      message: issue.message,
      code: issue.code,
    })
  }
}

/** Flattens zod issues into the `details.issues` shape of a `validation_error`. */
export function flattenValidationIssues(source: { readonly issues: readonly IssueLike[] } | readonly IssueLike[]): ValidationIssue[] {
  const issues: readonly IssueLike[] = 'issues' in source ? source.issues : source
  const out: ValidationIssue[] = []
  pushIssues(issues, [], out)
  return out
}

/**
 * A `validation_error` built from a zod error (or its issues), with `details: { issues }`. The message defaults to
 * the first issue, prefixed with its path (`name: Too big: ...`).
 */
export function validationError(
  source: { readonly issues: readonly IssueLike[] } | readonly IssueLike[],
  message?: string,
): HarnessError {
  const issues = flattenValidationIssues(source)
  const first = issues[0]
  const fallback = first
    ? `${first.path.length > 0 ? `${first.path.join('.')}: ` : ''}${first.message}`
    : 'Invalid request.'
  return new HarnessError({ code: 'validation_error', message: message ?? fallback, details: { issues } })
}
