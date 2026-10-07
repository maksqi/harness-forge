/* eslint-disable no-template-curly-in-string -- `${user_config.KEY}`, `${VAR}` and `${CLAUDE_*}` are literal plugin content */
import type { HttpEchoServer, McpTestApp } from '../../mcp/__fixtures__/harness.ts'
// MCP servers of Claude Code plugins (W12.1-T4): the merge of `.mcp.json` (wrapper or flat map) and `plugin.json`, the
// id table, the Claude names, the variable mapping and the skipped servers; end to end, the `userConfig` secret reaches
// an http MCP fixture as a header and never appears in a body, a DTO or a log.
import type { FixtureTree } from '../../testing/claude-fixtures.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMcpTestApp, startHttpEchoServer, waitFor } from '../../mcp/__fixtures__/harness.ts'
import { writeFileTree } from '../../testing/claude-fixtures.ts'
import { claudeMcpName, readClaudeMcpServers } from './mcp.ts'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0))
    await close()
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

function file(content: string): { content: string, mode: number } {
  return { content, mode: 0o644 }
}

async function readServers(files: FixtureTree, options: { pluginId?: string, inline?: Record<string, unknown>[], userConfig?: { key: string, sensitive?: boolean, default?: string }[] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hf-claude-mcp-')))
  roots.push(root)
  await writeFileTree(root, files)
  return readClaudeMcpServers({
    root,
    pluginId: options.pluginId ?? 'kit',
    pluginName: options.pluginId ?? 'kit',
    files: Object.keys(files).filter(path => path.endsWith('.json')),
    inline: options.inline ?? [],
    userConfig: (options.userConfig ?? []).map(option => ({ key: option.key, type: 'string', title: option.key, required: false, multiple: false, sensitive: option.sensitive ?? false, ...(option.default === undefined ? {} : { default: option.default }) })),
  })
}

describe('readClaudeMcpServers', () => {
  it('one server takes the plugin id; several take <pluginId>-<slug>; a long or taken id falls back to 4 hex; else skipped', async () => {
    const one = await readServers({ '.mcp.json': file(JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example.com/mcp' } } })) })
    expect(one.servers.map(server => [server.name, server.id, server.claudeName])).toEqual([['docs', 'kit', 'plugin_kit_docs']])

    const several = await readServers({ 'servers.json': file(JSON.stringify({
      'docs': { type: 'http', url: 'https://docs.example.com/mcp' },
      'My Server': { type: 'sse', url: 'https://sse.example.com/sse' },
      'my-server': { type: 'http', url: 'https://other.example.com/mcp' },
      'a-very-long-server-name-that-does-not-fit': { command: 'node', args: ['server.mjs'] },
    })) })
    const ids = several.servers.map(server => [server.name, server.id])
    expect(ids.slice(0, 2)).toEqual([['docs', 'kit-docs'], ['My Server', 'kit-my-server']])
    expect(ids[2]?.[1]).toMatch(/^kit-[\da-f]{4}$/)
    expect(ids[3]?.[1]).toMatch(/^kit-[\da-f]{4}$/)
    expect(several.servers.find(server => server.name === 'My Server')?.claudeName).toBe('plugin_kit_My_Server')

    const long = await readServers({ '.mcp.json': file(JSON.stringify({ a: { type: 'http', url: 'https://a.example.com/' }, b: { type: 'http', url: 'https://b.example.com/' } })) }, { pluginId: 'a-plugin-id-of-thirty-one-chars' })
    expect(long.servers).toEqual([])
    expect(long.diagnostics.filter(item => item.code === 'invalid-server')).toHaveLength(2)
  })

  it('merges .mcp.json and plugin.json inline maps (a later name wins) and maps the variables', async () => {
    const read = await readServers({
      '.mcp.json': file(JSON.stringify({ mcpServers: {
        api: { type: 'http', url: 'https://old.example.com/mcp' },
        tools: { command: '${CLAUDE_PLUGIN_ROOT}/server', args: ['--token', '${user_config.TOKEN}', '--key=${API_KEY}', '${REGION:-eu}'], env: { DATA: '${CLAUDE_PLUGIN_DATA}', KEY: '${API_KEY}' } },
      } })),
    }, {
      inline: [{ api: { type: 'http', url: '${user_config.URL}', headers: { Authorization: 'Bearer ${user_config.TOKEN}' } } }],
      userConfig: [{ key: 'TOKEN', sensitive: true }, { key: 'URL', default: 'https://api.example.com/mcp' }],
    })
    expect(read.servers.map(server => server.decl)).toEqual([
      { id: 'kit-api', name: 'api', transport: { type: 'http', url: '{{settings.URL}}', headers: { Authorization: 'Bearer {{settings.TOKEN}}' } } },
      { id: 'kit-tools', name: 'tools', transport: { type: 'stdio', command: '${CLAUDE_PLUGIN_ROOT}/server', args: ['--token', '{{settings.TOKEN}}', '--key={{settings.env_API_KEY}}', '{{settings.env_REGION}}'], env: { DATA: '${CLAUDE_PLUGIN_DATA}', KEY: '{{settings.env_API_KEY}}' } } },
    ])
    expect(read.variables).toEqual([{ name: 'API_KEY', defaultValue: null }, { name: 'REGION', defaultValue: 'eu' }])
    expect(read.hosts).toEqual(['api.example.com'])
    expect(read.executables).toEqual([{ kind: 'mcp', label: 'tools', command: '${CLAUDE_PLUGIN_ROOT}/server --token ${user_config.TOKEN} --key=${API_KEY} ${REGION:-eu}' }])
  })

  it('skips what cannot run here (the project folder, options or variables in a command, an undeclared option) with diagnostics', async () => {
    const read = await readServers({ '.mcp.json': file(JSON.stringify({
      project: { command: 'node', args: ['${CLAUDE_PROJECT_DIR}/server.mjs'] },
      option: { command: '${user_config.BIN}', args: [] },
      variable: { command: '${SERVER_BIN}' },
      undeclared: { type: 'http', url: 'https://x.example.com/', headers: { A: '${user_config.MISSING}' } },
      helper: { type: 'http', url: 'https://ok.example.com/mcp', headersHelper: './helper.sh', oauth: { clientId: 'x' } },
      socket: { type: 'ws', url: 'wss://ws.example.com' },
    })) }, { userConfig: [{ key: 'BIN' }] })
    expect(read.servers.map(server => server.name)).toEqual(['helper'])
    expect(read.diagnostics.map(item => [item.component, item.code])).toEqual(expect.arrayContaining([
      ['mcpServers.project', 'unsupported-component'],
      ['mcpServers.option', 'invalid-server'],
      ['mcpServers.variable', 'invalid-variable'],
      ['mcpServers.undeclared', 'invalid-server'],
      ['mcpServers.helper', 'unsupported-component'],
      ['mcpServers.socket', 'unsupported-type'],
    ]))
    // Every stdio server declared is an executable of the trust consent, also a skipped one.
    expect(read.executables.map(item => item.label)).toEqual(['project', 'option', 'variable'])
  })

  it('reports unreadable and invalid files and keeps the others', async () => {
    const read = await readServers({ 'a.json': file('{ "mcpServers": '), 'b.json': file('[1]'), 'c.json': file(JSON.stringify({ ok: { type: 'http', url: 'https://ok.example.com/' } })) })
    expect(read.servers.map(server => server.id)).toEqual(['kit'])
    expect(read.diagnostics.map(item => item.code)).toEqual(['invalid-json', 'not-an-object'])
  })

  it('claudeMcpName replaces what tool names cannot hold', () => {
    expect(claudeMcpName('review-kit', 'review tools.v2')).toBe('plugin_review-kit_review_tools_v2')
  })
})

describe('a Claude Code plugin MCP server end to end', () => {
  it('the userConfig secret reaches the http server as a header and never a body, a DTO or a log', async () => {
    const echo: HttpEchoServer = await startHttpEchoServer()
    closers.push(() => echo.close())
    const secret = 'HF_CANARY-mcp-token-5e8c'
    const h: McpTestApp = await createMcpTestApp({
      beforeStart: async (t) => {
        const dir = join(t.env.paths.plugins, 'header-kit')
        await writeFileTree(dir, {
          '.claude-plugin/plugin.json': file(JSON.stringify({
            name: 'header-kit',
            userConfig: {
              URL: { type: 'string', title: 'URL', default: echo.url },
              TOKEN: { type: 'string', title: 'Token', sensitive: true },
            },
            mcpServers: { echo: { type: 'http', url: '${user_config.URL}', headers: { Authorization: 'Bearer ${user_config.TOKEN}' } } },
          })),
          'commands/use.md': file('---\ndescription: Use the token\n---\nToken: ${user_config.TOKEN}.\n'),
        })
        const inspection = await t.deps.plugins.inspectDirectory(dir, { format: 'claude' })
        expect(inspection.requiresTrust).toBe(false)
        await t.deps.plugins.saveRecord({ id: 'header-kit', source: 'copy', format: 'claude', version: inspection.manifest.version })
      },
    })
    closers.push(() => h.close())
    const { t } = h
    expect(t.deps.plugins.state('header-kit')).toBe('active')
    await t.deps.plugins.updateSettings('header-kit', { TOKEN: secret })
    await waitFor(() => echo.requests.some(headers => headers.authorization === `Bearer ${secret}`))
    await waitFor(async () => (await t.deps.mcp.get('header-kit')).status === 'connected')
    expect(t.deps.registry.mcpServers.get('header-kit')).toMatchObject({ claudeName: 'plugin_header-kit_echo', decl: { transport: { url: echo.url, headers: { Authorization: 'Bearer {{settings.TOKEN}}' } } } })
    expect(t.deps.registry.commands.get('header-kit:use')?.definition.template).toBe('Token: .')
    const dtos = JSON.stringify([await t.deps.plugins.get('header-kit'), await t.deps.plugins.getSettings('header-kit'), await t.deps.mcp.list(), await t.deps.plugins.logs('header-kit')])
    expect(dtos).not.toContain(secret)
    expect(JSON.stringify(t.logs.records)).not.toContain(secret)
  })
})
