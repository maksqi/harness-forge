// Recording types of dictation (API.md 5.21, ARCHITECTURE.md 6.12): the declared type table (aliases, parameters,
// octet-stream), the magic-byte table (WebM / Ogg / MP4 / MP3 / WAV / FLAC, with the look-alikes that must be refused)
// and the combined check with its messages.
import { describe, expect, it } from 'vitest'
import { createMockWav } from '../../builtin-plugins/mock/media.ts'
import { SAMPLE_WEBM_BYTES } from '../../testing/api-samples.ts'
import { checkAudioType, declaredAudioType, ebmlDocType, mediaTypeOf, OCTET_STREAM, sniffAudioType } from './sniff.ts'
import { AUDIO_UPLOAD_TYPES } from './types.ts'

/** Bytes of a hex string (spaces ignored). */
function hex(text: string): number[] {
  return (text.replace(/\s+/g, '').match(/../g) ?? []).map(byte => Number.parseInt(byte, 16))
}

function ascii(text: string): number[] {
  return [...text].map(char => char.charCodeAt(0))
}

/** `head` padded with zero bytes to `size` (every sample is at least a plausible recording length). */
function bytes(head: readonly number[], size = 128): Uint8Array {
  const out = new Uint8Array(Math.max(size, head.length))
  out.set(head)
  return out
}

/** An `ftyp` box with a major brand and compatible brands. */
function ftyp(major: string, compatible: string[]): number[] {
  const size = 16 + 4 * compatible.length
  return [...hex(size.toString(16).padStart(8, '0')), ...ascii('ftyp'), ...ascii(major), 0, 0, 2, 0, ...compatible.flatMap(ascii)]
}

/** An ID3v2.3 tag of `size` bytes (synchsafe) with an empty body. */
function id3(size: number): number[] {
  const synchsafe = [(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F]
  return [...ascii('ID3'), 0x03, 0x00, 0x00, ...synchsafe, ...new Uint8Array(size)]
}

const MP3_FRAME = hex('FFFB9064') // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz
const ADTS_FRAME = hex('FFF15080') // AAC ADTS (MPEG-4, no CRC)
const PNG = hex('89504E470D0A1A0A0000000D49484452')

/** Firefox writes the EBML header size and element sizes on 8 bytes; the DocType padded with a NUL. */
const FIREFOX_WEBM = hex('1A45DFA3 0100000000000023 4286 81 01 42F7 81 01 42F2 81 04 42F3 81 08 4282 85 7765626D00 4287 81 04 4285 81 02')

const SNIFF_TABLE: Array<[label: string, content: Uint8Array, expected: string | null]> = [
  ['WebM from Chrome (one-byte sizes)', SAMPLE_WEBM_BYTES, 'audio/webm'],
  ['WebM from Firefox (eight-byte sizes, NUL-padded DocType)', bytes(FIREFOX_WEBM), 'audio/webm'],
  ['WebM with the DocType after other header elements', bytes(hex('1A45DFA3 8B 4287 81 04 4282 84 7765626D')), 'audio/webm'],
  ['Matroska (DocType matroska)', bytes(hex('1A45DFA3 8F 4286 81 01 4282 88 6D6174726F736B61')), null],
  ['an EBML header without a DocType', bytes(hex('1A45DFA3 84 4286 81 01')), null],
  ['an EBML header cut off inside the DocType', new Uint8Array(hex('1A45DFA3 87 4282 84 7765')), null],
  ['Ogg', bytes([...ascii('OggS'), 0x00, 0x02]), 'audio/ogg'],
  ['MP4 from Safari (iso5)', bytes(ftyp('iso5', ['iso5', 'iso6', 'mp41'])), 'audio/mp4'],
  ['M4A', bytes(ftyp('M4A ', ['M4A ', 'mp42', 'isom'])), 'audio/mp4'],
  ['AVIF (image brand)', bytes(ftyp('avif', ['mif1', 'miaf'])), null],
  ['HEIC (image brand)', bytes(ftyp('heic', ['mif1', 'heic'])), null],
  ['an mp42 file with an image brand among the compatible brands', bytes(ftyp('mp42', ['isom', 'mif1'])), null],
  ['an ftyp box that is too small', bytes([...hex('00000008'), ...ascii('ftyp')]), null],
  ['MP3 with an ID3v2 tag', bytes([...id3(10), ...MP3_FRAME]), 'audio/mpeg'],
  ['MP3 frame sync (MPEG-1 Layer III)', bytes(MP3_FRAME), 'audio/mpeg'],
  ['MP3 frame sync (MPEG-2 Layer III)', bytes(hex('FFF39064')), 'audio/mpeg'],
  ['MP3 frame sync (MPEG-2.5 Layer III)', bytes(hex('FFE39064')), 'audio/mpeg'],
  ['AAC ADTS without CRC', bytes(ADTS_FRAME), null],
  ['AAC ADTS with CRC (MPEG-2)', bytes(hex('FFF85080')), null],
  ['AAC ADTS behind an ID3v2 tag', bytes([...id3(10), ...ADTS_FRAME]), null],
  ['an MPEG frame of the reserved version', bytes(hex('FFEB9064')), null],
  ['an MPEG frame with the bad bitrate index', bytes(hex('FFFBF064')), null],
  ['an MPEG frame with the reserved sample rate', bytes(hex('FFFB9C64')), null],
  ['WAV', createMockWav('hello'), 'audio/wav'],
  ['WebP (RIFF, not WAVE)', bytes([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 ')]), null],
  ['AVI (RIFF, not WAVE)', bytes([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('AVI LIST')]), null],
  ['FLAC', bytes([...ascii('fLaC'), 0x00, 0x00, 0x00, 0x22]), 'audio/flac'],
  ['FLAC behind an ID3v2 tag', bytes([...id3(20), ...ascii('fLaC'), 0x00, 0x00, 0x00, 0x22]), 'audio/flac'],
  ['PNG', bytes(PNG), null],
  ['JPEG', bytes(hex('FFD8FFE000104A464946')), null],
  ['PDF', bytes(ascii('%PDF-1.7')), null],
  ['text', new TextEncoder().encode('This is not a recording, just text that is long enough to pass the size floor.'), null],
  ['zero bytes', new Uint8Array(128), null],
]

describe('sniffAudioType', () => {
  it.each(SNIFF_TABLE)('%s', (_label, content, expected) => {
    expect(sniffAudioType(content)).toBe(expected)
  })

  it('reads the DocType of an EBML header', () => {
    expect(ebmlDocType(SAMPLE_WEBM_BYTES)).toBe('webm')
    expect(ebmlDocType(bytes(FIREFOX_WEBM))).toBe('webm')
    expect(ebmlDocType(bytes(hex('1A45DFA3 8F 4286 81 01 4282 88 6D6174726F736B61')))).toBe('matroska')
    expect(ebmlDocType(bytes(PNG))).toBeNull()
    // An unknown-size header is scanned within the first kilobyte; a bad element id stops the scan.
    expect(ebmlDocType(bytes(hex('1A45DFA3 FF 4282 84 7765626D')))).toBe('webm')
    expect(ebmlDocType(bytes(hex('1A45DFA3 85 00 81 01 4282')))).toBeNull()
  })
})

describe('declaredAudioType', () => {
  it('maps every canonical type and alias of AUDIO_UPLOAD_TYPES, parameters and case ignored', () => {
    for (const [canonical, aliases] of Object.entries(AUDIO_UPLOAD_TYPES)) {
      expect(declaredAudioType(canonical)).toBe(canonical)
      for (const alias of aliases)
        expect(declaredAudioType(alias), alias).toBe(canonical)
    }
    expect(declaredAudioType('audio/webm;codecs=opus')).toBe('audio/webm')
    expect(declaredAudioType('Audio/WebM; codecs="opus"')).toBe('audio/webm')
    expect(declaredAudioType('audio/ogg; codecs=opus')).toBe('audio/ogg')
    expect(declaredAudioType('video/mp4;codecs=mp4a.40.2')).toBe('audio/mp4')
  })

  it('lets the content decide for application/octet-stream and a missing type', () => {
    expect(declaredAudioType('application/octet-stream')).toBe(OCTET_STREAM)
    expect(declaredAudioType('')).toBe(OCTET_STREAM)
    expect(declaredAudioType(undefined)).toBe(OCTET_STREAM)
  })

  it.each(['image/png', 'audio/aac', 'audio/x-matroska', 'video/quicktime', 'text/plain', 'audio/webm2', 'audio webm', 'audio/'])('refuses %s', (type) => {
    expect(declaredAudioType(type)).toBeNull()
  })

  it('normalizes media types for messages', () => {
    expect(mediaTypeOf(' Audio/MPEG ; rate=1')).toBe('audio/mpeg')
    expect(mediaTypeOf('not a type')).toBe('')
    expect(mediaTypeOf(undefined)).toBe('')
  })
})

describe('checkAudioType', () => {
  it('accepts content that matches the declared type (aliases too) and answers the canonical type', () => {
    expect(checkAudioType('audio/webm;codecs=opus', SAMPLE_WEBM_BYTES)).toEqual({ ok: true, type: 'audio/webm' })
    expect(checkAudioType('video/webm', SAMPLE_WEBM_BYTES)).toEqual({ ok: true, type: 'audio/webm' })
    expect(checkAudioType('audio/x-wav', createMockWav())).toEqual({ ok: true, type: 'audio/wav' })
    expect(checkAudioType('audio/mp3', bytes([...id3(10), ...MP3_FRAME]))).toEqual({ ok: true, type: 'audio/mpeg' })
    expect(checkAudioType('audio/x-m4a', bytes(ftyp('M4A ', ['M4A ', 'isom'])))).toEqual({ ok: true, type: 'audio/mp4' })
  })

  it('refuses content that does not match the declared type', () => {
    expect(checkAudioType('audio/webm', bytes(PNG))).toEqual({ ok: false, reason: 'The recording does not match its type (audio/webm).' })
    expect(checkAudioType('audio/ogg', SAMPLE_WEBM_BYTES)).toEqual({ ok: false, reason: 'The recording does not match its type (audio/ogg).' })
    expect(checkAudioType('audio/mpeg', bytes(ADTS_FRAME))).toMatchObject({ ok: false })
    expect(checkAudioType('video/mp4', bytes(ftyp('avif', ['mif1'])))).toEqual({ ok: false, reason: 'The recording does not match its type (video/mp4).' })
  })

  it('lets the magic bytes decide for application/octet-stream', () => {
    expect(checkAudioType('application/octet-stream', createMockWav())).toEqual({ ok: true, type: 'audio/wav' })
    expect(checkAudioType('', SAMPLE_WEBM_BYTES)).toEqual({ ok: true, type: 'audio/webm' })
    expect(checkAudioType('application/octet-stream', bytes(PNG))).toEqual({
      ok: false,
      reason: 'The recording is not in a supported format: send a WebM, Ogg, MP4, MP3, WAV or FLAC recording.',
    })
  })

  it('refuses types that are not accepted before looking at the content', () => {
    expect(checkAudioType('image/png', bytes(PNG))).toEqual({
      ok: false,
      reason: 'The type image/png is not accepted: send a WebM, Ogg, MP4, MP3, WAV or FLAC recording.',
    })
    expect(checkAudioType('text/plain', SAMPLE_WEBM_BYTES)).toMatchObject({ ok: false, reason: expect.stringContaining('text/plain is not accepted') })
    expect(checkAudioType('audio webm', SAMPLE_WEBM_BYTES)).toMatchObject({ ok: false, reason: expect.stringContaining('The type of the recording is not accepted') })
  })
})
