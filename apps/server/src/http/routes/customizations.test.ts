// Customization routes (W10.1-T7; API.md 5.28) through the real service and the test database, with project folders in
// `realpath(mkdtemp())` workspace roots: every answer of the six routes (200 / 201 / 204, 400 with the diagnostics,
// 404, 409 `exists` and the per-kind 409), `/customizations/source` before `/customizations/:id`, and the
// `customization.changed` event of every personal change.
import type { CustomizationChangedData, ProjectSummary } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  customizationListSchema,
  customizationSchema,
  customizationSourceResultSchema,
  DEFINITION_LIMITS,
  harnessErrorEnvelopeSchema,
  LIMITS,
} from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { customizations } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'

const UNKNOWN_PROJECT = 'prj_ZZZZZZZZZZZZZZZZ'
const UNKNOWN_ID = 'cus_ZZZZZZZZZZZZZZZZ'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content)
  }
}

interface Harness {
  t: TestApp
  project: ProjectSummary
  dir: string
  events: CustomizationChangedData[]
}

async function open(): Promise<Harness> {
  const root = await tempFolder()
  const t = await createTestApp({ builtins: [], workspaceRoots: [root] })
  cleanups.push(() => t.close())
  const project = await t.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })
  const events: CustomizationChangedData[] = []
  const subscription = t.deps.events.subscribe((event) => {
    if (event.type === 'customization.changed')
      events.push(event.data)
  })
  cleanups.push(() => subscription.dispose())
  return { t, project, dir: join(root, 'demo'), events }
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

const AGENT = '---\nname: reviewer\ndescription: Reviews diffs.\n---\nReview the diff.\n'

describe('gET /customizations', () => {
  it('answers the global catalog and a project catalog (kind filter, refresh); 404 unknown project; 400 bad query', async () => {
    const h = await open()
    await write(h.dir, { '.claude/agents/a.md': AGENT.replace('reviewer', 'a'), '.harness/agents/a.md': AGENT.replace('reviewer', 'a').replace('Reviews', 'Wins') })
    const global = await send(h.t, 'GET', '/api/customizations')
    expect(global.status).toBe(200)
    const list = customizationListSchema.parse(global.body)
    expect(list.project).toBeNull()
    expect(list.items.map(entry => [entry.kind, entry.name, entry.source])).toEqual([['agent', 'explore', 'builtin'], ['agent', 'general', 'builtin']])

    const scoped = await send(h.t, 'GET', `/api/customizations?projectId=${h.project.id}&kind=agent`)
    expect(scoped.status).toBe(200)
    const project = customizationListSchema.parse(scoped.body)
    expect(project.items.filter(entry => entry.name === 'a').map(entry => [entry.path, entry.state])).toEqual([
      ['.harness/agents/a.md', 'active'],
      ['.claude/agents/a.md', 'shadowed'],
    ])
    expect(project.project).toMatchObject({ id: h.project.id, available: true, folders: ['.claude/agents', '.harness/agents'] })
    expect(customizationListSchema.parse((await send(h.t, 'GET', `/api/customizations?projectId=${h.project.id}&kind=skill`)).body).items).toEqual([])

    await write(h.dir, { '.harness/commands/new.md': '---\ndescription: New.\n---\nNew.' })
    const refreshed = customizationListSchema.parse((await send(h.t, 'GET', `/api/customizations?projectId=${h.project.id}&kind=command&refresh=1`)).body)
    expect(refreshed.items.map(entry => entry.name)).toEqual(['new'])

    const unknown = await send(h.t, 'GET', `/api/customizations?projectId=${UNKNOWN_PROJECT}`)
    expect(unknown.status).toBe(404)
    expect(envelope(unknown).code).toBe('not_found')
    expect((await send(h.t, 'GET', '/api/customizations?kind=widget')).status).toBe(400)
    expect((await send(h.t, 'GET', '/api/customizations?projectId=nope')).status).toBe(400)
  })
})

describe('gET /customizations/source', () => {
  it('answers project (winner or path), builtin and plugin markdown; 400 user / missing project; 404 unknown', async () => {
    const h = await open()
    const claude = AGENT.replace('Reviews', 'Claude reviews')
    await write(h.dir, { '.claude/agents/reviewer.md': claude, '.harness/agents/reviewer.md': AGENT })
    const base = `/api/customizations/source?projectId=${h.project.id}&kind=agent&name=reviewer&source=project`
    const winner = await send(h.t, 'GET', base)
    expect(winner.status).toBe(200)
    expect(customizationSourceResultSchema.parse(winner.body)).toEqual({ content: AGENT, path: '.harness/agents/reviewer.md' })
    expect((await send(h.t, 'GET', `${base}&path=${encodeURIComponent('.claude/agents/reviewer.md')}`)).body).toEqual({ content: claude, path: '.claude/agents/reviewer.md' })
    expect((await send(h.t, 'GET', `${base}&path=${encodeURIComponent('AGENTS.md')}`)).status).toBe(404)

    const builtin = await send(h.t, 'GET', '/api/customizations/source?kind=agent&name=general&source=builtin')
    expect(builtin.status).toBe(200)
    expect(customizationSourceResultSchema.parse(builtin.body).content).toMatch(/^---\nname: general\n/)
    h.t.deps.registry.commands.register('acme', { name: 'greet', description: 'Greets.', template: 'Hello {{input}}' })
    expect((await send(h.t, 'GET', '/api/customizations/source?kind=command&name=greet&source=plugin')).body).toEqual({ content: '---\nname: greet\ndescription: Greets.\n---\n\nHello {{input}}\n' })

    const user = await send(h.t, 'GET', '/api/customizations/source?kind=agent&name=reviewer&source=user')
    expect(user.status).toBe(400)
    expect(envelope(user).message).toBe('Read personal definitions with GET /customizations/:id.')
    expect((await send(h.t, 'GET', '/api/customizations/source?kind=agent&name=reviewer&source=project')).status).toBe(400)
    expect((await send(h.t, 'GET', `/api/customizations/source?projectId=${UNKNOWN_PROJECT}&kind=agent&name=reviewer&source=project`)).status).toBe(404)
    expect((await send(h.t, 'GET', `/api/customizations/source?projectId=${h.project.id}&kind=agent&name=nope&source=project`)).status).toBe(404)
    expect((await send(h.t, 'GET', '/api/customizations/source?kind=skill&name=pdf&source=builtin')).status).toBe(404)
    expect((await send(h.t, 'GET', '/api/customizations/source?kind=agent&source=builtin')).status).toBe(400)
  })

  it('is never taken for a customization id (the static segment is registered first)', async () => {
    const h = await open()
    const response = await send(h.t, 'GET', '/api/customizations/source?kind=skill&name=pdf&source=builtin')
    expect(response.status).toBe(404)
    expect(envelope(response).details ?? {}).not.toMatchObject({ issues: [expect.objectContaining({ path: ['id'] })] })
  })
})

describe('personal definitions', () => {
  it('pOST 201 / GET / PATCH / DELETE 204, each write with customization.changed', async () => {
    const h = await open()
    const created = await send(h.t, 'POST', '/api/customizations', { kind: 'agent', content: AGENT })
    expect(created.status).toBe(201)
    const row = customizationSchema.parse(created.body)
    expect(row).toMatchObject({ kind: 'agent', name: 'reviewer', description: 'Reviews diffs.', content: AGENT, enabled: true })
    expect(h.events).toEqual([{ kind: 'agent', id: row.id }])

    const got = await send(h.t, 'GET', `/api/customizations/${row.id}`)
    expect(got.status).toBe(200)
    expect(got.body).toEqual(created.body)

    const toggled = await send(h.t, 'PATCH', `/api/customizations/${row.id}`, { enabled: false })
    expect(toggled.status).toBe(200)
    expect(customizationSchema.parse(toggled.body)).toMatchObject({ enabled: false, content: AGENT })
    const edited = await send(h.t, 'PATCH', `/api/customizations/${row.id}`, { content: AGENT.replace('reviewer', 'critic'), enabled: true })
    expect(customizationSchema.parse(edited.body)).toMatchObject({ name: 'critic', enabled: true })
    const listed = customizationListSchema.parse((await send(h.t, 'GET', '/api/customizations?kind=agent')).body)
    expect(listed.items.find(entry => entry.source === 'user')).toMatchObject({ name: 'critic', id: row.id, state: 'active' })

    const removed = await h.t.request(`/api/customizations/${row.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    expect(await removed.text()).toBe('')
    expect(h.events).toEqual([
      { kind: 'agent', id: row.id },
      { kind: 'agent', id: row.id },
      { kind: 'agent', id: row.id },
      { kind: 'agent', id: row.id },
    ])
    for (const [method, body] of [['GET', undefined], ['PATCH', { enabled: true }], ['DELETE', undefined]] as const) {
      const missing = await send(h.t, method, `/api/customizations/${row.id}`, body)
      expect(missing.status, method).toBe(404)
      expect(envelope(missing).code).toBe('not_found')
    }
  })

  it('pOST answers 400 with the diagnostics, 400 for reserved names and bad bodies, 409 exists and 409 at the cap', async () => {
    const h = await open()
    const invalid = await send(h.t, 'POST', '/api/customizations', { kind: 'command', content: '---\nname: x\n---\n' })
    expect(invalid.status).toBe(400)
    const error = envelope(invalid)
    expect(error.code).toBe('validation_error')
    expect(error.details).toMatchObject({ diagnostics: [{ level: 'error', code: 'missing-field' }], issues: [{ path: ['content'] }] })
    const reserved = await send(h.t, 'POST', '/api/customizations', { kind: 'agent', content: AGENT.replace('reviewer', 'explore') })
    expect(reserved.status).toBe(400)
    expect(envelope(reserved).details).toMatchObject({ diagnostics: [{ code: 'reserved-name' }] })
    for (const body of [
      { kind: 'agent' },
      { kind: 'agent', content: '' },
      { kind: 'widget', content: AGENT },
      { kind: 'agent', content: AGENT, extra: true },
      { kind: 'agent', content: 'x'.repeat(DEFINITION_LIMITS.contentBytes + 1) },
    ])
      expect((await send(h.t, 'POST', '/api/customizations', body)).status, JSON.stringify(body).slice(0, 60)).toBe(400)

    expect((await send(h.t, 'POST', '/api/customizations', { kind: 'agent', content: AGENT, enabled: false })).status).toBe(201)
    const taken = await send(h.t, 'POST', '/api/customizations', { kind: 'agent', content: AGENT })
    expect(taken.status).toBe(409)
    expect(envelope(taken)).toMatchObject({ code: 'conflict', message: 'A personal agent named "reviewer" already exists.', details: { reason: 'exists' } })

    const at = Date.now()
    await h.t.db.insert(customizations).values(Array.from({ length: LIMITS.customizationsPerKindMax }, (_, index) => ({
      id: `cus_${String(index).padStart(16, '0')}`,
      kind: 'command' as const,
      name: `c${index}`,
      description: 'A command.',
      content: `---\nname: c${index}\ndescription: A command.\n---\nDo it.`,
      enabled: true,
      createdAt: at,
      updatedAt: at,
    })))
    const full = await send(h.t, 'POST', '/api/customizations', { kind: 'command', content: '---\nname: last\ndescription: Last.\n---\nNo.' })
    expect(full.status).toBe(409)
    expect(envelope(full).details).toMatchObject({ reason: 'exists' })
  })

  it('pATCH answers 400 for an empty body or invalid content, 409 for a taken name; ids are validated', async () => {
    const h = await open()
    const first = customizationSchema.parse((await send(h.t, 'POST', '/api/customizations', { kind: 'skill', content: '---\nname: one\ndescription: One.\n---\nOne.' })).body)
    await send(h.t, 'POST', '/api/customizations', { kind: 'skill', content: '---\nname: two\ndescription: Two.\n---\nTwo.' })
    expect((await send(h.t, 'PATCH', `/api/customizations/${first.id}`, {})).status).toBe(400)
    expect((await send(h.t, 'PATCH', `/api/customizations/${first.id}`, { kind: 'agent' })).status).toBe(400)
    const invalid = await send(h.t, 'PATCH', `/api/customizations/${first.id}`, { content: '---\nname: one\n---\nNo description.' })
    expect(invalid.status).toBe(400)
    expect(envelope(invalid).details).toMatchObject({ diagnostics: [{ code: 'missing-field' }] })
    const taken = await send(h.t, 'PATCH', `/api/customizations/${first.id}`, { content: '---\nname: two\ndescription: Clash.\n---\nNo.' })
    expect(taken.status).toBe(409)
    expect(envelope(taken).details).toMatchObject({ reason: 'exists' })
    expect((await send(h.t, 'GET', '/api/customizations/not-an-id')).status).toBe(400)
    expect((await send(h.t, 'GET', `/api/customizations/${UNKNOWN_ID}`)).status).toBe(404)
  })
})
