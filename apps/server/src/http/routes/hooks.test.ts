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

describe('hook routes: prompt hooks and the handler fields (Phase 12, W12.5-T6)', () => {
  it('cRUD of a prompt hook: 201 with fresh auth, 403 without; the listing; switching the type; 400 for the other type\'s fields', async () => {
    const h = await app()
    const body = { type: 'prompt', event: 'Stop', prompt: 'Did the agent run the tests? $ARGUMENTS', model: 'haiku', timeout: 20, continueOnBlock: false, statusMessage: 'Checking the work…' }
    const refused = await send(h.t, 'POST', '/api/hooks', h.stale, body)
    expect(refused.status).toBe(403)
    expect(await h.t.db.select().from(hooks)).toEqual([])

    const created = await send(h.t, 'POST', '/api/hooks', h.fresh, body)
    expect(created.status).toBe(201)
    const hook = personalHookSchema.parse(created.body)
    expect(hook).toMatchObject({ type: 'prompt', event: 'Stop', prompt: body.prompt, model: 'haiku', timeout: 20, statusMessage: 'Checking the work…', enabled: true })
    const [row] = await h.t.db.select().from(hooks)
    expect(row).toMatchObject({ type: 'prompt', command: '', prompt: body.prompt, model: 'haiku', options: { statusMessage: 'Checking the work…' } })
    const listed = hookListSchema.parse((await send(h.t, 'GET', '/api/hooks', h.stale)).body)
    expect(listed.items).toEqual([expect.objectContaining({ kind: 'command', type: 'prompt', command: '', prompt: body.prompt, model: 'haiku', statusMessage: 'Checking the work…', state: 'active', source: 'personal' })])

    // Prompt hooks only on the prompt events; command fields on a prompt hook are refused.
    expect((await send(h.t, 'POST', '/api/hooks', h.fresh, { ...body, event: 'SessionStart' })).status).toBe(400)
    expect((await send(h.t, 'PATCH', `/api/hooks/${hook.id}`, h.fresh, { args: ['x'] })).status).toBe(400)
    expect((await send(h.t, 'PATCH', `/api/hooks/${hook.id}`, h.fresh, { event: 'Notification' })).status).toBe(400)
    // Turning it off needs no fresh auth; any other change does.
    expect((await send(h.t, 'PATCH', `/api/hooks/${hook.id}`, h.stale, { enabled: false })).status).toBe(200)
    expect((await send(h.t, 'PATCH', `/api/hooks/${hook.id}`, h.stale, { prompt: 'Other' })).status).toBe(403)
    const edited = await send(h.t, 'PATCH', `/api/hooks/${hook.id}`, h.fresh, { prompt: 'Other prompt', model: null, continueOnBlock: true, statusMessage: null })
    expect(edited.status).toBe(200)
    expect(personalHookSchema.parse(edited.body)).toMatchObject({ type: 'prompt', prompt: 'Other prompt', model: null, continueOnBlock: true, enabled: false })
    expect(personalHookSchema.parse(edited.body)).not.toHaveProperty('statusMessage')

    // A switch to a command hook needs a command; the prompt fields go.
    expect((await send(h.t, 'PATCH', `/api/hooks/${hook.id}`, h.fresh, { type: 'command' })).status).toBe(400)
    const switched = await send(h.t, 'PATCH', `/api/hooks/${hook.id}`, h.fresh, { type: 'command', command: 'sh', args: ['.claude/hooks/check.sh', 'a b'], async: true })
    expect(switched.status).toBe(200)
    expect(personalHookSchema.parse(switched.body)).toMatchObject({ type: 'command', command: 'sh', args: ['.claude/hooks/check.sh', 'a b'], async: true })
    const [after] = await h.t.db.select().from(hooks)
    expect(after).toMatchObject({ type: 'command', prompt: null, model: null, options: { args: ['.claude/hooks/check.sh', 'a b'], async: true } })
    // An `if` rule only on a tool event.
    expect((await send(h.t, 'PATCH', `/api/hooks/${hook.id}`, h.fresh, { if: 'Bash(git:*)' })).status).toBe(400)
    expect((await send(h.t, 'PATCH', `/api/hooks/${hook.id}`, h.fresh, { event: 'PreToolUse', if: 'Bash(git:*)' })).status).toBe(200)
    expect((await send(h.t, 'PATCH', `/api/hooks/${hook.id}`, h.fresh, { event: 'Stop' })).status).toBe(400)
    expect(changed(h)).toHaveLength(5)
  })

  it('importPersonal: one hooks.changed; command hooks off unless enabled, prompt hooks as given; invalid items and the cap fail per item', async () => {
    const h = await app()
    const results = await h.t.deps.hooks.importPersonal([
      { event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh' },
      { event: 'Stop', command: 'sh stop.sh', enabled: true },
      { type: 'prompt', event: 'Stop', prompt: 'Done?' },
      { event: 'PreToolUse', matcher: '^Bash', command: 'sh x.sh' },
      { type: 'prompt', event: 'SessionStart', prompt: 'Hi' } as never,
    ])
    expect(results.map(result => result.ok ? [result.hook.type, result.hook.enabled] : result.message)).toEqual([
      ['command', false],
      ['command', true],
      ['prompt', true],
      'This hook is not valid and was not imported.',
      'This hook is not valid and was not imported.',
    ])
    expect(JSON.stringify(results)).not.toContain('^Bash')
    expect(changed(h)).toEqual([{ projectId: null }])
    expect(await h.t.deps.hooks.importPersonal([{ event: 'Stop', command: '' }])).toEqual([{ ok: false, message: 'This hook is not valid and was not imported.' }])
    expect(changed(h)).toHaveLength(1)

    await h.t.db.insert(hooks).values(Array.from({ length: LIMITS.personalHooksMax - 4 }, (_, index) => ({ id: `hok_${String(index).padStart(16, '0')}`, event: 'Stop' as const, command: 'sh x.sh', createdAt: index, updatedAt: index })))
    const capped = await h.t.deps.hooks.importPersonal([{ event: 'Stop', command: 'sh a.sh' }, { event: 'Stop', command: 'sh b.sh' }])
    expect(capped.map(result => result.ok)).toEqual([true, false])
    expect(capped[1]).toEqual({ ok: false, message: `At most ${LIMITS.personalHooksMax} personal hooks can be stored; delete one first.` })
    expect(changed(h)).toHaveLength(2)
  })
})
