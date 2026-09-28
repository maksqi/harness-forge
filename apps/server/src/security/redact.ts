// Secret redaction for logs and error messages (ARCHITECTURE.md 10.3 and 12). W4.1 may extend the patterns.
import type { Redactor } from './types.ts'

/** Replacement for a masked value. */
export const REDACTED = '[redacted]'

/** Registered secrets shorter than this are ignored (they would mask ordinary words). */
const MIN_SECRET_LENGTH = 4
/** Longer strings are cut in `redact()` (logs never need megabytes of text). */
const MAX_STRING_LENGTH = 16_384
const MAX_DEPTH = 8

/**
 * Field names whose values are masked: auth headers and anything that looks like a key, secret, password, passphrase,
 * token, credential or signature.
 */
const SENSITIVE_KEY = /authorization|cookie|key|secret|passw(?:or)?d|passphrase|token|credential|signature/i

/**
 * A value after a secret-looking name in free text (`password=...`, `"api_key": "..."`, `x-api-key: ...`): at least 6
 * characters with a digit, or at least 12 characters, so ordinary words ("token: none", "password: must ...") stay.
 */
const SECRET_VALUE = String.raw`(?=[^\s"',;}&]*\d)[^\s"',;}&]{6,}|[^\s"',;}&]{12,}`

/** Text patterns masked by `redactText()`, with their replacement (`$1` keeps a non-secret prefix). */
const TEXT_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // `Bearer <token>` anywhere, `Basic <credentials>` in an authorization header.
  [/\b(Bearer\s+)[\w.~+/=-]{8,}/gi, `$1${REDACTED}`],
  [/(authorization["']?\s*[:=]\s*["']?Basic\s+)[\w.~+/=-]+/gi, `$1${REDACTED}`],
  // OpenAI / Anthropic / DeepSeek / OpenRouter style keys (`sk-...`, `sk-ant-...`, `sk-or-...`) and similar prefixes.
  [/\b(?:sk|pk|rk)-[\w-]{3,}/g, REDACTED],
  // Groq, xAI, GitHub, Hugging Face and Google API keys.
  [/\b(?:gsk_|xai-|ghp_|gho_|github_pat_|hf_)\w{16,}/gi, REDACTED],
  [/\bAIza[\w-]{20,}/g, REDACTED],
  // Secrets in URL query strings, also with a prefixed name (`X-Amz-Signature`, `X-Amz-Security-Token`,
  // `client_secret`, `access_token`, `X-Goog-Credential`).
  [/([?&;](?:[\w.~-]*[-_.])?(?:api[_-]?key|key|token|secret|password|passwd|sig|signature|credential|auth)=)[^&\s#"']+/gi, `$1${REDACTED}`],
  // Name / value pairs in free text and JSON excerpts (upstream error bodies, plugin log lines).
  [new RegExp(String.raw`((?:^|[^\w-])["']?[\w-]*?(?:api[-_]?key|secret|passw(?:or)?d|passphrase|token|credential|authorization)["']?\s*[:=]\s*["']?)(?:${SECRET_VALUE})`, 'gi'), `$1${REDACTED}`],
  // The session cookie.
  [/(hf_session=)[^;\s"']+/g, `$1${REDACTED}`],
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

/** A redactor with its own set of registered secrets (one per app instance). */
export function createRedactor(): Redactor {
  const secrets = new Set<string>()
  let secretPattern: RegExp | null = null

  function addSecret(value: string): void {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH || secrets.has(value))
      return
    secrets.add(value)
    const sorted = [...secrets].sort((a, b) => b.length - a.length).map(escapeRegExp)
    secretPattern = new RegExp(sorted.join('|'), 'g')
  }

  function redactText(text: string): string {
    let out = text
    if (secretPattern !== null)
      out = out.replace(secretPattern, REDACTED)
    for (const [pattern, replacement] of TEXT_PATTERNS)
      out = out.replace(pattern, replacement)
    return out
  }

  function redactString(text: string): string {
    const cut = text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}...[truncated]` : text
    return redactText(cut)
  }

  function redactError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
    const out: Record<string, unknown> = { name: error.name, message: redactString(error.message) }
    const extra = error as Error & { code?: unknown, status?: unknown, providerId?: unknown, details?: unknown }
    if (extra.code !== undefined)
      out.code = walk(extra.code, false, depth + 1, seen)
    if (extra.status !== undefined)
      out.status = walk(extra.status, false, depth + 1, seen)
    if (extra.providerId !== undefined)
      out.providerId = walk(extra.providerId, false, depth + 1, seen)
    if (extra.details !== undefined)
      out.details = walk(extra.details, false, depth + 1, seen)
    if (typeof error.stack === 'string')
      out.stack = redactString(error.stack)
    if (error.cause !== undefined)
      out.cause = walk(error.cause, false, depth + 1, seen)
    return out
  }

  function walk(value: unknown, sensitive: boolean, depth: number, seen: WeakSet<object>): unknown {
    switch (typeof value) {
      case 'string':
        return sensitive ? REDACTED : redactString(value)
      case 'number':
      case 'boolean':
      case 'undefined':
        return value
      case 'bigint':
        return sensitive ? REDACTED : value.toString()
      case 'symbol':
        return value.toString()
      case 'function':
        return '[function]'
    }
    if (value === null)
      return null
    const object = value as object
    if (depth > MAX_DEPTH)
      return '[truncated]'
    if (seen.has(object))
      return '[circular]'
    seen.add(object)
    try {
      if (object instanceof Error)
        return sensitive ? REDACTED : redactError(object, depth, seen)
      if (object instanceof Date)
        return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString()
      if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer)
        return `[binary ${object.byteLength} bytes]`
      if (object instanceof URL)
        return sensitive ? REDACTED : redactString(object.href)
      if (Array.isArray(object))
        return object.map(item => walk(item, sensitive, depth + 1, seen))
      if (object instanceof Map)
        return [...object.entries()].map(([key, item]) => [walk(key, sensitive, depth + 1, seen), walk(item, sensitive || SENSITIVE_KEY.test(String(key)), depth + 1, seen)])
      if (object instanceof Set)
        return [...object].map(item => walk(item, sensitive, depth + 1, seen))
      if (object instanceof Headers) {
        const out: Record<string, unknown> = {}
        object.forEach((item, key) => {
          out[key] = walk(item, sensitive || SENSITIVE_KEY.test(key), depth + 1, seen)
        })
        return out
      }
      if (!isPlainObject(object) && typeof (object as { toJSON?: unknown }).toJSON === 'function')
        return walk((object as { toJSON: () => unknown }).toJSON(), sensitive, depth + 1, seen)
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(object))
        out[key] = walk(item, sensitive || SENSITIVE_KEY.test(key), depth + 1, seen)
      return out
    }
    finally {
      seen.delete(object)
    }
  }

  return {
    addSecret,
    redactText,
    redact: value => walk(value, false, 0, new WeakSet()),
  }
}
