// Helpers shared by the language models (./models.ts) and the media models (./media.ts) of the dev-only `mock`
// provider (PROVIDERS.md 8): the provider id, word counting, abortable delays and the error of an unknown model id.
import { APICallError } from '@ai-sdk/provider'

export const MOCK_PROVIDER_ID = 'mock'

/** The answer to an empty user text (`mock:echo`, `mock:shell`). */
export const MOCK_EMPTY_MESSAGE = '(empty message)'

/** Whitespace-separated words. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(word => word !== '').length
}

/** Chunks of one word plus its following whitespace. */
export function wordChunks(text: string): string[] {
  return text.match(/\S+\s*/g) ?? []
}

/** The reason of an aborted signal as an error (an `AbortError` `DOMException` when the reason is not an error). */
export function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason
  return reason instanceof Error || reason instanceof DOMException ? reason : new DOMException('The operation was aborted.', 'AbortError')
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(abortError(signal))
  if (ms <= 0)
    return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal as AbortSignal))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The `APICallError` (404, not retryable) of a model id the mock provider does not have for this kind of model. */
export function unknownModelError(modelId: string): APICallError {
  return new APICallError({
    message: `Unknown mock model "${modelId}".`,
    url: `mock://${encodeURIComponent(modelId)}`,
    requestBodyValues: {},
    statusCode: 404,
    isRetryable: false,
  })
}
