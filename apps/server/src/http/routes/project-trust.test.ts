// Project trust routes (API.md 5.32, Phase 11 W11.3-T4 / T5): the list, approve with fresh auth (403 without it) and
// 409 stale, revoke without fresh auth (idempotent, 200 with the list), 404 for an unknown project, and an approved
// hook reaching the hooks snapshot (through `projectTrust.approved`).
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessErrorEnvelopeSchema, projectTrustListSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { projectTrust } from '../../db/schema.ts'
import { createProjectConfigService } from '../../services/project-config/index.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { FRESH_AUTH_REQUIRED_MESSAGE } from '../middleware/fresh-auth.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'

const PASSWORD = 'correct horse battery staple'
const UNKNOWN = 'prj_ZZZZZZZZZZZZZZZZ'
const CHECK = 'sh .claude/hooks/check.sh'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

interface Harness {
  t: TestApp
  events: RecordingEventBus
  projectId: string
  fresh: string
  stale: string
}

/** The events of project trust (the project MCP manager may add its own `project-mcp.changed`). */
function trustEvents(h: Harness) {
  return h.events.events.filter(event => event.type === 'project-trust.changed' || event.type === 'hooks.changed')
}

async function setup(): Promise<Harness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const events = createRecordingEventBus()
  const t = await createTestApp({
    env: { HF_PASSWORD: PASSWORD },
    builtins: [],
    workspaceRoots: [base],
    overrides: { events },
    factories: { projectConfig: deps => createProjectConfigService(deps, { recheckDelayMs: 60_000 }) },
  })
  cleanups.push(() => t.close())
  const project = await t.deps.projects.create({ name: 'Demo', path: base, newFolder: 'demo' })
  const root = join(base, 'demo')
  for (const [rel, content] of [
    ['.claude/hooks/check.sh', 'echo ok\n'],
    ['.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: CHECK }] }] } })],
    ['.mcp.json', JSON.stringify({ mcpServers: { local: { command: 'node', args: ['server.mjs'] } } })],
  ] as const) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), content)
  }
  const cookie = async (ageMs: number) => `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() - ageMs })}`
  return { t, events, projectId: project.id, fresh: await cookie(60_000), stale: await cookie(FRESH_AUTH_WINDOW_MS + 60_000) }
}

async function send(h: Harness, method: string, path: string, options: { body?: unknown, cookie?: string } = {}): Promise<{ status: number, body: unknown }> {
  const headers: Record<string, string> = { cookie: options.cookie ?? h.stale }
  if (options.body !== undefined)
    headers['content-type'] = 'application/json'
  const response = await h.t.request(path, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

describe('project trust routes', () => {
  it('the list route answers the items of a fresh scan; 404 for an unknown project', async () => {
    const h = await setup()
    const listed = await send(h, 'GET', `/api/projects/${h.projectId}/trust`)
    expect(listed.status).toBe(200)
    const list = projectTrustListSchema.parse(listed.body)
    expect(list.items.map(item => [item.kind, item.state])).toEqual([['hook', 'pending'], ['mcp', 'pending']])
    const missing = await send(h, 'GET', `/api/projects/${UNKNOWN}/trust`)
    expect(missing.status).toBe(404)
    expect(harnessErrorEnvelopeSchema.parse(missing.body).error.code).toBe('not_found')
  })

  it('approving needs fresh auth: 403 with a stale session and nothing approved; 200 with a fresh one; 409 stale', async () => {
    const h = await setup()
    const list = projectTrustListSchema.parse((await send(h, 'GET', `/api/projects/${h.projectId}/trust`)).body)
    const hook = list.items[0]!
    const body = { items: [{ kind: 'hook', sha256: hook.sha256 }] }

    const stale = await send(h, 'POST', `/api/projects/${h.projectId}/trust`, { body })
    expect(stale.status).toBe(403)
    expect(harnessErrorEnvelopeSchema.parse(stale.body).error).toEqual({ code: 'forbidden', message: FRESH_AUTH_REQUIRED_MESSAGE, action: 'login' })
    expect(await h.t.db.select().from(projectTrust)).toEqual([])
    expect(await h.t.deps.projectTrust.approved(h.projectId)).toEqual(new Set())

    const wrong = await send(h, 'POST', `/api/projects/${h.projectId}/trust`, { body: { items: [{ kind: 'hook', sha256: 'f'.repeat(64) }] }, cookie: h.fresh })
    expect(wrong.status).toBe(409)
    expect(harnessErrorEnvelopeSchema.parse(wrong.body).error).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    expect(await h.t.db.select().from(projectTrust)).toEqual([])

    const unknown = await send(h, 'POST', `/api/projects/${UNKNOWN}/trust`, { body, cookie: h.fresh })
    expect(unknown.status).toBe(404)

    h.events.clear()
    const approved = await send(h, 'POST', `/api/projects/${h.projectId}/trust`, { body, cookie: h.fresh })
    expect(approved.status).toBe(200)
    expect(projectTrustListSchema.parse(approved.body).items.map(item => item.state)).toEqual(['approved', 'pending'])
    expect(trustEvents(h).map(event => [event.type, event.data])).toEqual([
      ['project-trust.changed', { projectId: h.projectId, pending: 1 }],
      ['hooks.changed', { projectId: h.projectId }],
    ])
    // The approved hook is in the approved set the hooks snapshot reads, and verifies before its run.
    expect(await h.t.deps.projectTrust.approved(h.projectId)).toEqual(new Set([hook.sha256]))
    const snapshot = await h.t.deps.projectConfig.snapshot(h.projectId)
    const item = snapshot.hooks.find(entry => entry.sha256 === hook.sha256)!
    expect(await h.t.deps.projectConfig.verify(h.projectId, item)).toBe(true)
  })

  it('revoking needs no fresh auth, is idempotent and answers the list; 404 for an unknown project', async () => {
    const h = await setup()
    const list = projectTrustListSchema.parse((await send(h, 'GET', `/api/projects/${h.projectId}/trust`)).body)
    const hook = list.items[0]!
    await send(h, 'POST', `/api/projects/${h.projectId}/trust`, { body: { items: [{ kind: 'hook', sha256: hook.sha256 }] }, cookie: h.fresh })

    const revoked = await send(h, 'DELETE', `/api/projects/${h.projectId}/trust/${hook.sha256}`)
    expect(revoked.status).toBe(200)
    expect(projectTrustListSchema.parse(revoked.body).items.map(item => item.state)).toEqual(['pending', 'pending'])
    expect(await h.t.deps.projectTrust.approved(h.projectId)).toEqual(new Set())
    const again = await send(h, 'DELETE', `/api/projects/${h.projectId}/trust/${hook.sha256}`)
    expect(again.status).toBe(200)
    expect((await send(h, 'DELETE', `/api/projects/${UNKNOWN}/trust/${hook.sha256}`)).status).toBe(404)
  })
})
