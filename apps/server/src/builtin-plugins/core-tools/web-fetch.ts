// The `web_fetch` tool of `core-tools` (policy `ask`): fetches a public http(s) URL through the SSRF guard
// (security/ssrf.ts: public addresses only, every redirect re-checked, 10 s, 2 MB) and returns the title and readable
// text of HTML pages, or the text of text documents (plain, markdown, JSON, XML, ...). Other content types are refused.
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { SafeFetch } from '../../security/types.ts'
import { Buffer } from 'node:buffer'
import { HarnessError } from '@harness-forge/shared'
import { z } from 'zod'
import { createSafeFetch, safeFetch } from '../../security/ssrf.ts'
import { charsetOf, contentKind, decodeBytes, extractHtml, mimeTypeOf, normalizePlainText, sniffHtmlCharset } from './html-text.ts'

export const WEB_FETCH_TOOL_NAME = 'web_fetch'
/** Response body cap (ARCHITECTURE.md 10.4). */
export const WEB_FETCH_MAX_BYTES = 2_097_152
export const WEB_FETCH_TIMEOUT_MS = 10_000
export const WEB_FETCH_MAX_REDIRECTS = 5
export const WEB_FETCH_MIN_CHARS = 1000
export const WEB_FETCH_MAX_CHARS = 40_000
export const WEB_FETCH_DEFAULT_CHARS = 20_000
/**
 * Budget of `text` as serialized JSON: the whole tool output stays well under the 64 KB cap of the chat pipeline even
 * for scripts that take three UTF-8 bytes per character.
 */
export const WEB_FETCH_TEXT_JSON_BYTES = 48_000
/** Longest URL accepted from the model. */
export const WEB_FETCH_URL_MAX_CHARS = 2048

const ACCEPT = 'text/html,application/xhtml+xml,text/plain;q=0.9,text/*;q=0.8,application/json;q=0.8,application/xml;q=0.7,*/*;q=0.1'
/** Room kept for looking back to a whitespace boundary when cutting text. */
const WORD_BOUNDARY_LOOKBACK = 200

export const webFetchInputSchema = z.object({
  url: z.string().trim().min(1).max(WEB_FETCH_URL_MAX_CHARS).describe('The http:// or https:// URL to fetch.'),
  maxChars: z
    .int()
    .min(WEB_FETCH_MIN_CHARS)
    .max(WEB_FETCH_MAX_CHARS)
    .optional()
    .describe(`Maximum characters of text to return (${WEB_FETCH_MIN_CHARS}-${WEB_FETCH_MAX_CHARS}, default ${WEB_FETCH_DEFAULT_CHARS}).`),
})
export type WebFetchInput = z.infer<typeof webFetchInputSchema>

export interface WebFetchOutput {
  /** Final URL after redirects. */
  url: string
  status: number
  /** `type/subtype` of the response, null when missing. */
  contentType: string | null
  /** HTML `<title>` (else `og:title`); null for other documents. */
  title: string | null
  /** Readable text (HTML) or the document text, cut to `maxChars`. */
  text: string
  /** `text` was cut. */
  truncated: boolean
}

function jsonBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Never ends inside a surrogate pair. */
function safeEnd(text: string, end: number): number {
  const code = text.charCodeAt(end - 1)
  return end > 0 && code >= 0xD800 && code <= 0xDBFF ? end - 1 : end
}

/**
 * Cuts `text` to at most `maxChars` characters and `maxJsonBytes` bytes of serialized JSON, preferring a whitespace
 * boundary close to the cut.
 */
export function truncateText(text: string, maxChars: number, maxJsonBytes: number = WEB_FETCH_TEXT_JSON_BYTES): { text: string, truncated: boolean } {
  if (text.length <= maxChars && jsonBytes(text) <= maxJsonBytes)
    return { text, truncated: false }
  let end = Math.min(text.length, maxChars)
  if (jsonBytes(text.slice(0, end)) > maxJsonBytes) {
    let low = 0
    let high = end
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (jsonBytes(text.slice(0, middle)) <= maxJsonBytes)
        low = middle
      else
        high = middle - 1
    }
    end = low
  }
  end = safeEnd(text, end)
  const window = text.slice(Math.max(0, end - WORD_BOUNDARY_LOOKBACK), end)
  const boundary = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'))
  if (boundary > 0)
    end = end - window.length + boundary
  return { text: text.slice(0, end).trimEnd(), truncated: true }
}

export interface WebFetchDeps {
  /** The guarded fetch of this call. */
  fetch: SafeFetch
  userAgent?: string
  signal?: AbortSignal
}

/** Fetches `input.url` and converts the response for the model. Errors are `HarnessError`s with a clear message. */
export async function webFetch(input: WebFetchInput, deps: WebFetchDeps): Promise<WebFetchOutput> {
  const maxChars = Math.min(WEB_FETCH_MAX_CHARS, Math.max(WEB_FETCH_MIN_CHARS, input.maxChars ?? WEB_FETCH_DEFAULT_CHARS))
  const headers: Record<string, string> = { accept: ACCEPT }
  if (deps.userAgent)
    headers['user-agent'] = deps.userAgent
  const response = await deps.fetch(input.url.trim(), {
    maxBytes: WEB_FETCH_MAX_BYTES,
    timeoutMs: WEB_FETCH_TIMEOUT_MS,
    maxRedirects: WEB_FETCH_MAX_REDIRECTS,
    headers,
    ...(deps.signal ? { signal: deps.signal } : {}),
  })
  if (response.status >= 400)
    throw new HarnessError({ code: 'provider_error', message: `The server answered HTTP ${response.status}.`, status: response.status })

  const header = response.headers.get('content-type')
  const mimeType = mimeTypeOf(header)
  const kind = contentKind(mimeType, response.body)
  if (kind === 'unsupported') {
    throw new HarnessError({
      code: 'provider_error',
      message: `Unsupported content type "${mimeType ?? 'unknown'}": web_fetch reads HTML and text documents only.`,
    })
  }
  let title: string | null = null
  let text: string
  if (kind === 'html') {
    const page = extractHtml(decodeBytes(response.body, charsetOf(header) ?? sniffHtmlCharset(response.body)))
    title = page.title
    text = page.text
  }
  else {
    text = normalizePlainText(decodeBytes(response.body, charsetOf(header)))
  }
  const cut = truncateText(text, maxChars)
  return { url: response.url, status: response.status, contentType: mimeType, title, text: cut.text, truncated: cut.truncated }
}

export interface WebFetchToolOptions {
  /** Read at call time: the `allowLocalhost` setting of `core-tools` (default: loopback stays blocked). */
  allowLocalhost?: () => boolean
  /** `User-Agent` of the requests. */
  userAgent?: string
  /** The public-only guard (default `safeFetch`). */
  safeFetch?: SafeFetch
  /** The guard that also reaches loopback addresses (default `createSafeFetch({ allowLoopback: true })`, lazily). */
  loopbackFetch?: SafeFetch
}

/** The `web_fetch` tool definition. */
export function createWebFetchTool(options: WebFetchToolOptions = {}): ToolDefinition<WebFetchInput, WebFetchOutput> {
  let loopbackFetch = options.loopbackFetch
  const fetcher = (): SafeFetch => {
    if (options.allowLocalhost?.() !== true)
      return options.safeFetch ?? safeFetch
    loopbackFetch ??= createSafeFetch({ allowLoopback: true })
    return loopbackFetch
  }
  return {
    name: WEB_FETCH_TOOL_NAME,
    description: 'Fetch a web page or text document (http or https) and return its title and readable text. Only public internet addresses can be reached; HTML is converted to plain text, other text documents are returned as is.',
    inputSchema: webFetchInputSchema,
    policy: 'ask',
    async execute(input, c) {
      return webFetch(input, { fetch: fetcher(), userAgent: options.userAgent, signal: c.signal })
    },
  }
}
