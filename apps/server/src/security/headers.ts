// Secure response headers and Content-Security-Policy values (ARCHITECTURE.md 10.2). Applied to every response by
// `http/middleware/secure-headers.ts`; the SPA HTML CSP (with the sha256 hashes of the document's inline scripts) is
// built by `http/static.ts` from the served `200.html` / `index.html`. Owner: W1.1 (W1.1-T7).
import { createHash } from 'node:crypto'

/**
 * Sent on every response (a route may set its own value first; it is then kept). `X-Robots-Tag` (Phase 5, ADR-025)
 * keeps share links, the SPA and the API out of search engines.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Robots-Tag': 'noindex, nofollow',
})

/** `Strict-Transport-Security`, sent only on HTTPS requests (`X-Forwarded-Proto: https` counts). */
export const HSTS_HEADER_VALUE = 'max-age=31536000'

/** CSP of API responses (and other non-HTML responses) that do not set their own. */
export const API_CSP = 'default-src \'none\'; frame-ancestors \'none\''

/** `Cache-Control` of API responses that do not set their own. */
export const API_CACHE_CONTROL = 'no-store'

/**
 * The SPA HTML CSP (ARCHITECTURE.md 10.2). `scriptHashes` are CSP hash sources without quotes (`sha256-<base64>`, see
 * `inlineScriptHashes`). Never contains `unsafe-eval` or `unsafe-inline` for scripts. `wasm-unsafe-eval` only allows
 * compiling WebAssembly (Shiki's Oniguruma engine used by markdown code blocks), not JavaScript `eval`.
 */
export function spaCsp(scriptHashes: readonly string[]): string {
  const scriptSources = ['\'self\'', '\'wasm-unsafe-eval\'', ...scriptHashes.map(hash => `'${hash}'`)]
  return [
    'default-src \'self\'',
    `script-src ${scriptSources.join(' ')}`,
    'style-src \'self\' \'unsafe-inline\'',
    'img-src \'self\' data: blob:',
    'font-src \'self\' data:',
    'connect-src \'self\'',
    'worker-src \'self\' blob:',
    'object-src \'none\'',
    'base-uri \'none\'',
    'form-action \'self\'',
    'frame-ancestors \'none\'',
  ].join('; ')
}

/** `<script ...>...</script>`: attributes (group 1) and raw text content (group 2). */
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
/** A `src` attribute (not `data-src`). */
const SRC_ATTRIBUTE = /(?:^|\s)src\s*=/i

/** CSP hash source (`sha256-<base64>`, no quotes) of a script's text. */
export function scriptHash(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`
}

/**
 * CSP hash sources of every inline `<script>` element (no `src`) of an HTML document, in document order, without
 * duplicates. The text is hashed exactly as the browser sees it: HTML input preprocessing turns CR LF and lone CR into
 * LF before parsing, and script content is raw text (no entity decoding). Non-JavaScript types (`importmap`, JSON data
 * blocks) are included: import maps are subject to `script-src`, and extra hashes of data blocks are harmless.
 */
export function inlineScriptHashes(html: string): string[] {
  const normalized = html.replace(/\r\n?/g, '\n')
  const hashes: string[] = []
  for (const match of normalized.matchAll(SCRIPT_ELEMENT)) {
    const [, attributes = '', text = ''] = match
    if (SRC_ATTRIBUTE.test(attributes))
      continue
    const hash = scriptHash(text)
    if (!hashes.includes(hash))
      hashes.push(hash)
  }
  return hashes
}
