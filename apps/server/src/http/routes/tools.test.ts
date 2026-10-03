// Tool routes (API.md 5.12): the list, the prefs, the refused `allow` overrides (ADR-038 `execute` tools, Phase 9
// ADR-041 `exit_plan_mode`) and the effective override of `GET /tools` (W9.7).
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { TestApp } from '../../testing/create-test-app.ts'
import process from 'node:process'
import { harnessErrorEnvelopeSchema, listResponseSchema, toolSummarySchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CORE_AGENT_PLUGIN_ID, createExitPlanModeTool, createTodoWriteTool } from '../../builtin-plugins/core-agent/index.ts'
import { toolPrefs } from '../../db/schema.ts'
import { allowRefusedMessage, effectiveToolOverride, EXECUTE_ALLOW_REFUSED_MESSAGE, PLAN_ALLOW_REFUSED_MESSAGE } from '../../mcp/tools.ts'
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

function registerRunner(): void {
  t.deps.registry.tools.register('runner', {
    name: 'run_task',
    description: 'Runs a task.',
    inputSchema: z.object({ task: z.string() }),
    workspace: 'execute',
    execute: async () => ({ ok: true }),
  } as ToolDefinition)
}

/** A row straight into `tool_prefs` (an override stored before v1.4, or planted by hand). */
async function plant(toolName: string, override: 'allow' | 'ask' | 'deny', enabled = true): Promise<void> {
  await t.db.insert(toolPrefs).values({ toolName, enabled, override, updatedAt: 1 })
}

async function listed(name: string): Promise<Record<string, unknown> | undefined> {
  const { body } = await send('GET', '/api/tools')
  return listResponseSchema(toolSummarySchema).parse(body).items.find(tool => tool.name === name)
}

describe('tools routes: the effective override (Phase 9, W9.7)', () => {
  it('gET /tools shows a stored allow on an execute tool as null; ask and deny stay', async () => {
    registerRunner()
    await plant('run_task', 'allow')
    await plant('word_count', 'allow')
    expect(await listed('run_task')).toMatchObject({ workspace: 'execute', enabled: true, override: null })
    // Other tools keep their allow.
    expect(await listed('word_count')).toMatchObject({ override: 'allow' })
    // The raw prefs still hold the row (the approval ignores it itself).
    expect((await t.deps.tools.prefs()).get('run_task')).toEqual({ enabled: true, override: 'allow' })

    await t.db.update(toolPrefs).set({ override: 'deny' })
    expect(await listed('run_task')).toMatchObject({ override: 'deny' })
    await t.db.update(toolPrefs).set({ override: 'ask' })
    expect(await listed('run_task')).toMatchObject({ override: 'ask' })
  })

  it('a patch of a tool with a stale allow answers and stores the effective override', async () => {
    registerRunner()
    await plant('run_task', 'allow')
    const disabled = await send('PATCH', '/api/tools/run_task', { enabled: false })
    expect(disabled.status).toBe(200)
    expect(toolSummarySchema.parse(disabled.body)).toMatchObject({ enabled: false, override: null })
    expect((await t.deps.tools.prefs()).get('run_task')).toEqual({ enabled: false, override: null })
    // Enabled again with no override: the defaults, so the row goes.
    expect(toolSummarySchema.parse((await send('PATCH', '/api/tools/run_task', { enabled: true })).body)).toMatchObject({ enabled: true, override: null })
    expect(await t.deps.tools.prefs()).toEqual(new Map())
  })

  it('pATCH /tools/exit_plan_mode refuses allow (400 on [override]); ask, deny and null are accepted', async () => {
    t.deps.registry.tools.register(CORE_AGENT_PLUGIN_ID, createExitPlanModeTool())
    t.deps.registry.tools.register(CORE_AGENT_PLUGIN_ID, createTodoWriteTool())
    const refused = await send('PATCH', '/api/tools/exit_plan_mode', { override: 'allow' })
    expect(refused.status).toBe(400)
    expect(harnessErrorEnvelopeSchema.parse(refused.body).error).toMatchObject({
      code: 'validation_error',
      message: PLAN_ALLOW_REFUSED_MESSAGE,
      details: { issues: [{ path: ['override'], message: PLAN_ALLOW_REFUSED_MESSAGE }] },
    })
    expect(await t.deps.tools.prefs()).toEqual(new Map())
    for (const override of ['ask', 'deny', null] as const) {
      const answer = await send('PATCH', '/api/tools/exit_plan_mode', { override })
      expect(answer.status, String(override)).toBe(200)
      expect(toolSummarySchema.parse(answer.body)).toMatchObject({ name: 'exit_plan_mode', pluginId: CORE_AGENT_PLUGIN_ID, override })
    }
    // A refused allow with another field changes nothing.
    expect((await send('PATCH', '/api/tools/exit_plan_mode', { enabled: false, override: 'allow' })).status).toBe(400)
    expect(await listed('exit_plan_mode')).toMatchObject({ enabled: true, override: null })
    // The other agent tools take allow.
    expect((await send('PATCH', '/api/tools/todo_write', { override: 'allow' })).status).toBe(200)
    // A planted allow on the plan tool is listed as null.
    await plant('exit_plan_mode', 'allow')
    expect(await listed('exit_plan_mode')).toMatchObject({ override: null })
  })

  it('only core-agent\'s exit_plan_mode is the plan tool (owner, not the name alone)', async () => {
    expect(allowRefusedMessage({ name: 'exit_plan_mode', pluginId: CORE_AGENT_PLUGIN_ID, workspace: null })).toBe(PLAN_ALLOW_REFUSED_MESSAGE)
    expect(allowRefusedMessage({ name: 'exit_plan_mode', pluginId: 'acme', workspace: null })).toBeNull()
    expect(allowRefusedMessage({ name: 'todo_write', pluginId: CORE_AGENT_PLUGIN_ID, workspace: null })).toBeNull()
    expect(effectiveToolOverride({ name: 'exit_plan_mode', pluginId: CORE_AGENT_PLUGIN_ID, workspace: null }, 'allow')).toBeNull()
    // The approval asks for the plan before it reads any override, so even a stored deny does not apply.
    expect(effectiveToolOverride({ name: 'exit_plan_mode', pluginId: CORE_AGENT_PLUGIN_ID, workspace: null }, 'deny')).toBeNull()
    expect(effectiveToolOverride({ name: 'exit_plan_mode', pluginId: 'acme', workspace: null }, 'allow')).toBe('allow')
    expect(allowRefusedMessage({ name: 'shell', pluginId: 'core-workspace', workspace: 'execute' })).toBe(EXECUTE_ALLOW_REFUSED_MESSAGE)
    expect(allowRefusedMessage({ name: 'write_file', pluginId: 'core-workspace', workspace: 'write' })).toBeNull()
    expect(effectiveToolOverride({ name: 'x', pluginId: 'p', workspace: 'execute' }, 'allow')).toBeNull()
    expect(effectiveToolOverride({ name: 'x', pluginId: 'p', workspace: 'execute' }, 'deny')).toBe('deny')
    expect(effectiveToolOverride({ name: 'x', pluginId: 'p', workspace: 'read' }, 'allow')).toBe('allow')
    expect(effectiveToolOverride({ name: 'x', pluginId: 'p', workspace: null }, null)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('the real builtins: a SQL-planted allow on shell and on exit_plan_mode lists as null; PATCH allow is 400', async () => {
    const full = await createTestApp({ start: true })
    try {
      await full.db.insert(toolPrefs).values([
        { toolName: 'shell', enabled: true, override: 'allow', updatedAt: 1 },
        { toolName: 'exit_plan_mode', enabled: true, override: 'allow', updatedAt: 1 },
        { toolName: 'read_file', enabled: true, override: 'allow', updatedAt: 1 },
      ])
      const items = listResponseSchema(toolSummarySchema).parse(await (await full.request('/api/tools')).json()).items
      const byName = new Map(items.map(tool => [tool.name, tool]))
      expect(byName.get('shell')).toMatchObject({ workspace: 'execute', override: null })
      expect(byName.get('exit_plan_mode')).toMatchObject({ pluginId: CORE_AGENT_PLUGIN_ID, override: null })
      expect(byName.get('read_file')).toMatchObject({ override: 'allow' })
      const patch = async (name: string) => full.request(`/api/tools/${name}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ override: 'allow' }) })
      expect((await patch('exit_plan_mode')).status).toBe(400)
      expect((await patch('shell')).status).toBe(400)
      expect((await patch('todo_write')).status).toBe(200)
    }
    finally {
      await full.close()
    }
  })
})
