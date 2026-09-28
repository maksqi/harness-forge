import type { TranscriptionModelV4CallOptions } from '@ai-sdk/provider'
import type { SettingsUpdate } from '@harness-forge/shared'
import type { FakeMediaResolverOptions } from '../../providers/testing.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeAudioService } from '../../testing/fake-media.ts'
// Voice routes (API.md 5.21, ADR-029): the multipart rules of `POST /audio/transcriptions`, the recording checks and
// the model errors through the real audio service (fake media resolvers), 413 from the body limit and from the service,
// abort on client disconnect, the speech response headers, session auth + the Origin check without fresh auth, usage
// rows, and no transcript or speech text in any log record.
import { APICallError } from '@ai-sdk/provider'
import { audioTranscriptionSchema, harnessErrorEnvelopeSchema, LIMITS } from '@harness-forge/shared'
import { MockSpeechModelV4, MockTranscriptionModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWav } from '../../builtin-plugins/mock/media.test-util.ts'
import { MOCK_TRANSCRIPT } from '../../builtin-plugins/mock/media.ts'
import { usage } from '../../db/schema.ts'
import { fakeMediaProviders } from '../../providers/testing.ts'
import { CANCELED_MESSAGE, EMPTY_RECORDING_MESSAGE, NO_SPEECH_MODEL_MESSAGE, NO_TRANSCRIPTION_MODEL_MESSAGE, RECORDING_TOO_LARGE_MESSAGE } from '../../services/audio/index.ts'
import { SAMPLE_WEBM_BYTES } from '../../testing/api-samples.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeAudioService } from '../../testing/fake-media.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'

const PASSWORD = 'correct horse battery staple'
const SPEECH_TEXT = 'Please read this sentence aloud for me.'
const TRANSCRIBE = '/api/audio/transcriptions'
const SPEECH = '/api/audio/speech'
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...new Uint8Array(120)])

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

interface RouteAppOptions extends FakeMediaResolverOptions {
  env?: Record<string, string>
  settings?: SettingsUpdate
}

/** The real audio service on the fake media resolvers (`mock:transcribe`, `mock:speech`). */
async function routeApp(options: RouteAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1', ...options.env }, factories: { providers: fakeMediaProviders(options) } })
  apps.push(t)
  if (options.settings !== undefined)
    await t.deps.settings.update(options.settings)
  return t
}

async function fakeApp(): Promise<{ t: TestApp, audio: FakeAudioService }> {
  const audio = createFakeAudioService()
  const t = await createTestApp({ start: false, overrides: { audio } })
  apps.push(t)
  return { t, audio }
}

function transcribeForm(fields: Record<string, string> = {}, file: Blob | null = new File([SAMPLE_WEBM_BYTES], 'dictation.webm', { type: 'audio/webm;codecs=opus' })): FormData {
  const form = new FormData()
  if (file !== null)
    form.append('file', file)
  for (const [key, value] of Object.entries(fields))
    form.append(key, value)
  return form
}

function recordingBlob(content: Uint8Array, type: string): File {
  return new File([new Uint8Array(content)], 'recording', { type })
}

function jsonInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

async function errorOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

/** Rejects with the abort reason once the call's signal aborts (a provider that never answers). */
function untilAborted(options: { abortSignal?: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = options.abortSignal
    if (signal === undefined)
      return
    if (signal.aborted)
      reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

describe('pOST /api/audio/transcriptions', () => {
  it('transcribes a WebM recording with the settings model; never cached', async () => {
    const t = await routeApp({ settings: { transcriptionModelRef: 'mock:transcribe' } })
    const response = await t.request(TRANSCRIBE, { method: 'POST', body: transcribeForm() })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(audioTranscriptionSchema.parse(await response.json())).toEqual({ text: MOCK_TRANSCRIPT, language: null, durationSec: null, modelRef: 'mock:transcribe' })
  })

  it('hands the recording and the parsed fields to the service', async () => {
    const { t, audio } = await fakeApp()
    expect((await t.request(TRANSCRIBE, { method: 'POST', body: transcribeForm({ modelRef: 'groq:whisper-large-v3', language: 'de' }) })).status).toBe(200)
    expect((await t.request(TRANSCRIBE, { method: 'POST', body: transcribeForm() })).status).toBe(200)
    expect(audio.calls).toEqual([
      { member: 'transcribe', type: 'audio/webm;codecs=opus', bytes: SAMPLE_WEBM_BYTES.byteLength, form: { modelRef: 'groq:whisper-large-v3', language: 'de' } },
      { member: 'transcribe', type: 'audio/webm;codecs=opus', bytes: SAMPLE_WEBM_BYTES.byteLength, form: {} },
    ])
  })

  it.each<[string, () => RequestInit, string]>([
    ['a JSON body', () => jsonInit({ modelRef: 'mock:transcribe' }), 'Unsupported Content-Type: send multipart/form-data.'],
    ['no file part', () => ({ method: 'POST', body: transcribeForm({ language: 'en' }, null) }), 'Attach the recording in the part named "file".'],
    ['a text part named file', () => ({ method: 'POST', body: (() => {
      const form = transcribeForm({}, null)
      form.append('file', 'not a recording')
      return form
    })() }), 'The part "file" must be a file.'],
    ['two recordings', () => ({ method: 'POST', body: (() => {
      const form = transcribeForm()
      form.append('file', new File([SAMPLE_WEBM_BYTES], 'second.webm', { type: 'audio/webm' }))
      return form
    })() }), 'Send exactly one recording.'],
    ['an unknown field', () => ({ method: 'POST', body: transcribeForm({ prompt: 'meeting notes' }) }), 'Unknown field "prompt".'],
    ['a repeated field', () => ({ method: 'POST', body: (() => {
      const form = transcribeForm({ language: 'en' })
      form.append('language', 'de')
      return form
    })() }), 'The field "language" is sent more than once.'],
    ['a field sent as a file', () => ({ method: 'POST', body: (() => {
      const form = transcribeForm()
      form.append('language', new File(['en'], 'language.txt', { type: 'text/plain' }))
      return form
    })() }), 'Only the part "file" may be a file ("language" is one).'],
    ['an invalid language', () => ({ method: 'POST', body: transcribeForm({ language: 'english' }) }), ''],
    ['an invalid model ref', () => ({ method: 'POST', body: transcribeForm({ modelRef: 'whisper' }) }), ''],
    ['an empty model ref', () => ({ method: 'POST', body: transcribeForm({ modelRef: '' }) }), ''],
  ])('answers 400 validation_error for %s without calling the service', async (_label, init, message) => {
    const { t, audio } = await fakeApp()
    const response = await t.request(TRANSCRIBE, init())
    expect(response.status).toBe(400)
    const error = await errorOf(response)
    expect(error.code).toBe('validation_error')
    if (message !== '')
      expect(error.message).toBe(message)
    expect(audio.calls).toEqual([])
  })

  it('refuses a PNG sent as audio/webm, a type that is not accepted and an empty recording', async () => {
    const t = await routeApp({ settings: { transcriptionModelRef: 'mock:transcribe' } })
    const cases: Array<[Blob, string]> = [
      [recordingBlob(PNG, 'audio/webm'), 'The recording does not match its type (audio/webm).'],
      [recordingBlob(PNG, 'image/png'), 'The type image/png is not accepted: send a WebM, Ogg, MP4, MP3, WAV or FLAC recording.'],
      [recordingBlob(SAMPLE_WEBM_BYTES.subarray(0, 40), 'audio/webm'), EMPTY_RECORDING_MESSAGE],
    ]
    for (const [file, message] of cases) {
      const response = await t.request(TRANSCRIBE, { method: 'POST', body: transcribeForm({}, file) })
      expect(response.status, message).toBe(400)
      expect(await errorOf(response)).toMatchObject({ code: 'validation_error', message, details: { issues: [{ path: ['file'] }] } })
    }
    expect(await t.db.select().from(usage)).toEqual([])
  })

  it('answers 413 above the body limit, and for a recording over 25 MB within it', async () => {
    const t = await routeApp({ settings: { transcriptionModelRef: 'mock:transcribe' } })
    const declared = await t.request(TRANSCRIBE, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(LIMITS.audioUploadBytes + 64 * 1024 + 1) },
      body: '--x--',
    })
    expect(declared.status).toBe(413)
    expect(await errorOf(declared)).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.audioUploadBytes } })

    // Within the multipart allowance of the body limit, so the service refuses it.
    const large = new File([new Uint8Array(LIMITS.audioUploadBytes + 1)], 'long.webm', { type: 'audio/webm' })
    const response = await t.request(TRANSCRIBE, { method: 'POST', body: transcribeForm({}, large) })
    expect(response.status).toBe(413)
    expect(await errorOf(response)).toEqual({ code: 'payload_too_large', message: RECORDING_TOO_LARGE_MESSAGE, details: { limitBytes: LIMITS.audioUploadBytes } })
  })

  it('refuses a request without a model and a model of another kind', async () => {
    const t = await routeApp()
    const none = await t.request(TRANSCRIBE, { method: 'POST', body: transcribeForm() })
    expect(none.status).toBe(400)
    expect(await errorOf(none)).toMatchObject({ code: 'validation_error', message: NO_TRANSCRIPTION_MODEL_MESSAGE })
    const speech = await t.request(TRANSCRIBE, { method: 'POST', body: transcribeForm({ modelRef: 'mock:speech' }) })
    expect(speech.status).toBe(400)
    // The resolver's message (providers/) names the model.
    expect(await errorOf(speech)).toMatchObject({ code: 'validation_error', message: expect.stringContaining('mock:speech') })
  })

  it('maps a provider failure (401 -> 502 auth_invalid)', async () => {
    const failing = new MockTranscriptionModelV4({
      provider: 'mock',
      modelId: 'transcribe',
      doGenerate: async () => {
        throw new APICallError({ message: 'Incorrect API key provided', url: 'https://api.example.com/v1/audio/transcriptions', requestBodyValues: {}, statusCode: 401, isRetryable: false })
      },
    })
    const t = await routeApp({ transcriptionModels: { 'mock:transcribe': failing }, settings: { transcriptionModelRef: 'mock:transcribe' } })
    const response = await t.request(TRANSCRIBE, { method: 'POST', body: transcribeForm() })
    expect(response.status).toBe(502)
    expect(await errorOf(response)).toMatchObject({ code: 'auth_invalid', providerId: 'mock', status: 401, action: 'configure-provider' })
  })

  it('aborts the provider call when the client disconnects', async () => {
    const calls: TranscriptionModelV4CallOptions[] = []
    const hanging = new MockTranscriptionModelV4({
      provider: 'mock',
      modelId: 'transcribe',
      doGenerate: async (options) => {
        calls.push(options)
        return untilAborted(options)
      },
    })
    const t = await routeApp({ transcriptionModels: { 'mock:transcribe': hanging }, settings: { transcriptionModelRef: 'mock:transcribe' } })
    const controller = new AbortController()
    const pending = t.request(TRANSCRIBE, { method: 'POST', body: transcribeForm(), signal: controller.signal })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.abortSignal!.aborted).toBe(false)
    controller.abort()
    const response = await pending
    expect(calls[0]!.abortSignal!.aborted).toBe(true)
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatchObject({ code: 'validation_error', message: CANCELED_MESSAGE })
    expect(await t.db.select().from(usage)).toEqual([])
    expect((await t.deps.providers.get('mock')).lastError).toBeNull()
  })
})

describe('pOST /api/audio/speech', () => {
  it('answers the audio of mock:speech with the allowlisted type, its length, no-store and nosniff', async () => {
    const t = await routeApp()
    const response = await t.request(SPEECH, jsonInit({ text: 'Hello world', modelRef: 'mock:speech' }))
    expect(response.status).toBe(200)
    const body = new Uint8Array(await response.arrayBuffer())
    expect(response.headers.get('content-type')).toBe('audio/wav')
    expect(response.headers.get('content-length')).toBe(String(body.byteLength))
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new TextDecoder().decode(body.subarray(0, 4))).toBe('RIFF')
    expect(readWav(body)).toMatchObject({ riff: 'RIFF', wave: 'WAVE', silent: true })
  })

  it('uses the settings model; the body text of 4096 characters is the limit', async () => {
    const t = await routeApp({ settings: { speechModelRef: 'mock:speech' } })
    const response = await t.request(SPEECH, jsonInit({ text: 'x'.repeat(LIMITS.speechTextMaxChars) }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/wav')
  })

  it.each<[string, unknown]>([
    ['4097 characters', { text: 'x'.repeat(LIMITS.speechTextMaxChars + 1) }],
    ['an empty text', { text: '' }],
    ['a text of spaces', { text: '   ' }],
    ['no text', { modelRef: 'mock:speech' }],
    ['an unknown field', { text: 'Hello world', speed: 1.5 }],
    ['an invalid voice', { text: 'Hello world', voice: 'alloy<script>' }],
    ['an invalid model ref', { text: 'Hello world', modelRef: 'tts' }],
  ])('answers 400 validation_error for %s without calling the service', async (_label, body) => {
    const { t, audio } = await fakeApp()
    const response = await t.request(SPEECH, jsonInit(body))
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('validation_error')
    expect(audio.calls).toEqual([])
  })

  it('refuses a body that is not JSON', async () => {
    const { t, audio } = await fakeApp()
    const response = await t.request(SPEECH, { method: 'POST', body: transcribeForm() })
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatchObject({ code: 'validation_error', message: 'Unsupported Content-Type: send application/json.' })
    expect(audio.calls).toEqual([])
  })

  it('hands the trimmed text, the model and the voice to the service', async () => {
    const { t, audio } = await fakeApp()
    const response = await t.request(SPEECH, jsonInit({ text: '  Hello world ', modelRef: 'mock:speech', voice: 'mock-voice-b' }))
    expect(response.status).toBe(200)
    expect(audio.calls).toEqual([{ member: 'speak', text: 'Hello world', modelRef: 'mock:speech', voice: 'mock-voice-b' }])
  })

  it('refuses a request without a model and a model of another kind', async () => {
    const t = await routeApp()
    const none = await t.request(SPEECH, jsonInit({ text: 'Hello world' }))
    expect(none.status).toBe(400)
    expect(await errorOf(none)).toMatchObject({ code: 'validation_error', message: NO_SPEECH_MODEL_MESSAGE })
    const other = await t.request(SPEECH, jsonInit({ text: 'Hello world', modelRef: 'mock:transcribe' }))
    expect(other.status).toBe(400)
    expect(await errorOf(other)).toMatchObject({ code: 'validation_error', message: expect.stringContaining('mock:transcribe') })
  })

  it('maps a provider failure (429 -> rate_limited with Retry-After)', async () => {
    const failing = new MockSpeechModelV4({
      provider: 'mock',
      modelId: 'speech',
      doGenerate: async () => {
        throw new APICallError({ message: 'Rate limit reached', url: 'https://api.example.com/v1/audio/speech', requestBodyValues: {}, statusCode: 429, responseHeaders: { 'retry-after': '7' }, isRetryable: false })
      },
    })
    const t = await routeApp({ speechModels: { 'mock:speech': failing }, settings: { speechModelRef: 'mock:speech' } })
    const response = await t.request(SPEECH, jsonInit({ text: 'Hello world' }))
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('7')
    expect(await errorOf(response)).toMatchObject({ code: 'rate_limited', providerId: 'mock', retryAfterMs: 7000 })
  })
})

describe('both audio routes', () => {
  it('need a session and pass the Origin check, but need no fresh auth', async () => {
    const t = await routeApp({ env: { HF_PASSWORD: PASSWORD }, settings: { transcriptionModelRef: 'mock:transcribe', speechModelRef: 'mock:speech' } })
    const send = async (path: string, headers: Record<string, string>): Promise<Response> => path === TRANSCRIBE
      ? t.request(path, { method: 'POST', headers, body: transcribeForm() })
      : t.request(path, jsonInit({ text: 'Hello world' }, headers))
    // A session whose password login is an hour old: past the fresh-auth window, still a valid session.
    const stale = { cookie: `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() - 60 * 60 * 1000 })}` }
    for (const path of [TRANSCRIBE, SPEECH]) {
      const anonymous = await send(path, {})
      expect(anonymous.status, path).toBe(401)
      expect((await errorOf(anonymous)).code).toBe('unauthorized')
      const crossSite = await send(path, { ...stale, origin: 'https://evil.example' })
      expect(crossSite.status, path).toBe(403)
      expect((await errorOf(crossSite)).code).toBe('forbidden')
      const ok = await send(path, { ...stale, origin: 'http://127.0.0.1:8787' })
      expect(ok.status, path).toBe(200)
      await ok.arrayBuffer()
    }
  })

  it('write one usage row per call and never log the transcript or the speech text', async () => {
    const t = await routeApp({ settings: { transcriptionModelRef: 'mock:transcribe', speechModelRef: 'mock:speech' } })
    expect((await t.request(TRANSCRIBE, { method: 'POST', body: transcribeForm() })).status).toBe(200)
    const speech = await t.request(SPEECH, jsonInit({ text: SPEECH_TEXT }))
    expect(speech.status).toBe(200)
    await speech.arrayBuffer()
    expect(await t.db.select({ purpose: usage.purpose, chatId: usage.chatId, input: usage.input, output: usage.output, costUsd: usage.costUsd }).from(usage)).toEqual([
      { purpose: 'transcription', chatId: null, input: 0, output: 0, costUsd: null },
      { purpose: 'speech', chatId: null, input: 0, output: 0, costUsd: null },
    ])
    const lines = t.logs.records.filter(record => record.msg === 'audio transcription' || record.msg === 'audio speech')
    expect(lines.map(record => [record.msg, record.level, record.outcome])).toEqual([['audio transcription', 'info', 'ok'], ['audio speech', 'info', 'ok']])
    expect(t.logs.records.filter(record => record.msg === 'request' && String(record.path).startsWith('/api/audio/')).map(record => record.status)).toEqual([200, 200])
    const logs = t.logs.text()
    expect(logs).not.toContain(MOCK_TRANSCRIPT)
    expect(logs).not.toContain(SPEECH_TEXT)
  })
})
