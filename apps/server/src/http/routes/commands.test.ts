import type { CommandSummary } from '@harness-forge/shared'
import type { McpPromptInfo } from '../../mcp/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeCustomizationService } from '../../testing/fake-customizations.ts'
import type { FakeProjectMcpManager } from '../../testing/fake-project-mcp.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandSummarySchema, HarnessError, listResponseSchema, mcpPromptCommandName } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BUILTIN_COMMANDS } from '../../builtin-plugins/core-commands/commands.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { fakeCatalogEntry } from '../../testing/fake-customizations.ts'

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
    expect(body.items[0]).toEqual({ name: body.items[0]!.name, kind: 'command', description: expect.any(String), source: 'plugin', pluginId: 'core-commands' })
    // Phase 9 (ADR-040): `/compact [focus]` is run by the server; the agent tools' plugin owns it.
    expect(body.items.filter(item => item.name === 'compact')).toEqual([
      { name: 'compact', kind: 'command', description: 'Summarize the conversation to free up context', source: 'harness', pluginId: 'core-agent' },
    ])
  })

  it('follows registrations of plugins', async () => {
    const registration = t.deps.registry.commands.register('mock', { name: 'aaa-first', description: 'First', template: 'x {{input}}' })
    try {
      const { items } = await (await t.request('/api/commands')).json() as { items: { name: string, pluginId: string }[] }
      expect(items[0]).toEqual({ name: 'aaa-first', kind: 'command', description: 'First', source: 'plugin', pluginId: 'mock' })
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

describe('gET /api/commands?projectId: command files and personal commands (W10.2-T6)', () => {
  let app: TestApp
  let root: string
  let projectA: string
  let projectB: string

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, workspaceRoots: [root], customizations: 'fake' })
    projectA = (await app.deps.projects.create({ name: 'Alpha', path: root, newFolder: 'alpha' })).id
    projectB = (await app.deps.projects.create({ name: 'Beta', path: root, newFolder: 'beta' })).id
    const fake = app.deps.customizations as FakeCustomizationService
    fake.entries.set(projectA, [
      fakeCatalogEntry('command', 'review', { argumentHint: '<files>', modelRef: 'mock:agents', tools: ['read_file'] }),
      fakeCatalogEntry('command', 'review', { path: '.claude/commands/review.md', description: 'The Claude review.' }),
      fakeCatalogEntry('command', 'deploy', { path: '.harness/commands/ops/deploy.md', namespace: 'ops' }),
      fakeCatalogEntry('command', 'broken', { path: '.harness/commands/broken.md', state: 'invalid' }),
    ])
    await fake.create({ kind: 'command', content: '---\nname: standup\ndescription: My standup notes.\n---\nWrite my standup.' })
    await fake.create({ kind: 'command', content: '---\nname: later\ndescription: Off.\n---\nLater.', enabled: false })
  })

  afterAll(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  async function list(query = ''): Promise<CommandSummary[]> {
    const response = await app.request(`/api/commands${query}`)
    expect(response.status).toBe(200)
    return listResponseSchema(commandSummarySchema).parse(await response.json()).items
  }

  it('lists the project\'s effective commands with their fields over the personal and plugin commands, sorted by name', async () => {
    const items = await list(`?projectId=${projectA}`)
    expect(items.map(item => item.name)).toEqual([...items.map(item => item.name)].sort())
    expect(items.find(item => item.name === 'review')).toEqual({ name: 'review', kind: 'command', description: 'The review command.', source: 'project', argumentHint: '<files>', modelRef: 'mock:agents' })
    expect(items.filter(item => item.name === 'review')).toHaveLength(1)
    expect(items.find(item => item.name === 'deploy')).toEqual({ name: 'deploy', kind: 'command', description: 'The deploy command.', source: 'project', namespace: 'ops' })
    expect(items.find(item => item.name === 'standup')).toEqual({ name: 'standup', kind: 'command', description: 'My standup notes.', source: 'user' })
    expect(items.find(item => item.name === 'compact')).toMatchObject({ source: 'harness', pluginId: 'core-agent' })
    expect(items.find(item => item.name === 'summarize')).toMatchObject({ source: 'plugin', pluginId: 'core-commands' })
    // Invalid and turned-off definitions are not usable commands.
    expect(items.some(item => item.name === 'broken' || item.name === 'later')).toBe(false)
  })

  it('another project\'s list and the global list never show the project\'s commands (the plugin command is back)', async () => {
    for (const query of [`?projectId=${projectB}`, '']) {
      const items = await list(query)
      expect(items.find(item => item.name === 'review'), query).toMatchObject({ source: 'plugin', pluginId: 'core-commands' })
      expect(items.some(item => item.name === 'deploy'), query).toBe(false)
      expect(items.find(item => item.name === 'standup'), query).toMatchObject({ source: 'user' })
      for (const item of items)
        expect(item.source === 'project', query).toBe(false)
    }
  })

  it('answers an unknown project with 404 and an invalid id with 400', async () => {
    expect((await app.request('/api/commands?projectId=prj_0000000000000000')).status).toBe(404)
    expect((await app.request('/api/commands?projectId=../x')).status).toBe(400)
  })

  it('lists the user-invocable skills of the scope as kind skill (W11.5-T5); a command wins the name', async () => {
    const fake = app.deps.customizations as FakeCustomizationService
    const skills = [
      fakeCatalogEntry('skill', 'ship-it', { argumentHint: '<env>' }),
      fakeCatalogEntry('skill', 'quiet', { userInvocable: false }),
      fakeCatalogEntry('skill', 'deploy'),
      fakeCatalogEntry('skill', `long-${'s'.repeat(50)}`),
    ]
    fake.entries.set(projectA, [...(fake.entries.get(projectA) ?? []), ...skills])
    try {
      const items = await list(`?projectId=${projectA}`)
      expect(items.find(item => item.name === 'ship-it')).toEqual({ name: 'ship-it', kind: 'skill', description: 'The ship-it skill.', source: 'project', argumentHint: '<env>' })
      expect(items.some(item => item.name === `long-${'s'.repeat(50)}` && item.kind === 'skill')).toBe(true)
      expect(items.some(item => item.name === 'quiet')).toBe(false)
      expect(items.filter(item => item.name === 'deploy')).toEqual([expect.objectContaining({ kind: 'command', source: 'project' })])
      expect((await list(`?projectId=${projectB}`)).some(item => item.kind === 'skill')).toBe(false)
    }
    finally {
      fake.entries.set(projectA, (fake.entries.get(projectA) ?? []).filter(entry => entry.kind !== 'skill'))
    }
  })
})

describe('gET /api/commands: MCP prompts (W14.2-T2, ADR-061)', () => {
  let app: TestApp
  let root: string
  let projectId: string

  function prompt(serverId: string, name: string, args: McpPromptInfo['arguments'] = []): McpPromptInfo {
    return { serverId, serverName: `${serverId} server`, name, commandName: mcpPromptCommandName(serverId, name), title: null, description: `The ${name} prompt.`, arguments: args }
  }

  async function list(query = ''): Promise<CommandSummary[]> {
    const response = await app.request(`/api/commands${query}`)
    expect(response.status).toBe(200)
    return listResponseSchema(commandSummarySchema).parse(await response.json()).items
  }

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, workspaceRoots: [root], projectMcp: 'fake' })
    projectId = (await app.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })).id
    vi.spyOn(app.deps.mcp, 'prompts').mockResolvedValue({
      items: [prompt('docs', 'greet', [{ name: 'name', required: true }, { name: 'greeting', required: false }]), prompt('wiki', 'search')],
      truncated: false,
      unavailable: [{ serverId: 'locked', status: 'needs-auth' }],
    })
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  it('lists the prompts of the connected global servers with source mcp, the server and the hint, sorted by name', async () => {
    const items = await list()
    const mcp = items.filter(item => item.source === 'mcp')
    expect(mcp).toEqual([
      { name: 'mcp__docs__greet', kind: 'command', description: 'The greet prompt.', source: 'mcp', mcpServer: { id: 'docs', name: 'docs server' }, argumentHint: '<name> [greeting]' },
      { name: 'mcp__wiki__search', kind: 'command', description: 'The search prompt.', source: 'mcp', mcpServer: { id: 'wiki', name: 'wiki server' } },
    ])
    expect(items.map(item => item.name)).toEqual([...items.map(item => item.name)].sort())
    expect(items.some(item => item.name === 'compact')).toBe(true)
  })

  it('adds the project\'s prompts with its projectId (no wait); a project server shadows the global one', async () => {
    const fake = app.deps.projectMcp as FakeProjectMcpManager
    fake.promptLists.set(projectId, { items: [prompt('docs', 'local')], truncated: false, unavailable: [], shadowed: new Set(['docs']) })
    const spy = vi.spyOn(fake, 'prompts')
    try {
      const names = (await list(`?projectId=${projectId}`)).filter(item => item.source === 'mcp').map(item => item.name)
      expect(names).toEqual(['mcp__docs__local', 'mcp__wiki__search'])
      expect(spy).toHaveBeenCalledWith(projectId, expect.objectContaining({ waitMs: 0 }))
      // Without the project id the global servers answer.
      expect((await list()).filter(item => item.source === 'mcp').map(item => item.name)).toEqual(['mcp__docs__greet', 'mcp__wiki__search'])
      // A project listing that fails leaves the global prompts.
      spy.mockRejectedValueOnce(new HarnessError({ code: 'provider_error', message: 'boom' }))
      expect((await list(`?projectId=${projectId}`)).filter(item => item.source === 'mcp').map(item => item.name)).toEqual(['mcp__docs__greet', 'mcp__wiki__search'])
    }
    finally {
      spy.mockRestore()
      fake.promptLists.delete(projectId)
    }
  })
})
