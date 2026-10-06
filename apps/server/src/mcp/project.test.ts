// Smoke tests of the project MCP manager stub (Phase 11, C36-T5): the final signatures; nothing starts. W11.4 replaces
// the stub and these expectations with the real ones.
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeProjectConfigService, fakeProjectConfigSnapshot, fakeProjectMcpServerItem } from '../testing/fake-project-config.ts'
import { noProjectMcpTools } from './project.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe('project MCP manager stub (P11-0b)', () => {
  it('toolsFor answers no tools; list answers the config servers as pending; the writes answer not_implemented', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const config = createFakeProjectConfigService()
    const t = await createTestApp({ builtins: [], workspaceRoots: [root], projectConfig: config })
    cleanups.push(() => t.close())
    const project = await t.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })
    const { projectMcp } = t.deps

    const signal = new AbortController().signal
    const tools = await projectMcp.toolsFor(project.id, { signal, waitMs: 5000 })
    expect(tools).toEqual({ tools: [], shadowed: new Set(), unavailable: [], names: new Map() })
    expect(noProjectMcpTools()).toEqual(tools)
    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(projectMcp.toolsFor(project.id, { signal: aborted.signal, waitMs: 0 })).rejects.toThrow('stopped')

    expect(await projectMcp.list(project.id)).toEqual({ items: [], variables: [] })
    // eslint-disable-next-line no-template-curly-in-string -- a `.mcp.json` variable reference is test data
    const server = fakeProjectMcpServerItem('My_Server.v2', { type: 'http', url: 'https://${HOST:-docs.example.com}/mcp', headers: {} })
    config.snapshots.set(project.id, fakeProjectConfigSnapshot(project.id, { mcpServers: [server] }))
    expect(await projectMcp.list(project.id)).toEqual({
      items: [{ id: 'my-server-v2', name: 'My_Server.v2', transport: 'http', state: 'pending', sha256: server.sha256, tools: [], missingVariables: [] }],
      variables: [],
    })
    await expect(projectMcp.list('prj_ZZZZZZZZZZZZZZZZ')).rejects.toMatchObject({ code: 'not_found' })

    await expect(projectMcp.setVariables(project.id, { HOST: 'localhost' })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(projectMcp.reconnect(project.id, 'my-server-v2')).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(projectMcp.stopProject(project.id)).resolves.toBeUndefined()
    await expect(projectMcp.stop()).resolves.toBeUndefined()
  })
})
