// Voice routes (API.md 5.21, ADR-029) - Phase 6 stubs (501). Owner: W6.5. Keep the export name `createAudioRoutes`.
// Thin: validate, call `deps.audio`, map to the response. Session auth and the Origin check apply, no fresh auth.
//
// - `POST /audio/transcriptions` is multipart: exactly one recording in the part `file` + the `AudioTranscribeForm`
//   fields. The route reads the multipart body itself (like `readImportForm` in `data.ts`: unknown or repeated fields
//   -> `400`), so the strict form schema never sees the file part; the body-limit middleware caps it at
//   `LIMITS.audioUploadBytes` + multipart overhead.
// - `POST /audio/speech` takes a JSON `AudioSpeechBody` and answers the audio bytes (`Cache-Control: no-store`).
// Nothing is stored; logs carry sizes and timings, never the audio or the text.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, audioSpeechBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createAudioRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.post(apiRoutes['audio.transcribe'].path, notImplemented('audio.transcribe'))
  app.post(apiRoutes['audio.speech'].path, validate('json', audioSpeechBodySchema), notImplemented('audio.speech'))
  return app
}
