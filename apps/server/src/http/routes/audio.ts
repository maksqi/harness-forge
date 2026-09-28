// Voice routes (API.md 5.21, ADR-029). Owner: W6.5. Keep the export name `createAudioRoutes`. Thin: parse, call
// `deps.audio`, map to the response. Session auth and the Origin check apply (global middleware); no fresh auth (the
// routes run no code and create nothing lasting).
//
// - `POST /audio/transcriptions` is multipart: exactly one recording in the part `file` + the `AudioTranscribeForm`
//   fields (`modelRef`, `language`; omitted = the settings). The route reads the multipart body itself (like
//   `readImportForm` in `data.ts`): a missing or second file, a text part named `file`, an unknown or repeated field ->
//   `400`, so the strict form schema never sees the file part. The body-limit middleware caps the body at
//   `LIMITS.audioUploadBytes` + multipart overhead; the service checks the recording itself (size, type, magic bytes).
//   Answers `AudioTranscription` with `Cache-Control: no-store`.
// - `POST /audio/speech` takes a JSON `AudioSpeechBody` and answers the audio bytes with the allowlisted
//   `Content-Type`, `Content-Length`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
// Both hand the request signal to the service: a client that disconnects aborts the provider call. Nothing is stored;
// logs carry sizes and timings, never the audio or the text.
import type { AudioTranscribeForm } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppEnv } from '../types.ts'
import { apiRoutes, audioSpeechBodySchema, audioTranscribeFormSchema, validationError } from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

const MULTIPART = /^multipart\/form-data\s*;/i
/** Multipart fields of `POST /audio/transcriptions` besides the part `file`. */
const TRANSCRIBE_FORM_FIELDS: ReadonlySet<string> = new Set(Object.keys(audioTranscribeFormSchema.shape))

function invalidRequest(message: string, path: Array<string | number> = ['file']): Error {
  return validationError([{ path, message, code: 'custom' }], message)
}

/** The recording and the parsed fields of a `POST /audio/transcriptions` body. */
async function readTranscribeForm(c: AppContext): Promise<{ file: File, form: AudioTranscribeForm }> {
  if (!MULTIPART.test(c.req.header('content-type') ?? ''))
    throw invalidRequest('Send multipart/form-data with the recording in the part named "file".')
  let body: FormData
  try {
    body = await c.req.formData()
  }
  catch {
    throw invalidRequest('The multipart body cannot be read.', [])
  }
  let file: File | undefined
  // No prototype: a part named "__proto__" is an ordinary (unknown, refused) field.
  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of body.entries()) {
    if (key === 'file') {
      if (typeof value === 'string')
        throw invalidRequest('The part "file" must be a file.')
      if (file !== undefined)
        throw invalidRequest('Send exactly one recording.')
      file = value
      continue
    }
    const name = key.slice(0, 64)
    if (!TRANSCRIBE_FORM_FIELDS.has(key))
      throw invalidRequest(`Unknown field "${name}".`, [name])
    if (typeof value !== 'string')
      throw invalidRequest(`Only the part "file" may be a file ("${name}" is one).`, [name])
    if (Object.hasOwn(fields, key))
      throw invalidRequest(`The field "${name}" is sent more than once.`, [name])
    fields[key] = value
  }
  if (file === undefined)
    throw invalidRequest('Attach the recording in the part named "file".')
  const parsed = audioTranscribeFormSchema.safeParse(fields)
  if (!parsed.success)
    throw validationError(parsed.error)
  return { file, form: parsed.data }
}

/** The bytes as a body Hono accepts (a view over an `ArrayBuffer`), copied only when they sit in another buffer. */
function responseBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes)
}

export function createAudioRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post(apiRoutes['audio.transcribe'].path, async (c) => {
    const { file, form } = await readTranscribeForm(c)
    const transcription = await deps.audio.transcribe({ file, form, signal: c.req.raw.signal })
    c.header('Cache-Control', 'no-store')
    return c.json(transcription)
  })

  app.post(apiRoutes['audio.speech'].path, validate('json', audioSpeechBodySchema), async (c) => {
    const speech = await deps.audio.speak({ ...c.req.valid('json'), signal: c.req.raw.signal })
    return c.body(responseBytes(speech.audio), 200, {
      'Content-Type': speech.mediaType,
      'Content-Length': String(speech.audio.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  return app
}
