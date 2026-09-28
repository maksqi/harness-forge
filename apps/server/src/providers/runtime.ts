// Provider runtime pieces (PLUGINS.md 9 `ProviderRuntime`, 11 "Guards"): the host `fetch` handed to provider code and
// the timeout guard of provider calls. Provider calls are guarded here rather than by the plugin host guard: their
// failures are upstream errors (mapped to `auth_invalid`, `rate_limited`, ...), not `plugin_error`s.
import type { ProviderDefinition, ProviderRuntime } from '@harness-forge/plugin-sdk'
import type { Logger } from '../logger.ts'
import type { Redactor } from '../security/types.ts'
import { HarnessError } from '@harness-forge/shared'

/** `listModels` guard (PLUGINS.md 11). */
export const LIST_MODELS_TIMEOUT_MS = 15_000
/** `validate` guard and the whole `POST /providers/:id/test` (API.md 5.5). */
export const VALIDATE_TIMEOUT_MS = 15_000
/** Same-origin redirects followed by the host `fetch`. */
export const MAX_PROVIDER_REDIRECTS = 5

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** The `DOMException` a guard aborts with when its time is up (mapped to `provider_unreachable`). */
export function timeoutError(ms: number): DOMException {
  return new DOMException(`The provider did not answer within ${Math.round(ms / 1000)} s.`, 'TimeoutError')
}

/** The reason of an aborted signal as an error (`AbortError` when the reason is not an error). */
export function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason
  return reason instanceof Error || reason instanceof DOMException ? reason : new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * Runs `run` with a signal that aborts after `ms` or when `parent` aborts. On timeout the signal aborts with a
 * `TimeoutError` and the returned promise rejects with it (the host stops waiting even if `run` ignores the signal).
 */
export async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => T | Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  if (parent?.aborted)
    throw abortReason(parent)
  const onParentAbort = (): void => controller.abort(parent ? abortReason(parent) : undefined)
  parent?.addEventListener('abort', onParentAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError(ms)
      controller.abort(error)
      reject(error)
    }, ms)
  })
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(abortReason(controller.signal)), { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), expired, aborted])
  }
  finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', onParentAbort)
  }
}

/** Combines optional signals (undefined when there is none). */
export function combineSignals(...signals: (AbortSignal | null | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined && signal !== null)
  if (present.length <= 1)
    return present[0]
  return AbortSignal.any(present)
}

export interface HostFetchOptions {
  providerId: string
  /** Debug log of method + URL (never headers or bodies). */
  logger: Logger
  /** Aborts every request (the run signal, or the guard signal of `listModels` / `validate`). */
  signal?: AbortSignal
  /** The underlying fetch (default `globalThis.fetch`, read at call time so tests can stub it). */
  fetch?: typeof globalThis.fetch
  maxRedirects?: number
}

function redirectError(providerId: string, message: string): HarnessError {
  return new HarnessError({ code: 'provider_error', message, providerId })
}

function isReplayableBody(body: RequestInit['body']): boolean {
  return body === undefined || body === null || typeof body === 'string' || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body) || body instanceof URLSearchParams || body instanceof Blob || body instanceof FormData
}

/**
 * The host `fetch` of `ProviderRuntime`: requests abort with `signal`, at most `maxRedirects` same-origin redirects
 * are followed (a cross-origin redirect fails with `provider_error`, so a key is never sent to another host), and
 * each request is logged at `debug` with its method and URL.
 */
export function createHostFetch(options: HostFetchOptions): typeof globalThis.fetch {
  const maxRedirects = options.maxRedirects ?? MAX_PROVIDER_REDIRECTS
  const logger = options.logger

  return async (input, init = {}) => {
    const baseFetch = options.fetch ?? globalThis.fetch
    const signal = combineSignals(options.signal, init.signal ?? (input instanceof Request ? input.signal : undefined))

    if (input instanceof Request) {
      // The AI SDK passes URL strings; a `Request` input is sent once and a redirect answer is refused.
      logger.debug('provider request', { providerId: options.providerId, method: input.method, url: input.url })
      const response = await baseFetch(input, { ...init, signal, redirect: 'manual' })
      if (REDIRECT_STATUSES.has(response.status) && response.headers.has('location')) {
        await response.body?.cancel().catch(() => {})
        throw redirectError(options.providerId, 'The provider answered with a redirect, which is not followed for this request.')
      }
      return response
    }

    let url = new URL(input instanceof URL ? input.href : String(input))
    let method = (init.method ?? 'GET').toUpperCase()
    let body = init.body
    const headers = new Headers(init.headers)
    for (let hops = 0; ; hops++) {
      logger.debug('provider request', { providerId: options.providerId, method, url: url.href })
      const response = await baseFetch(url.href, { ...init, method, headers, body, signal, redirect: 'manual' })
      const location = response.headers.get('location')
      if (!REDIRECT_STATUSES.has(response.status) || location === null)
        return response
      await response.body?.cancel().catch(() => {})
      let next: URL
      try {
        next = new URL(location, url)
      }
      catch {
        throw redirectError(options.providerId, 'The provider answered with an invalid redirect.')
      }
      if (next.origin !== url.origin)
        throw redirectError(options.providerId, `The provider redirected to another origin (${next.origin}); cross-origin redirects are not followed.`)
      if (hops >= maxRedirects)
        throw redirectError(options.providerId, `The provider redirected more than ${maxRedirects} times.`)
      const rewriteToGet = response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')
      if (rewriteToGet) {
        method = method === 'HEAD' ? 'HEAD' : 'GET'
        body = undefined
        headers.delete('content-type')
        headers.delete('content-length')
      }
      else if (!isReplayableBody(body)) {
        throw redirectError(options.providerId, 'The provider redirected a streamed request, which cannot be replayed.')
      }
      url = next
    }
  }
}

export interface ProviderRuntimeInput {
  definition: ProviderDefinition
  /** Resolved credential values (stored -> env -> default); unresolved optional fields are absent. */
  values: Readonly<Record<string, string>>
  /** The run signal, or the guard signal of `listModels` / `validate`. */
  signal?: AbortSignal
  logger: Logger
  /** Resolved secret values are registered so they never reach logs or error details. */
  redactor: Redactor
  fetch?: typeof globalThis.fetch
}

/** The `ProviderRuntime` handed to `createLanguageModel`, `listModels` and `validate`. */
export function createProviderRuntime(input: ProviderRuntimeInput): ProviderRuntime {
  for (const field of input.definition.credentials) {
    const value = input.values[field.key]
    if (field.type === 'secret' && value)
      input.redactor.addSecret(value)
  }
  return {
    credentials: { ...input.values },
    fetch: createHostFetch({ providerId: input.definition.id, logger: input.logger, signal: input.signal, fetch: input.fetch }),
    signal: input.signal,
  }
}
