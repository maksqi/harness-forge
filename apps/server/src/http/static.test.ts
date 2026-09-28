// SPA serving (W1.1-T9): files, caching, the `200.html` fallback for deep links, the SPA CSP with inline-script hashes
// (W1.1-T7), unknown `/api/*` stays JSON, no traversal outside the root (SEC-F1). Fixture: a temp `HF_WEB_DIR`; the last
// block checks the real web build (W5.7-T5).
import type { TestApp } from '../testing/create-test-app.ts'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { harnessErrorEnvelopeSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { webPublicDir } from '../paths.ts'
import { inlineScriptHashes, SECURITY_HEADERS } from '../security/headers.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createMemorySecretStore, createMemorySettingsService } from '../testing/fakes.ts'
import { createStaticSite, IMMUTABLE_CACHE_CONTROL, safePathSegments, SPA_FALLBACK_FILE, SVG_CSP } from './static.ts'

const COLOR_MODE = '"use strict";(()=>{const e=document.documentElement;e.classList.add(localStorage.getItem("hf-color-mode")||"dark")})();'
const NUXT_CONFIG = 'window.__NUXT__={};window.__NUXT__.config={public:{},app:{baseURL:"/"}}'
const SECRET = 'TOP-SECRET-OUTSIDE-THE-WEB-ROOT'
const CHAT_PATH = '/chat/0199a8f0-0000-7000-8000-000000000001'

function html(title: string, extraScript = ''): string {
  return `<!DOCTYPE html><html><head><title>${title}</title><script type="importmap">{"imports":{}}</script>`
    + `<script type="module" src="/_nuxt/app.js" crossorigin></script><script>${COLOR_MODE}</script>${extraScript}</head>`
    + `<body><div id="__nuxt"></div><script>${NUXT_CONFIG}</script></body></html>`
}

function hash(text: string): string {
  return `'sha256-${createHash('sha256').update(text).digest('base64')}'`
}

let base: string
let webDir: string
let t: TestApp

function write(relative: string, content: string): void {
  const file = join(webDir, relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'harness-forge-static-'))
  webDir = join(base, 'web', '.output', 'public')
  mkdirSync(webDir, { recursive: true })
  writeFileSync(join(base, 'web', '.output', 'nitro.json'), JSON.stringify({ framework: { name: 'nuxt', version: '4.5.2' } }))
  mkdirSync(join(base, 'outside'))
  writeFileSync(join(base, 'outside', 'secret.txt'), SECRET)
  write('index.html', html('index'))
  write('200.html', html('spa'))
  write('_nuxt/app.js', 'console.log("app")\n')
  write('_nuxt/builds/latest.json', '{"id":"build-1"}')
  write('_nuxt/builds/meta/build-1.json', '{"id":"build-1"}')
  write('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  write('robots.txt', 'User-agent: *\n')
  write('.hidden.txt', SECRET)
  write('docs/index.html', html('docs'))
  mkdirSync(join(webDir, 'empty-dir'))
  write('listing-dir/file-a.txt', 'a')
  symlinkSync(join(base, 'outside', 'secret.txt'), join(webDir, 'link-out.txt'))
  symlinkSync(join(base, 'outside'), join(webDir, 'link-dir'))
  symlinkSync(join(webDir, 'robots.txt'), join(webDir, 'link-in.txt'))

  t = await createTestApp({
    env: { HF_WEB_DIR: webDir },
    start: false,
    overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() },
  })
})

afterAll(async () => {
  await t.close()
  rmSync(base, { recursive: true, force: true })
})

function get(path: string, headers: Record<string, string> = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, method = 'GET'): Promise<Response> {
  return t.request(path, { method, headers })
}

describe('files', () => {
  it('gET / serves index.html with no-cache and the SPA CSP', async () => {
    const response = await get('/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(await response.text()).toContain('<title>index</title>')
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain(`script-src 'self' 'wasm-unsafe-eval' ${hash('{"imports":{}}')} ${hash(COLOR_MODE)} ${hash(NUXT_CONFIG)};`)
    expect(csp).toContain('frame-ancestors \'none\'')
    expect(csp).not.toContain('\'unsafe-eval\'')
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      expect(response.headers.get(name), name).toBe(value)
  })

  it('/_nuxt/* assets are immutable, except the build manifest', async () => {
    const asset = await get('/_nuxt/app.js', { accept: '*/*' })
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(asset.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL)
    expect(asset.headers.get('content-length')).toBe(String('console.log("app")\n'.length))
    expect(asset.headers.get('content-security-policy')).toBeNull()
    expect(await asset.text()).toBe('console.log("app")\n')
    expect((await get('/_nuxt/builds/meta/build-1.json')).headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL)
    expect((await get('/_nuxt/builds/latest.json')).headers.get('cache-control')).toBe('no-cache')
  })

  it('other files revalidate; SVG documents get a sandboxing CSP', async () => {
    const robots = await get('/robots.txt', { accept: '*/*' })
    expect(robots.headers.get('cache-control')).toBe('no-cache')
    expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const svg = await get('/favicon.svg', { accept: 'image/*' })
    expect(svg.headers.get('content-type')).toContain('image/svg+xml')
    expect(svg.headers.get('content-security-policy')).toBe(SVG_CSP)
  })

  it('answers If-None-Match with 304 and HEAD without a body', async () => {
    const first = await get('/_nuxt/app.js')
    const etag = first.headers.get('etag') ?? ''
    expect(etag).toMatch(/^W\/".+"$/)
    const cached = await get('/_nuxt/app.js', { 'if-none-match': etag })
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')
    const head = await get('/_nuxt/app.js', { accept: '*/*' }, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(first.headers.get('content-length'))
    expect(await head.text()).toBe('')
  })

  it('serves a directory index and symlinks that stay inside the root', async () => {
    expect(await (await get('/docs/')).text()).toContain('<title>docs</title>')
    expect(await (await get('/link-in.txt', { accept: '*/*' })).text()).toBe('User-agent: *\n')
  })
})

describe('sPA fallback', () => {
  it('a deep link loads 200.html (production deep links no longer 404)', async () => {
    const response = await get(CHAT_PATH)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(await response.text()).toContain('<title>spa</title>')
    expect(response.headers.get('content-security-policy')).toContain(hash(COLOR_MODE))
  })

  it.each([
    ['a browser navigation', { accept: 'text/html' }],
    ['curl (*/*)', { accept: '*/*' }],
    ['no Accept header', {}],
  ])('serves the SPA to %s without a file extension', async (_name, headers: Record<string, string>) => {
    const response = await get('/settings/providers', headers)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>spa</title>')
  })

  it('hEAD of a deep link answers the headers only', async () => {
    const response = await get(CHAT_PATH, { accept: 'text/html' }, 'HEAD')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toBe('')
  })

  it.each([
    ['a missing asset', '/_nuxt/missing.js', { accept: '*/*' }],
    ['a missing asset even for HTML', '/_nuxt/missing.js', { accept: 'text/html' }],
    ['a missing image', '/missing.png', { accept: 'image/avif,image/webp,*/*' }],
    ['a JSON request', '/settings', { accept: 'application/json' }],
  ])('404 for %s', async (_name, path, headers: Record<string, string>) => {
    const response = await get(path, headers)
    expect(response.status).toBe(404)
    expect(harnessErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('not_found')
  })

  it.each(['/api/nope', '/api', '/api/chats/not-a-chat/unknown'])('unknown API path %s stays a JSON 404 envelope', async (path) => {
    const response = await get(path)
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(harnessErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('not_found')
  })

  it('applies only after every route: a route registered later still answers', async () => {
    const app = await createTestApp({ env: { HF_WEB_DIR: webDir }, start: false })
    try {
      app.app.get('/registered-later', c => c.text('late route'))
      for (const headers of [{ accept: 'text/html' }, {}] as Record<string, string>[]) {
        const response = await app.request('/registered-later', { headers })
        expect(await response.text()).toBe('late route')
      }
      expect(await (await app.request('/not-registered', { headers: { accept: 'text/html' } })).text()).toContain('<title>')
    }
    finally {
      await app.close()
    }
  })

  it('only GET and HEAD are served', async () => {
    expect((await t.request('/', { method: 'POST' })).status).toBe(404)
    expect((await t.request(CHAT_PATH, { method: 'DELETE' })).status).toBe(404)
  })

  it('recomputes the CSP when the HTML changes (a rebuild without restart)', async () => {
    const script = 'console.log("rebuilt")'
    write('200.html', html('rebuilt', `<script>${script}</script>`))
    const later = new Date(Date.now() + 5000)
    utimesSync(join(webDir, '200.html'), later, later)
    const response = await get(CHAT_PATH)
    expect(await response.text()).toContain('<title>rebuilt</title>')
    expect(response.headers.get('content-security-policy')).toContain(hash(script))
  })
})

describe('path safety', () => {
  it.each([
    '/..%2f..%2foutside%2fsecret.txt',
    '/%2e%2e/%2e%2e/outside/secret.txt',
    '/..%5c..%5coutside%5csecret.txt',
    '/%252e%252e/outside/secret.txt',
    '/_nuxt/..%2f..%2f..%2foutside%2fsecret.txt',
    '/docs/../../outside/secret.txt',
    '//outside/secret.txt',
    '/link-out.txt',
    '/link-dir/secret.txt',
    '/.hidden.txt',
    '/%2ehidden.txt',
    '/robots.txt%00.html',
    '/%E0%A4%A',
  ])('%s never leaves the root', async (path) => {
    for (const accept of ['*/*', 'text/html', 'application/json']) {
      const response = await get(path, { accept })
      const text = await response.text()
      expect(text, `${path} (${accept})`).not.toContain(SECRET)
      expect([200, 404], `${path} (${accept})`).toContain(response.status)
      if (response.status === 200)
        expect(text).toContain('<title>')
    }
  })

  it('safePathSegments refuses unsafe segments', () => {
    expect(safePathSegments('/a/b%20c/d.js')).toEqual(['a', 'b c', 'd.js'])
    expect(safePathSegments('//a///b/')).toEqual(['a', 'b'])
    for (const path of ['/..', '/a/%2e%2e', '/a%2fb', '/a%5cb', '/a%00', '/.env', '/%', '/a/%0Ab'])
      expect(safePathSegments(path), path).toBeNull()
  })

  it('a directory is never listed', async () => {
    for (const path of ['/listing-dir', '/listing-dir/', '/empty-dir/']) {
      for (const accept of ['*/*', 'text/html', 'application/json']) {
        const response = await get(path, { accept })
        const text = await response.text()
        expect(text, `${path} (${accept})`).not.toContain('file-a.txt')
        // Either the SPA shell (a navigation) or a 404 envelope.
        expect(text.includes('<title>') || response.status === 404, `${path} (${accept})`).toBe(true)
      }
    }
  })
})

describe('without a build', () => {
  it('serves nothing until the directory exists, then picks it up', async () => {
    const dir = join(base, 'later')
    const app = await createTestApp({
      env: { HF_WEB_DIR: dir },
      start: false,
      overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() },
    })
    try {
      const missing = await app.request(CHAT_PATH, { headers: { accept: 'text/html' } })
      expect(missing.status).toBe(404)
      expect(harnessErrorEnvelopeSchema.parse(await missing.json()).error.code).toBe('not_found')
      mkdirSync(dir)
      writeFileSync(join(dir, '200.html'), html('late build'))
      const served = await app.request(CHAT_PATH, { headers: { accept: 'text/html' } })
      expect(await served.text()).toContain('<title>late build</title>')
    }
    finally {
      await app.close()
    }
  })
})

describe('health', () => {
  it('reports the Nuxt version of the served build', async () => {
    const response = await t.request('/api/health')
    expect(await response.json()).toMatchObject({ versions: { nuxt: '4.5.2' } })
  })
})

// Skipped without a web build, unless `HF_TEST_REQUIRE_WEB_BUILD=1` (CI after `pnpm build`, the gates): then a missing
// build fails the test instead of skipping it silently (S3).
describe('the built SPA (apps/web/.output/public, when a build exists or HF_TEST_REQUIRE_WEB_BUILD=1)', () => {
  const built = join(webPublicDir(), SPA_FALLBACK_FILE)
  const requireBuild = process.env.HF_TEST_REQUIRE_WEB_BUILD === '1'

  it.skipIf(!existsSync(built) && !requireBuild)('sEC-C1: the CSP of the real 200.html allows exactly its inline scripts, nothing inline-executable', async () => {
    expect(existsSync(built), `${built} is missing: run pnpm build first (HF_TEST_REQUIRE_WEB_BUILD=1 requires the web build)`).toBe(true)
    const response = await createStaticSite(webPublicDir()).fallback(new Request('http://127.0.0.1:8787/chat/x', { headers: { accept: 'text/html' } }))
    expect(response?.status).toBe(200)
    const document = await response!.text()
    const csp = response!.headers.get('content-security-policy') ?? ''
    const directives = new Map(csp.split('; ').map((directive) => {
      const [name = '', ...values] = directive.split(' ')
      return [name, values] as const
    }))
    // Hashes regenerated from the served file: one per inline script, and no way to run other inline code.
    const scriptSources = directives.get('script-src') ?? []
    for (const hashSource of inlineScriptHashes(document))
      expect(scriptSources).toContain(`'${hashSource}'`)
    expect(scriptSources.filter(source => source.startsWith('\'sha256-'))).toHaveLength(inlineScriptHashes(document).length)
    expect(scriptSources).not.toContain('\'unsafe-inline\'')
    expect(scriptSources).not.toContain('\'unsafe-eval\'')
    expect(scriptSources).not.toContain('\'unsafe-hashes\'')
    for (const [name, value] of [['default-src', '\'self\''], ['object-src', '\'none\''], ['base-uri', '\'none\''], ['frame-ancestors', '\'none\'']] as const)
      expect(directives.get(name), name).toEqual([value])
    // Inline event handlers and javascript: URLs would be blocked by this CSP: the build must not rely on them.
    expect(document).not.toMatch(/\son[a-z]+\s*=/i)
    expect(document).not.toMatch(/javascript:/i)
    // Every external script and stylesheet is same-origin.
    for (const [, url] of document.matchAll(/<(?:script|link)\b[^>]*\s(?:src|href)="([^"]*)"/gi))
      expect(url, url).toMatch(/^\/(?!\/)/)
  })
})
