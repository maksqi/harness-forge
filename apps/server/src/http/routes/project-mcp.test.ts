// Route tests of the project MCP routes (API.md 5.33, ADR-050; W11.4-T6): every answer of `GET /projects/:id/mcp`,
// `PUT /projects/:id/mcp/variables` (fresh auth) and `POST /projects/:id/mcp/:serverId/reconnect`, against the real
// manager with the C36 fakes of the project config reader and of project trust (fixtures on loopback only).
import type { ProjectMcpTestApp } from '../../mcp/project-testing.ts'
import { harnessErrorEnvelopeSchema, projectMcpListSchema, projectMcpServerSchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { secrets } from '../../db/schema.ts'
import { createProjectMcpTestApp, minServerItem } from '../../mcp/project-testing.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'

const PASSWORD = 'correct horse battery staple'
const UNKNOWN_PROJECT = 'prj_ZZZZZZZZZZZZZZZZ'

let h: ProjectMcpTestApp | null = null

afterEach(async () => {
  await h?.close()
  h = null
})

async function open(env: Record<string, string> = {}): Promise<ProjectMcpTestApp> {
  h = await createProjectMcpTestApp({ env: { HF_PASSWORD: PASSWORD, ...env } })
  return h
}

async function cookie(app: ProjectMcpTestApp, ageMs: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await app.t.deps.sessions.issue({ authAt: Date.now() - ageMs })}`
}

interface JsonResponse { status: number, body: unknown }

async function send(app: ProjectMcpTestApp, method: string, path: string, session: string, body?: unknown): Promise<JsonResponse> {
  const headers: Record<string, string> = { cookie: session }
  if (body !== undefined)
    headers['content-type'] = 'application/json'
  const response = await app.t.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

function errorOf(body: unknown) {
  return harnessErrorEnvelopeSchema.parse(body).error
}

describe('project MCP routes', () => {
  it('gET /projects/:id/mcp: the servers and variables (never a value); 404 unknown project; 400 invalid id', async () => {
    const app = await open()
    const session = await cookie(app, 0)
    // eslint-disable-next-line no-template-curly-in-string -- `.mcp.json` variable references are test data
    const item = minServerItem('Local', [], { TOKEN: '${MCP_TOKEN}' })
    app.setServers([item])
    const listed = await send(app, 'GET', `/api/projects/${app.project.id}/mcp`, session)
    expect(listed.status).toBe(200)
    expect(projectMcpListSchema.parse(listed.body)).toEqual({
      items: [{ id: 'local', name: 'Local', transport: 'stdio', state: 'pending', sha256: item.sha256, tools: [], missingVariables: ['MCP_TOKEN'] }],
      variables: [{ name: 'MCP_TOKEN', set: false, hint: null, usedBy: ['local'] }],
    })
    expect((await send(app, 'GET', `/api/projects/${app.other.id}/mcp`, session)).body).toEqual({ items: [], variables: [] })
    const missing = await send(app, 'GET', `/api/projects/${UNKNOWN_PROJECT}/mcp`, session)
    expect(missing.status).toBe(404)
    expect(errorOf(missing.body).code).toBe('not_found')
    expect((await send(app, 'GET', '/api/projects/nope/mcp', session)).status).toBe(400)
    expect((await app.t.request(`/api/projects/${app.project.id}/mcp`)).status).toBe(401)
  })

  it('pUT /projects/:id/mcp/variables: fresh auth; values stored encrypted and never answered; 400 / 404 / 409', async () => {
    const app = await open()
    const fresh = await cookie(app, 0)
    const stale = await cookie(app, 11 * 60 * 1000)
    const path = `/api/projects/${app.project.id}/mcp/variables`
    // eslint-disable-next-line no-template-curly-in-string -- `.mcp.json` variable references are test data
    app.setServers([minServerItem('Local', [], { TOKEN: '${MCP_TOKEN}' })])
    const rows = () => app.t.db.select().from(secrets).where(eq(secrets.scope, `project:${app.project.id}`))

    const refused = await send(app, 'PUT', path, stale, { values: { MCP_TOKEN: 'route-secret-123' } })
    expect(refused.status).toBe(403)
    expect(errorOf(refused.body)).toMatchObject({ code: 'forbidden', action: 'login' })
    expect(await rows()).toEqual([])

    const saved = await send(app, 'PUT', path, fresh, { values: { MCP_TOKEN: 'route-secret-123', SPARE: 'spare-value-1' } })
    expect(saved.status).toBe(200)
    const list = projectMcpListSchema.parse(saved.body)
    expect(list.variables).toEqual([
      { name: 'MCP_TOKEN', set: true, hint: null, usedBy: ['local'] },
      { name: 'SPARE', set: true, hint: null, usedBy: [] },
    ])
    expect(JSON.stringify(saved.body)).not.toContain('route-secret-123')
    expect((await rows()).map(row => row.name).sort()).toEqual(['mcp.var.MCP_TOKEN', 'mcp.var.SPARE'])

    const cleared = await send(app, 'PUT', path, fresh, { values: { SPARE: null } })
    expect(projectMcpListSchema.parse(cleared.body).variables.map(variable => variable.name)).toEqual(['MCP_TOKEN'])

    for (const body of [
      { values: { '1BAD': 'x' } },
      { values: { GOOD: '' } },
      { values: { GOOD: 'x'.repeat(4097) } },
      { values: {}, extra: true },
      { values: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`V${index}`, 'x'])) },
      {},
    ]) {
      const invalid = await send(app, 'PUT', path, fresh, body)
      expect(invalid.status, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect(errorOf(invalid.body).code).toBe('validation_error')
    }

    const full = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`V${index}`, `value-${index}`]))
    const tooMany = await send(app, 'PUT', path, fresh, { values: full })
    expect(tooMany.status).toBe(409)
    expect(errorOf(tooMany.body)).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })

    const unknown = await send(app, 'PUT', `/api/projects/${UNKNOWN_PROJECT}/mcp/variables`, fresh, { values: { A: 'b' } })
    expect(unknown.status).toBe(404)
    expect(JSON.stringify(app.t.logs.records)).not.toContain('route-secret-123')
  })

  it('pOST /projects/:id/mcp/:serverId/reconnect: 200 connected / pending; 404 unknown server or project; 400 invalid id', async () => {
    const app = await open()
    const session = await cookie(app, 11 * 60 * 1000)
    const local = minServerItem('Local')
    const later = minServerItem('Later')
    app.setServers([local, later])
    await app.approve(local)
    const reconnected = await send(app, 'POST', `/api/projects/${app.project.id}/mcp/local/reconnect`, session)
    expect(reconnected.status).toBe(200)
    expect(projectMcpServerSchema.parse(reconnected.body)).toMatchObject({ id: 'local', state: 'connected', tools: ['mcp__local__echo', 'mcp__local__env', 'mcp__local__pid'] })
    const pending = await send(app, 'POST', `/api/projects/${app.project.id}/mcp/later/reconnect`, session)
    expect(pending.status).toBe(200)
    expect(projectMcpServerSchema.parse(pending.body).state).toBe('pending')
    const unknownServer = await send(app, 'POST', `/api/projects/${app.project.id}/mcp/nope/reconnect`, session)
    expect(unknownServer.status).toBe(404)
    expect(errorOf(unknownServer.body).code).toBe('not_found')
    expect((await send(app, 'POST', `/api/projects/${UNKNOWN_PROJECT}/mcp/local/reconnect`, session)).status).toBe(404)
    expect((await send(app, 'POST', `/api/projects/${app.project.id}/mcp/Not_An_Id/reconnect`, session)).status).toBe(400)
    await waitForEvent(app)
  })

  it('pOST …/reconnect in safe mode: 409 disabled; GET lists the servers as disabled', async () => {
    const app = await open({ HF_SAFE_MODE: '1' })
    const session = await cookie(app, 0)
    const local = minServerItem('Local')
    app.setServers([local])
    await app.approve(local)
    const refused = await send(app, 'POST', `/api/projects/${app.project.id}/mcp/local/reconnect`, session)
    expect(refused.status).toBe(409)
    expect(errorOf(refused.body)).toMatchObject({ code: 'conflict', details: { reason: 'disabled' } })
    const listed = projectMcpListSchema.parse((await send(app, 'GET', `/api/projects/${app.project.id}/mcp`, session)).body)
    expect(listed.items.map(item => item.state)).toEqual(['disabled'])
  })
})

/** `project-mcp.changed` carries the project's servers after a state change. */
async function waitForEvent(app: ProjectMcpTestApp): Promise<void> {
  const deadline = Date.now() + 5000
  while (!app.events.ofType('project-mcp.changed').some(event => event.data.servers.some(item => item.state === 'connected'))) {
    if (Date.now() > deadline)
      throw new Error('no project-mcp.changed with a connected server')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
