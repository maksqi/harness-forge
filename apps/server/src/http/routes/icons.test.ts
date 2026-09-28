import type { TestApp } from '../../testing/create-test-app.ts'
import { harnessErrorEnvelopeSchema, lobeIconListSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIconService } from '../../providers/icons.ts'
import { createTestApp } from '../../testing/create-test-app.ts'

let t: TestApp

beforeAll(async () => {
  t = await createTestApp({ factories: { icons: createIconService } })
})

afterAll(async () => {
  await t.close()
})

async function envelope(response: Response): Promise<{ code: string, message: string }> {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

describe('gET /api/icons/lobe', () => {
  it('lists the slugs with a one-day cache', async () => {
    const response = await t.request('/api/icons/lobe')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
    const list = lobeIconListSchema.parse(await response.json())
    expect(list.items.length).toBeGreaterThan(100)
    expect(list.items).toContainEqual({ slug: 'claude', hasColor: true })
    expect(list.version).toBe(t.deps.icons.version)
  })
})

describe('gET /api/icons/lobe/:slug', () => {
  it('serves an svg with immutable caching, nosniff and a restrictive CSP', async () => {
    const response = await t.request(`/api/icons/lobe/claude-color?v=${t.deps.icons.version}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe('default-src \'none\'; style-src \'unsafe-inline\'')
    expect(await response.text()).toMatch(/^<svg[\s>]/)
  })

  it('answers HEAD requests with the svg headers', async () => {
    const response = await t.request('/api/icons/lobe/claude-color', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(await response.text()).toBe('')
  })

  it('answers 404 not_found for an unknown slug', async () => {
    const response = await t.request('/api/icons/lobe/no-such-icon')
    expect(response.status).toBe(404)
    expect((await envelope(response)).code).toBe('not_found')
  })

  it.each([
    // `%2e%2e` is a dot segment for the URL parser: `/api/icons` is not a route.
    ['%2e%2e', 404, 'not_found'],
    ['%2e%2e%2fpackage.json', 400, 'validation_error'],
    ['..%2Fpackage.json', 400, 'validation_error'],
    ['..%2F..%2F..%2Fpackage.json', 400, 'validation_error'],
    ['claude.svg', 400, 'validation_error'],
    ['CLAUDE', 400, 'validation_error'],
    [`${'a'.repeat(65)}`, 400, 'validation_error'],
  ])('answers %s with %i %s and never serves another file', async (slug, status, code) => {
    const response = await t.request(`/api/icons/lobe/${slug}`)
    expect(response.status).toBe(status)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect((await envelope(response)).code).toBe(code)
  })

  it('never resolves dot segments to files outside the route', async () => {
    for (const path of ['/api/icons/lobe/../../package.json', '/api/icons/lobe/./claude/../../x']) {
      const response = await t.request(path)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.text()).not.toContain('"name"')
    }
  })

  it('is public when a password is set', async () => {
    const secured = await createTestApp({ env: { HF_PASSWORD: 'correct horse battery staple' }, factories: { icons: createIconService } })
    try {
      expect((await secured.request('/api/icons/lobe')).status).toBe(200)
      expect((await secured.request('/api/icons/lobe/openai')).status).toBe(200)
    }
    finally {
      await secured.close()
    }
  })
})
