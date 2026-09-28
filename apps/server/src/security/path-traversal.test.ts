// SEC-F1: every path that comes from a request stays inside its root. One fuzz table of encodings (`..`, encoded and
// double-encoded separators and dots, backslashes, absolute paths, drive letters, NUL, overlong UTF-8) plus symbolic
// links that point outside, against the plugin file API (read, write, delete), the plugin icon, file downloads, LobeHub
// slugs and the static SPA files; export and download file names never break out of `Content-Disposition`.
import type { PluginTestApp } from '../plugins/__fixtures__/harness.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createChatId } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPluginTestApp, manifest, removeTempDirs, tempDir } from '../plugins/__fixtures__/harness.ts'
import { createTestApp } from '../testing/create-test-app.ts'

const SECRET = 'TOP-SECRET-OUTSIDE-THE-ROOT'

/** Encodings of "../../<target>" and friends; `%%` is replaced by the target file name. */
const TRAVERSALS = [
  '..%2f..%2f%%',
  '..%2F..%2F%%',
  '%2e%2e%2f%2e%2e%2f%%',
  '%2E%2E%2F%2E%2E%2F%%',
  '.%2e%2f.%2e%2f%%',
  '%252e%252e%252f%252e%252e%252f%%',
  '..%252f..%252f%%',
  '%25252e%25252e%25252f%%',
  '..%5c..%5c%%',
  '..%5C..%5C%%',
  '%5c%5c%%',
  '%2f%%',
  '%2F%2F%%',
  'C%3a%5c%%',
  'C:%2f%%',
  '%%%00.md',
  '%00..%2f..%2f%%',
  '%c0%ae%c0%ae%c0%af%c0%ae%c0%ae%c0%af%%',
  '..%c0%af..%c0%af%%',
  '..%ef%bc%8f..%ef%bc%8f%%',
  '%e2%80%ae..%2f%%',
]

function payloads(target: string): string[] {
  return TRAVERSALS.map(pattern => pattern.replace('%%', encodeURIComponent(target)))
}

async function bodyOf(response: Response): Promise<string> {
  return Buffer.from(await response.arrayBuffer()).toString('latin1')
}

describe('plugin files and plugin icon', () => {
  let h: PluginTestApp
  let dataRoot: string
  let outside: string

  beforeAll(async () => {
    h = await createPluginTestApp()
    dataRoot = h.dataDir
    outside = join(dataRoot, 'outside.txt')
    writeFileSync(outside, SECRET)
    writeFileSync(join(dataRoot, 'outside.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><title>${SECRET}</title></svg>`)
    await h.install({ id: 'walled', files: { 'plugin.json': manifest('walled'), 'notes.md': 'inside\n' }, enabled: true })
    const dir = h.pluginDir('walled')
    symlinkSync(dataRoot, join(dir, 'up'))
    symlinkSync(outside, join(dir, 'leak.txt'))
    await h.t.deps.plugins.load('walled')
    // A valid icon at install time, swapped for a link to a file outside the plugin afterwards (checked at serve time).
    await h.install({ id: 'icon-escape', files: { 'plugin.json': manifest('icon-escape', { icon: 'icon.svg' }), 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' }, enabled: true })
    await h.t.deps.plugins.load('icon-escape')
    rmSync(join(h.pluginDir('icon-escape'), 'icon.svg'))
    symlinkSync(join(dataRoot, 'outside.svg'), join(h.pluginDir('icon-escape'), 'icon.svg'))
  })

  afterAll(async () => {
    await h.close()
    removeTempDirs()
  })

  it('the plugin works for paths inside it (control)', async () => {
    const response = await h.t.request('/api/plugins/walled/files/notes.md')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('inside')
  })

  it.each([...payloads('outside.txt'), 'up/outside.txt', 'up%2foutside.txt', 'leak.txt', 'up/plugins/walled/notes.md'])('read, write and delete refuse %s', async (payload) => {
    const path = `/api/plugins/walled/files/${payload}`
    const read = await h.t.request(path)
    expect(read.status, `GET ${payload}`).toBeGreaterThanOrEqual(400)
    expect(read.status, `GET ${payload}`).toBeLessThan(500)
    expect(await bodyOf(read)).not.toContain(SECRET)

    const write = await h.t.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'pwned\n' }) })
    expect(write.status, `PUT ${payload}`).toBeGreaterThanOrEqual(400)
    expect(write.status, `PUT ${payload}`).toBeLessThan(500)
    const remove = await h.t.request(path, { method: 'DELETE' })
    expect(remove.status, `DELETE ${payload}`).toBeGreaterThanOrEqual(400)
    expect(remove.status, `DELETE ${payload}`).toBeLessThan(500)

    expect(readFileSync(outside, 'utf8')).toBe(SECRET)
  })

  it('a write through a linked folder never creates a file outside the plugin', async () => {
    for (const payload of ['up/pwned.txt', 'up%2fpwned.txt', '..%2fpwned.txt', '..%2f..%2fpwned.txt']) {
      const write = await h.t.request(`/api/plugins/walled/files/${payload}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'pwned\n' }) })
      expect(write.status, payload).toBeGreaterThanOrEqual(400)
    }
    expect(existsSync(join(dataRoot, 'pwned.txt'))).toBe(false)
    expect(existsSync(join(dataRoot, 'plugins', 'pwned.txt'))).toBe(false)
  })

  it('the file tree lists links without following them', async () => {
    const response = await h.t.request('/api/plugins/walled/files')
    expect(await bodyOf(response)).not.toContain('outside.txt')
  })

  it('an icon that is a link to a file outside the plugin is never served', async () => {
    const response = await h.t.request('/api/plugins/icon-escape/icon')
    expect(response.status).toBe(404)
    expect(await bodyOf(response)).not.toContain(SECRET)
  })

  it('a plugin whose manifest icon points outside is refused at inspection', async () => {
    const dir = join(h.dataDir, 'staged-icon')
    mkdirSync(dir)
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest('staged-icon', { icon: 'icon.svg' })))
    symlinkSync(join(dataRoot, 'outside.svg'), join(dir, 'icon.svg'))
    await expect(h.t.deps.plugins.inspectDirectory(dir)).rejects.toMatchObject({ message: expect.stringContaining('points outside the plugin directory') })
  })
})

describe('file downloads, LobeHub slugs and static files', () => {
  let t: TestApp
  let root: string
  let webDir: string

  beforeAll(async () => {
    root = tempDir('hf-traversal-')
    webDir = join(root, 'web')
    mkdirSync(join(webDir, '_nuxt'), { recursive: true })
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>spa</title><script>window.x=1</script>')
    writeFileSync(join(webDir, '200.html'), '<!doctype html><title>spa</title><script>window.x=1</script>')
    writeFileSync(join(webDir, '_nuxt', 'app.js'), 'console.log(1)\n')
    writeFileSync(join(root, 'outside.txt'), SECRET)
    writeFileSync(join(webDir, '.env'), `SECRET=${SECRET}`)
    symlinkSync(join(root, 'outside.txt'), join(webDir, 'leak.txt'))
    symlinkSync(root, join(webDir, 'up'))
    t = await createTestApp({ env: { HF_WEB_DIR: webDir }, start: false })
  })

  afterAll(async () => {
    await t.close()
    removeTempDirs()
  })

  it.each([...payloads('outside.txt'), 'leak.txt', 'up/outside.txt', '.env', '%2eenv', '_nuxt/..%2f..%2foutside.txt', '_nuxt%2f..%2f..%2foutside.txt'])('static files refuse /%s', async (payload) => {
    for (const accept of ['*/*', 'text/html']) {
      const response = await t.request(`/${payload}`, { headers: { accept } })
      const body = await bodyOf(response)
      expect(body, payload).not.toContain(SECRET)
      // Either nothing, or the SPA document for a navigation.
      if (response.status === 200)
        expect(body).toContain('<title>spa</title>')
      else
        expect(response.status).toBe(404)
    }
  })

  it('the static root still serves its own files (control)', async () => {
    expect((await t.request('/_nuxt/app.js')).status).toBe(200)
  })

  it.each([...payloads('package.json'), ...payloads('etc/passwd'), 'openai%00', 'openai.svg%2f..%2f..%2fpackage.json'])('lobeHub slug %s', async (payload) => {
    const response = await t.request(`/api/icons/lobe/${payload}`)
    expect([400, 404], payload).toContain(response.status)
    const body = await bodyOf(response)
    expect(body).not.toContain('"version"')
    expect(body).not.toContain('root:')
  })

  it.each([...payloads('harness.db'), 'file_..%2f..%2f..%2f..', `file_${'a'.repeat(16)}%2f..`])('file download %s', async (payload) => {
    const response = await t.request(`/api/files/${payload}`)
    expect([400, 404], payload).toContain(response.status)
    expect(await bodyOf(response)).not.toContain('SQLite format')
  })

  it('download and export file names cannot break out of Content-Disposition', async () => {
    const hostile = '..\\../evil"; filename=x.sh\r\nX-Injected: 1\u0000.txt'
    const form = new FormData()
    form.append('file', new File(['notes'], hostile, { type: 'text/plain' }))
    const upload = await t.request('/api/files', { method: 'POST', body: form })
    expect(upload.status).toBe(201)
    const { url } = await upload.json() as { url: string }
    const download = await t.request(url)
    const disposition = download.headers.get('content-disposition') ?? ''
    expect(download.headers.get('x-injected')).toBeNull()
    expect(disposition).not.toMatch(/[\r\n\0]/)
    expect(disposition).toMatch(/^attachment; filename="[^"/\\]*"; filename\*=UTF-8''[\w.%-]*$/)

    const chatId = createChatId()
    expect((await t.request('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: chatId, title: '../../etc/"passwd"; x=y' }) })).status).toBe(201)
    for (const format of ['md', 'json']) {
      const exported = await t.request(`/api/chats/${chatId}/export?format=${format}`)
      expect(exported.status).toBe(200)
      expect(exported.headers.get('content-disposition')).toMatch(/^attachment; filename="[^"/\\]*"; filename\*=UTF-8''[\w.%-]*$/)
    }
  })

  it('the test fixture outside the roots is intact', () => {
    expect(readFileSync(join(dirname(webDir), 'outside.txt'), 'utf8')).toBe(SECRET)
  })
})
