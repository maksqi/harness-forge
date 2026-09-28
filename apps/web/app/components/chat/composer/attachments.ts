// Attachment rules of the composer (docs/UI.md 7.7, docs/API.md 5.11): `POST /files` accepts `image/*`,
// `application/pdf` and `text/*` up to 20 MB. Browsers often report code and data files with an empty or
// non-text type (`.ts` as `video/mp2t`, `.json` as `application/json`), so known text extensions upload as text;
// the server still checks the content (valid UTF-8).
import type { CatalogModel } from '@harness-forge/shared'
import { isAllowedUploadMime, LIMITS, UPLOAD_MIME_PATTERNS } from '@harness-forge/shared'

const MARKDOWN = 'text/markdown'
const PLAIN = 'text/plain'

/** Extensions uploaded as text even when the browser reports another type. */
export const TEXT_EXTENSION_MIME: Readonly<Record<string, string>> = {
  md: MARKDOWN,
  markdown: MARKDOWN,
  mdx: MARKDOWN,
  txt: PLAIN,
  text: PLAIN,
  log: PLAIN,
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: PLAIN,
  jsonl: PLAIN,
  yaml: PLAIN,
  yml: PLAIN,
  toml: PLAIN,
  ini: PLAIN,
  xml: PLAIN,
  html: PLAIN,
  htm: PLAIN,
  css: PLAIN,
  scss: PLAIN,
  js: PLAIN,
  mjs: PLAIN,
  cjs: PLAIN,
  jsx: PLAIN,
  ts: PLAIN,
  mts: PLAIN,
  cts: PLAIN,
  tsx: PLAIN,
  vue: PLAIN,
  svelte: PLAIN,
  py: PLAIN,
  rb: PLAIN,
  go: PLAIN,
  rs: PLAIN,
  java: PLAIN,
  kt: PLAIN,
  swift: PLAIN,
  c: PLAIN,
  h: PLAIN,
  cc: PLAIN,
  cpp: PLAIN,
  hpp: PLAIN,
  cs: PLAIN,
  php: PLAIN,
  sh: PLAIN,
  bash: PLAIN,
  zsh: PLAIN,
  sql: PLAIN,
  graphql: PLAIN,
  proto: PLAIN,
  diff: PLAIN,
  patch: PLAIN,
}

/** `accept` of the hidden file input: the server's MIME families plus the text extensions above. */
export const COMPOSER_ACCEPT = [...UPLOAD_MIME_PATTERNS, ...Object.keys(TEXT_EXTENSION_MIME).map(ext => `.${ext}`)].join(',')

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** The MIME type a file uploads with, or null when the server would reject its type. */
export function uploadMimeOf(file: { name: string, type: string }): string | null {
  const type = file.type.trim().toLowerCase()
  if (type && isAllowedUploadMime(type))
    return type
  return TEXT_EXTENSION_MIME[extensionOf(file.name)] ?? null
}

export type AttachmentRejection = 'type' | 'size'

/** Checks a file before uploading: the upload MIME type, or why it cannot be attached. */
export function checkAttachment(file: { name: string, type: string, size: number }):
  | { ok: true, mime: string }
  | { ok: false, reason: AttachmentRejection } {
  const mime = uploadMimeOf(file)
  if (!mime)
    return { ok: false, reason: 'type' }
  if (file.size > LIMITS.uploadBytes)
    return { ok: false, reason: 'size' }
  return { ok: true, mime }
}

export function isImageMime(mime: string): boolean {
  return mime.toLowerCase().startsWith('image/')
}

export function isPdfMime(mime: string): boolean {
  return mime.toLowerCase().split(';')[0]!.trim() === 'application/pdf'
}

type ModelForWarnings = Pick<CatalogModel, 'name' | 'capabilities'>

/**
 * Capability warnings for the attached files and the selected model: images without vision, PDFs without PDF
 * input. Unknown models yield none. While a warning shows, Send is disabled.
 */
export function capabilityWarnings(attachments: ReadonlyArray<{ mime: string }>, model: ModelForWarnings | null | undefined): string[] {
  if (!model)
    return []
  const warnings: string[] = []
  if (!model.capabilities.vision && attachments.some(file => isImageMime(file.mime)))
    warnings.push(`${model.name} can't see images. Remove them or choose another model.`)
  if (!model.capabilities.pdf && attachments.some(file => isPdfMime(file.mime)))
    warnings.push(`${model.name} can't read PDFs. Remove them or choose another model.`)
  return warnings
}
