// Project definition file routes (API.md 5.36, Phase 12 W12.4): read, write and remove through HTTP with a session that
// is not fresh (no fresh auth), the answers parse with the shared schemas, the error envelopes (400 path / kind /
// diagnostics, 404, 409 stale), 204 on delete, and `workspace.changed { source: 'user' }`.
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  harnessErrorEnvelopeSchema,
  projectDefinitionFileSchema,
  projectDefinitionWriteResultSchema,
} from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'
import { stubRouteKeys } from '../validate.ts'

const PASSWORD = 'correct horse battery staple'
const UNKNOWN = 'prj_ZZZZZZZZZZZZZZZZ'
const AGENT = '---\nname: reviewer\ndescription: Reviews code.\n---\nReview carefully.\n'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

interface Harness {
  t: TestApp
  events: RecordingEventBus
  projectId: string
  root: string
  stale: string
}

async function setup(): Promise<Harness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const events = createRecordingEventBus()
  const t = await createTestApp({ env: { HF_PASSWORD: PASSWORD }, builtins: [], workspaceRoots: [base], overrides: { events } })
  cleanups.push(() => t.close())
  const project = await t.deps.projects.create({ name: 'Demo', path: base, newFolder: 'demo' })
  const stale = `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() - FRESH_AUTH_WINDOW_MS - 60_000 })}`
  events.clear()
  return { t, events, projectId: project.id, root: join(base, 'demo'), stale }
}

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function fileUrl(projectId: string, query: Record<string, string>): string {
  return `/api/projects/${projectId}/definitions/file?${new URLSearchParams(query).toString()}`
}

async function send(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number, body: unknown }> {
  const headers: Record<string, string> = { cookie: h.stale }
  if (body !== undefined)
    headers['content-type'] = 'application/json'
  const response = await h.t.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

function errorOf(response: { body: unknown }) {
  return harnessErrorEnvelopeSchema.parse(response.body).error
}

describe('project definition routes', () => {
  it('are real routes (no 501 stub)', () => {
    for (const key of ['projectDefinitions.read', 'projectDefinitions.write', 'projectDefinitions.remove'] as const)
      expect(stubRouteKeys().has(key), key).toBe(false)
  })

  it('create, read, update and delete an agent with a session that is not fresh', async () => {
    const h = await setup()
    const path = '.claude/agents/reviewer.md'
    const missing = await send(h, 'GET', fileUrl(h.projectId, { path }))
    expect(missing.status).toBe(200)
    expect(projectDefinitionFileSchema.parse(missing.body)).toEqual({ path, kind: 'agent', exists: false, content: null, sha256: null, diagnostics: [] })

    const created = await send(h, 'PUT', `/api/projects/${h.projectId}/definitions/file`, { path, expectedSha256: null, content: AGENT })
    expect(created.status).toBe(200)
    expect(projectDefinitionWriteResultSchema.parse(created.body)).toEqual({ path, sha256: sha(AGENT), created: true, diagnostics: [], trust: { pending: 0 } })
    expect(await readFile(join(h.root, path), 'utf8')).toBe(AGENT)

    const read = await send(h, 'GET', fileUrl(h.projectId, { path }))
    expect(projectDefinitionFileSchema.parse(read.body)).toMatchObject({ exists: true, content: AGENT, sha256: sha(AGENT) })

    const stale = await send(h, 'PUT', `/api/projects/${h.projectId}/definitions/file`, { path, expectedSha256: null, content: AGENT })
    expect(stale.status).toBe(409)
    expect(errorOf(stale)).toMatchObject({ code: 'conflict', message: 'The file changed on disk. Load it again or overwrite it.', details: { reason: 'stale' } })

    const staleDelete = await send(h, 'DELETE', fileUrl(h.projectId, { path, expectedSha256: sha('other') }))
    expect(staleDelete.status).toBe(409)
    expect(errorOf(staleDelete).details).toEqual({ reason: 'stale' })

    const removed = await h.t.request(fileUrl(h.projectId, { path, expectedSha256: sha(AGENT) }), { method: 'DELETE', headers: { cookie: h.stale } })
    expect(removed.status).toBe(204)
    expect(existsSync(join(h.root, path))).toBe(false)
    const gone = await send(h, 'DELETE', fileUrl(h.projectId, { path, expectedSha256: sha(AGENT) }))
    expect(gone.status).toBe(404)

    expect(h.events.ofType('workspace.changed').map(event => event.data)).toEqual([
      { projectId: h.projectId, chatId: null, batchId: null, source: 'user', paths: [path] },
      { projectId: h.projectId, chatId: null, batchId: null, source: 'user', paths: [path] },
    ])
  })

  it('a settings hook save answers the pending count; parser errors are 400 with details.diagnostics', async () => {
    const h = await setup()
    await mkdir(join(h.root, '.claude'), { recursive: true })
    const original = JSON.stringify({ permissions: { deny: ['Read(.env)'] } })
    await writeFile(join(h.root, '.claude', 'settings.json'), original)
    const saved = await send(h, 'PUT', `/api/projects/${h.projectId}/definitions/file`, {
      path: '.claude/settings.json',
      expectedSha256: sha(original),
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
    })
    expect(saved.status).toBe(200)
    expect(projectDefinitionWriteResultSchema.parse(saved.body).trust.pending).toBe(1)
    expect(Object.keys(JSON.parse(await readFile(join(h.root, '.claude', 'settings.json'), 'utf8')) as object)).toEqual(['permissions', 'hooks'])

    const invalid = await send(h, 'PUT', `/api/projects/${h.projectId}/definitions/file`, { path: '.claude/agents/bad.md', expectedSha256: null, content: 'No frontmatter.' })
    expect(invalid.status).toBe(400)
    expect(errorOf(invalid)).toMatchObject({ code: 'validation_error', message: 'Add a description.', details: { diagnostics: [{ level: 'error', code: 'missing-field' }] } })
  })

  it('400 for a path outside the editable set, a field of another kind and deleting a settings file; 404 for an unknown project', async () => {
    const h = await setup()
    for (const path of ['.env', '.git/config', '../x.md', '.claude/agents/../../x.md', 'README.md']) {
      const response = await send(h, 'GET', fileUrl(h.projectId, { path }))
      expect(response.status, path).toBe(400)
      expect(errorOf(response).code).toBe('validation_error')
    }
    const mismatch = await send(h, 'PUT', `/api/projects/${h.projectId}/definitions/file`, { path: '.claude/agents/a.md', expectedSha256: null, hooks: {} })
    expect(mismatch.status).toBe(400)
    const settingsDelete = await send(h, 'DELETE', fileUrl(h.projectId, { path: '.claude/settings.json', expectedSha256: sha('{}') }))
    expect(settingsDelete.status).toBe(400)

    const unknown = await send(h, 'GET', fileUrl(UNKNOWN, { path: '.claude/agents/a.md' }))
    expect(unknown.status).toBe(404)
    const unknownWrite = await send(h, 'PUT', `/api/projects/${UNKNOWN}/definitions/file`, { path: '.mcp.json', expectedSha256: null, mcpServers: {} })
    expect(unknownWrite.status).toBe(404)
    expect(h.events.ofType('workspace.changed')).toEqual([])
  })
})
