import type { Logger, PluginContext, ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { TestApp } from '../../testing/create-test-app.ts'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { listResponseSchema, pluginManifestBaseSchema, toolSummarySchema, WORKSPACE_TOOL_ACCESS, WORKSPACE_TOOL_NAMES, WORKSPACE_TOOL_SCHEMAS } from '@harness-forge/shared'
import semver from 'semver'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import coreWorkspace, { createWorkspaceTools, manifest, NO_WORKSPACE_MESSAGE, readFilePolicy, requireWorkspace, writeFilePolicy } from './index.ts'

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

/** Guard timeouts of PLUGINS.md 1 (read tools 30 s, walks 60 s, writes 30 s, shell 600 s). */
const TIMEOUTS: Record<string, number> = {
  read_file: 30_000,
  list_directory: 30_000,
  find_files: 60_000,
  search_files: 60_000,
  write_file: 30_000,
  edit_file: 30_000,
  shell: 600_000,
}

/** Static policies; `read_file`, `write_file` and `edit_file` have policy functions (`policies.ts`). */
const POLICIES: Record<string, string | typeof readFilePolicy> = {
  read_file: readFilePolicy,
  list_directory: 'safe',
  find_files: 'safe',
  search_files: 'safe',
  write_file: writeFilePolicy,
  edit_file: writeFilePolicy,
  shell: 'ask',
}

/** The file tools of W7.2 (the shell is W7.3's, tested in `shell-tool.test.ts`). */
const FILE_TOOL_NAMES = WORKSPACE_TOOL_NAMES.filter(name => name !== 'shell')

/** A valid input of each file tool. */
const FILE_TOOL_INPUTS: Record<string, unknown> = {
  read_file: { path: 'a.txt' },
  list_directory: {},
  find_files: { pattern: '*.ts' },
  search_files: { pattern: 'x' },
  write_file: { path: 'a.txt', content: 'x' },
  edit_file: { path: 'a.txt', old_string: 'x', new_string: 'y' },
}

const context: ToolCallContext = {
  chatId: '0199a8f0-0000-7000-8000-000000000001',
  modelRef: 'mock:workspace',
  toolCallId: 'mock_call_1',
  messages: [],
  signal: new AbortController().signal,
  workspace: { projectId: 'prj_AAAAAAAAAAAAAAAA', name: 'Demo', root: '/srv/projects/demo' },
}

describe('core-workspace manifest', () => {
  it('is a valid builtin manifest: 1.0.0, engines ^1.2.0, permission process, no settings', () => {
    const parsed = pluginManifestBaseSchema.parse(manifest)
    expect(parsed).toMatchObject({ id: 'core-workspace', version: '1.0.0', engines: { harness: '^1.2.0' }, main: 'index.ts', permissions: ['process'] })
    expect(parsed.settings).toBeUndefined()
    expect(semver.satisfies(PLUGIN_API_VERSION, manifest.engines.harness)).toBe(true)
    // An older host (plugin API 1.1) would offer the tools in every chat: the range must exclude it.
    expect(semver.satisfies('1.1.0', manifest.engines.harness)).toBe(false)
  })
})

describe('the seven workspace tools', () => {
  const tools = createWorkspaceTools({ logger, platform: 'linux' })

  it('come in the shared registration order', () => {
    expect(tools.map(tool => tool.name)).toEqual([...WORKSPACE_TOOL_NAMES])
  })

  it('shell is not registered on Windows', () => {
    expect(createWorkspaceTools({ logger, platform: 'win32' }).map(tool => tool.name)).toEqual(WORKSPACE_TOOL_NAMES.filter(name => name !== 'shell'))
    expect(createWorkspaceTools({ logger, platform: 'darwin' })).toHaveLength(7)
  })

  it.each(WORKSPACE_TOOL_NAMES.map(name => [name] as const))('%s: shared input schema, workspace access, timeout, policy, description', (name) => {
    const tool = tools.find(entry => entry.name === name)!
    expect(tool.inputSchema).toBe(WORKSPACE_TOOL_SCHEMAS[name].input)
    expect(tool.workspace).toBe(WORKSPACE_TOOL_ACCESS[name])
    expect(tool.timeoutMs).toBe(TIMEOUTS[name])
    expect(tool.policy).toBe(POLICIES[name])
    expect(tool.description.length).toBeGreaterThan(20)
    expect(tool.description.length).toBeLessThanOrEqual(1024)
  })

  it.each(FILE_TOOL_NAMES.map(name => [name] as const))('%s: refuses a call without a project folder, and a missing folder', async (name) => {
    const tool = tools.find(entry => entry.name === name)!
    const { workspace: _workspace, ...withoutWorkspace } = context
    await expect(tool.execute(FILE_TOOL_INPUTS[name], withoutWorkspace)).rejects.toMatchObject({ code: 'validation_error', message: NO_WORKSPACE_MESSAGE })
    // The fake root does not exist: the path guard refuses every path.
    await expect(tool.execute(FILE_TOOL_INPUTS[name], context)).rejects.toMatchObject({ code: 'validation_error' })
  })

  it.each(FILE_TOOL_NAMES.map(name => [name] as const))('%s: has a toModelOutput', (name) => {
    expect(typeof tools.find(entry => entry.name === name)!.toModelOutput).toBe('function')
  })

  it('the shell description tells the model each call is a new process', () => {
    const shell = tools.find(tool => tool.name === 'shell')!
    expect(shell.description).toMatch(/new process/)
    expect(shell.description).toMatch(/no stdin/)
    expect(shell.description).toMatch(/background processes are stopped/)
  })

  it('requireWorkspace returns the call workspace or refuses a call without one', () => {
    expect(requireWorkspace(context)).toEqual({ projectId: 'prj_AAAAAAAAAAAAAAAA', name: 'Demo', root: '/srv/projects/demo' })
    const { workspace: _workspace, ...withoutWorkspace } = context
    expect(() => requireWorkspace(withoutWorkspace)).toThrow(NO_WORKSPACE_MESSAGE)
  })

  it('setup registers every tool through ctx.tools.register', async () => {
    const registered: ToolDefinition[] = []
    const ctx = {
      logger,
      tools: {
        register: (definition: ToolDefinition) => {
          registered.push(definition)
          return { dispose() {} }
        },
      },
    } as unknown as PluginContext
    await coreWorkspace.setup(ctx)
    const expected = process.platform === 'win32' ? WORKSPACE_TOOL_NAMES.filter(name => name !== 'shell') : [...WORKSPACE_TOOL_NAMES]
    expect(registered.map(tool => tool.name)).toEqual(expected)
  })
})

describe('core-workspace in the plugin host', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({ builtins: [{ id: 'core-workspace', manifest, module: coreWorkspace }], start: false })
    await t.deps.plugins.start()
  })

  afterAll(async () => {
    await t.close()
  })

  it('loads active and contributes the tools with their workspace access', () => {
    expect(t.deps.plugins.state('core-workspace')).toBe('active')
    const names = process.platform === 'win32' ? WORKSPACE_TOOL_NAMES.filter(name => name !== 'shell') : [...WORKSPACE_TOOL_NAMES]
    expect([...t.deps.registry.contributions('core-workspace').tools].sort()).toEqual([...names].sort())
    for (const name of names) {
      expect(t.deps.registry.tools.get(name), name).toMatchObject({
        pluginId: 'core-workspace',
        mcpServerId: null,
        definition: { workspace: WORKSPACE_TOOL_ACCESS[name], timeoutMs: TIMEOUTS[name] },
      })
    }
  })

  it('gET /api/tools lists them (ToolSummary.workspace is reported from W7.6 on)', async () => {
    const response = await t.request('/api/tools')
    expect(response.status).toBe(200)
    const items = listResponseSchema(toolSummarySchema).parse(await response.json()).items
    const ours = items.filter(item => item.pluginId === 'core-workspace')
    expect(ours.map(item => item.name).sort()).toEqual(process.platform === 'win32' ? WORKSPACE_TOOL_NAMES.filter(name => name !== 'shell').sort() : [...WORKSPACE_TOOL_NAMES].sort())
    for (const item of ours)
      expect([null, WORKSPACE_TOOL_ACCESS[item.name as keyof typeof WORKSPACE_TOOL_ACCESS]]).toContain(item.workspace)
  })
})
