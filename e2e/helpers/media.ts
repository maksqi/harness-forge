// Media helpers for the Phase 6 specs (docs/UI.md 7.16 - 7.18, 9.9; ADR-028, ADR-029): the Settings -> Media keys a
// spec changes (restore them through `cleanup`), the pixel size of a loaded image, the parts of a multipart request body
// (the dictation upload) and a log of the requests a page sends to one API route, bodies included.
import type { Locator, Page, Route } from '@playwright/test'
import type { Settings } from '../../packages/shared/src/index.ts'
import type { Size } from './layout.ts'
import { Buffer } from 'node:buffer'
import { expect } from '@playwright/test'

/** The keys of Settings -> Media (docs/UI.md 9.9). */
export const MEDIA_SETTINGS_KEYS = [
  'imageModelRef',
  'transcriptionModelRef',
  'transcriptionLanguage',
  'speechModelRef',
  'speechVoice',
  'speechSpeed',
] as const

export type MediaSettings = Pick<Settings, (typeof MEDIA_SETTINGS_KEYS)[number]>

/** The media keys of `settings`: `cleanup(api => api.updateSettings(mediaSettingsOf(before)))`. */
export function mediaSettingsOf(settings: Settings): MediaSettings {
  return {
    imageModelRef: settings.imageModelRef,
    transcriptionModelRef: settings.transcriptionModelRef,
    transcriptionLanguage: settings.transcriptionLanguage,
    speechModelRef: settings.speechModelRef,
    speechVoice: settings.speechVoice,
    speechSpeed: settings.speechSpeed,
  }
}

/** Nothing chosen in Settings -> Media (the defaults). */
export const NO_MEDIA_SETTINGS: MediaSettings = {
  imageModelRef: null,
  transcriptionModelRef: null,
  transcriptionLanguage: 'auto',
  speechModelRef: null,
  speechVoice: null,
  speechSpeed: 1,
}

/** The pixel size of an `<img>` once it has loaded (waits for the load). */
export async function naturalSize(image: Locator): Promise<Size> {
  const read = () => image.evaluate((element) => {
    const img = element as unknown as { complete: boolean, naturalWidth: number, naturalHeight: number }
    return img.complete ? { width: img.naturalWidth, height: img.naturalHeight } : { width: 0, height: 0 }
  })
  await expect.poll(async () => (await read()).width, { message: `${image} has loaded` }).toBeGreaterThan(0)
  return read()
}

/** One part of a `multipart/form-data` body. */
export interface MultipartPart {
  /** The `name` of its Content-Disposition. */
  name: string
  /** The `filename` of its Content-Disposition, if any. */
  filename?: string
  /** Its own Content-Type header, if any (e.g. `audio/webm;codecs=opus`). */
  contentType?: string
  /** Size of its body in bytes. */
  size: number
  /** The first bytes of its body (at most 16). */
  head: Uint8Array
}

/**
 * The parts of a `multipart/form-data` request body, from the boundary of its Content-Type header. Throws when the
 * header is not multipart or has no boundary.
 */
export function multipartParts(body: Uint8Array, contentType: string): MultipartPart[] {
  const boundary = contentType.match(/^multipart\/form-data;.*\bboundary=(?:"([^"]+)"|([^;]+))/i)
  const marker = boundary?.[1] ?? boundary?.[2]?.trim()
  if (!marker)
    throw new Error(`Not a multipart body: ${contentType}`)
  const bytes = Buffer.from(body)
  const delimiter = Buffer.from(`--${marker}`)
  const parts: MultipartPart[] = []
  let start = bytes.indexOf(delimiter)
  while (start !== -1) {
    const next = bytes.indexOf(delimiter, start + delimiter.length)
    if (next === -1)
      break
    // Skip the CRLF after the delimiter; the part ends with a CRLF before the next delimiter.
    const part = bytes.subarray(start + delimiter.length + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    if (split !== -1) {
      const headers = part.subarray(0, split).toString('utf8')
      const content = part.subarray(split + 4)
      const disposition = headers.match(/^content-disposition:(.*)$/im)?.[1] ?? ''
      const type = headers.match(/^content-type:(.*)$/im)?.[1]?.trim()
      const filename = disposition.match(/\bfilename="([^"]*)"/)?.[1]
      parts.push({
        name: disposition.match(/\bname="([^"]*)"/)?.[1] ?? '',
        ...(filename === undefined ? {} : { filename }),
        ...(type === undefined ? {} : { contentType: type }),
        size: content.length,
        head: new Uint8Array(content.subarray(0, 16)),
      })
    }
    start = next
  }
  return parts
}

/** A request a page sent, as `recordRequests` saw it. */
export interface RecordedRequest {
  method: string
  /** The URL path, e.g. `/api/audio/speech`. */
  path: string
  /** Request headers (lowercase names). */
  headers: Record<string, string>
  /**
   * The body as sent, or null without one. Unlike `Request.postDataBuffer()` of a page request it includes the bytes of
   * files and blobs (a multipart dictation upload), because `recordRequests` reads it through `page.route()`.
   */
  body: Buffer | null
}

/** The requests a page sent to one API route, in order (see `recordRequests`). */
export interface RequestLog {
  readonly requests: readonly RecordedRequest[]
  /** The JSON bodies of the requests, in order. */
  jsonBodies: () => unknown[]
  /** Stops recording (removes the route). */
  stop: () => Promise<void>
}

/**
 * Records every request of `page` with this method to this URL path (e.g. `POST /api/audio/speech`) from now on, and lets
 * it through unchanged (`route.fallback()`, so other routes of the spec still apply): a spec can prove that an action
 * sent no request, or read the body of the one it sent. Call `stop()` when done (a closed page needs no stop).
 */
export async function recordRequests(page: Page, method: string, path: string): Promise<RequestLog> {
  const requests: RecordedRequest[] = []
  const matches = (url: URL) => url.pathname === path
  const handler = async (route: Route) => {
    const request = route.request()
    if (request.method() === method)
      requests.push({ method, path, headers: await request.allHeaders(), body: request.postDataBuffer() })
    await route.fallback()
  }
  await page.route(matches, handler)
  return {
    requests,
    jsonBodies: () => requests.map(request => (request.body === null ? null : JSON.parse(request.body.toString('utf8')) as unknown)),
    stop: () => page.unroute(matches, handler),
  }
}
