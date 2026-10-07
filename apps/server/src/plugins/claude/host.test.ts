/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}` and `${user_config.KEY}` are literal plugin content */
// Claude Code plugins in the plugin host (W12.1-T3 … T6, T10): a `claude` row loads through the reader and the
// registration (qualified names, markdown commands, the agent fields, skills with `baseDir`, styles, hooks with the
// plugin environment, MCP servers with their Claude names); a pure-markdown plugin is active without trust, a plugin
// with a hook stays `untrusted` until pinned (the whole-tree hash: an edited script or a flipped exec bit unpins it);
// a folder placed by hand is detected; saving the settings reloads the plugin with the new option values; secrets never
// reach a body, a DTO or the plugin log; `bin/` and `.lsp.json` are never run.
import type { FixtureTree } from '../../testing/claude-fixtures.ts'
import type { PluginTestApp } from '../__fixtures__/harness.ts'
import { existsSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { pluginDetailSchema, pluginSummarySchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { claudePluginFiles, REVIEW_KIT_BIN_MARKER, writeFileTree } from '../../testing/claude-fixtures.ts'
import { createPluginTestApp, removeTempDirs } from '../__fixtures__/harness.ts'

const apps: PluginTestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  removeTempDirs()
})

async function app(): Promise<PluginTestApp> {
  const created = await createPluginTestApp({ start: false })
  apps.push(created)
  return created
}

/** Writes a Claude Code plugin into `plugins/<id>` and records it (`format: 'claude'`), pinned when `trust`. */
async function install(h: PluginTestApp, id: string, files: FixtureTree, options: { trust?: boolean, record?: boolean } = {}): Promise<string> {
  const dir = h.pluginDir(id)
  await writeFileTree(dir, files)
  if (options.record ?? true) {
    const inspection = await h.t.deps.plugins.inspectDirectory(dir, { format: 'claude' })
    await h.t.deps.plugins.saveRecord({
      id,
      source: 'copy',
      format: 'claude',
      version: inspection.manifest.version,
      ...(options.trust === true ? { trustedHash: inspection.sha256 } : {}),
    })
  }
  return dir
}

function file(content: string, mode = 0o644): { content: string, mode: number } {
  return { content, mode }
}

describe('a Claude Code plugin in the host', () => {
  it('review-kit loads once trusted: qualified commands, the agent, the skill, the style, hooks and MCP servers', async () => {
    const h = await app()
    await install(h, 'review-kit', claudePluginFiles('review-kit'), { trust: true })
    await h.t.deps.plugins.start()
    const { plugins: host, registry } = h.t.deps
    const detail = pluginDetailSchema.parse(await host.get('review-kit'))
    expect(detail).toMatchObject({ format: 'claude', state: 'active', kind: 'declarative', runsCode: true, editable: false, hasSettings: true, lastError: null, trust: { required: true, trusted: true } })
    pluginSummarySchema.parse(await host.summary('review-kit'))
    // The relay of W12.8: the detail's trust hash is the inspection's sha256 and the pin of an unchanged tree.
    const inspection = await host.inspectDirectory(h.pluginDir('review-kit'), { format: 'claude' })
    expect(detail.trust.hash).toBe(inspection.sha256)
    expect(detail.trust.trustedHash).toBe(inspection.sha256)
    expect(detail.contributions).toEqual({
      providers: [],
      models: 0,
      tools: [],
      // Registration order: `.mcp.json` first, then the inline servers of plugin.json.
      mcpServers: ['review-kit-review-tools', 'review-kit-review-api'],
      commands: ['review-kit:clean-gone', 'review-kit:db:migrate', 'review-kit:review'],
      hooks: [],
      commandHooks: 1,
      agents: ['review-kit:code-reviewer'],
      skills: ['review-kit:pdf'],
      outputStyles: ['review-kit:terse'],
    })
    const root = h.pluginDir('review-kit')
    expect(registry.commands.get('review-kit:review')?.definition.template).toContain(`${await realRoot(h, 'review-kit')}/skills/pdf/reference.md`)
    expect(registry.commands.get('review-kit:db:migrate')?.definition).toMatchObject({ syntax: 'markdown', argumentHint: '<table> <change>' })
    expect(registry.agents.get('review-kit:code-reviewer')).toMatchObject({ pluginId: 'review-kit', definition: { model: 'sonnet', color: 'blue' } })
    expect(registry.skills.get('review-kit:pdf')?.definition).toMatchObject({ baseDir: 'skills/pdf' })
    expect(registry.skills.get('review-kit:pdf')?.definition.content).toContain(`${await realRoot(h, 'review-kit')}/skills/pdf/reference.md`)
    expect(registry.styles.get('review-kit:terse')?.definition).toMatchObject({ keepCodingInstructions: true })
    expect(registry.hookCommands.get('review-kit')).toMatchObject({
      root: await realRoot(h, 'review-kit'),
      hooks: [{ event: 'PostToolUse', matcher: 'Write|Edit', command: '${CLAUDE_PLUGIN_ROOT}/hooks/format.sh' }],
      env: { CLAUDE_PLUGIN_DATA: join(h.t.env.paths.pluginData, 'review-kit'), CLAUDE_PLUGIN_OPTION_API_URL: 'https://review.example.com/mcp' },
    })
    expect(registry.hookCommands.get('review-kit')?.diagnostics.map(item => item.code)).toEqual(['unsupported-type', 'unknown-event'])
    // MCP servers: the plugin folder literal in the stdio arguments, the URL from the option default, the secret as a placeholder.
    expect(registry.mcpServers.get('review-kit-review-tools')).toMatchObject({
      claudeName: 'plugin_review-kit_review-tools',
      decl: { transport: { type: 'stdio', command: 'node', args: [`${await realRoot(h, 'review-kit')}/servers/mcp-min.mjs`, '--name', 'review-tools'], env: { TOKEN: '{{settings.API_TOKEN}}', API_URL: '{{settings.API_URL}}' } } },
    })
    expect(registry.mcpServers.get('review-kit-review-api')?.decl.transport).toEqual({ type: 'http', url: 'https://review.example.com/mcp', headers: { Authorization: 'Bearer {{settings.API_TOKEN}}' } })
    expect(detail.claude).toMatchObject({ namespace: 'review-kit', hosts: ['review.example.com', 'hooks.example.com'], components: { commands: 3, agents: 1, skills: 1, outputStyles: 1, hooks: 1, mcpServers: 2 } })
    // bin/ and .lsp.json are listed and never run.
    expect(detail.claude?.unsupported.map(part => part.component)).toEqual(expect.arrayContaining(['.lsp.json', 'bin/']))
    expect(existsSync(join(root, REVIEW_KIT_BIN_MARKER))).toBe(false)
    // Disable removes every registration; enable brings them back.
    await host.disable('review-kit')
    expect([registry.commands.get('review-kit:review'), registry.hookCommands.get('review-kit'), registry.mcpServers.get('review-kit-review-api')]).toEqual([undefined, undefined, undefined])
    await host.enable('review-kit')
    expect(registry.commands.get('review-kit:review')?.pluginId).toBe('review-kit')
  })

  it('a plugin with a hook stays untrusted (nothing registered) until pinned; trust refuses a stale hash', async () => {
    const h = await app()
    await install(h, 'review-kit', claudePluginFiles('review-kit'))
    await h.t.deps.plugins.start()
    const { plugins: host, registry } = h.t.deps
    expect(host.state('review-kit')).toBe('untrusted')
    expect([registry.commands.get('review-kit:review'), registry.hookCommands.get('review-kit'), registry.agents.get('review-kit:code-reviewer')]).toEqual([undefined, undefined, undefined])
    const detail = await host.get('review-kit')
    expect(detail.trust).toMatchObject({ required: true, trusted: false, trustedHash: null })
    // The declared contributions are listed before the plugin runs.
    expect(detail.contributions.commands).toEqual(['review-kit:clean-gone', 'review-kit:db:migrate', 'review-kit:review'])
    await expect(host.trust('review-kit', 'a'.repeat(64))).rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    const trusted = await host.trust('review-kit', detail.trust.hash!)
    expect(trusted.state).toBe('active')
    expect(registry.hookCommands.get('review-kit')?.hooks).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('editing a script or flipping an exec bit unpins the plugin (whole-tree hash)', async () => {
    const h = await app()
    const dir = await install(h, 'review-kit', claudePluginFiles('review-kit'), { trust: true })
    await h.t.deps.plugins.start()
    const host = h.t.deps.plugins
    expect(host.state('review-kit')).toBe('active')
    await writeFile(join(dir, 'hooks/format.sh'), `${await readFile(join(dir, 'hooks/format.sh'), 'utf8')}# edited\n`)
    await host.reload('review-kit')
    expect(host.state('review-kit')).toBe('untrusted')
    expect(h.t.deps.registry.hookCommands.get('review-kit')).toBeUndefined()
    const hash = (await host.get('review-kit')).trust.hash!
    await host.trust('review-kit', hash)
    expect(host.state('review-kit')).toBe('active')
    await chmod(join(dir, 'skills/pdf/scripts/fill.sh'), 0o644)
    await host.reload('review-kit')
    expect(host.state('review-kit')).toBe('untrusted')
  })

  it('a pure-markdown plugin is active without trust; a folder placed by hand is detected and remembered as claude', async () => {
    const h = await app()
    await install(h, 'notes-only', claudePluginFiles('notes-only'), { record: false })
    await h.t.deps.plugins.start()
    const { plugins: host, registry } = h.t.deps
    expect(await host.summary('notes-only')).toMatchObject({ format: 'claude', state: 'active', runsCode: false })
    expect((await host.get('notes-only')).trust).toMatchObject({ required: false, trusted: true })
    expect(await host.record('notes-only')).toMatchObject({ source: 'copy', format: 'claude', version: '0.0.0' })
    expect(registry.commands.get('notes-only:note')?.definition).toMatchObject({ syntax: 'markdown', description: 'Write a note about the current task' })
  })

  it('saving the settings reloads the plugin: option values reach bodies and the hook environment, secrets only the environment', async () => {
    const h = await app()
    await install(h, 'opts', {
      '.claude-plugin/plugin.json': file(JSON.stringify({
        name: 'opts',
        userConfig: {
          FOCUS: { type: 'string', title: 'Focus', default: 'bugs' },
          TOKEN: { type: 'string', title: 'Token', sensitive: true },
        },
      })),
      'commands/check.md': file('---\ndescription: Check\n---\nFocus ${user_config.FOCUS}; token "${user_config.TOKEN}"; data ${CLAUDE_PLUGIN_DATA}; spans keep !`echo ${user_config.FOCUS}`.\n'),
      'agents/helper.md': file('---\nname: helper\ndescription: Helps.\n---\nToken "${user_config.TOKEN}" and focus ${user_config.FOCUS}.\n'),
      'hooks/hooks.json': file(JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'sh', args: ['${CLAUDE_PLUGIN_ROOT}/hook.sh', '${user_config.FOCUS}'] }] }] } })),
      'hook.sh': file('#!/bin/sh\ncat > /dev/null\n', 0o755),
    }, { trust: true })
    await h.t.deps.plugins.start()
    const { plugins: host, registry } = h.t.deps
    const secret = 'HF_CANARY-plugin-token-7f3a'
    expect(host.state('opts')).toBe('active')
    expect(registry.commands.get('opts:check')?.definition.template).toBe(`Focus bugs; token ""; data ${join(h.t.env.paths.pluginData, 'opts')}; spans keep !\`echo \${user_config.FOCUS}\`.`)
    await host.updateSettings('opts', { FOCUS: 'style', TOKEN: secret })
    expect(host.state('opts')).toBe('active')
    expect(registry.commands.get('opts:check')?.definition.template).toContain('Focus style; token "";')
    expect(registry.agents.get('opts:helper')?.definition.instructions).toBe('Token "" and focus style.')
    const hooks = registry.hookCommands.get('opts')!
    // W12.16: the option reference stays as written; the runner substitutes it at spawn from the environment below.
    expect(hooks.hooks[0]?.args).toEqual([`${await realRoot(h, 'opts')}/hook.sh`, '${user_config.FOCUS}'])
    expect(hooks.env).toEqual({ CLAUDE_PLUGIN_DATA: join(h.t.env.paths.pluginData, 'opts'), CLAUDE_PLUGIN_OPTION_FOCUS: 'style', CLAUDE_PLUGIN_OPTION_TOKEN: secret })
    // The secret is in no DTO and no log entry.
    const dtos = JSON.stringify([await host.get('opts'), await host.getSettings('opts'), await host.list(), await host.logs('opts')])
    expect(dtos).not.toContain(secret)
    expect(JSON.stringify([...registry.commands.list(), ...registry.agents.list()])).not.toContain(secret)
  })

  it('never reads process.env for a variable of a plugin MCP server', async () => {
    const h = await app()
    const canary = 'HF_CANARY-process-env-91c2'
    process.env.HF_W121_CANARY_VAR = canary
    try {
      await install(h, 'env-kit', {
        '.mcp.json': file(JSON.stringify({ mcpServers: { api: { type: 'http', url: 'https://api.example.com/mcp', headers: { 'X-Key': '${HF_W121_CANARY_VAR}' } } } })),
      })
      await h.t.deps.plugins.start()
      const server = h.t.deps.registry.mcpServers.get('env-kit')
      expect(server?.decl.transport).toEqual({ type: 'http', url: 'https://api.example.com/mcp', headers: { 'X-Key': '{{settings.env_HF_W121_CANARY_VAR}}' } })
      expect((await h.t.deps.plugins.getSettings('env-kit')).schema?.properties.env_HF_W121_CANARY_VAR).toMatchObject({ type: 'string', format: 'secret' })
      expect(JSON.stringify(await h.t.deps.plugins.settingsValues('env-kit'))).not.toContain(canary)
    }
    finally {
      delete process.env.HF_W121_CANARY_VAR
    }
  })

  it('inspectDirectory: the Claude Code info; an unusable plugin is a validation_error; compile is forbidden', async () => {
    const h = await app()
    const dir = await install(h, 'review-kit', claudePluginFiles('review-kit'), { record: false })
    await h.t.deps.plugins.start()
    const inspection = await h.t.deps.plugins.inspectDirectory(dir, { format: 'claude' })
    expect(inspection).toMatchObject({ format: 'claude', kind: 'declarative', requiresTrust: true, compatible: true, reserved: false, manifest: { id: 'review-kit' } })
    expect(inspection.claude?.executables.map(item => item.kind)).toEqual(['hook', 'hook', 'mcp'])
    expect(inspection.files.count).toBe(Object.keys(claudePluginFiles('review-kit')).length)
    const broken = h.pluginDir('broken')
    await writeFileTree(broken, claudePluginFiles('broken'))
    await expect(h.t.deps.plugins.inspectDirectory(broken, { format: 'claude' })).rejects.toMatchObject({ code: 'validation_error' })
    // Without the format the folder is read as a harness plugin (no plugin.json at its root).
    await expect(h.t.deps.plugins.inspectDirectory(dir)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(h.t.deps.plugins.compile('review-kit')).rejects.toMatchObject({ code: 'forbidden' })
  })
})

async function realRoot(h: PluginTestApp, id: string): Promise<string> {
  return (await h.t.deps.plugins.directory(id))!
}
