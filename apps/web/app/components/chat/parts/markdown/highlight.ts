// Syntax highlighting for markdown code fences (docs/UI.md 4.4): Shiki is loaded lazily on the first complete code
// block; tokens carry both themes as CSS variables (`--shiki-light` / `--shiki-dark`, `defaultColor: false`), so the
// `.dark` class switches colors without highlighting again. Results are cached per language + code.
import type { BundledLanguage } from 'shiki'

/** One token of a highlighted line: text plus its inline style (CSS variables only). */
export interface CodeToken {
  content: string
  style?: Record<string, string>
}

export type CodeLine = CodeToken[]

export const CODE_THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const

/** Larger blocks stay plain text: highlighting them would stall the main thread. */
export const MAX_HIGHLIGHT_CHARS = 100_000
const CACHE_LIMIT = 200
const PLAIN_LANGUAGES = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'none', 'output', 'console-output'])

const cache = new Map<string, CodeLine[]>()
const pending = new Map<string, Promise<CodeLine[] | null>>()

/** The code split into lines of one plain token (empty lines have no token). */
export function plainCodeLines(code: string): CodeLine[] {
  return code.split('\n').map(line => (line === '' ? [] : [{ content: line }]))
}

/** Lowercased fence language without attributes (`ts {1,3}` -> `ts`). */
export function normalizeCodeLanguage(language: string | undefined): string {
  return (language ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

function cacheKey(code: string, language: string): string {
  return `${language}\u0000${code}`
}

function remember(key: string, lines: CodeLine[]) {
  cache.delete(key)
  cache.set(key, lines)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined)
      cache.delete(oldest)
  }
}

/** Highlighted lines already computed for this code, or null. */
export function cachedCodeLines(code: string, language: string): CodeLine[] | null {
  return cache.get(cacheKey(code, normalizeCodeLanguage(language))) ?? null
}

/**
 * Highlights `code` with Shiki (loaded on first use). Resolves to null for plain text, unknown languages, very large
 * blocks and highlighter failures: callers keep the plain rendering then.
 */
export function highlightCode(code: string, language: string): Promise<CodeLine[] | null> {
  const lang = normalizeCodeLanguage(language)
  if (PLAIN_LANGUAGES.has(lang) || code === '' || code.length > MAX_HIGHLIGHT_CHARS)
    return Promise.resolve(null)
  const key = cacheKey(code, lang)
  const cached = cache.get(key)
  if (cached)
    return Promise.resolve(cached)
  const inFlight = pending.get(key)
  if (inFlight)
    return inFlight
  const task = (async () => {
    try {
      const shiki = await import('shiki')
      const known = Object.hasOwn(shiki.bundledLanguages, lang) || Object.hasOwn(shiki.bundledLanguagesAlias, lang)
      if (!known)
        return null
      const result = await shiki.codeToTokens(code, { lang: lang as BundledLanguage, themes: CODE_THEMES, defaultColor: false })
      const lines: CodeLine[] = result.tokens.map(line => line.map(token => ({
        content: token.content,
        ...(token.htmlStyle ? { style: token.htmlStyle } : {}),
      })))
      remember(key, lines)
      return lines
    }
    catch {
      return null
    }
    finally {
      pending.delete(key)
    }
  })()
  pending.set(key, task)
  return task
}
