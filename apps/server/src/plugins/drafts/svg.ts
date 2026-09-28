// SVG sanitizer of uploaded plugin icons (API.md 4.12 `IconFileInput`: "SVG is sanitized (no scripts, no external
// refs)"). Owner: W3.3.
//
// The icon is parsed with a small strict XML tokenizer into a tree and serialized again from allowlists, so nothing
// the parser did not understand can reach the output:
// - elements: static SVG shapes, text, paint servers, clipping, masking, markers and filter primitives; `a` and
//   `switch` are unwrapped (children kept); everything else (script, foreignObject, animations, feImage, metadata,
//   editor namespaces, ...) is dropped with its subtree;
// - attributes: presentation and geometry attributes only (never `on*` handlers); `href` / `xlink:href` must be a
//   local `#fragment` (`image` may also embed a raster `data:image/(png|jpeg|gif|webp);base64,` URI); every `url(...)`
//   must be a local `url(#id)`; values with a backslash (CSS escapes) or a script URL are dropped;
// - `<style>` and `style=""`: kept only when they contain no `@import` / `@font-face`, CSS escapes, script URLs or
//   non-local `url(...)`;
// - a DOCTYPE with an internal subset (entity declarations) is rejected, other DOCTYPEs, comments and processing
//   instructions are dropped; only the predefined XML entities and numeric references are decoded.
// The served icon additionally carries `Content-Security-Policy: default-src 'none'` and is only ever rendered through
// `<img>` or a CSS mask by the web app (never inlined).

/** Thrown for input that is not a well-formed SVG document. */
export class SvgSanitizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SvgSanitizeError'
  }
}

/** Nesting depth limit of the element tree. */
const MAX_DEPTH = 128
/** Element count limit. */
const MAX_ELEMENTS = 20_000

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'

const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'image',
  'style',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDistantLight',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'fePointLight',
  'feSpecularLighting',
  'feSpotLight',
  'feTile',
  'feTurbulence',
])

/** Elements whose children are kept while the element itself is dropped. */
const UNWRAPPED_ELEMENTS: ReadonlySet<string> = new Set(['a', 'switch'])

const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'class',
  'style',
  'transform',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'd',
  'points',
  'pathLength',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'color',
  'display',
  'visibility',
  'overflow',
  'clip-path',
  'clip-rule',
  'mask',
  'filter',
  'stop-color',
  'stop-opacity',
  'offset',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'filterUnits',
  'primitiveUnits',
  'in',
  'in2',
  'result',
  'stdDeviation',
  'dx',
  'dy',
  'mode',
  'type',
  'values',
  'operator',
  'k1',
  'k2',
  'k3',
  'k4',
  'flood-color',
  'flood-opacity',
  'lighting-color',
  'tableValues',
  'slope',
  'intercept',
  'amplitude',
  'exponent',
  'baseFrequency',
  'numOctaves',
  'seed',
  'stitchTiles',
  'scale',
  'xChannelSelector',
  'yChannelSelector',
  'radius',
  'order',
  'kernelMatrix',
  'kernelUnitLength',
  'divisor',
  'bias',
  'targetX',
  'targetY',
  'edgeMode',
  'preserveAlpha',
  'surfaceScale',
  'diffuseConstant',
  'specularConstant',
  'specularExponent',
  'azimuth',
  'elevation',
  'pointsAtX',
  'pointsAtY',
  'pointsAtZ',
  'limitingConeAngle',
  'z',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'refX',
  'refY',
  'orient',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'letter-spacing',
  'word-spacing',
  'text-decoration',
  'writing-mode',
  'textLength',
  'lengthAdjust',
  'rotate',
  'startOffset',
  'method',
  'spacing',
  'vector-effect',
  'shape-rendering',
  'text-rendering',
  'image-rendering',
  'color-interpolation',
  'color-interpolation-filters',
  'color-rendering',
  'isolation',
  'mix-blend-mode',
  'paint-order',
  'enable-background',
  'version',
  'xml:space',
  'xmlns',
  'xmlns:xlink',
  'href',
  'xlink:href',
])

/** Elements whose text content is kept (other text is whitespace only and dropped). */
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(['text', 'tspan', 'textPath', 'title', 'desc', 'style'])

const RASTER_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp);base64,[\d+/=a-z\s]+$/i
const SCRIPT_URL = /(?:java|vb)script\s*:|data\s*:\s*text\/html|expression\s*\(/i
const URL_OPENING = /url\s*\(/gi
const NAME_START = /^[A-Z_][\w.:-]*/i
const LOCAL_FRAGMENT = /^#[\w.:-]+$/
const NUMERIC_ENTITY = /^#(?:x([\da-f]{1,6})|(\d{1,7}))$/i

interface ElementNode {
  kind: 'element'
  name: string
  attributes: Array<[string, string]>
  children: Node[]
}

interface TextNode {
  kind: 'text'
  value: string
}

type Node = ElementNode | TextNode

// ---------- parsing ----------

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' }

/** Decodes the predefined XML entities and numeric character references; anything else is an error. */
function decodeEntities(value: string): string {
  return value.replace(/&([^;&\s]{1,16});/g, (_match, entity: string) => {
    const named = PREDEFINED_ENTITIES[entity]
    if (named !== undefined)
      return named
    const numeric = entity.match(NUMERIC_ENTITY)
    if (numeric) {
      const code = numeric[1] === undefined ? Number(numeric[2]) : Number.parseInt(numeric[1], 16)
      if (code > 0 && code <= 0x10FFFF && (code < 0xD800 || code > 0xDFFF))
        return String.fromCodePoint(code)
    }
    throw new SvgSanitizeError(`Unsupported entity "&${entity};".`)
  })
}

function decodeText(raw: string): string {
  if (/&(?![^;&\s]{1,16};)/.test(raw))
    throw new SvgSanitizeError('A "&" must start an entity such as "&amp;".')
  return decodeEntities(raw)
}

class Parser {
  private index = 0
  private elements = 0
  private readonly roots: Node[] = []
  private readonly stack: ElementNode[] = []

  constructor(private readonly source: string) {}

  parse(): ElementNode {
    const source = this.source
    while (this.index < source.length) {
      if (source.startsWith('<!--', this.index))
        this.skipPast('-->', 'comment')
      else if (source.startsWith('<![CDATA[', this.index))
        this.cdata()
      else if (source.startsWith('<!', this.index))
        this.doctype()
      else if (source.startsWith('<?', this.index))
        this.skipPast('?>', 'processing instruction')
      else if (source.startsWith('</', this.index))
        this.endTag()
      else if (source[this.index] === '<')
        this.startTag()
      else
        this.text()
    }
    if (this.stack.length > 0)
      throw new SvgSanitizeError(`The element <${this.stack.at(-1)?.name}> is not closed.`)
    if (this.roots.some(node => node.kind === 'text' && node.value.trim() !== ''))
      throw new SvgSanitizeError('Text outside the root element.')
    const elements = this.roots.filter((node): node is ElementNode => node.kind === 'element')
    const root = elements[0]
    if (elements.length !== 1 || root === undefined)
      throw new SvgSanitizeError('An SVG file has exactly one root element.')
    if (root.name !== 'svg')
      throw new SvgSanitizeError('The root element is not <svg>.')
    return root
  }

  private append(node: Node): void {
    const parent = this.stack.at(-1)
    if (parent)
      parent.children.push(node)
    else
      this.roots.push(node)
  }

  private skipPast(terminator: string, what: string): void {
    const end = this.source.indexOf(terminator, this.index)
    if (end < 0)
      throw new SvgSanitizeError(`Unterminated ${what}.`)
    this.index = end + terminator.length
  }

  private cdata(): void {
    const start = this.index + '<![CDATA['.length
    const end = this.source.indexOf(']]>', start)
    if (end < 0)
      throw new SvgSanitizeError('Unterminated CDATA section.')
    this.append({ kind: 'text', value: this.source.slice(start, end) })
    this.index = end + 3
  }

  private doctype(): void {
    const end = this.source.indexOf('>', this.index)
    if (end < 0)
      throw new SvgSanitizeError('Unterminated DOCTYPE.')
    const declaration = this.source.slice(this.index, end)
    if (!/^<!DOCTYPE\s/i.test(declaration))
      throw new SvgSanitizeError('Unsupported markup declaration.')
    if (declaration.includes('['))
      throw new SvgSanitizeError('DOCTYPE declarations with entity definitions are not allowed.')
    this.index = end + 1
  }

  private text(): void {
    const end = this.source.indexOf('<', this.index)
    const stop = end < 0 ? this.source.length : end
    this.append({ kind: 'text', value: decodeText(this.source.slice(this.index, stop)) })
    this.index = stop
  }

  private readName(): string {
    const match = this.source.slice(this.index, this.index + 256).match(NAME_START)
    if (!match)
      throw new SvgSanitizeError('Invalid element or attribute name.')
    this.index += match[0].length
    return match[0]
  }

  private skipSpace(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index] ?? ''))
      this.index += 1
  }

  private endTag(): void {
    this.index += 2
    const name = this.readName()
    this.skipSpace()
    if (this.source[this.index] !== '>')
      throw new SvgSanitizeError(`Malformed end tag </${name}>.`)
    this.index += 1
    const open = this.stack.pop()
    if (!open || open.name !== name)
      throw new SvgSanitizeError(`Unexpected end tag </${name}>.`)
  }

  private startTag(): void {
    this.index += 1
    const name = this.readName()
    const node: ElementNode = { kind: 'element', name, attributes: [], children: [] }
    const seen = new Set<string>()
    for (;;) {
      const before = this.index
      this.skipSpace()
      const char = this.source[this.index]
      if (char === undefined)
        throw new SvgSanitizeError(`Unterminated tag <${name}>.`)
      if (char === '>' || this.source.startsWith('/>', this.index))
        break
      if (this.index === before)
        throw new SvgSanitizeError(`Attributes of <${name}> must be separated by spaces.`)
      const attribute = this.readName()
      this.skipSpace()
      if (this.source[this.index] !== '=')
        throw new SvgSanitizeError(`The attribute "${attribute}" of <${name}> has no value.`)
      this.index += 1
      this.skipSpace()
      const quote = this.source[this.index]
      if (quote !== '"' && quote !== '\'')
        throw new SvgSanitizeError(`The attribute "${attribute}" of <${name}> must be quoted.`)
      const end = this.source.indexOf(quote, this.index + 1)
      if (end < 0)
        throw new SvgSanitizeError(`Unterminated value of "${attribute}".`)
      const raw = this.source.slice(this.index + 1, end)
      if (raw.includes('<'))
        throw new SvgSanitizeError(`The value of "${attribute}" contains "<".`)
      if (seen.has(attribute))
        throw new SvgSanitizeError(`Duplicate attribute "${attribute}" on <${name}>.`)
      seen.add(attribute)
      node.attributes.push([attribute, decodeText(raw)])
      this.index = end + 1
    }
    this.elements += 1
    if (this.elements > MAX_ELEMENTS)
      throw new SvgSanitizeError('The SVG has too many elements.')
    this.append(node)
    if (this.source.startsWith('/>', this.index)) {
      this.index += 2
      return
    }
    this.index += 1
    if (this.stack.length >= MAX_DEPTH)
      throw new SvgSanitizeError('The SVG is nested too deeply.')
    this.stack.push(node)
  }
}

// ---------- sanitizing ----------

/**
 * The arguments of every `url(...)` of a value (quotes removed, trimmed), or null when one is malformed (no closing
 * parenthesis, unbalanced quotes). A linear scan: CSS text comes from the upload.
 */
export function urlArguments(value: string): string[] | null {
  const args: string[] = []
  for (const match of value.matchAll(URL_OPENING)) {
    let index = (match.index ?? 0) + match[0].length
    while (index < value.length && /\s/.test(value[index] ?? ''))
      index += 1
    const char = value[index]
    const quote = char === '"' || char === '\'' ? char : null
    if (quote !== null) {
      const end = value.indexOf(quote, index + 1)
      if (end < 0)
        return null
      const close = value.indexOf(')', end + 1)
      if (close < 0 || value.slice(end + 1, close).trim() !== '')
        return null
      args.push(value.slice(index + 1, end).trim())
      continue
    }
    const close = value.indexOf(')', index)
    if (close < 0)
      return null
    const arg = value.slice(index, close).trim()
    if (arg.includes('"') || arg.includes('\'') || arg.includes('('))
      return null
    args.push(arg)
  }
  return args
}

/** Every `url(...)` of a value points into the document (`url(#id)`). */
function hasOnlyLocalUrls(value: string): boolean {
  const args = urlArguments(value)
  return args !== null && args.every(arg => arg.startsWith('#'))
}

/** C0 control characters other than tab, line feed and carriage return, and DEL. */
function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) || code === 0x7F)
      return true
  }
  return false
}

/** A CSS text (style element or attribute) without imports, fonts, escapes, script URLs or non-local URLs. */
export function isSafeCss(css: string): boolean {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  if (text.includes('/*') || text.includes('\\') || text.includes('<'))
    return false
  if (/@import|@font-face|@namespace|behavior\s*:|-moz-binding/i.test(text))
    return false
  return !SCRIPT_URL.test(text) && hasOnlyLocalUrls(text)
}

function safeAttributeValue(element: string, name: string, value: string): string | null {
  if (value.includes('\\') || hasControlChars(value))
    return null
  if (name === 'href' || name === 'xlink:href') {
    const trimmed = value.trim()
    if (LOCAL_FRAGMENT.test(trimmed))
      return trimmed
    if (element === 'image' && RASTER_DATA_URI.test(trimmed))
      return trimmed.replace(/\s+/g, '')
    return null
  }
  if (name === 'xmlns')
    return value === SVG_NAMESPACE ? value : null
  if (name === 'xmlns:xlink')
    return value === XLINK_NAMESPACE ? value : null
  if (name === 'style')
    return isSafeCss(value) ? value : null
  if (SCRIPT_URL.test(value) || !hasOnlyLocalUrls(value))
    return null
  return value
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;')
}

function serializeChildren(children: readonly Node[], parent: string, out: string[]): void {
  for (const child of children) {
    if (child.kind === 'element')
      serializeElement(child, out)
    else if (TEXT_ELEMENTS.has(parent) || child.value.trim() === '')
      out.push(escapeText(child.value))
  }
}

function serializeElement(node: ElementNode, out: string[]): void {
  if (UNWRAPPED_ELEMENTS.has(node.name)) {
    serializeChildren(node.children, node.name, out)
    return
  }
  if (!ALLOWED_ELEMENTS.has(node.name))
    return
  if (node.name === 'style') {
    if (node.children.some(child => child.kind === 'element'))
      return
    const css = node.children.map(child => (child.kind === 'text' ? child.value : '')).join('')
    if (!isSafeCss(css))
      return
  }
  const attributes: string[] = []
  for (const [name, value] of node.attributes) {
    if (!ALLOWED_ATTRIBUTES.has(name))
      continue
    const safe = safeAttributeValue(node.name, name, value)
    if (safe !== null)
      attributes.push(` ${name}="${escapeAttribute(safe)}"`)
  }
  const content: string[] = []
  serializeChildren(node.children, node.name, content)
  if (content.length === 0)
    out.push(`<${node.name}${attributes.join('')}/>`)
  else
    out.push(`<${node.name}${attributes.join('')}>`, ...content, `</${node.name}>`)
}

/** True when some element uses `xlink:href` (the root then needs the xlink namespace declaration). */
function usesXlink(node: ElementNode): boolean {
  return node.attributes.some(([name]) => name === 'xlink:href')
    || node.children.some(child => child.kind === 'element' && usesXlink(child))
}

/**
 * Sanitizes an SVG document; throws `SvgSanitizeError` when it is not a well-formed SVG. The result starts with the
 * `<svg>` root element (no XML declaration) and declares the SVG namespace.
 */
export function sanitizeSvg(source: string): string {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source
  if (text.includes('\0'))
    throw new SvgSanitizeError('The SVG contains NUL characters.')
  const root = new Parser(text).parse()
  // Declared by the output whatever the input said (an `<img>` does not render an SVG without its namespace).
  root.attributes = root.attributes.filter(([name]) => name !== 'xmlns' && name !== 'xmlns:xlink')
  root.attributes.unshift(['xmlns', SVG_NAMESPACE])
  if (usesXlink(root))
    root.attributes.splice(1, 0, ['xmlns:xlink', XLINK_NAMESPACE])
  const out: string[] = []
  serializeElement(root, out)
  return `${out.join('')}\n`
}
