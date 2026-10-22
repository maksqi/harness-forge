// A Claude Code plugin's stdio MCP server and the trust pin (v1.8.1, ADR-053): the plugin's whole tree is hashed again
// right before its server starts, so an unchanged trusted plugin connects (and reconnects), while a file edited after the
// trust keeps the server from starting (a permanent `forbidden` error, no new process) and leaves the plugin `untrusted`.
import type { FixtureTree } from '../testing/claude-fixtures.ts'
import type { McpTestApp } from './__fixtures__/harness.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileTree } from '../testing/claude-fixtures.ts'
import { createMcpTestApp, MCP_MIN_PATH, waitFor } from './__fixtures__/harness.ts'

const apps: McpTestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

/** A Claude Code plugin with one stdio server (`mcp-min.mjs`, which appends its pid to `pidFile` at start). */
function serverPlugin(pidFile: string): FixtureTree {
  return {
    '.claude-plugin/plugin.json': { content: JSON.stringify({ name: 'mcp-kit', version: '1.0.0' }), mode: 0o644 },
    '.mcp.json': { content: JSON.stringify({ mcpServers: { tools: { command: process.execPath, args: [MCP_MIN_PATH, '--name', 'tools', '--pid-file', pidFile] } } }), mode: 0o644 },
    'README.md': { content: '# mcp-kit\n', mode: 0o644 },
  }
}

async function starts(pidFile: string): Promise<number> {
  return (await readFile(pidFile, 'utf8').catch(() => '')).split('\n').filter(line => line.trim() !== '').length
}

describe('the stdio server of a trusted Claude Code plugin', () => {
  it('connects and reconnects while the tree is unchanged; after an edit it does not start and the plugin turns untrusted', async () => {
    let dir = ''
    let pidFile = ''
    const h = await createMcpTestApp({
      beforeStart: async (t) => {
        dir = join(t.env.paths.plugins, 'mcp-kit')
        pidFile = join(t.env.dataDir, 'mcp-kit.pids')
        await writeFileTree(dir, serverPlugin(pidFile))
        const inspection = await t.deps.plugins.inspectDirectory(dir, { format: 'claude' })
        await t.deps.plugins.saveRecord({ id: 'mcp-kit', source: 'copy', format: 'claude', version: inspection.manifest.version, trustedHash: inspection.sha256 })
      },
    })
    apps.push(h)
    const { plugins, mcp, registry } = h.t.deps
    expect(plugins.state('mcp-kit')).toBe('active')
    await waitFor(async () => (await mcp.get('mcp-kit')).status === 'connected')
    expect(await starts(pidFile)).toBe(1)

    // Unchanged: a reconnect starts the server again.
    expect((await mcp.reconnect('mcp-kit')).status).toBe('connected')
    expect(await starts(pidFile)).toBe(2)

    // Edited after the trust: the reconnect starts nothing; the plugin is loaded again and waits for trust.
    await writeFile(join(dir, 'README.md'), '# mcp-kit, edited\n')
    await mcp.reconnect('mcp-kit').catch(() => null)
    await waitFor(() => plugins.state('mcp-kit') === 'untrusted')
    expect(await starts(pidFile)).toBe(2)
    expect(registry.mcpServers.get('mcp-kit')).toBeUndefined()
    const logs = await plugins.logs('mcp-kit')
    expect(logs.some(entry => entry.message.includes('changed after it was trusted, so its stdio MCP server "mcp-kit" is not started'))).toBe(true)
  })
})
