// Claude Code import routes (W12.3-T5, API.md 5.35): every answer through the real import service over a fake Claude
// Code home (C45 builders in a temp folder): home 200; scan 200 / 403 / 404 / 409; upload 200 (folder files with their
// relative paths as part file names, a zip) / 400 / 413; apply 200 / 400 / 403 / 404. A session is required. No answer
// carries a canary, an env or a header value.
import type { ClaudeImportPlan } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { claudeImportApplyResultSchema, claudeImportPlanSchema, harnessErrorEnvelopeSchema, LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupImportFixtures, hasCanary, planItems, uploadOfHome, writeFakeHome, zipOfHome } from '../../services/claude-import/fixtures.test-util.ts'
import { fakeClaudeHomeFiles } from '../../testing/claude-fixtures.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'

const PASSWORD = 'correct horse battery staple'

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  await cleanupImportFixtures()
})

interface Harness {
  t: TestApp
  fresh: string
  stale: string
}

async function harness(claudeHome: string): Promise<Harness> {
  const t = await createTestApp({ start: false, builtins: [], env: { HF_PASSWORD: PASSWORD, HF_CLAUDE_HOME: claudeHome }, customizations: 'fake', hooks: 'fake' })
  apps.push(t)
  const fresh = `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() })}`
  const stale = `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() - FRESH_AUTH_WINDOW_MS - 60_000 })}`
  return { t, fresh, stale }
}

interface Answer { status: number, body: unknown, text: string }

async function send(h: Harness, method: string, path: string, cookie: string | null, body?: unknown): Promise<Answer> {
  const init: RequestInit = { method, headers: cookie === null ? {} : { cookie } }
  if (body instanceof FormData) {
    init.body = body
  }
  else if (body !== undefined) {
    init.headers = { ...init.headers as Record<string, string>, 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const response = await h.t.request(path, init)
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) as unknown, text }
}

function errorOf(answer: Answer) {
  return harnessErrorEnvelopeSchema.parse(answer.body).error
}

/** The multipart form the browser sends for a picked folder (`useClaudeImport().planFromFiles`). */
function folderForm(): FormData {
  const upload = uploadOfHome(fakeClaudeHomeFiles())
  const form = new FormData()
  for (const file of upload.files ?? [])
    form.append('files', file.file, file.path)
  if (upload.claudeJson !== undefined)
    form.append('claudeJson', upload.claudeJson, '.claude.json')
  return form
}

describe('claude import routes', () => {
  it('a session is required', async () => {
    const { claudeHome } = await writeFakeHome()
    const h = await harness(claudeHome)
    expect((await send(h, 'GET', '/api/claude-import/home', null)).status).toBe(401)
    expect((await send(h, 'POST', '/api/claude-import/scan', null)).status).toBe(401)
    expect((await send(h, 'POST', '/api/claude-import/upload', null, folderForm())).status).toBe(401)
  })

  it('home 200; scan 200 with fresh auth, 403 without, 404 for a missing folder, 409 while turned off', async () => {
    const { claudeHome } = await writeFakeHome()
    const h = await harness(claudeHome)
    expect((await send(h, 'GET', '/api/claude-import/home', h.stale)).body).toEqual({ available: true, path: claudeHome })
    const refused = await send(h, 'POST', '/api/claude-import/scan', h.stale)
    expect(refused.status).toBe(403)
    expect(errorOf(refused)).toMatchObject({ code: 'forbidden', action: 'login' })
    const scanned = await send(h, 'POST', '/api/claude-import/scan', h.fresh)
    expect(scanned.status).toBe(200)
    expect(claudeImportPlanSchema.parse(scanned.body)).toMatchObject({ source: 'scan', root: claudeHome })
    expect(hasCanary(scanned.text)).toBe(false)

    const missing = await harness(`${claudeHome}-missing`)
    const notFound = await send(missing, 'POST', '/api/claude-import/scan', missing.fresh)
    expect(notFound.status).toBe(404)
    const off = await harness('0')
    const disabled = await send(off, 'POST', '/api/claude-import/scan', off.fresh)
    expect(disabled.status).toBe(409)
    expect(errorOf(disabled)).toMatchObject({ code: 'conflict', details: { reason: 'disabled' } })
    expect((await send(off, 'GET', '/api/claude-import/home', off.stale)).body).toEqual({ available: false, reason: 'disabled', path: null })
  })

  it('upload 200: the folder files (named by their relative paths) and the zip give the scan\'s plan, with a stale session', async () => {
    const { claudeHome } = await writeFakeHome()
    const h = await harness(claudeHome)
    const scanned = claudeImportPlanSchema.parse((await send(h, 'POST', '/api/claude-import/scan', h.fresh)).body)
    const folder = await send(h, 'POST', '/api/claude-import/upload', h.stale, folderForm())
    expect(folder.status).toBe(200)
    const fromFolder = claudeImportPlanSchema.parse(folder.body)
    expect(planItems(fromFolder)).toEqual(planItems(scanned))
    expect(fromFolder).toMatchObject({ source: 'upload', root: '.claude' })

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(zipOfHome(fakeClaudeHomeFiles()))], { type: 'application/zip' }), 'claude.zip')
    form.append('label', 'claude.zip')
    const zipped = await send(h, 'POST', '/api/claude-import/upload', h.stale, form)
    expect(zipped.status).toBe(200)
    const fromZip = claudeImportPlanSchema.parse(zipped.body)
    expect(planItems(fromZip)).toEqual(planItems(scanned))
    expect(fromZip.root).toBe('claude.zip')
    expect(hasCanary(folder.text + zipped.text)).toBe(false)
  })

  it('upload 400: not multipart, both or none of file / files, a text part, an unknown field, an unreadable zip; 413 above 32 MiB', async () => {
    const h = await harness('0')
    const cases: Array<[string, () => RequestInit]> = [
      ['json', () => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [] }) })],
      ['both', () => {
        const form = new FormData()
        form.append('file', new Blob(['PK']), 'a.zip')
        form.append('files', new Blob(['x']), 'agents/a.md')
        return { body: form }
      }],
      ['none', () => {
        const form = new FormData()
        form.append('label', 'empty')
        return { body: form }
      }],
      ['text part', () => {
        const form = new FormData()
        form.append('files', 'agents/a.md')
        return { body: form }
      }],
      ['unknown field', () => {
        const form = new FormData()
        form.append('files', new Blob(['x']), 'agents/a.md')
        form.append('extra', 'x')
        return { body: form }
      }],
      ['two zips', () => {
        const form = new FormData()
        form.append('file', new Blob(['PK']), 'a.zip')
        form.append('file', new Blob(['PK']), 'b.zip')
        return { body: form }
      }],
      ['not a zip', () => {
        const form = new FormData()
        form.append('file', new Blob(['not a zip']), 'a.zip')
        return { body: form }
      }],
    ]
    for (const [name, init] of cases) {
      const response = await h.t.request('/api/claude-import/upload', { method: 'POST', ...init(), headers: { ...(init().headers as Record<string, string> | undefined), cookie: h.stale } })
      expect(response.status, name).toBe(400)
      expect(harnessErrorEnvelopeSchema.parse(await response.json()).error.code, name).toBe('validation_error')
    }
    const tooLarge = await h.t.request('/api/claude-import/upload', {
      method: 'POST',
      headers: { 'cookie': h.stale, 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(LIMITS.claudeImportBytesMax + 64 * 1024 + 1) },
      body: '--x--',
    })
    expect(tooLarge.status).toBe(413)
    expect(harnessErrorEnvelopeSchema.parse(await tooLarge.json()).error).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.claudeImportBytesMax } })
  })

  it('apply 200 with fresh auth; 403 without; 400 for an unknown key; 404 for an expired or applied plan', async () => {
    const { claudeHome } = await writeFakeHome()
    const h = await harness(claudeHome)
    const plan = claudeImportPlanSchema.parse((await send(h, 'POST', '/api/claude-import/upload', h.stale, folderForm())).body) as ClaudeImportPlan
    const agent = plan.items.find(item => item.kind === 'agent' && item.name === 'reviewer')!
    const body = { planId: plan.id, items: [{ key: agent.key, action: 'import' }] }
    expect((await send(h, 'POST', '/api/claude-import/apply', h.stale, body)).status).toBe(403)
    const unknown = await send(h, 'POST', '/api/claude-import/apply', h.fresh, { planId: plan.id, items: [{ key: 'agent:nope:agents/nope.md', action: 'import' }] })
    expect(unknown.status).toBe(400)
    expect(errorOf(unknown).details).toMatchObject({ issues: [expect.objectContaining({ path: ['items', 0, 'key'] })] })
    const applied = await send(h, 'POST', '/api/claude-import/apply', h.fresh, body)
    expect(applied.status).toBe(200)
    expect(claudeImportApplyResultSchema.parse(applied.body)).toMatchObject({ results: [{ key: agent.key, outcome: 'created' }], counts: { created: 1 } })
    const again = await send(h, 'POST', '/api/claude-import/apply', h.fresh, body)
    expect(again.status).toBe(404)
    expect(errorOf(again)).toMatchObject({ code: 'not_found', message: 'The import plan expired. Read the folder again.' })
  })
})
