// Upload type checks (API.md 5.11): the declared MIME type must be in `UPLOAD_MIME_PATTERNS` (`image/*`,
// `application/pdf`, `text/*`) and match the content: magic bytes for raster images and PDF, UTF-8 markup for SVG, valid
// UTF-8 without NUL bytes for text. Without a usable declared type (missing or `application/octet-stream`) the type is
// taken from the content (then the file extension for text).
import { isUtf8 } from 'node:buffer'
import { isAllowedUploadMime } from '@harness-forge/shared'

export const MIME_PNG = 'image/png'
export const MIME_JPEG = 'image/jpeg'
export const MIME_GIF = 'image/gif'
export const MIME_WEBP = 'image/webp'
export const MIME_AVIF = 'image/avif'
export const MIME_HEIC = 'image/heic'
export const MIME_HEIF = 'image/heif'
export const MIME_BMP = 'image/bmp'
export const MIME_ICO = 'image/vnd.microsoft.icon'
export const MIME_TIFF = 'image/tiff'
export const MIME_SVG = 'image/svg+xml'
export const MIME_PDF = 'application/pdf'
export const MIME_TEXT = 'text/plain'

/** Aliases browsers and OSes send, mapped to the stored type. */
const MIME_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': MIME_JPEG,
  'image/pjpeg': MIME_JPEG,
  'image/x-png': MIME_PNG,
  'image/x-icon': MIME_ICO,
  'image/ico': MIME_ICO,
  'image/x-ms-bmp': MIME_BMP,
  'image/x-bmp': MIME_BMP,
  'application/x-pdf': MIME_PDF,
  // Text-like application types browsers report for code/data files; stored as text (still validated as UTF-8).
  'application/json': MIME_TEXT,
  'application/ld+json': MIME_TEXT,
  'application/xml': 'text/xml',
  'application/yaml': MIME_TEXT,
  'application/x-yaml': MIME_TEXT,
  'application/toml': MIME_TEXT,
  'application/javascript': 'text/javascript',
  'application/x-javascript': 'text/javascript',
  'application/typescript': MIME_TEXT,
  'application/x-typescript': MIME_TEXT,
  'application/x-sh': MIME_TEXT,
  'application/sql': MIME_TEXT,
}

/** Content types accepted for a declared image type (HEIC and HEIF files share brands). */
const IMAGE_CONTENT: Readonly<Record<string, readonly string[]>> = {
  [MIME_PNG]: [MIME_PNG],
  [MIME_JPEG]: [MIME_JPEG],
  [MIME_GIF]: [MIME_GIF],
  [MIME_WEBP]: [MIME_WEBP],
  [MIME_AVIF]: [MIME_AVIF],
  [MIME_HEIC]: [MIME_HEIC, MIME_HEIF],
  [MIME_HEIF]: [MIME_HEIC, MIME_HEIF],
  'image/heic-sequence': [MIME_HEIC, MIME_HEIF],
  'image/heif-sequence': [MIME_HEIC, MIME_HEIF],
  [MIME_BMP]: [MIME_BMP],
  [MIME_ICO]: [MIME_ICO],
  [MIME_TIFF]: [MIME_TIFF],
}

/** Text types inferred from the extension of an untyped UTF-8 upload. */
const TEXT_EXTENSIONS: Readonly<Record<string, string>> = {
  txt: MIME_TEXT,
  text: MIME_TEXT,
  log: MIME_TEXT,
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  xml: 'text/xml',
  svg: MIME_SVG,
}

/** Lowercase `type/subtype` without parameters, aliases resolved; '' when missing or malformed. */
export function canonicalMime(declared: string | undefined): string {
  const type = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(type))
    return ''
  return MIME_ALIASES[type] ?? type
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = ''
  for (let index = start; index < start + length && index < bytes.length; index++)
    out += String.fromCharCode(bytes[index]!)
  return out
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length)
    return false
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16) + ((bytes[offset + 3]! << 24) >>> 0)
}

/** AVIF / HEIC / HEIF from the ISO BMFF `ftyp` box brands. */
function sniffIsoImage(bytes: Uint8Array): string | null {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp')
    return null
  const boxSize = Math.min(uint32be(bytes, 0), bytes.length, 256)
  const brands = [ascii(bytes, 8, 4)]
  for (let offset = 16; offset + 4 <= boxSize; offset += 4)
    brands.push(ascii(bytes, offset, 4))
  if (brands.some(brand => brand === 'avif' || brand === 'avis'))
    return MIME_AVIF
  if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx'].includes(brand)))
    return MIME_HEIC
  if (brands.some(brand => ['mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs'].includes(brand)))
    return MIME_HEIF
  return null
}

function isBmp(bytes: Uint8Array): boolean {
  if (bytes.length < 18 || bytes[0] !== 0x42 || bytes[1] !== 0x4D)
    return false
  const reservedZero = bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0
  return reservedZero && [12, 40, 52, 56, 64, 108, 124].includes(uint32le(bytes, 14))
}

/** `%PDF-` at the start, or (`lenient`, for uploads declared as PDF) within the first 1024 bytes as readers allow. */
function isPdf(bytes: Uint8Array, lenient: boolean): boolean {
  return lenient ? ascii(bytes, 0, 1024 + 5).includes('%PDF-') : ascii(bytes, 0, 5) === '%PDF-'
}

/**
 * The binary format of `bytes` from its magic bytes, or null. `lenientPdf` accepts a PDF header after leading
 * garbage (only used when the upload is declared as PDF).
 */
export function sniffBinaryType(bytes: Uint8Array, options: { lenientPdf?: boolean } = {}): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    return MIME_PNG
  if (startsWith(bytes, [0xFF, 0xD8, 0xFF]))
    return MIME_JPEG
  const head = ascii(bytes, 0, 12)
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a'))
    return MIME_GIF
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')
    return MIME_WEBP
  const iso = sniffIsoImage(bytes)
  if (iso !== null)
    return iso
  if (startsWith(bytes, [0x49, 0x49, 0x2A, 0x00]) || startsWith(bytes, [0x4D, 0x4D, 0x00, 0x2A]))
    return MIME_TIFF
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 6 && (bytes[4]! | (bytes[5]! << 8)) > 0)
    return MIME_ICO
  if (isBmp(bytes))
    return MIME_BMP
  if (isPdf(bytes, options.lenientPdf === true))
    return MIME_PDF
  return null
}

/** Valid UTF-8 without NUL bytes (a NUL means binary content). */
export function isUtf8Text(bytes: Uint8Array): boolean {
  return !bytes.includes(0) && isUtf8(bytes)
}

/** UTF-8 text whose first 4 KB contain an `<svg` element. */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096)).toLowerCase()
  return /<svg[\s/>]/.test(head)
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export type UploadTypeResult = { ok: true, mime: string } | { ok: false, reason: string }

const MISMATCH = 'The file content does not match its type'

/** The type to store for an upload, or why it is rejected. */
export function resolveUploadType(declared: string | undefined, name: string, bytes: Uint8Array): UploadTypeResult {
  const type = canonicalMime(declared)
  if (type === '' || type === 'application/octet-stream') {
    const sniffed = sniffBinaryType(bytes)
    if (sniffed !== null)
      return { ok: true, mime: sniffed }
    if (!isUtf8Text(bytes))
      return { ok: false, reason: 'Unsupported file type: upload images, PDF files or UTF-8 text.' }
    const byExtension = TEXT_EXTENSIONS[extensionOf(name)] ?? MIME_TEXT
    if (byExtension === MIME_SVG)
      return looksLikeSvg(bytes) ? { ok: true, mime: MIME_SVG } : { ok: true, mime: MIME_TEXT }
    return { ok: true, mime: byExtension }
  }
  if (!isAllowedUploadMime(type))
    return { ok: false, reason: `The type ${type} is not allowed: upload images, PDF files or text.` }
  if (type === MIME_SVG)
    return isUtf8Text(bytes) && looksLikeSvg(bytes) ? { ok: true, mime: type } : { ok: false, reason: `${MISMATCH} (${type}).` }
  if (type.startsWith('image/')) {
    const accepted = IMAGE_CONTENT[type]
    if (accepted === undefined)
      return { ok: false, reason: `Unsupported image type ${type}.` }
    const sniffed = sniffBinaryType(bytes)
    return sniffed !== null && accepted.includes(sniffed) ? { ok: true, mime: type } : { ok: false, reason: `${MISMATCH} (${type}).` }
  }
  if (type === MIME_PDF)
    return sniffBinaryType(bytes, { lenientPdf: true }) === MIME_PDF ? { ok: true, mime: type } : { ok: false, reason: `${MISMATCH} (${type}).` }
  // text/*
  return isUtf8Text(bytes) ? { ok: true, mime: type } : { ok: false, reason: `${MISMATCH} (${type}): expected UTF-8 text.` }
}

/** Extension for a file name that had to be replaced. */
export function extensionForMime(mime: string): string {
  const extensions: Readonly<Record<string, string>> = {
    [MIME_PNG]: '.png',
    [MIME_JPEG]: '.jpg',
    [MIME_GIF]: '.gif',
    [MIME_WEBP]: '.webp',
    [MIME_AVIF]: '.avif',
    [MIME_HEIC]: '.heic',
    [MIME_HEIF]: '.heif',
    [MIME_BMP]: '.bmp',
    [MIME_ICO]: '.ico',
    [MIME_TIFF]: '.tiff',
    [MIME_SVG]: '.svg',
    [MIME_PDF]: '.pdf',
    [MIME_TEXT]: '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'text/html': '.html',
  }
  return extensions[mime] ?? ''
}
