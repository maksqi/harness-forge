import type { FileRef } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { fileRefSchema, harnessErrorEnvelopeSchema, LIMITS } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PDF, PNG, SVG, TEXT } from '../../services/files/fixtures.test-util.ts'
import { createTestApp } from '../../testing/create-test-app.ts'

let t: TestApp

beforeAll(async () => {
  t = await createTestApp({ start: false })
})

afterAll(async () => {
  await t.close()
})

function form(...entries: [string, Blob | string, string?][]): FormData {
  const body = new FormData()
  for (const [key, value, name] of entries) {
    if (typeof value === 'string')
      body.append(key, value)
    else
      body.append(key, value, name)
  }
  return body
}

async function upload(body: FormData | string, headers: Record<string, string> = {}): Promise<Response> {
  return t.request('/api/files', { method: 'POST', body, headers })
}

async function uploaded(bytes: Uint8Array, name: string, type: string): Promise<FileRef> {
  const response = await upload(form(['file', new Blob([bytes], { type }), name]))
  expect(response.status).toBe(201)
  return fileRefSchema.parse(await response.json())
}

async function errorOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

describe('pOST /api/files', () => {
  it('answers 201 with a FileRef', async () => {
    const ref = await uploaded(PNG, 'photo.png', 'image/png')
    expect(ref).toMatchObject({ name: 'photo.png', mime: 'image/png', size: PNG.byteLength, url: `/api/files/${ref.id}` })
  })

  it.each([
    ['no multipart body', () => upload(JSON.stringify({ file: 'x' }), { 'content-type': 'application/json' })],
    ['a missing file part', () => upload(form(['other', new Blob([TEXT], { type: 'text/plain' }), 'a.txt']))],
    ['two files', () => upload(form(['file', new Blob([TEXT], { type: 'text/plain' }), 'a.txt'], ['file', new Blob([TEXT], { type: 'text/plain' }), 'b.txt']))],
    ['an extra field', () => upload(form(['file', new Blob([TEXT], { type: 'text/plain' }), 'a.txt'], ['note', 'hello']))],
    ['a text field named file', () => upload(form(['file', 'not a file']))],
    ['a disallowed type', () => upload(form(['file', new Blob([TEXT], { type: 'application/zip' }), 'archive.zip']))],
    ['a mismatched type', () => upload(form(['file', new Blob([TEXT], { type: 'image/png' }), 'fake.png']))],
  ])('answers 400 validation_error for %s', async (_label, send) => {
    const response = await send()
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('validation_error')
  })

  it('answers 413 payload_too_large over 20 MB', async () => {
    const response = await upload(form(['file', new Blob([new Uint8Array(LIMITS.uploadBytes + 1)], { type: 'text/plain' }), 'big.txt']))
    expect(response.status).toBe(413)
    const error = await errorOf(response)
    expect(error.code).toBe('payload_too_large')
    expect((error.details as { limitBytes: number }).limitBytes).toBeGreaterThanOrEqual(LIMITS.uploadBytes)
  })
})

describe('gET /api/files/:id', () => {
  it('serves a raster image inline with safe headers', async () => {
    const ref = await uploaded(PNG, 'photo.png', 'image/png')
    const response = await t.request(ref.url)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
    const headers = response.headers
    expect(headers.get('content-type')).toBe('image/png')
    expect(headers.get('content-length')).toBe(String(PNG.byteLength))
    expect(headers.get('etag')).toMatch(/^"[\da-f]{64}"$/)
    expect(headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
    expect(headers.get('content-security-policy')).toBe('default-src \'none\'; style-src \'unsafe-inline\'; sandbox')
    expect(headers.get('content-disposition')).toBe('inline; filename="photo.png"; filename*=UTF-8\'\'photo.png')
  })

  it('serves PDF inline without the sandbox, SVG and text as attachments', async () => {
    const pdf = await t.request((await uploaded(PDF, 'doc.pdf', 'application/pdf')).url)
    expect(pdf.headers.get('content-disposition')).toMatch(/^inline;/)
    expect(pdf.headers.get('content-security-policy')).toBe('default-src \'none\'; style-src \'unsafe-inline\'')
    await pdf.arrayBuffer()
    const svg = await t.request((await uploaded(SVG, 'logo.svg', 'image/svg+xml')).url)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(svg.headers.get('content-security-policy')).toContain('sandbox')
    await svg.arrayBuffer()
    const text = await t.request((await uploaded(TEXT, 'notes.txt', 'text/plain')).url)
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(text.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(await text.text()).toBe('hello world\n')
  })

  it('answers 304 when the ETag matches and HEAD without a body', async () => {
    const ref = await uploaded(TEXT, 'etag.txt', 'text/plain')
    const first = await t.request(ref.url)
    const etag = first.headers.get('etag')!
    await first.arrayBuffer()
    const cached = await t.request(ref.url, { headers: { 'if-none-match': `W/"x", ${etag}` } })
    expect(cached.status).toBe(304)
    expect(cached.headers.get('etag')).toBe(etag)
    const head = await t.request(ref.url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(TEXT.byteLength))
    expect(await head.text()).toBe('')
  })

  it('answers 404 for an unknown id', async () => {
    const response = await t.request('/api/files/file_0000000000000000')
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('not_found')
  })

  it.each([
    '/api/files/..%2f..%2fsecret.key',
    '/api/files/file_..%2F..%2F..%2Fx',
    '/api/files/%2e%2e',
    '/api/files/file_abc',
    '/api/files/FILE_0000000000000000',
  ])('rejects the malformed id %s without touching the filesystem', async (path) => {
    const response = await t.request(path)
    expect([400, 404]).toContain(response.status)
    const error = await errorOf(response)
    expect(['validation_error', 'not_found']).toContain(error.code)
  })
})
