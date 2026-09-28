// Renderer options of `Markdown` (docs/UI.md 10.4): the markstream custom id our node components are registered
// under, the link policy (http, https and mailto only; raw HTML anchors stay text) and the lazily loaded KaTeX
// stylesheet.
import type { ParsedNode, ParseOptions } from 'markstream-vue'

/** markstream `custom-id` of every `Markdown` renderer (scopes the code block and image overrides). */
export const MARKDOWN_CUSTOM_ID = 'hf-markdown'

const ALLOWED_LINK = /^(?:https?:\/\/|mailto:)/i

/**
 * Links render only for `http:`, `https:` and `mailto:` targets; anything else (relative paths, `javascript:`,
 * `data:`, other schemes) renders as its plain link text. Whitespace and control characters are rejected too.
 */
export function isAllowedMarkdownLink(url: unknown): boolean {
  if (typeof url !== 'string')
    return false
  const value = url.trim()
  if (!value || Array.from(value).some(char => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7F))
    return false
  return ALLOWED_LINK.test(value)
}

type LooseNode = Record<string, unknown> & { type?: unknown }

function isNodeLike(value: unknown): value is LooseNode {
  return typeof value === 'object' && value !== null
}

function textNode(content: string): ParsedNode {
  return { type: 'text', content, raw: content } as ParsedNode
}

/** A link node that must not render as a link: raw HTML anchors (escape policy) and disallowed targets. */
function replaceLink(node: LooseNode): LooseNode | null {
  if (node.type !== 'link' || node.loading === true)
    return null
  const raw = typeof node.raw === 'string' ? node.raw : ''
  if (raw.trimStart().startsWith('<'))
    return textNode(raw) as unknown as LooseNode
  if (!isAllowedMarkdownLink(node.href))
    return textNode(typeof node.text === 'string' ? node.text : '') as unknown as LooseNode
  return null
}

function sanitizeArray(items: unknown[], depth: number): unknown[] {
  let copy: unknown[] | null = null
  items.forEach((item, index) => {
    const next = sanitizeValue(item, depth + 1)
    if (next !== item) {
      copy ??= items.slice()
      copy[index] = next
    }
  })
  return copy ?? items
}

/** Returns `value` itself when nothing inside changed, else a copy along the changed path (nodes may be reused). */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 64)
    return value
  if (Array.isArray(value))
    return sanitizeArray(value, depth)
  if (!isNodeLike(value))
    return value
  const replacement = replaceLink(value)
  if (replacement)
    return replacement
  let copy: LooseNode | null = null
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== 'object' || child === null)
      continue
    const next = sanitizeValue(child, depth + 1)
    if (next !== child) {
      copy ??= { ...value }
      copy[key] = next
    }
  }
  return copy ?? value
}

/**
 * `postTransformNodes` hook: turns link nodes that came from raw HTML (`<a href>` is parsed into a link even with the
 * escape policy) back into their literal text, and links to disallowed targets into their link text.
 */
export function sanitizeMarkdownNodes(nodes: ParsedNode[]): ParsedNode[] {
  return nodes.map(node => sanitizeValue(node, 0) as ParsedNode)
}

/** Parser options shared by every renderer. */
export const MARKDOWN_PARSE_OPTIONS: ParseOptions = Object.freeze({
  validateLink: isAllowedMarkdownLink,
  postTransformNodes: sanitizeMarkdownNodes,
})

const MATH_HINT = /\$\$|\\\(|\\\[|\$[^\s$]/

let katexStyles: Promise<unknown> | null = null

/** Loads the KaTeX stylesheet the first time content looks like it contains math (KaTeX itself loads lazily too). */
export function ensureMathStyles(content: string): void {
  if (katexStyles || !MATH_HINT.test(content))
    return
  katexStyles = import('katex/dist/katex.min.css').catch(() => {
    katexStyles = null
  })
}
