import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeChatRunner, RecordingEventBus } from '../../testing/fakes.ts'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessErrorEnvelopeSchema, listResponseSchema, projectBrowseSchema, projectSummarySchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { chats, projectTrust } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeChatRunner, createRecordingEventBus } from '../../testing/fakes.ts'
import { FRESH_AUTH_REQUIRED_MESSAGE } from '../middleware/fresh-auth.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'

const PASSWORD = 'correct horse battery staple'
const CHAT_A = '0199a8f0-0000-7000-8000-0000000000a1'
const CHAT_B = '0199a8f0-0000-7000-8000-0000000000a2'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

interface Harness {
  t: TestApp
  events: RecordingEventBus
  runs: FakeChatRunner
  /** Realpath of the default root `<dataDir>/workspaces`. */
  root: string
  /** A session cookie within the fresh-auth window. */
  fresh: string
  /** A session cookie older than the fresh-auth window. */
  stale: string
}

async function open(options: { dataDir?: string, workspaceRoots?: string[] } = {}): Promise<Harness> {
  const events = createRecordingEventBus()
  const runs = createFakeChatRunner()
  const t = await createTestApp({ env: { HF_PASSWORD: PASSWORD }, overrides: { events, runs }, ...options })
  cleanups.push(() => t.close())
  const cookie = async (ageMs: number) => `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() - ageMs })}`
  const [root] = await t.deps.projects.roots()
  return { t, events, runs, root: root!, fresh: await cookie(60_000), stale: await cookie(FRESH_AUTH_WINDOW_MS + 60_000) }
}

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface JsonResponse { status: number, body: unknown }

async function send(h: Harness, method: string, path: string, options: { body?: unknown, cookie?: string | null } = {}): Promise<JsonResponse> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined)
    headers['content-type'] = 'application/json'
  const cookie = options.cookie === undefined ? h.stale : options.cookie
  if (cookie !== null)
    headers.cookie = cookie
  const response = await h.t.request(path, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

function errorOf(response: JsonResponse) {
  return harnessErrorEnvelopeSchema.parse(response.body).error
}

function browseUrl(path?: string): string {
  return path === undefined ? '/api/projects/browse' : `/api/projects/browse?path=${encodeURIComponent(path)}`
}

describe('projects routes: create', () => {
  it('needs fresh auth when a password is set: 403 with a stale session, 201 with a fresh one', async () => {
    const h = await open()
    const body = { name: 'Demo', path: h.root, newFolder: 'demo' }
    expect((await send(h, 'POST', '/api/projects', { body, cookie: null })).status).toBe(401)
    const stale = await send(h, 'POST', '/api/projects', { body })
    expect(stale.status).toBe(403)
    expect(errorOf(stale)).toEqual({ code: 'forbidden', message: FRESH_AUTH_REQUIRED_MESSAGE, action: 'login' })
    expect(existsSync(join(h.root, 'demo'))).toBe(false)

    const created = await send(h, 'POST', '/api/projects', { body, cookie: h.fresh })
    expect(created.status).toBe(201)
    const project = projectSummarySchema.parse(created.body)
    expect(project).toMatchObject({ name: 'Demo', path: join(h.root, 'demo'), available: true, chatCount: 0 })
    expect(existsSync(project.path)).toBe(true)
    expect(h.events.ofType('project.changed').map(event => event.data)).toEqual([{ id: project.id, project }])
  })

  it('the same folder again is 409 exists; a new folder that exists is 409 and stays untouched', async () => {
    const h = await open()
    const first = projectSummarySchema.parse((await send(h, 'POST', '/api/projects', { body: { name: 'Demo', path: h.root, newFolder: 'demo' }, cookie: h.fresh })).body)
    await writeFile(join(first.path, 'keep.txt'), 'kept')
    const samePath = await send(h, 'POST', '/api/projects', { body: { name: 'Again', path: first.path }, cookie: h.fresh })
    expect(samePath.status).toBe(409)
    expect(errorOf(samePath)).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    const sameFolder = await send(h, 'POST', '/api/projects', { body: { name: 'Again', path: h.root, newFolder: 'demo' }, cookie: h.fresh })
    expect(sameFolder.status).toBe(409)
    expect(errorOf(sameFolder)).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect(await readFile(join(first.path, 'keep.txt'), 'utf8')).toBe('kept')

    // The folder was removed on disk while the project still uses its path: the folder this request creates is
    // removed again.
    await rm(first.path, { recursive: true })
    const recreated = await send(h, 'POST', '/api/projects', { body: { name: 'Again', path: h.root, newFolder: 'demo' }, cookie: h.fresh })
    expect(recreated.status).toBe(409)
    expect(existsSync(first.path)).toBe(false)
  })

  it('outside the roots and inside the data dir are 400 on path; a missing folder is 404; bodies are validated', async () => {
    const h = await open()
    const outside = await tempFolder()
    for (const path of [outside, '/etc', h.t.env.paths.files, h.t.env.dataDir]) {
      const refused = await send(h, 'POST', '/api/projects', { body: { name: 'Bad', path }, cookie: h.fresh })
      expect(refused.status, path).toBe(400)
      expect(errorOf(refused)).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
    }
    const missing = await send(h, 'POST', '/api/projects', { body: { name: 'Missing', path: join(h.root, 'missing') }, cookie: h.fresh })
    expect(missing.status).toBe(404)
    expect(errorOf(missing).code).toBe('not_found')
    for (const body of [{ name: 'x' }, { name: '', path: h.root }, { name: 'x', path: h.root, newFolder: '.hidden' }, { name: 'x', path: h.root, extra: 1 }]) {
      const invalid = await send(h, 'POST', '/api/projects', { body, cookie: h.fresh })
      expect(invalid.status, JSON.stringify(body)).toBe(400)
    }
    expect(h.events.ofType('project.changed')).toEqual([])
  })

  it('a root that contains the data dir: the data dir and the folders around it are refused', async () => {
    const parent = await tempFolder()
    const dataDir = join(parent, 'data')
    await mkdir(dataDir)
    const h = await open({ dataDir, workspaceRoots: [parent] })
    const refused = await send(h, 'POST', '/api/projects', { body: { name: 'Parent', path: parent }, cookie: h.fresh })
    expect(refused.status).toBe(400)
    expect(errorOf(refused).message).toBe('This folder contains the harness-forge data directory.')
    expect((await send(h, 'POST', '/api/projects', { body: { name: 'Code', path: parent, newFolder: 'code' }, cookie: h.fresh })).status).toBe(201)
  })
})

describe('projects routes: list, update, remove', () => {
  it('lists with a stale session; updates name and instructions; 404 for unknown ids; 400 for bad params and bodies', async () => {
    const h = await open()
    const project = projectSummarySchema.parse((await send(h, 'POST', '/api/projects', { body: { name: 'Demo', path: h.root, newFolder: 'demo' }, cookie: h.fresh })).body)
    await h.t.db.insert(chats).values([{ id: CHAT_A, projectId: project.id }, { id: CHAT_B, projectId: null }])

    const list = await send(h, 'GET', '/api/projects')
    expect(list.status).toBe(200)
    expect(listResponseSchema(projectSummarySchema).parse(list.body).items).toEqual([{ ...project, chatCount: 1 }])

    const updated = await send(h, 'PATCH', `/api/projects/${project.id}`, { body: { name: 'Renamed', instructions: 'Be brief.' } })
    expect(updated.status).toBe(200)
    expect(projectSummarySchema.parse(updated.body)).toMatchObject({ id: project.id, name: 'Renamed', instructions: 'Be brief.', path: project.path, chatCount: 1 })
    expect((await send(h, 'PATCH', `/api/projects/${project.id}`, { body: { instructions: null } })).body).toMatchObject({ instructions: null })

    expect((await send(h, 'PATCH', '/api/projects/prj_BBBBBBBBBBBBBBBB', { body: { name: 'x' } })).status).toBe(404)
    expect((await send(h, 'PATCH', '/api/projects/not-an-id', { body: { name: 'x' } })).status).toBe(400)
    expect((await send(h, 'PATCH', `/api/projects/${project.id}`, { body: {} })).status).toBe(400)
    expect((await send(h, 'PATCH', `/api/projects/${project.id}`, { body: { path: '/elsewhere' } })).status).toBe(400)
    expect((await send(h, 'GET', '/api/projects', { cookie: null })).status).toBe(401)
  })

  it('delete: 409 run-active during a run; then 204, chats detached, the folder kept, one event; 404 after', async () => {
    const h = await open()
    const project = projectSummarySchema.parse((await send(h, 'POST', '/api/projects', { body: { name: 'Demo', path: h.root, newFolder: 'demo' }, cookie: h.fresh })).body)
    await writeFile(join(project.path, 'keep.txt'), 'kept')
    await h.t.db.insert(chats).values([{ id: CHAT_A, projectId: project.id }, { id: CHAT_B, projectId: project.id }])

    h.runs.phases.set(CHAT_A, 'streaming')
    const busy = await send(h, 'DELETE', `/api/projects/${project.id}`)
    expect(busy.status).toBe(409)
    expect(errorOf(busy)).toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId: CHAT_A } })
    h.runs.phases.delete(CHAT_A)

    h.events.clear()
    const removed = await h.t.request(`/api/projects/${project.id}`, { method: 'DELETE', headers: { cookie: h.stale } })
    expect(removed.status).toBe(204)
    expect(await removed.text()).toBe('')
    expect(h.events.events.map(event => [event.type, event.data])).toEqual([['project.changed', { id: project.id, project: null }]])
    const rows = await h.t.db.select({ id: chats.id, projectId: chats.projectId }).from(chats)
    expect(rows.every(row => row.projectId === null)).toBe(true)
    expect(await readFile(join(project.path, 'keep.txt'), 'utf8')).toBe('kept')
    expect((await send(h, 'DELETE', `/api/projects/${project.id}`)).status).toBe(404)
    expect(listResponseSchema(projectSummarySchema).parse((await send(h, 'GET', '/api/projects')).body).items).toEqual([])
  })
})

describe('projects routes: output style and trust cascade (Phase 11)', () => {
  it('pATCH { outputStyle } round-trips through GET /projects with a stale session; unknown names accepted, null clears, bad names 400', async () => {
    const h = await open()
    const project = projectSummarySchema.parse((await send(h, 'POST', '/api/projects', { body: { name: 'Demo', path: h.root, newFolder: 'demo' }, cookie: h.fresh })).body)
    expect(project.outputStyle).toBeNull()

    const styled = await send(h, 'PATCH', `/api/projects/${project.id}`, { body: { outputStyle: 'explanatory' } })
    expect(styled.status).toBe(200)
    expect(projectSummarySchema.parse(styled.body)).toMatchObject({ id: project.id, outputStyle: 'explanatory' })
    const listed = listResponseSchema(projectSummarySchema).parse((await send(h, 'GET', '/api/projects')).body).items
    expect(listed.map(item => [item.id, item.outputStyle])).toEqual([[project.id, 'explanatory']])

    expect((await send(h, 'PATCH', `/api/projects/${project.id}`, { body: { outputStyle: 'my-team-style' } })).body).toMatchObject({ outputStyle: 'my-team-style' })
    expect((await send(h, 'PATCH', `/api/projects/${project.id}`, { body: { instructions: 'Be brief.' } })).body).toMatchObject({ outputStyle: 'my-team-style', instructions: 'Be brief.' })
    expect((await send(h, 'PATCH', `/api/projects/${project.id}`, { body: { outputStyle: null } })).body).toMatchObject({ outputStyle: null })

    for (const outputStyle of ['Explanatory', '', 42, 'a b'])
      expect((await send(h, 'PATCH', `/api/projects/${project.id}`, { body: { outputStyle } })).status).toBe(400)
    expect((await send(h, 'PATCH', '/api/projects/prj_BBBBBBBBBBBBBBBB', { body: { outputStyle: 'learning' } })).status).toBe(404)
  })

  it('delete removes the trust approvals of the project with it (foreign key cascade) and emits project.changed { project: null }', async () => {
    const h = await open()
    const project = projectSummarySchema.parse((await send(h, 'POST', '/api/projects', { body: { name: 'Demo', path: h.root, newFolder: 'demo' }, cookie: h.fresh })).body)
    const other = projectSummarySchema.parse((await send(h, 'POST', '/api/projects', { body: { name: 'Other', path: h.root, newFolder: 'other' }, cookie: h.fresh })).body)
    const at = Date.now()
    await h.t.db.insert(projectTrust).values([
      { projectId: project.id, sha256: 'c'.repeat(64), kind: 'command', label: 'status', createdAt: at },
      { projectId: other.id, sha256: 'd'.repeat(64), kind: 'mcp', label: 'docs', createdAt: at },
    ])
    h.events.clear()
    expect((await h.t.request(`/api/projects/${project.id}`, { method: 'DELETE', headers: { cookie: h.stale } })).status).toBe(204)
    expect(h.events.events.map(event => [event.type, event.data])).toEqual([['project.changed', { id: project.id, project: null }]])
    expect(await h.t.db.select({ projectId: projectTrust.projectId, sha256: projectTrust.sha256 }).from(projectTrust)).toEqual([{ projectId: other.id, sha256: 'd'.repeat(64) }])
  })
})

describe('projects routes: browse', () => {
  it('without a path the roots; a folder lists its subfolders; /etc, the data dir and missing folders are refused', async () => {
    const h = await open()
    const roots = await send(h, 'GET', browseUrl())
    expect(roots.status).toBe(200)
    expect(projectBrowseSchema.parse(roots.body)).toEqual({ path: null, parent: null, roots: [{ path: h.root, available: true }], entries: [], truncated: false })

    await mkdir(join(h.root, 'apps', 'web'), { recursive: true })
    await mkdir(join(h.root, 'apps', '.cache'))
    const project = projectSummarySchema.parse((await send(h, 'POST', '/api/projects', { body: { name: 'Web', path: join(h.root, 'apps', 'web') }, cookie: h.fresh })).body)
    const apps = await send(h, 'GET', browseUrl(join(h.root, 'apps')))
    expect(apps.status).toBe(200)
    expect(projectBrowseSchema.parse(apps.body)).toEqual({
      path: join(h.root, 'apps'),
      parent: h.root,
      roots: [{ path: h.root, available: true }],
      entries: [{ name: 'web', path: project.path, projectId: project.id }],
      truncated: false,
    })

    for (const path of ['/etc', h.t.env.dataDir, h.t.env.paths.files]) {
      const refused = await send(h, 'GET', browseUrl(path))
      expect(refused.status, path).toBe(400)
      expect(errorOf(refused)).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
    }
    expect((await send(h, 'GET', browseUrl(join(h.root, 'missing')))).status).toBe(404)
    expect((await send(h, 'GET', '/api/projects/browse?path=')).status).toBe(400)
  })
})
