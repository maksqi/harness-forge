import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { TestApp } from '../../testing/create-test-app.ts'
import process from 'node:process'
import { harnessErrorEnvelopeSchema, listResponseSchema, toolSummarySchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestApp } from '../../testing/create-test-app.ts'

let t: TestApp

beforeEach(async () => {
  t = await createTestApp({ builtins: [], start: false })
  const definition = {
    name: 'word_count',
    description: 'Counts words.',
    inputSchema: z.object({ text: z.string() }),
    policy: 'safe',
    execute: async () => ({ words: 1 }),
  } as ToolDefinition
  t.deps.registry.tools.register('words', definition)
})

afterEach(async () => {
  await t.close()
})

async function send(method: string, path: string, body?: unknown): Promise<{ status: number, body: unknown }> {
  const response = await t.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

describe('tools routes', () => {
  it('lists the tools', async () => {
    const { status, body } = await send('GET', '/api/tools')
    expect(status).toBe(200)
    expect(listResponseSchema(toolSummarySchema).parse(body).items).toEqual([
      expect.objectContaining({ name: 'word_count', pluginId: 'words', policy: 'safe', enabled: true, override: null, available: true }),
    ])
  })

  it('updates the enabled flag and the override', async () => {
    const disabled = await send('PATCH', '/api/tools/word_count', { enabled: false })
    expect(disabled.status).toBe(200)
    expect(toolSummarySchema.parse(disabled.body)).toMatchObject({ enabled: false, override: null })
    const allowed = await send('PATCH', '/api/tools/word_count', { override: 'allow' })
    expect(toolSummarySchema.parse(allowed.body)).toMatchObject({ enabled: false, override: 'allow' })
    expect(await t.deps.tools.prefs()).toEqual(new Map([['word_count', { enabled: false, override: 'allow' }]]))
  })

  it('answers 400 on [override] for override allow on a tool with workspace access execute (ADR-038)', async () => {
    t.deps.registry.tools.register('runner', {
      name: 'run_task',
      description: 'Runs a task.',
      inputSchema: z.object({ task: z.string() }),
      workspace: 'execute',
      execute: async () => ({ ok: true }),
    } as ToolDefinition)
    const refused = await send('PATCH', '/api/tools/run_task', { override: 'allow' })
    expect(refused.status).toBe(400)
    expect(harnessErrorEnvelopeSchema.parse(refused.body).error).toMatchObject({
      code: 'validation_error',
      message: 'Shell commands can\'t be always allowed. Add a shell rule instead.',
      details: { issues: [{ path: ['override'] }] },
    })
    expect(await t.deps.tools.prefs()).toEqual(new Map())
    const denied = await send('PATCH', '/api/tools/run_task', { override: 'deny' })
    expect(denied.status).toBe(200)
    expect(toolSummarySchema.parse(denied.body)).toMatchObject({ workspace: 'execute', override: 'deny' })
    expect((await send('PATCH', '/api/tools/run_task', { override: 'ask' })).status).toBe(200)
    expect((await send('PATCH', '/api/tools/run_task', { override: null })).status).toBe(200)
    // Tools without execute access still take allow.
    expect((await send('PATCH', '/api/tools/word_count', { override: 'allow' })).status).toBe(200)
  })

  it.skipIf(process.platform === 'win32')('pATCH /tools/shell: allow is 400, deny is 200', async () => {
    const full = await createTestApp({ start: true })
    try {
      const patch = async (body: unknown) => full.request('/api/tools/shell', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const refused = await patch({ override: 'allow' })
      expect(refused.status).toBe(400)
      expect(harnessErrorEnvelopeSchema.parse(await refused.json()).error.details).toMatchObject({ issues: [{ path: ['override'] }] })
      const denied = await patch({ override: 'deny' })
      expect(denied.status).toBe(200)
      expect(toolSummarySchema.parse(await denied.json())).toMatchObject({ name: 'shell', workspace: 'execute', override: 'deny' })
    }
    finally {
      await full.close()
    }
  })

  it('answers 404 for an unknown tool and 400 for invalid input', async () => {
    const missing = await send('PATCH', '/api/tools/unknown_tool', { enabled: false })
    expect(missing.status).toBe(404)
    expect(harnessErrorEnvelopeSchema.parse(missing.body).error.code).toBe('not_found')
    for (const [path, body] of [
      ['/api/tools/word_count', {}],
      ['/api/tools/word_count', { override: 'always' }],
      ['/api/tools/word_count', { enabled: 'no' }],
      ['/api/tools/bad%20name', { enabled: false }],
    ] as const) {
      const response = await send('PATCH', path, body)
      expect(response.status).toBe(400)
      expect(harnessErrorEnvelopeSchema.parse(response.body).error.code).toBe('validation_error')
    }
  })
})
