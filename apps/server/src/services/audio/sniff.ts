// Recording types of dictation (ADR-029, API.md 5.21, ARCHITECTURE.md 6.12 / 10.8). Owner: W6.5.
//
// `POST /audio/transcriptions` accepts the types of `AUDIO_UPLOAD_TYPES` (parameters such as `;codecs=opus` stripped,
// lowercased, aliases mapped to their canonical type), and the declared type must match the magic bytes:
// - WebM: an EBML header whose DocType is `webm` (Matroska files say `matroska` and are refused);
// - Ogg: `OggS`;
// - MP4: an `ftyp` box none of whose brands is an image brand (AVIF / HEIF / HEIC share the container);
// - MP3: an ID3v2 tag or an MPEG audio frame sync (AAC ADTS frames, which share the first sync bits, are refused);
// - WAV: `RIFF....WAVE`;
// - FLAC: `fLaC` (also after an ID3v2 tag, which some taggers add).
// `application/octet-stream` (or no type at all) lets the content decide. Chat uploads keep their own rules
// (`services/files/sniff.ts`, `UPLOAD_MIME_PATTERNS`): audio is accepted by this route only.
import type { AudioUploadType } from './types.ts'
import { AUDIO_UPLOAD_TYPES } from './types.ts'

/** The declared type that lets the magic bytes decide. */
export const OCTET_STREAM = 'application/octet-stream'

/** What the accepted formats are called in messages. */
export const ACCEPTED_FORMATS_TEXT = 'WebM, Ogg, MP4, MP3, WAV or FLAC'

/** Every accepted declared type (canonical types and their aliases) mapped to its canonical type. */
const CANONICAL_TYPES: ReadonlyMap<string, AudioUploadType> = new Map(
  (Object.entries(AUDIO_UPLOAD_TYPES) as Array<[AudioUploadType, readonly string[]]>).flatMap(([canonical, aliases]) => [
    [canonical, canonical] as const,
    ...aliases.map(alias => [alias, canonical] as const),
  ]),
)

const MEDIA_TYPE_PATTERN = /^[\w.+-]+\/[\w.+-]+$/

const EBML_MAGIC = [0x1A, 0x45, 0xDF, 0xA3] as const
const EBML_DOCTYPE_ID = 0x4282
/** How much of the file the EBML header scan reads at most. */
const EBML_SCAN_BYTES = 1024
/** Longest DocType read (`webm`, `matroska`). */
const EBML_DOCTYPE_MAX_BYTES = 64

const OGG_MAGIC = [0x4F, 0x67, 0x67, 0x53] as const // OggS
const FLAC_MAGIC = [0x66, 0x4C, 0x61, 0x43] as const // fLaC

/** ISO BMFF brands of image files (AVIF, HEIF / HEIC, MIAF, Canon raw): an `ftyp` with one of them is no recording. */
const ISO_IMAGE_BRANDS: ReadonlySet<string> = new Set([
  'avif',
  'avis',
  'avio',
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'mif2',
  'msf1',
  'miaf',
  'crx ',
])
/** Compatible brands read from an `ftyp` box at most. */
const FTYP_MAX_BRANDS = 64

/** Lowercase `type/subtype` of a declared type without its parameters; '' when missing or malformed. */
export function mediaTypeOf(declared: string | undefined): string {
  const type = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return MEDIA_TYPE_PATTERN.test(type) && type.length <= 127 ? type : ''
}

/**
 * The canonical type of a declared recording type (`video/webm` -> `audio/webm`); `OCTET_STREAM` when the content must
 * decide (`application/octet-stream`, or a `Blob` without a type); null when the type is not accepted or malformed.
 * (A multipart part without a `Content-Type` header is parsed as `text/plain`, which is not accepted.)
 */
export function declaredAudioType(declared: string | undefined): AudioUploadType | typeof OCTET_STREAM | null {
  if ((declared ?? '').split(';')[0]?.trim() === '')
    return OCTET_STREAM
  const type = mediaTypeOf(declared)
  if (type === OCTET_STREAM)
    return OCTET_STREAM
  return CANONICAL_TYPES.get(type) ?? null
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length)
    return false
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = ''
  for (let index = start; index < start + length && index < bytes.length; index++)
    out += String.fromCharCode(bytes[index]!)
  return out
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!
}

// ---------- WebM (EBML) ----------

/** Length (1..8) of an EBML variable-size integer, from its first byte; 0 for the invalid first byte 0x00. */
function vintLength(first: number): number {
  for (let length = 1; length <= 8; length++) {
    if ((first & (0x80 >> (length - 1))) !== 0)
      return length
  }
  return 0
}

/** An element size at `offset` (`unknown`: every value bit set); null when invalid or cut off. */
function readElementSize(bytes: Uint8Array, offset: number): { length: number, value: number, unknown: boolean } | null {
  if (offset >= bytes.length)
    return null
  const length = vintLength(bytes[offset]!)
  if (length === 0 || offset + length > bytes.length)
    return null
  const mask = 0xFF >> length
  let value = bytes[offset]! & mask
  let unknown = value === mask
  for (let index = 1; index < length; index++) {
    const byte = bytes[offset + index]!
    value = value * 256 + byte
    if (byte !== 0xFF)
      unknown = false
  }
  return { length, value, unknown }
}

/** An element id at `offset` (1..4 bytes, marker bits kept, e.g. `0x4282`); null when invalid or cut off. */
function readElementId(bytes: Uint8Array, offset: number): { length: number, id: number } | null {
  if (offset >= bytes.length)
    return null
  const length = vintLength(bytes[offset]!)
  if (length === 0 || length > 4 || offset + length > bytes.length)
    return null
  let id = 0
  for (let index = 0; index < length; index++)
    id = id * 256 + bytes[offset + index]!
  return { length, id }
}

/**
 * The DocType of the EBML header that starts `bytes` (`webm`, `matroska`), or null when there is no EBML header or it
 * carries no readable DocType. Child elements are walked in any order within the header (sizes of 1..8 bytes: Chrome
 * writes one-byte sizes, Firefox eight-byte ones).
 */
export function ebmlDocType(bytes: Uint8Array): string | null {
  if (!startsWith(bytes, EBML_MAGIC))
    return null
  const header = readElementSize(bytes, EBML_MAGIC.length)
  if (header === null)
    return null
  let offset = EBML_MAGIC.length + header.length
  const declaredEnd = header.unknown ? Number.POSITIVE_INFINITY : offset + header.value
  const end = Math.min(declaredEnd, bytes.length, EBML_SCAN_BYTES)
  while (offset < end) {
    const element = readElementId(bytes, offset)
    if (element === null)
      return null
    const size = readElementSize(bytes, offset + element.length)
    if (size === null || size.unknown)
      return null
    const start = offset + element.length + size.length
    if (element.id === EBML_DOCTYPE_ID) {
      if (size.value > EBML_DOCTYPE_MAX_BYTES || start + size.value > bytes.length)
        return null
      // A string element may be padded with NUL bytes.
      return ascii(bytes, start, size.value).replace(/\0+$/, '')
    }
    offset = start + size.value
  }
  return null
}

// ---------- MP4 (ISO BMFF) ----------

/** An `ftyp` box at the start whose brands (major and compatible) contain no image brand. */
function isAudioMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp')
    return false
  const boxSize = uint32be(bytes, 0)
  const major = ascii(bytes, 8, 4)
  if (boxSize < 16 || !/^[\x20-\x7E]{4}$/.test(major))
    return false
  const brands = [major]
  const end = Math.min(boxSize, bytes.length, 16 + 4 * FTYP_MAX_BRANDS)
  for (let offset = 16; offset + 4 <= end; offset += 4)
    brands.push(ascii(bytes, offset, 4))
  return !brands.some(brand => ISO_IMAGE_BRANDS.has(brand))
}

// ---------- MP3 (ID3v2, MPEG audio frames) ----------

/**
 * An MPEG audio frame header at `offset`: an 11-bit frame sync, a known version (not the reserved `01`), a layer
 * (I, II or III; the reserved layer `00` is what AAC ADTS headers carry), a usable bitrate index and sample rate.
 */
function isMpegAudioFrame(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length < offset + 4 || bytes[offset] !== 0xFF)
    return false
  const second = bytes[offset + 1]!
  const third = bytes[offset + 2]!
  if ((second & 0xE0) !== 0xE0)
    return false
  const version = (second >> 3) & 0x03
  const layer = (second >> 1) & 0x03
  const bitrate = third >> 4
  const sampleRate = (third >> 2) & 0x03
  return version !== 0x01 && layer !== 0x00 && bitrate !== 0x0F && sampleRate !== 0x03
}

/** An AAC ADTS frame header at `offset` (12-bit sync, layer `00`). */
function isAdtsFrame(bytes: Uint8Array, offset: number): boolean {
  return bytes.length >= offset + 2 && bytes[offset] === 0xFF && (bytes[offset + 1]! & 0xF6) === 0xF0
}

/** The end of an ID3v2 tag that starts `bytes` (header, synchsafe size, optional footer), or null without one. */
function id3TagEnd(bytes: Uint8Array): number | null {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3' || bytes[3] === 0xFF || bytes[4] === 0xFF)
    return null
  for (let index = 6; index < 10; index++) {
    if (bytes[index]! >= 0x80)
      return null
  }
  const size = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!
  const footer = (bytes[5]! & 0x10) !== 0 ? 10 : 0
  return 10 + size + footer
}

// ---------- sniffing ----------

/** The recording type of the magic bytes, or null when the content is none of the accepted formats. */
export function sniffAudioType(bytes: Uint8Array): AudioUploadType | null {
  const tagEnd = id3TagEnd(bytes)
  if (tagEnd !== null) {
    // What follows the tag decides between FLAC, AAC (refused) and MP3 (the format ID3 tags belong to).
    if (startsWith(bytes, FLAC_MAGIC, tagEnd))
      return 'audio/flac'
    if (isAdtsFrame(bytes, tagEnd))
      return null
    return 'audio/mpeg'
  }
  if (ebmlDocType(bytes) === 'webm')
    return 'audio/webm'
  if (startsWith(bytes, OGG_MAGIC))
    return 'audio/ogg'
  if (isAudioMp4(bytes))
    return 'audio/mp4'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE')
    return 'audio/wav'
  if (startsWith(bytes, FLAC_MAGIC))
    return 'audio/flac'
  if (isMpegAudioFrame(bytes, 0))
    return 'audio/mpeg'
  return null
}

export type AudioTypeCheck = { ok: true, type: AudioUploadType } | { ok: false, reason: string }

/**
 * The canonical type of a recording from its declared type and its bytes, or why it is refused: a type that is not
 * accepted, content that does not match the declared type, or (declared `application/octet-stream` / none) content of
 * no accepted format.
 */
export function checkAudioType(declared: string | undefined, bytes: Uint8Array): AudioTypeCheck {
  const type = declaredAudioType(declared)
  if (type === null) {
    return {
      ok: false,
      reason: `The type ${mediaTypeOf(declared) || 'of the recording'} is not accepted: send a ${ACCEPTED_FORMATS_TEXT} recording.`,
    }
  }
  const sniffed = sniffAudioType(bytes)
  if (type === OCTET_STREAM) {
    return sniffed === null
      ? { ok: false, reason: `The recording is not in a supported format: send a ${ACCEPTED_FORMATS_TEXT} recording.` }
      : { ok: true, type: sniffed }
  }
  return sniffed === type ? { ok: true, type } : { ok: false, reason: `The recording does not match its type (${mediaTypeOf(declared)}).` }
}
