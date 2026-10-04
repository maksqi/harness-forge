import type { TestApp } from '../../testing/create-test-app.ts'
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
