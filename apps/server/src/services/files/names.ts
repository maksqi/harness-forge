// File names of uploads and downloads: sanitizing (API.md 5.11: no path separators or control characters, <= 255
// characters) and the `Content-Disposition` header (RFC 6266 / RFC 8187) of downloads and chat exports.
import { replaceControlChars, truncateCodePoints, wellFormed } from '../chats/text.ts'
import { extensionForMime } from './sniff.ts'

export const FILE_NAME_MAX_LENGTH = 255
/** Extensions longer than this are not preserved when a long name is shortened. */
const MAX_KEPT_EXTENSION = 16

/**
 * The stored name of an upload: the last path segment, NFC, without control or bidi-override characters, trimmed, at
 * most 255 characters (the extension kept when shortened). Empty or dot-only names become `file<.ext>` from the type.
 */
export function sanitizeFileName(raw: string, mime: string): string {
  const segment = wellFormed(raw).split(/[/\\]/).pop() ?? ''
  const name = replaceControlChars(segment.normalize('NFC'), '').trim()
  if (name === '' || /^\.+$/.test(name))
    return `file${extensionForMime(mime)}`
  const chars = Array.from(name)
  if (chars.length <= FILE_NAME_MAX_LENGTH)
    return name
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= MAX_KEPT_EXTENSION ? name.slice(dot) : ''
  const stem = extension === '' ? name : name.slice(0, dot)
  return `${truncateCodePoints(stem, FILE_NAME_MAX_LENGTH - Array.from(extension).length).trimEnd()}${extension}`
}

/** RFC 8187 `ext-value` encoding (UTF-8, percent-encoded; `'()*` encoded too). */
function encodeExtValue(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Conservative ASCII fallback for the plain `filename` parameter: letters, digits, space and `._-+,()`; everything
 * else (quotes, `\`, `%`, `;`, `=`, non-ASCII) becomes `_`, so even a naive header parser cannot be misled.
 */
function asciiFallback(value: string): string {
  const out = value.replace(/[^\w .+,()-]/g, '_').trim()
  return out === '' || /^[._]+$/.test(out) ? 'download' : out
}

/**
 * `Content-Disposition: <type>; filename="<ascii fallback>"; filename*=UTF-8''<name>` (browsers use `filename*`;
 * the fallback serves old clients).
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const name = replaceControlChars(wellFormed(filename), '').trim() || 'download'
  return `${type}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeExtValue(name)}`
}
