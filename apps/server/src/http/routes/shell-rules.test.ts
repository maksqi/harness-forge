// Shell rule routes (W8.6-T1, API.md 5.25): 200 / 201 / 400 / 404 / 409 / 204 through the real service, a session is
// required, fresh auth is not.
import type { TestApp } from '../../testing/create-test-app.ts'
import { harnessErrorEnvelopeSchema, LIMITS, parseShellRule, shellRuleListSchema, shellRuleSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { projects, shellRules } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'

const A = 'prj_AAAAAAAAAAAAAAAA'
const B = 'prj_BBBBBBBBBBBBBBBB'
const UNKNOWN = 'prj_ZZZZZZZZZZZZZZZZ'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function app(env: Record<string, string> = {}): Promise<TestApp> {
  const t = await createTestApp({ builtins: [], start: false, env })
  cleanups.push(() => t.close())
  await t.db.insert(projects).values([
    { id: A, name: 'Alpha', path: '/srv/projects/alpha', createdAt: 1, updatedAt: 1 },
    { id: B, name: 'Beta', path: '/srv/projects/beta', createdAt: 1, updatedAt: 1 },
  ])
  return t
}

interface JsonResponse { status: number, body: unknown, text: string }

async function send(t: TestApp, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const response = await t.request(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null, text }
}

function envelope(response: JsonResponse) {
  return harnessErrorEnvelopeSchema.parse(response.body).error
}

describe('shell rule routes', () => {
  it('creates (201), lists (global first) and removes (204) rules', async () => {
    const t = await app()
    const empty = await send(t, 'GET', '/api/shell-rules')
    expect(empty.status).toBe(200)
    expect(shellRuleListSchema.parse(empty.body)).toEqual({ items: [] })

    const project = await send(t, 'POST', '/api/shell-rules', { projectId: A, prefix: '  pnpm   test  ' })
    expect(project.status).toBe(201)
    expect(shellRuleSchema.parse(project.body)).toMatchObject({ projectId: A, prefix: 'pnpm test' })
    const global = await send(t, 'POST', '/api/shell-rules', { projectId: null, prefix: 'ls' })
    expect(global.status).toBe(201)
    const other = await send(t, 'POST', '/api/shell-rules', { projectId: B, prefix: 'make' })
    expect(other.status).toBe(201)

    const list = shellRuleListSchema.parse((await send(t, 'GET', '/api/shell-rules')).body)
    expect(list.items.map(rule => [rule.projectId, rule.prefix])).toEqual([[null, 'ls'], [A, 'pnpm test'], [B, 'make']])

    const id = shellRuleSchema.parse(project.body).id
    const removed = await send(t, 'DELETE', `/api/shell-rules/${id}`)
    expect(removed.status).toBe(204)
    expect(removed.text).toBe('')
    expect(shellRuleListSchema.parse((await send(t, 'GET', '/api/shell-rules')).body).items.map(rule => rule.prefix)).toEqual(['ls', 'make'])
    // The typed client agrees with the routes.
    expect((await t.client.shellRules.list()).items).toHaveLength(2)
  })

  it('answers 400 on [prefix] with the parser message for a refused prefix', async () => {
    const t = await app()
    for (const prefix of ['bash -c', 'export', 'ls > out.txt', 'node', 'cd src', 'rm -rf $HOME']) {
      const parsed = parseShellRule(prefix)
      expect(parsed.ok, prefix).toBe(false)
      const response = await send(t, 'POST', '/api/shell-rules', { projectId: A, prefix })
      expect(response.status, prefix).toBe(400)
      const error = envelope(response)
      expect(error.code).toBe('validation_error')
      expect(error.message).toBe(parsed.ok ? '' : parsed.message)
      expect(error.details).toMatchObject({ issues: [{ path: ['prefix'] }] })
    }
    expect(await t.deps.shellRules.list()).toEqual([])
  })

  it('answers 400 for invalid input (shape, strict body, ids) before the service', async () => {
    const t = await app()
    for (const body of [
      { projectId: null, prefix: '   ' },
      { projectId: null, prefix: 'x'.repeat(LIMITS.shellRulePrefixMaxChars + 1) },
      { projectId: 'prj_short', prefix: 'ls' },
      { prefix: 'ls' },
      { projectId: null, prefix: 'ls', scope: 'global' },
    ]) {
      const response = await send(t, 'POST', '/api/shell-rules', body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(envelope(response).code).toBe('validation_error')
    }
    const badId = await send(t, 'DELETE', '/api/shell-rules/srl_short')
    expect(badId.status).toBe(400)
  })

  it('answers 404 for an unknown project and an unknown rule', async () => {
    const t = await app()
    const project = await send(t, 'POST', '/api/shell-rules', { projectId: UNKNOWN, prefix: 'ls' })
    expect(project.status).toBe(404)
    expect(envelope(project)).toMatchObject({ code: 'not_found', message: `Project ${UNKNOWN} not found.` })
    const rule = await send(t, 'DELETE', '/api/shell-rules/srl_AAAAAAAAAAAAAAAA')
    expect(rule.status).toBe(404)
    expect(envelope(rule)).toMatchObject({ code: 'not_found', message: 'Shell rule srl_AAAAAAAAAAAAAAAA not found.' })
  })

  it('answers 409 exists for the same canonical prefix in the same scope', async () => {
    const t = await app()
    expect((await send(t, 'POST', '/api/shell-rules', { projectId: A, prefix: 'git status' })).status).toBe(201)
    const duplicate = await send(t, 'POST', '/api/shell-rules', { projectId: A, prefix: 'git \'status\'' })
    expect(duplicate.status).toBe(409)
    expect(envelope(duplicate)).toMatchObject({ code: 'conflict', message: 'This rule already exists.', details: { reason: 'exists' } })
    expect((await send(t, 'POST', '/api/shell-rules', { projectId: null, prefix: 'git status' })).status).toBe(201)
  })

  it('answers 400 when the scope is full', async () => {
    const t = await app()
    await t.db.insert(shellRules).values(Array.from({ length: LIMITS.shellRulesPerScopeMax }, (_, index) => ({
      id: `srl_F${String(index).padStart(15, '0')}`,
      projectId: B,
      prefix: `tool${index}`,
      createdAt: 1,
    })))
    const full = await send(t, 'POST', '/api/shell-rules', { projectId: B, prefix: 'make' })
    expect(full.status).toBe(400)
    expect(envelope(full)).toMatchObject({ code: 'validation_error', message: `This project already has ${LIMITS.shellRulesPerScopeMax} shell rules. Remove one first.` })
    expect((await send(t, 'POST', '/api/shell-rules', { projectId: A, prefix: 'make' })).status).toBe(201)
    expect(shellRuleListSchema.parse((await send(t, 'GET', '/api/shell-rules')).body).items).toHaveLength(LIMITS.shellRulesPerScopeMax + 1)
  })

  it('needs a session but no fresh auth', async () => {
    const password = 'correct horse battery staple'
    const t = await app({ HF_PASSWORD: password })
    expect((await send(t, 'GET', '/api/shell-rules')).status).toBe(401)
    expect((await send(t, 'POST', '/api/shell-rules', { projectId: null, prefix: 'ls' })).status).toBe(401)
    const stale = `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() - FRESH_AUTH_WINDOW_MS - 60_000 })}`
    const created = await send(t, 'POST', '/api/shell-rules', { projectId: null, prefix: 'ls' }, { cookie: stale })
    expect(created.status, created.text).toBe(201)
    expect((await send(t, 'GET', '/api/shell-rules', undefined, { cookie: stale })).status).toBe(200)
    const id = shellRuleSchema.parse(created.body).id
    expect((await send(t, 'DELETE', `/api/shell-rules/${id}`, undefined, { cookie: stale })).status).toBe(204)
  })
})
