// Uploaded plugin icons of drafts (API.md 4.12 `IconFileInput`): base64 -> bytes, <= 256 KB, PNG signature check,
// SVG sanitized (`svg.ts`). Owner: W3.3.
import type { IconFileInput, ValidationIssue } from '@harness-forge/shared'
import { Buffer } from 'node:buffer'
import { LIMITS, validationError } from '@harness-forge/shared'
import { sanitizeSvg, SvgSanitizeError } from './svg.ts'

/** A decoded, checked icon file ready to be written next to `plugin.json`. */
export interface IconFile {
  name: IconFileInput['name']
  bytes: Uint8Array
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] as const
const PNG_IHDR = [0x49, 0x48, 0x44, 0x52] as const

function iconError(message: string, path: readonly (string | number)[] = ['iconFile']): never {
  const issue: ValidationIssue = { path: [...path], message, code: 'custom' }
  throw validationError([issue], message)
}

/** True for bytes that start like a PNG file (signature + IHDR chunk). */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 24)
    return false
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) && PNG_IHDR.every((byte, index) => bytes[12 + index] === byte)
}

/** Strict UTF-8 decoding (an SVG is text); null for invalid sequences. */
function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    return null
  }
}

/** Decodes and checks an uploaded icon; throws `validation_error` (path `iconFile`) when it is unusable. */
export function decodeIconFile(input: IconFileInput): IconFile {
  const bytes = new Uint8Array(Buffer.from(input.base64, 'base64'))
  if (bytes.length === 0)
    iconError('The icon file is empty.', ['iconFile', 'base64'])
  if (bytes.length > LIMITS.iconFileBytes)
    iconError(`Icons are limited to ${LIMITS.iconFileBytes / 1024} KB.`, ['iconFile', 'base64'])
  if (input.name === 'icon.png') {
    if (!isPng(bytes))
      iconError('icon.png is not a PNG image.', ['iconFile', 'base64'])
    return { name: input.name, bytes }
  }
  const text = utf8Text(bytes)
  if (text === null)
    iconError('icon.svg is not UTF-8 text.', ['iconFile', 'base64'])
  let svg: string
  try {
    svg = sanitizeSvg(text)
  }
  catch (error) {
    if (error instanceof SvgSanitizeError)
      iconError(`icon.svg is not a valid SVG image: ${error.message}`, ['iconFile', 'base64'])
    throw error
  }
  const sanitized = new TextEncoder().encode(svg)
  if (sanitized.length > LIMITS.iconFileBytes)
    iconError(`Icons are limited to ${LIMITS.iconFileBytes / 1024} KB.`, ['iconFile', 'base64'])
  return { name: input.name, bytes: sanitized }
}
