import type { TestApp } from '../../testing/create-test-app.ts'
import { DEFAULT_SETTINGS, HarnessError, harnessErrorEnvelopeSchema, settingsSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_EPOCH_KEY } from '../../services/settings/types.ts'
import { createTestApp } from '../../testing/create-test-app.ts'

let t: TestApp

beforeEach(async () => {
  t = await createTestApp({ builtins: [], start: false })
})

afterEach(async () => {
  await t.close()
})

function put(body: unknown): Promise<Response> {
  return t.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('reading settings (GET /api/settings)', () => {
  it('answers every key with defaults applied', async () => {
    const response = await t.request('/api/settings')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body: unknown = await response.json()
    expect(settingsSchema.strict().parse(body)).toEqual(DEFAULT_SETTINGS)
  })

  it('never exposes internal keys', async () => {
    await t.deps.settings.setInternal(SESSION_EPOCH_KEY, 7)
    const body = await (await t.request('/api/settings')).json() as Record<string, unknown>
    expect(Object.keys(body).some(key => key.startsWith('_'))).toBe(false)
    expect(JSON.stringify(body)).not.toContain('sessionEpoch')
  })
})

describe('updating settings (PUT /api/settings)', () => {
  it('applies a partial update and answers the full settings', async () => {
    const updated = await t.client.settings.update({ body: { sendKey: 'mod-enter', textSize: 'lg', showThinking: true } })
    expect(updated).toEqual({ ...DEFAULT_SETTINGS, sendKey: 'mod-enter', textSize: 'lg', showThinking: true })
    expect(await t.client.settings.get()).toEqual(updated)

    const again = await t.client.settings.update({ body: { textSize: 'sm' } })
    expect(again).toMatchObject({ sendKey: 'mod-enter', textSize: 'sm', showThinking: true })
  })

  it('validates model refs for format only', async () => {
    const response = await put({ defaultModelRef: 'ollama:llama3:8b', titleModelRef: null })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ defaultModelRef: 'ollama:llama3:8b', titleModelRef: null })
  })

  it.each([
    ['a bad value', { maxSteps: 0 }, ['maxSteps']],
    ['a bad model ref', { defaultModelRef: 'not-a-ref' }, ['defaultModelRef']],
    ['an unknown key', { theme: 'light' }, []],
    ['an empty body', {}, []],
    ['instructions over 20000 characters', { instructions: 'x'.repeat(20_001) }, ['instructions']],
  ])('answers 400 validation_error for %s', async (_label, body, path) => {
    const response = await put(body)
    expect(response.status).toBe(400)
    const envelope = harnessErrorEnvelopeSchema.parse(await response.json())
    expect(envelope.error.code).toBe('validation_error')
    expect(envelope.error.details).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path })]) })
    expect(await t.client.settings.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('rejects a body that is not JSON', async () => {
    const response = await t.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"maxSteps":' })
    expect(response.status).toBe(400)
  })

  it('throws a typed HarnessError through the client', async () => {
    const error = await t.client.settings.update({ body: { maxSteps: 1000 } }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HarnessError)
    expect((error as HarnessError).code).toBe('validation_error')
  })
})
