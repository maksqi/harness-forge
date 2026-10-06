// Hook routes (W11.1-T7, API.md 5.31): every answer through the real hook service: 200 / 201 / 204 / 400 / 403 / 404 /
// 409, a session is required, fresh auth on create and on every update but the one that only turns a hook off, and
// `hooks.changed` after every write.
import type { ServerEvent } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessErrorEnvelopeSchema, hookListSchema, hookRunListSchema, LIMITS, personalHookSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { hooks } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'

const PASSWORD = 'correct horse battery staple'
const UNKNOWN_HOOK = 'hok_ZZZZZZZZZZZZZZZZ'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

interface Harness {
  t: TestApp
  fresh: string
  stale: string
  events: ServerEvent[]
}

async function app(): Promise<Harness> {
  const t = await createTestApp({ builtins: [], env: { HF_PASSWORD: PASSWORD } })
  cleanups.push(() => t.close())
  const events: ServerEvent[] = []
  const subscription = t.deps.events.subscribe(event => events.push(event))
  cleanups.push(() => subscription.dispose())
  const fresh = `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() })}`
  const stale = `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() - FRESH_AUTH_WINDOW_MS - 60_000 })}`
  return { t, fresh, stale, events }
}

interface JsonResponse { status: number, body: unknown }

async function send(t: TestApp, method: string, path: string, cookie: string | null, body?: unknown): Promise<JsonResponse> {
  const response = await t.request(path, {
    method,
    headers: { ...(cookie === null ? {} : { cookie }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

function error(response: JsonResponse) {
  return harnessErrorEnvelopeSchema.parse(response.body).error
}

function changed(h: Harness): unknown[] {
  return h.events.filter(event => event.type === 'hooks.changed').map(event => event.data)
}

describe('hook routes', () => {
  it('a session is required', async () => {
    const h = await app()
    expect((await send(h.t, 'GET', '/api/hooks', null)).status).toBe(401)
    expect((await send(h.t, 'GET', '/api/hooks/runs', null)).status).toBe(401)
    expect((await send(h.t, 'POST', '/api/hooks', null, { event: 'Stop', command: 'sh x.sh' })).status).toBe(401)
  })

  it('pOST /hooks: 201 with fresh auth, 403 without, 400 for an invalid matcher, 409 at 100 hooks', async () => {
    const h = await app()
    const refused = await send(h.t, 'POST', '/api/hooks', h.stale, { event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh' })
    expect(refused.status).toBe(403)
    expect(error(refused)).toMatchObject({ code: 'forbidden', action: 'login' })
    expect(await h.t.db.select().from(hooks)).toEqual([])

    const created = await send(h.t, 'POST', '/api/hooks', h.fresh, { event: 'PreToolUse', matcher: 'Bash|Write', command: 'sh guard.sh', timeout: 30 })
    expect(created.status).toBe(201)
    expect(personalHookSchema.parse(created.body)).toMatchObject({ event: 'PreToolUse', matcher: 'Bash|Write', command: 'sh guard.sh', timeout: 30, enabled: true })
    expect(changed(h)).toEqual([{ projectId: null }])

    const invalid = await send(h.t, 'POST', '/api/hooks', h.fresh, { event: 'PreToolUse', matcher: '^Bash', command: 'sh x.sh' })
    expect(invalid.status).toBe(400)
    expect(error(invalid)).toMatchObject({ code: 'validation_error', details: { issues: [expect.objectContaining({ path: ['matcher'] })] } })
    for (const body of [{ event: 'Stop', command: ' ' }, { event: 'Stop', command: 'sh x.sh', timeout: 0 }, { event: 'Stop', command: 'x'.repeat(4097) }, { event: 'Other', command: 'sh x.sh' }])
      expect((await send(h.t, 'POST', '/api/hooks', h.fresh, body)).status, JSON.stringify(body).slice(0, 60)).toBe(400)

    await h.t.db.insert(hooks).values(Array.from({ length: LIMITS.personalHooksMax - 1 }, (_, index) => ({
      id: `hok_${String(index).padStart(16, '0')}`,
      event: 'Stop' as const,
      command: 'sh x.sh',
      createdAt: index,
      updatedAt: index,
    })))
    const full = await send(h.t, 'POST', '/api/hooks', h.fresh, { event: 'Stop', command: 'sh x.sh' })
    expect(full.status).toBe(409)
    expect(error(full)).toMatchObject({ code: 'conflict', details: { reason: 'exists' }, message: `At most ${LIMITS.personalHooksMax} personal hooks can be stored; delete one first.` })
    expect(changed(h)).toHaveLength(1)
  })

  it('pATCH /hooks/:id: fresh auth unless the body only turns the hook off; 404; 400', async () => {
    const h = await app()
    const { id } = personalHookSchema.parse((await send(h.t, 'POST', '/api/hooks', h.fresh, { event: 'Stop', command: 'sh stop.sh' })).body)
    const off = await send(h.t, 'PATCH', `/api/hooks/${id}`, h.stale, { enabled: false })
    expect(off.status).toBe(200)
    expect(personalHookSchema.parse(off.body)).toMatchObject({ id, enabled: false })
    for (const body of [{ enabled: true }, { enabled: false, timeout: 5 }, { command: 'sh other.sh' }]) {
      const refused = await send(h.t, 'PATCH', `/api/hooks/${id}`, h.stale, body)
      expect(refused.status, JSON.stringify(body)).toBe(403)
    }
    const on = await send(h.t, 'PATCH', `/api/hooks/${id}`, h.fresh, { enabled: true, matcher: 'Bash', command: 'sh other.sh' })
    expect(on.status).toBe(200)
    expect(personalHookSchema.parse(on.body)).toMatchObject({ id, enabled: true, matcher: 'Bash', command: 'sh other.sh' })
    expect((await send(h.t, 'PATCH', `/api/hooks/${UNKNOWN_HOOK}`, h.stale, { enabled: false })).status).toBe(404)
    expect((await send(h.t, 'PATCH', `/api/hooks/${UNKNOWN_HOOK}`, h.fresh, { command: 'sh x.sh' })).status).toBe(404)
    expect((await send(h.t, 'PATCH', `/api/hooks/${id}`, h.fresh, { matcher: '(Write)+' })).status).toBe(400)
    expect((await send(h.t, 'PATCH', `/api/hooks/${id}`, h.fresh, {})).status).toBe(400)
    expect(changed(h)).toHaveLength(3)
  })

  it('dELETE /hooks/:id: 204 without fresh auth, then 404', async () => {
    const h = await app()
    const { id } = personalHookSchema.parse((await send(h.t, 'POST', '/api/hooks', h.fresh, { event: 'Stop', command: 'sh stop.sh' })).body)
    expect((await send(h.t, 'DELETE', `/api/hooks/${id}`, h.stale)).status).toBe(204)
    expect((await send(h.t, 'DELETE', `/api/hooks/${id}`, h.stale)).status).toBe(404)
    expect(changed(h)).toEqual([{ projectId: null }, { projectId: null }])
  })

  it('gET /hooks and /hooks/runs: the listing with the switches, a project scan, 404 for an unknown project; the run log', async () => {
    const h = await app()
    await send(h.t, 'POST', '/api/hooks', h.fresh, { event: 'Stop', command: 'sh stop.sh' })
    const list = await send(h.t, 'GET', '/api/hooks', h.stale)
    expect(list.status).toBe(200)
    expect(hookListSchema.parse(list.body)).toMatchObject({ items: [{ source: 'personal', state: 'active', command: 'sh stop.sh' }], diagnostics: [], switches: { setting: true, shell: true, safeMode: false } })

    const root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const second = await createTestApp({ builtins: [], workspaceRoots: [root] })
    cleanups.push(() => second.close())
    const project = await second.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })
    const scanned = await second.request(`/api/hooks?projectId=${project.id}`)
    expect(scanned.status).toBe(200)
    expect(hookListSchema.parse(await scanned.json()).project).toMatchObject({ id: project.id, available: true, pending: 0 })
    const unknown = await second.request('/api/hooks?projectId=prj_ZZZZZZZZZZZZZZZZ')
    expect(unknown.status).toBe(404)

    const runs = await send(h.t, 'GET', '/api/hooks/runs', h.stale)
    expect(runs.status).toBe(200)
    expect(hookRunListSchema.parse(runs.body)).toEqual({ items: [] })
  })
})
