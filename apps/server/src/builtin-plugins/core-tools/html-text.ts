// Readable text of fetched documents for the `web_fetch` tool: content-type classification, charset detection and a
// small tag-level HTML-to-text pass (no DOM). Non-content elements are dropped, block structure becomes line breaks,
// entities are decoded after the tags are removed (so escaped markup stays text). Pure and synchronous.
import { Buffer } from 'node:buffer'

export interface HtmlText {
  /** `<title>`, else `og:title`, else null (whitespace collapsed, at most 300 characters). */
  title: string | null
  /** Readable text: one block per line, blank lines between paragraphs. */
  text: string
}

/** What `web_fetch` can read. */
export type ContentKind = 'html' | 'text' | 'unsupported'

const TITLE_MAX_CHARS = 300
/** Private-use markers (removed from the input first): preformatted block placeholder, line and paragraph breaks. */
const PLACEHOLDER = '\uE000'
const LINE_BREAK = '\uE001'
const PARAGRAPH_BREAK = '\uE002'

/** Elements whose content is never readable text (removed with their content). */
const DROPPED_ELEMENTS = ['head', 'title', 'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'canvas', 'nav', 'select', 'datalist'] as const

/** Elements that start a new paragraph (blank line around them). */
const PARAGRAPH_ELEMENTS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dl',
  'fieldset',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'main',
  'ol',
  'p',
  'section',
  'table',
  'ul',
])

/** Elements that start a new line. */
const LINE_ELEMENTS: ReadonlySet<string> = new Set([
  'body',
  'caption',
  'dd',
  'details',
  'dialog',
  'div',
  'dt',
  'figcaption',
  'html',
  'legend',
  'li',
  'summary',
  'tbody',
  'tfoot',
  'thead',
  'tr',
])

/** Code points 160..255 in order (the Latin-1 entities of HTML 4). */
const LATIN1_ENTITY_NAMES = [
  'nbsp',
  'iexcl',
  'cent',
  'pound',
  'curren',
  'yen',
  'brvbar',
  'sect',
  'uml',
  'copy',
  'ordf',
  'laquo',
  'not',
  'shy',
  'reg',
  'macr',
  'deg',
  'plusmn',
  'sup2',
  'sup3',
  'acute',
  'micro',
  'para',
  'middot',
  'cedil',
  'sup1',
  'ordm',
  'raquo',
  'frac14',
  'frac12',
  'frac34',
  'iquest',
  'Agrave',
  'Aacute',
  'Acirc',
  'Atilde',
  'Auml',
  'Aring',
  'AElig',
  'Ccedil',
  'Egrave',
  'Eacute',
  'Ecirc',
  'Euml',
  'Igrave',
  'Iacute',
  'Icirc',
  'Iuml',
  'ETH',
  'Ntilde',
  'Ograve',
  'Oacute',
  'Ocirc',
  'Otilde',
  'Ouml',
  'times',
  'Oslash',
  'Ugrave',
  'Uacute',
  'Ucirc',
  'Uuml',
  'Yacute',
  'THORN',
  'szlig',
  'agrave',
  'aacute',
  'acirc',
  'atilde',
  'auml',
  'aring',
  'aelig',
  'ccedil',
  'egrave',
  'eacute',
  'ecirc',
  'euml',
  'igrave',
  'iacute',
  'icirc',
  'iuml',
  'eth',
  'ntilde',
  'ograve',
  'oacute',
  'ocirc',
  'otilde',
  'ouml',
  'divide',
  'oslash',
  'ugrave',
  'uacute',
  'ucirc',
  'uuml',
  'yacute',
  'thorn',
  'yuml',
] as const

/** Named entities: the Latin-1 set plus the common punctuation, symbol, arrow and math entities. */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', '\''],
  ...LATIN1_ENTITY_NAMES.map((name, index) => [name, String.fromCodePoint(160 + index)] as [string, string]),
  ...([
    ['OElig', 0x152],
    ['oelig', 0x153],
    ['Scaron', 0x160],
    ['scaron', 0x161],
    ['Yuml', 0x178],
    ['fnof', 0x192],
    ['circ', 0x2C6],
    ['tilde', 0x2DC],
    ['ensp', 0x2002],
    ['emsp', 0x2003],
    ['thinsp', 0x2009],
    ['zwnj', 0x200C],
    ['zwj', 0x200D],
    ['lrm', 0x200E],
    ['rlm', 0x200F],
    ['ndash', 0x2013],
    ['mdash', 0x2014],
    ['lsquo', 0x2018],
    ['rsquo', 0x2019],
    ['sbquo', 0x201A],
    ['ldquo', 0x201C],
    ['rdquo', 0x201D],
    ['bdquo', 0x201E],
    ['dagger', 0x2020],
    ['Dagger', 0x2021],
    ['bull', 0x2022],
    ['hellip', 0x2026],
    ['permil', 0x2030],
    ['prime', 0x2032],
    ['Prime', 0x2033],
    ['lsaquo', 0x2039],
    ['rsaquo', 0x203A],
    ['oline', 0x203E],
    ['frasl', 0x2044],
    ['euro', 0x20AC],
    ['trade', 0x2122],
    ['larr', 0x2190],
    ['uarr', 0x2191],
    ['rarr', 0x2192],
    ['darr', 0x2193],
    ['harr', 0x2194],
    ['crarr', 0x21B5],
    ['lArr', 0x21D0],
    ['uArr', 0x21D1],
    ['rArr', 0x21D2],
    ['dArr', 0x21D3],
    ['hArr', 0x21D4],
    ['forall', 0x2200],
    ['part', 0x2202],
    ['exist', 0x2203],
    ['empty', 0x2205],
    ['nabla', 0x2207],
    ['isin', 0x2208],
    ['notin', 0x2209],
    ['ni', 0x220B],
    ['prod', 0x220F],
    ['sum', 0x2211],
    ['minus', 0x2212],
    ['lowast', 0x2217],
    ['radic', 0x221A],
    ['prop', 0x221D],
    ['infin', 0x221E],
    ['ang', 0x2220],
    ['and', 0x2227],
    ['or', 0x2228],
    ['cap', 0x2229],
    ['cup', 0x222A],
    ['int', 0x222B],
    ['there4', 0x2234],
    ['sim', 0x223C],
    ['cong', 0x2245],
    ['asymp', 0x2248],
    ['ne', 0x2260],
    ['equiv', 0x2261],
    ['le', 0x2264],
    ['ge', 0x2265],
    ['sub', 0x2282],
    ['sup', 0x2283],
    ['sube', 0x2286],
    ['supe', 0x2287],
    ['oplus', 0x2295],
    ['otimes', 0x2297],
    ['perp', 0x22A5],
    ['sdot', 0x22C5],
    ['lceil', 0x2308],
    ['rceil', 0x2309],
    ['lfloor', 0x230A],
    ['rfloor', 0x230B],
    ['lang', 0x27E8],
    ['rang', 0x27E9],
    ['loz', 0x25CA],
    ['spades', 0x2660],
    ['clubs', 0x2663],
    ['hearts', 0x2665],
    ['diams', 0x2666],
    ['check', 0x2713],
    ['star', 0x2606],
    ['starf', 0x2605],
  ] as const).map(([name, code]) => [name, String.fromCodePoint(code)] as [string, string]),
])

/** HTML maps numeric references 0x80..0x9F to Windows-1252 (the spec's "character reference code" table). */
const WINDOWS_1252_C1: ReadonlyMap<number, number> = new Map([
  [0x80, 0x20AC],
  [0x82, 0x201A],
  [0x83, 0x0192],
  [0x84, 0x201E],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02C6],
  [0x89, 0x2030],
  [0x8A, 0x0160],
  [0x8B, 0x2039],
  [0x8C, 0x0152],
  [0x8E, 0x017D],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201C],
  [0x94, 0x201D],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02DC],
  [0x99, 0x2122],
  [0x9A, 0x0161],
  [0x9B, 0x203A],
  [0x9C, 0x0153],
  [0x9E, 0x017E],
  [0x9F, 0x0178],
])

function numericReference(code: number): string {
  if (!Number.isFinite(code) || code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF))
    return '\uFFFD'
  return String.fromCodePoint(WINDOWS_1252_C1.get(code) ?? code)
}

/** Decodes named (`&amp;`, `&eacute;`), decimal (`&#169;`) and hexadecimal (`&#x1F600;`) character references. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,8}|#x[\da-f]{1,7}|[a-z][a-z\d]{1,31});?/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      return numericReference(Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10))
    }
    return NAMED_ENTITIES.get(body) ?? match
  })
}

// Every tag pattern uses `[^<>]*` for the tag body: a match attempt that finds no `>` stops at the next `<`, so a page
// full of unclosed tags is processed in linear time (with `[^>]*` each `<` rescans to the end: quadratic, and the
// extraction runs synchronously on up to 2 MB of untrusted input).

/** Longest start tag whose attributes are parsed (`<meta>`). */
const TAG_ATTRIBUTES_MAX_CHARS = 4096

/** Removes every tag-like `<name ...>` / `</name>` (a lone `<` followed by a space stays text). */
function stripTags(html: string): string {
  return html.replace(/<\/?[a-z][^<>]*>/gi, '')
}

function collapseInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Attributes of one start tag (`name` lowercased; unquoted, single- and double-quoted values). */
function tagAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const match of tag.matchAll(/([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/g)) {
    const name = match[1]?.toLowerCase()
    if (name !== undefined && !attributes.has(name))
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attributes
}

function findTitle(html: string): string | null {
  const title = html.match(/<title\b[^<>]*>([\s\S]*?)(?:<\/title\s*>|$)/i)?.[1]
  let value = title === undefined ? '' : collapseInline(decodeEntities(stripTags(title)))
  if (value === '') {
    for (const [tag] of html.matchAll(/<meta\b[^<>]*>/gi)) {
      if (tag.length > TAG_ATTRIBUTES_MAX_CHARS)
        continue
      const attributes = tagAttributes(tag)
      const key = (attributes.get('property') ?? attributes.get('name') ?? '').toLowerCase()
      if (key === 'og:title') {
        value = collapseInline(decodeEntities(attributes.get('content') ?? ''))
        if (value !== '')
          break
      }
    }
  }
  return value === '' ? null : value.slice(0, TITLE_MAX_CHARS)
}

function dropElement(html: string, tag: string): string {
  // A self-closing form first (`<svg ... />`), then the element with its content (to the end when unclosed).
  return html
    .replace(new RegExp(`<${tag}\\b[^<>]*/>`, 'gi'), ' ')
    .replace(new RegExp(`<${tag}\\b[^<>]*>[\\s\\S]*?(?:</${tag}\\s*>|$)`, 'gi'), ' ')
}

/** Title and readable text of an HTML document. */
export function extractHtml(html: string): HtmlText {
  let source = html.replaceAll('\u0000', '').replace(/[\uE000-\uE002]/g, '')
  const title = findTitle(source)
  source = source
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, ' ')
    .replace(/<![^<>]*>/g, ' ')
    .replace(/<\?[\s\S]*?(?:\?>|$)/g, ' ')
  for (const tag of DROPPED_ELEMENTS)
    source = dropElement(source, tag)

  // Preformatted blocks keep their line breaks and spaces: set aside behind placeholders.
  const preserved: string[] = []
  source = source.replace(/<pre\b[^<>]*>([\s\S]*?)(?:<\/pre\s*>|$)/gi, (_match, inner: string) => {
    const block = decodeEntities(stripTags(inner.replace(/<br\b[^<>]*>/gi, '\n')))
      .replace(/\r\n?/g, '\n')
      .replace(/^\n+/, '')
      .trimEnd()
    preserved.push(block)
    return `${PARAGRAPH_BREAK}${PLACEHOLDER}${preserved.length - 1}${PLACEHOLDER}${PARAGRAPH_BREAK}`
  })

  // Source whitespace is not significant (as in a browser); block elements become explicit break markers.
  source = source
    .replace(/\s+/g, ' ')
    .replace(/<br\b[^<>]*>/gi, LINE_BREAK)
    .replace(/<li\b[^<>]*>/gi, `${LINE_BREAK}- `)
    .replace(/<\/?(?:td|th)\b[^<>]*>/gi, ' ')
    .replace(/<\/?([a-z][a-z\d]*)\b[^<>]*>/gi, (_match, name: string) => {
      const tag = name.toLowerCase()
      if (PARAGRAPH_ELEMENTS.has(tag))
        return PARAGRAPH_BREAK
      if (LINE_ELEMENTS.has(tag))
        return LINE_BREAK
      return ''
    })

  const lines = decodeEntities(source)
    .replace(/[\u200B\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    // A run of breaks is one line break, or a blank line when it contains a paragraph break.
    .replace(/[ \uE001\uE002]*[\uE001\uE002][ \uE001\uE002]*/g, run => (run.includes(PARAGRAPH_BREAK) ? '\n\n' : '\n'))
    .split('\n')
    .map(line => line.trim())
  const text = joinListItems(lines)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\uE000(\d+)\uE000/g, (_match, index: string) => preserved[Number(index)] ?? '')
  return { title, text }
}

function isBullet(line: string | undefined): boolean {
  return line !== undefined && line.startsWith('- ')
}

/**
 * Joins a bullet whose item text starts on a later line (`<li><p>text</p></li>`) with that text, drops empty bullets
 * and the blank lines between two bullets.
 */
function joinListItems(lines: readonly string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (line === '-') {
      let next = index + 1
      while (next < lines.length && lines[next] === '')
        next++
      const item = lines[next]
      if (item !== undefined && item !== '-' && !isBullet(item)) {
        result.push(`- ${item}`)
        index = next
      }
      continue
    }
    if (line === '' && isBullet(result.at(-1))) {
      let next = index + 1
      while (next < lines.length && lines[next] === '')
        next++
      if (isBullet(lines[next]) || lines[next] === '-')
        continue
    }
    result.push(line)
  }
  return result
}

// ---------- content types and charsets ----------

/** `type/subtype` of a Content-Type header, lowercased; null when missing or malformed. */
export function mimeTypeOf(contentType: string | null | undefined): string | null {
  const value = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : null
}

/** The `charset` parameter of a Content-Type header (quotes removed), else null. */
export function charsetOf(contentType: string | null | undefined): string | null {
  const match = (contentType ?? '').match(/;\s*charset\s*=\s*(?:"([^"]*)"|([^\s;]+))/i)
  const value = (match?.[1] ?? match?.[2] ?? '').trim()
  return value === '' ? null : value
}

/** A byte-order mark or `<meta charset>` / `http-equiv` declaration in the first 4 KB of an HTML document. */
export function sniffHtmlCharset(bytes: Uint8Array): string | null {
  const bom = bomCharset(bytes)
  if (bom !== null)
    return bom
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
  const match = head.match(/<meta\s[^<>]*?charset\s*=\s*(?:["']\s*)?([\w.:-]+)/i)
  return match?.[1] ?? null
}

function bomCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)
    return 'utf-8'
  if (bytes[0] === 0xFF && bytes[1] === 0xFE)
    return 'utf-16le'
  if (bytes[0] === 0xFE && bytes[1] === 0xFF)
    return 'utf-16be'
  return null
}

/** Decodes bytes with `charset` (a BOM wins; unknown labels fall back to UTF-8; invalid bytes become U+FFFD). */
export function decodeBytes(bytes: Uint8Array, charset: string | null): string {
  const label = bomCharset(bytes) ?? charset ?? 'utf-8'
  try {
    return new TextDecoder(label).decode(bytes)
  }
  catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** `application/*` types that are text. */
const TEXT_APPLICATION_TYPES: ReadonlySet<string> = new Set([
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/graphql',
  'application/x-ndjson',
  'application/ndjson',
  'application/x-sh',
  'application/x-www-form-urlencoded',
])

/** What `web_fetch` does with a response: HTML (text extraction), text (as is) or refuse it. */
export function contentKind(mimeType: string | null, body: Uint8Array): ContentKind {
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml')
    return 'html'
  if (mimeType !== null) {
    if (mimeType.startsWith('text/') || TEXT_APPLICATION_TYPES.has(mimeType) || /^application\/(?:[\w.-]+\+)?(?:json|xml)$/.test(mimeType))
      return 'text'
    return 'unsupported'
  }
  // No usable Content-Type: sniff the start of the body.
  const start = body.subarray(0, 1024)
  const head = Buffer.from(start).toString('latin1').trimStart().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || /<(?:head|body|title)\b/.test(head))
    return 'html'
  return start.includes(0) ? 'unsupported' : 'text'
}

/** Plain text normalized for the model: line endings, zero-width characters, outer blank lines. */
export function normalizePlainText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u200B\uFEFF]/g, '').replace(/\n{3,}/g, '\n\n').trim()
}
