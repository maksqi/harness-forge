// Project file mention routes (W9.6-T2, T3; API.md 5.27): search (ranking, limit, 400 / 404, an unavailable folder) and
// attach (201 `FileRef` served by `GET /files/:id`; `../x`, absolute paths, links out of the root, `.git`, secret-looking
// paths and folders 400; > 5 MiB 413; a binary blob is the upload's 400; missing 404) through the real services, in
// `realpath(mkdtemp())` workspace roots. A session is required, fresh auth is not (`security/fresh-auth-routes.test.ts`).
import type { ProjectSummary } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileRefSchema, harnessErrorEnvelopeSchema, LIMITS, projectFileSearchSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { files } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'

const UNKNOWN = 'prj_ZZZZZZZZZZZZZZZZ'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function write(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content)
  }
}

interface Harness {
  t: TestApp
  project: ProjectSummary
  /** The project folder (canonical). */
  dir: string
}

const FILES: Record<string, string> = {
  'checkpoint.txt': 'checkpoint\n',
  'notes.txt': 'notes\n',
  'src/app.ts': 'export const app = 1\n',
  'docs/guide.md': '# Guide\n',
  '.gitignore': 'dist/\n',
  'dist/out.js': 'ignored\n',
  'node_modules/pkg/index.js': 'ignored\n',
  '.git/config': '[core]\n',
  '.env': 'TOKEN=secret\n',
  'config/.env.local': 'TOKEN=secret\n',
}

async function open(): Promise<Harness> {
  const root = await tempFolder()
  const t = await createTestApp({ builtins: [], workspaceRoots: [root] })
  cleanups.push(() => t.close())
  const project = await t.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })
  const dir = join(root, 'demo')
  await write(dir, FILES)
  return { t, project, dir }
}

interface JsonResponse { status: number, body: unknown }

async function send(t: TestApp, method: string, path: string, body?: unknown): Promise<JsonResponse> {
  const response = await t.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

function envelope(response: JsonResponse) {
  return harnessErrorEnvelopeSchema.parse(response.body).error
}

function searchUrl(projectId: string, query: Record<string, string> = {}): string {
  const params = new URLSearchParams(query).toString()
  return `/api/projects/${projectId}/files${params === '' ? '' : `?${params}`}`
}

async function attach(h: Harness, path: string, projectId = h.project.id): Promise<JsonResponse> {
  return send(h.t, 'POST', `/api/projects/${projectId}/files/attach`, { path })
}

describe('gET /projects/:id/files', () => {
  it('ranks with rankPaths (?q=chk puts checkpoint.txt first) and applies the limit; ignored and secret paths are never listed', async () => {
    const h = await open()
    const ranked = await send(h.t, 'GET', searchUrl(h.project.id, { q: 'chk' }))
    expect(ranked.status).toBe(200)
    const result = projectFileSearchSchema.parse(ranked.body)
    expect(result.items[0]).toEqual({ path: 'checkpoint.txt', kind: 'file' })
    expect(result.truncated).toBe(false)
    expect(result.indexedAt).toBeGreaterThan(0)

    const all = projectFileSearchSchema.parse((await send(h.t, 'GET', searchUrl(h.project.id))).body)
    expect(all.items.map(item => `${item.kind}:${item.path}`).sort()).toEqual([
      'dir:docs',
      'dir:src',
      'file:.gitignore',
      'file:checkpoint.txt',
      'file:docs/guide.md',
      'file:notes.txt',
      'file:src/app.ts',
    ])
    const limited = projectFileSearchSchema.parse((await send(h.t, 'GET', searchUrl(h.project.id, { q: 't', limit: '2' }))).body)
    expect(limited.items).toHaveLength(2)
    // The same index answered every search.
    expect(new Set([result.indexedAt, all.indexedAt, limited.indexedAt]).size).toBe(1)

    // The typed client agrees with the route.
    const client = await h.t.client.projectFiles.search({ params: { id: h.project.id }, query: { q: 'guide' } })
    expect(client.items[0]).toEqual({ path: 'docs/guide.md', kind: 'file' })
  })

  it('finds a file written later once workspace.changed of the project arrives', async () => {
    const h = await open()
    expect(projectFileSearchSchema.parse((await send(h.t, 'GET', searchUrl(h.project.id, { q: 'fresh' }))).body).items).toEqual([])
    await write(h.dir, { 'fresh.txt': 'new\n' })
    h.t.deps.events.emit('workspace.changed', { projectId: h.project.id, chatId: null, batchId: null, source: 'tool', paths: ['fresh.txt'] })
    expect(projectFileSearchSchema.parse((await send(h.t, 'GET', searchUrl(h.project.id, { q: 'fresh' }))).body).items).toEqual([{ path: 'fresh.txt', kind: 'file' }])
  })

  it('answers 400 for invalid input before the service, 404 for an unknown project and 400 for an unavailable folder', async () => {
    const h = await open()
    const invalid: Array<Record<string, string>> = [{ limit: '0' }, { limit: '51' }, { limit: 'x' }, { q: 'a'.repeat(LIMITS.mentionQueryMaxChars + 1) }]
    for (const query of invalid) {
      const response = await send(h.t, 'GET', searchUrl(h.project.id, query))
      expect(response.status, JSON.stringify(query)).toBe(400)
      expect(envelope(response).code).toBe('validation_error')
    }
    expect((await send(h.t, 'GET', searchUrl(h.project.id, { q: 'a'.repeat(LIMITS.mentionQueryMaxChars) }))).status).toBe(200)
    expect((await send(h.t, 'GET', searchUrl('not-a-project'))).status).toBe(400)

    const unknown = await send(h.t, 'GET', searchUrl(UNKNOWN))
    expect(unknown.status).toBe(404)
    expect(envelope(unknown)).toMatchObject({ code: 'not_found', message: `Project ${UNKNOWN} not found.` })

    await rm(h.dir, { recursive: true, force: true })
    const missing = await send(h.t, 'GET', searchUrl(h.project.id))
    expect(missing.status).toBe(400)
    expect(envelope(missing)).toMatchObject({ code: 'validation_error' })
    expect(envelope(missing).message).toMatch(/^The project folder .+ is not available: /)
  })
})

describe('pOST /projects/:id/files/attach', () => {
  it('stores a snapshot of the file (201 FileRef) that GET /files/:id serves', async () => {
    const h = await open()
    const response = await attach(h, 'src/app.ts')
    expect(response.status).toBe(201)
    const ref = fileRefSchema.parse(response.body)
    expect(ref).toMatchObject({ name: 'app.ts', size: Buffer.byteLength(FILES['src/app.ts']!) })
    expect(ref.mime.startsWith('text/')).toBe(true)
    const served = await h.t.request(ref.url)
    expect(served.status).toBe(200)
    expect(await served.text()).toBe(FILES['src/app.ts'])

    // A snapshot: a later edit does not change the stored file.
    await write(h.dir, { 'src/app.ts': 'changed\n' })
    expect(await (await h.t.request(ref.url)).text()).toBe(FILES['src/app.ts'])

    // Absolute paths inside the project, images and the typed client work too.
    const absolute = await attach(h, join(h.dir, 'notes.txt'))
    expect(absolute.status).toBe(201)
    expect(fileRefSchema.parse(absolute.body).name).toBe('notes.txt')
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a0e2f6b80000000049454e44ae426082', 'hex')
    await write(h.dir, { 'img/dot.png': png })
    const image = await h.t.client.projectFiles.attach({ params: { id: h.project.id }, body: { path: 'img/dot.png' } })
    expect(image).toMatchObject({ name: 'dot.png', mime: 'image/png', size: png.byteLength })
  })

  it.skipIf(process.platform === 'win32')('refuses paths outside the project, links out of it, .git and secret-looking paths and folders (400 on path)', async () => {
    const h = await open()
    const outside = await tempFolder()
    await write(outside, { 'x.txt': 'outside\n' })
    await symlink(join(outside, 'x.txt'), join(h.dir, 'out-link.txt'))
    await symlink(outside, join(h.dir, 'out-folder'))
    await symlink(join(h.dir, '.env'), join(h.dir, 'env-link.txt'))
    await symlink(join(h.dir, '.git', 'config'), join(h.dir, 'git-link.txt'))

    const refused = [
      '../x',
      '../../x.txt',
      join(outside, 'x.txt'),
      'out-link.txt',
      'out-folder/x.txt',
      '.git/config',
      '.GIT/config',
      'src/../.git/config',
      '.env',
      'config/.env.local',
      'env-link.txt',
      'git-link.txt',
      'src',
      '.',
    ]
    for (const path of refused) {
      const response = await attach(h, path)
      expect(response.status, path).toBe(400)
      const error = envelope(response)
      expect(error.code, path).toBe('validation_error')
      expect(error.details, path).toMatchObject({ issues: [{ path: ['path'] }] })
    }
    // Nothing was stored.
    expect(await h.t.db.select().from(files)).toEqual([])
  })

  it('answers 413 above 5 MiB, 404 for a missing file or project, and the upload\'s 400 for a binary blob', async () => {
    const h = await open()
    await write(h.dir, { 'big.txt': Buffer.alloc(LIMITS.mentionFileMaxBytes + 1, 0x61), 'blob.bin': Buffer.from([0, 1, 2, 3, 0xFF, 0xFE, 0, 0]) })
    const big = await attach(h, 'big.txt')
    expect(big.status).toBe(413)
    expect(envelope(big)).toMatchObject({ code: 'payload_too_large', details: { limitBytes: 5_242_880 } })

    await write(h.dir, { 'six.txt': Buffer.alloc(6 * 1024 * 1024, 0x61) })
    expect((await attach(h, 'six.txt')).status).toBe(413)

    const blob = await attach(h, 'blob.bin')
    expect(blob.status).toBe(400)
    expect(envelope(blob).code).toBe('validation_error')

    const missing = await attach(h, 'missing.txt')
    expect(missing.status).toBe(404)
    expect(envelope(missing).code).toBe('not_found')
    expect((await attach(h, 'notes.txt', UNKNOWN)).status).toBe(404)
  })

  it('answers 400 for an invalid body before the service, and for an unavailable folder', async () => {
    const h = await open()
    for (const body of [{}, { path: '' }, { path: 'notes.txt', extra: true }, { path: 'a\u0000b' }, { path: 'x'.repeat(LIMITS.workspacePathMaxChars + 1) }]) {
      const response = await send(h.t, 'POST', `/api/projects/${h.project.id}/files/attach`, body)
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    await rm(h.dir, { recursive: true, force: true })
    const unavailable = await attach(h, 'notes.txt')
    expect(unavailable.status).toBe(400)
    expect(envelope(unavailable).message).toMatch(/^The project folder .+ is not available: /)
  })
})
