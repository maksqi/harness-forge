// Request body gate: size limits per route (`payload_too_large`, `details.limitBytes`) and JSON-only content types
// for JSON routes (SEC-B3).
import type { AddressInfo } from 'node:net'
import type { TestApp } from '../../testing/create-test-app.ts'
import { Buffer } from 'node:buffer'
import http from 'node:http'
import process from 'node:process'
import { apiRoutes, HarnessError, harnessErrorEnvelopeSchema, LIMITS } from '@harness-forge/shared'
import { serve } from '@hono/node-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createMemorySecretStore, createMemorySettingsService } from '../../testing/fakes.ts'
import { bodyLimitFor, checkBodyContentType } from './body-limit.ts'
import { SESSION_COOKIE_NAME } from './session-auth.ts'

const PASSWORD = 'a password 123'
let t: TestApp

beforeAll(async () => {
  t = await createTestApp({
    env: { HF_PASSWORD: PASSWORD },
    start: false,
    overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() },
  })
})

afterAll(async () => {
  await t.close()
})

async function errorOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

function streamOf(bytes: number): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) {
        controller.close()
        return
      }
      const size = Math.min(64 * 1024, bytes - sent)
      controller.enqueue(new Uint8Array(size).fill(0x61))
      sent += size
    },
  })
}

describe('limits by route', () => {
  it('uses the documented limits of LIMITS', () => {
    expect(bodyLimitFor('chat.send').limitBytes).toBe(LIMITS.chatBodyBytes)
    expect(bodyLimitFor('files.upload').limitBytes).toBe(LIMITS.uploadBytes)
    expect(bodyLimitFor('files.upload').maxBytes).toBeGreaterThan(LIMITS.uploadBytes)
    expect(bodyLimitFor('pluginInstall.install').limitBytes).toBe(LIMITS.pluginZipBytes)
    expect(bodyLimitFor('pluginInstall.inspect').limitBytes).toBe(LIMITS.pluginZipBytes)
    expect(bodyLimitFor('pluginFiles.write').limitBytes).toBe(LIMITS.pluginFileBytes)
    expect(bodyLimitFor('pluginFiles.write').maxBytes).toBeGreaterThan(2 * LIMITS.pluginFileBytes)
    expect(bodyLimitFor('settings.update')).toEqual({ maxBytes: LIMITS.jsonBodyBytes, limitBytes: LIMITS.jsonBodyBytes })
    expect(bodyLimitFor(undefined).limitBytes).toBe(LIMITS.jsonBodyBytes)
  })

  it('a declared Content-Length over the limit -> 413 before the body is read', async () => {
    const body = 'x'.repeat(LIMITS.jsonBodyBytes + 1)
    const response = await t.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      body,
    })
    expect(response.status).toBe(413)
    expect(await errorOf(response)).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.jsonBodyBytes } })
  })

  it('a streamed body of unknown length is counted -> 413', async () => {
    const response = await t.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: streamOf(LIMITS.jsonBodyBytes + 10),
      duplex: 'half',
    } as RequestInit)
    expect(response.status).toBe(413)
    expect((await errorOf(response)).details).toEqual({ limitBytes: LIMITS.jsonBodyBytes })
  })

  it('a streamed body under the limit is replayed to the route', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ password: PASSWORD }))
    const response = await t.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoded.slice(0, 5))
          controller.enqueue(encoded.slice(5))
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit)
    expect(response.status).toBe(200)
  })

  it('a streamed multipart upload over the limit -> 413, and the abandoned FormData stream never rejects', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(LIMITS.pluginZipBytes + 128 * 1024)]), 'big.zip')
      const cookie = `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() })}`
      // An in-process FormData body has no Content-Length header: it is counted while it streams.
      const response = await t.request('/api/plugins/install', { method: 'POST', headers: { cookie }, body: form })
      expect(response.status).toBe(413)
      expect((await errorOf(response)).details).toEqual({ limitBytes: LIMITS.pluginZipBytes })
      // undici pumps the rest of the form into the released stream; a cancelled one would reject here.
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(rejections).toEqual([])
    }
    finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('an oversized chunked upload over a real socket still receives the 413 answer', async () => {
    const server = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' })
    try {
      await new Promise(resolve => server.once('listening', resolve))
      const { port } = server.address() as AddressInfo
      const cookie = `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() })}`
      const answer = await new Promise<{ status: number | undefined, body: string }>((resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: '/api/settings',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked', cookie },
        }, (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            body += chunk
          })
          response.on('end', () => resolve({ status: response.statusCode, body }))
        })
        request.on('error', reject)
        const chunk = Buffer.alloc(64 * 1024, 0x61)
        let sent = 0
        const pump = (): void => {
          while (sent < 4 * LIMITS.jsonBodyBytes) {
            sent += chunk.length
            if (!request.write(chunk)) {
              request.once('drain', pump)
              return
            }
          }
          request.end()
        }
        pump()
      })
      expect(answer.status).toBe(413)
      expect(harnessErrorEnvelopeSchema.parse(JSON.parse(answer.body)).error.code).toBe('payload_too_large')
    }
    finally {
      if ('closeAllConnections' in server)
        server.closeAllConnections()
      server.close()
    }
  })

  it('a body that fails while it is read -> 400 validation_error, not an internal error', async () => {
    const cookie = `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() })}`
    let pulls = 0
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1)
          controller.enqueue(new TextEncoder().encode('{"displayName":'))
        else
          controller.error(new Error('client aborted'))
      },
    })
    const response = await t.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: broken,
      duplex: 'half',
    } as RequestInit)
    expect(response.status).toBe(400)
    expect((await errorOf(response)).details).toEqual({ issues: [expect.objectContaining({ code: 'body_unreadable' })] })
  })

  it('checks authentication first: an anonymous large body is never read', async () => {
    const response = await t.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: streamOf(10 * LIMITS.jsonBodyBytes),
      duplex: 'half',
    } as RequestInit)
    expect(response.status).toBe(401)
  })
})

describe('content types', () => {
  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', ''])('a JSON route rejects %j', async (contentType) => {
    const headers: Record<string, string> = contentType === '' ? {} : { 'content-type': contentType }
    const response = await t.request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ password: PASSWORD }) })
    expect(response.status).toBe(400)
    const error = await errorOf(response)
    expect(error.code).toBe('validation_error')
    expect(error.details).toEqual({ issues: [expect.objectContaining({ code: 'invalid_content_type', path: [] })] })
  })

  it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON'])('a JSON route accepts %j', async (contentType) => {
    const response = await t.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(response.status).toBe(200)
  })

  it('an empty body is not checked (the route validates it)', async () => {
    const response = await t.request('/api/auth/login', { method: 'POST' })
    expect(response.status).toBe(400)
    const error = await errorOf(response)
    expect(error.details).not.toEqual({ issues: [expect.objectContaining({ code: 'invalid_content_type' })] })
  })

  it('routes without a body schema ignore bodies', async () => {
    const response = await t.request('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' })
    expect(response.status).toBe(204)
  })

  it('multipart routes accept multipart; routes with body and form accept both', () => {
    expect(() => checkBodyContentType('multipart/form-data; boundary=abc', apiRoutes['files.upload'])).not.toThrow()
    expect(() => checkBodyContentType('application/json', apiRoutes['files.upload'])).toThrow(HarnessError)
    expect(() => checkBodyContentType('application/x-www-form-urlencoded', apiRoutes['files.upload'])).toThrow(/multipart\/form-data/)
    expect(() => checkBodyContentType('multipart/form-data; boundary=abc', apiRoutes['pluginInstall.install'])).not.toThrow()
    expect(() => checkBodyContentType('application/json', apiRoutes['pluginInstall.install'])).not.toThrow()
    expect(() => checkBodyContentType('text/plain', apiRoutes['pluginInstall.install'])).toThrow(HarnessError)
    expect(() => checkBodyContentType('application/merge-patch+json', apiRoutes['settings.update'])).not.toThrow()
    expect(() => checkBodyContentType(undefined, apiRoutes['auth.logout'])).not.toThrow()
  })
})
