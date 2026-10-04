import type { TestApp } from '../../testing/create-test-app.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandSummarySchema, listResponseSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUILTIN_COMMANDS } from '../../builtin-plugins/core-commands/commands.ts'
import { createTestApp } from '../../testing/create-test-app.ts'

let t: TestApp

beforeAll(async () => {
  t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
})

afterAll(async () => {
  await t.close()
})

describe('gET /api/commands', () => {
  it('lists the registered server-side commands and the harness command compact sorted by name with their plugin', async () => {
    const response = await t.request('/api/commands')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = listResponseSchema(commandSummarySchema).parse(await response.json())
    expect(body.items.map(item => item.name)).toEqual([...BUILTIN_COMMANDS.map(command => command.name), 'compact'].sort())
    expect(body.items[0]).toEqual({ name: body.items[0]!.name, description: expect.any(String), source: 'plugin', pluginId: 'core-commands' })
    // Phase 9 (ADR-040): `/compact [focus]` is run by the server; the agent tools' plugin owns it.
    expect(body.items.filter(item => item.name === 'compact')).toEqual([
      { name: 'compact', description: 'Summarize the conversation to free up context', source: 'harness', pluginId: 'core-agent' },
    ])
  })

  it('follows registrations of plugins', async () => {
    const registration = t.deps.registry.commands.register('mock', { name: 'aaa-first', description: 'First', template: 'x {{input}}' })
    try {
      const { items } = await (await t.request('/api/commands')).json() as { items: { name: string, pluginId: string }[] }
      expect(items[0]).toEqual({ name: 'aaa-first', description: 'First', source: 'plugin', pluginId: 'mock' })
    }
    finally {
      registration.dispose()
    }
    const { items } = await (await t.request('/api/commands')).json() as { items: { name: string }[] }
    expect(items.some(item => item.name === 'aaa-first')).toBe(false)
  })
})

describe('gET /api/commands?projectId (Phase 10, C31-T7)', () => {
  it('validates the project id (400), answers an unknown project with 404 and a known one with the list', async () => {
    const invalid = await t.request('/api/commands?projectId=nope')
    expect(invalid.status).toBe(400)
    const unknown = await t.request('/api/commands?projectId=prj_0123456789abcdef')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: { code: 'not_found' } })
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    const app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, workspaceRoots: [root] })
    try {
      const project = await app.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })
      const listed = await app.request(`/api/commands?projectId=${project.id}`)
      expect(listed.status).toBe(200)
      const body = listResponseSchema(commandSummarySchema).parse(await listed.json())
      const global = listResponseSchema(commandSummarySchema).parse(await (await app.request('/api/commands')).json())
      expect(body).toEqual(global)
      // Every item carries its source; plugin commands their plugin.
      for (const item of body.items)
        expect(item.source === 'harness' || (item.source === 'plugin' && item.pluginId !== undefined)).toBe(true)
    }
    finally {
      await app.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
