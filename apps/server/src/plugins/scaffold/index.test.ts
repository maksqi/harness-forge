// PluginFiles service (W3.4-T2, T3): every template scaffolds and loads `active` with a working contribution, the
// traversal-safe file API, stale writes, fresh-auth decisions, trust re-pinning (ADR-017) and builds with diagnostics.
import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { Mock } from 'vitest'
import type { PluginTestApp } from '../__fixtures__/harness.ts'
import type { BuiltinPlugin, PluginFiles } from '../types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { generateText } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginTestApp, manifest, removeTempDirs, tempDir, writeFiles } from '../__fixtures__/harness.ts'

let h: PluginTestApp
let files: PluginFiles

const CORE_TOOLS: BuiltinPlugin = {
  id: 'core-tools',
  manifest: { manifestVersion: 1, id: 'core-tools', name: 'Core tools', version: '1.0.0', engines: { harness: '^1.0.0' } },
  module: { setup: () => {} },
}

function freshAuth(): { requireFreshAuth: Mock<() => void> } {
  return { requireFreshAuth: vi.fn<() => void>() }
}

function denyFreshAuth(): { requireFreshAuth: () => never } {
  return {
    requireFreshAuth: () => {
      throw new HarnessError({ code: 'forbidden', message: 'Confirm your password.', action: 'login' })
    },
  }
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    if (error instanceof HarnessError)
      return error
    throw error
  }
  throw new Error('Expected a rejection.')
}

function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex')
}

function toolContext(): ToolCallContext {
  return { chatId: 'chat', modelRef: 'mock:echo', toolCallId: 'call-1', messages: [], signal: new AbortController().signal }
}

/** Whether names differ only in case on the file system of the temp directory. */
function caseInsensitiveFs(): boolean {
  const dir = tempDir('hf-case-')
  writeFileSync(join(dir, 'probe'), '')
  return existsSync(join(dir, 'PROBE'))
}

beforeEach(async () => {
  h = await createPluginTestApp({ builtins: [CORE_TOOLS] })
  files = h.t.deps.pluginFiles
})

afterEach(async () => {
  await h.close()
  removeTempDirs()
})

describe.each(['js', 'ts'] as const)('scaffold (%s)', (language) => {
  const entry = language === 'ts' ? 'index.ts' : 'index.mjs'

  it('tool: created, trusted, active, and the tool counts words', async () => {
    const detail = await files.scaffold({ id: 'text-tools', name: 'Text tools', template: 'tool', language })
    expect(detail).toMatchObject({
      id: 'text-tools',
      name: 'Text tools',
      kind: 'code',
      source: 'created',
      state: 'active',
      enabled: true,
      editable: true,
      trust: { required: true, trusted: true },
    })
    expect(detail.contributions.tools).toEqual(['text_tools_text_stats'])
    expect(readdirSync(h.pluginDir('text-tools')).sort()).toEqual(['README.md', 'harness-forge.d.ts', entry, 'plugin.json'].sort())
    const tool = h.t.deps.registry.tools.get('text_tools_text_stats')
    expect(tool?.definition.policy).toBe('ask')
    const output = await tool!.definition.execute({ text: 'one two\nthree' }, toolContext())
    expect(output).toEqual({ characters: 13, words: 3, lines: 2, readingMinutes: 1 })
    if (language === 'ts')
      expect(readdirSync(join(h.t.env.paths.pluginCache, 'text-tools')).some(name => name.endsWith('.mjs'))).toBe(true)
  })

  it('provider: registered, lists models and generates text through an OpenAI-compatible API', async () => {
    const requests: Array<{ url: string, authorization?: string }> = []
    const server = createServer((request, response) => {
      requests.push({ url: request.url ?? '', authorization: request.headers.authorization })
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/models') {
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'alpha', object: 'model' }, { id: 'beta', object: 'model' }] }))
        return
      }
      request.resume()
      request.on('end', () => response.end(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'alpha',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      })))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      const detail = await files.scaffold({ id: 'my-gateway', name: 'My gateway', template: 'provider', language })
      expect(detail).toMatchObject({ state: 'active', contributions: { providers: ['my-gateway'] } })
      const provider = h.t.deps.registry.providers.get('my-gateway')!.definition
      expect(provider.name).toBe('My gateway')
      expect(provider.credentials.map(field => [field.key, field.type, field.required ?? false])).toEqual([['baseURL', 'url', true], ['apiKey', 'secret', false]])

      await h.t.deps.credentials.set('my-gateway', { baseURL: `http://127.0.0.1:${port}/v1/`, apiKey: 'sk-test-key' })
      const runtime = await h.t.deps.providers.runtime('my-gateway')
      expect(await provider.listModels!(runtime)).toEqual([{ id: 'alpha' }, { id: 'beta' }])
      const { text } = await generateText({ model: provider.createLanguageModel('alpha', runtime), prompt: 'ping' })
      expect(text).toBe('pong')
      expect(requests.map(item => item.url)).toEqual(['/v1/models', '/v1/chat/completions'])
      expect(requests.every(item => item.authorization === 'Bearer sk-test-key')).toBe(true)
    }
    finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('mcp bridge: registers the MCP server once a URL is configured and follows settings changes', async () => {
    const detail = await files.scaffold({ id: 'docs-bridge', name: 'Docs bridge', template: 'mcp-bridge', language })
    expect(detail).toMatchObject({ state: 'active', hasSettings: true })
    const servers = h.t.deps.registry.mcpServers
    expect(servers.get('docs-bridge')).toBeUndefined()

    await h.t.deps.plugins.updateSettings('docs-bridge', { serverUrl: 'https://mcp.example.test/mcp' })
    expect(servers.get('docs-bridge')?.decl).toEqual({
      id: 'docs-bridge',
      name: 'Docs bridge',
      policy: 'ask',
      transport: { type: 'http', url: 'https://mcp.example.test/mcp' },
    })

    await h.t.deps.plugins.updateSettings('docs-bridge', { token: 'secret-token-value' })
    expect(servers.get('docs-bridge')?.decl.transport).toEqual({
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { Authorization: 'Bearer {{settings.token}}' },
    })

    await h.t.deps.plugins.updateSettings('docs-bridge', { serverUrl: null })
    expect(servers.get('docs-bridge')).toBeUndefined()
  })

  it('command pack: a template command and a run command that replies without a model', async () => {
    const detail = await files.scaffold({ id: 'writing', name: 'Writing', template: 'command-pack', language })
    expect(detail).toMatchObject({ state: 'active', contributions: { commands: ['tldr', 'wordcount'] } })
    const commands = h.t.deps.registry.commands
    expect(commands.get('tldr')?.definition.template).toBe('Summarize the following text in three short bullet points:\n\n{{input}}')
    const run = commands.get('wordcount')!.definition.run!
    const signal = new AbortController().signal
    expect(await run({ input: 'one two three', chatId: 'chat', signal })).toEqual({ type: 'reply', markdown: '**3** words' })
    expect(await run({ input: 'one', chatId: 'chat', signal })).toEqual({ type: 'reply', markdown: '**1** word' })
    expect(await run({ input: '', chatId: 'chat', signal })).toEqual({ type: 'reply', markdown: '**0** words' })

    // A second pack picks free names instead of failing on a conflict.
    const second = await files.scaffold({ id: 'writing-two', name: 'Writing two', template: 'command-pack', language })
    expect(second).toMatchObject({ state: 'active', contributions: { commands: ['tldr-2', 'wordcount-2'] } })
  })
})

describe('scaffold rules', () => {
  it('refuses reserved ids, existing ids and invalid names', async () => {
    expect(await rejection(files.scaffold({ id: 'core-extra', name: 'X', template: 'tool' }))).toMatchObject({ code: 'forbidden' })
    expect(await rejection(files.scaffold({ id: 'openai', name: 'X', template: 'tool' }))).toMatchObject({ code: 'forbidden' })

    await files.scaffold({ id: 'taken', name: 'Taken', template: 'tool' })
    expect(await rejection(files.scaffold({ id: 'taken', name: 'Again', template: 'command-pack' })))
      .toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    // A folder placed by hand counts as existing too.
    await h.install({ id: 'by-hand', files: { 'plugin.json': manifest('by-hand') } })
    expect(await rejection(files.scaffold({ id: 'by-hand', name: 'X', template: 'tool' })))
      .toMatchObject({ code: 'conflict', details: { reason: 'exists' } })

    expect(await rejection(files.scaffold({ id: 'long-name', name: 'x'.repeat(65), template: 'tool' })))
      .toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['name'] }] } })
    expect(await rejection(files.scaffold({ id: 'line-break', name: 'a\nb', template: 'tool' })))
      .toMatchObject({ code: 'validation_error' })
    expect(await rejection(files.scaffold({ id: 'a'.repeat(33), name: 'Too long', template: 'mcp-bridge' })))
      .toMatchObject({ code: 'validation_error' })
    // Failed scaffolds leave nothing behind (the staging folder is gone).
    expect(existsSync(h.pluginDir('long-name'))).toBe(false)
    expect(readdirSync(h.t.env.paths.pluginStaging)).toEqual([])
  })

  it('pins the trust hash of the created files and logs the creation', async () => {
    const detail = await files.scaffold({ id: 'pinned', name: 'Pinned', template: 'tool' })
    const record = await h.t.deps.plugins.record('pinned')
    expect(record).toMatchObject({ source: 'created', enabled: true })
    expect(record?.trustedHash).toBe(detail.trust.hash)
    expect(h.events.ofType('plugin.log').map(event => event.data.entry.message)).toContain('Created from the Tool template.')
  })
})

describe('list and read', () => {
  it('lists folders first, then files, with editable flags; skips node_modules, .git and links', async () => {
    await files.scaffold({ id: 'tree', name: 'Tree', template: 'tool' })
    const dir = h.pluginDir('tree')
    writeFiles(dir, { 'lib/util.mjs': 'export const x = 1\n', 'node_modules/pkg/index.js': 'x', '.git/config': 'x' })
    writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0]))
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(LIMITS.pluginFileBytes + 1))
    symlinkSync(join(dir, 'README.md'), join(dir, 'link.md'))
    const entries = await files.list('tree')
    expect(entries.map(entry => [entry.path, entry.type, entry.editable])).toEqual([
      ['lib', 'dir', false],
      ['README.md', 'file', true],
      ['big.txt', 'file', false],
      ['harness-forge.d.ts', 'file', true],
      ['image.png', 'file', false],
      ['index.mjs', 'file', true],
      ['lib/util.mjs', 'file', true],
      ['plugin.json', 'file', true],
    ])
    const readme = entries.find(entry => entry.path === 'README.md')!
    expect(readme.size).toBe(readFileSync(join(dir, 'README.md')).length)
    expect(readme.mtime).toBeGreaterThan(0)
  })

  it('reads text files with their etag, and refuses traversal, links, folders, binaries and big files', async () => {
    await files.scaffold({ id: 'reader', name: 'Reader', template: 'tool' })
    const dir = h.pluginDir('reader')
    const outside = tempDir('hf-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'escape.txt'))
    symlinkSync(outside, join(dir, 'escaped-dir'))
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 2, 0, 3]))
    writeFileSync(join(dir, 'latin1.txt'), Buffer.from([0xE9, 0x74, 0xE9]))
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(LIMITS.pluginFileBytes + 1))

    const content = await files.read('reader', 'plugin.json')
    const raw = readFileSync(join(dir, 'plugin.json'))
    expect(content).toMatchObject({ path: 'plugin.json', content: raw.toString('utf8'), etag: sha256(raw) })

    for (const path of ['../reader/plugin.json', '/etc/passwd', 'a/../plugin.json', 'a\\b', 'x\0y', './plugin.json', ''])
      expect(await rejection(files.read('reader', path)), path).toMatchObject({ code: 'validation_error' })
    for (const path of ['escape.txt', 'escaped-dir/secret.txt', 'lib', 'blob.bin', 'latin1.txt'])
      expect(await rejection(files.read('reader', path)), path).toMatchObject({ code: 'validation_error' })
    expect(await rejection(files.read('reader', 'big.txt'))).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.pluginFileBytes } })
    expect(await rejection(files.read('reader', 'missing.mjs'))).toMatchObject({ code: 'not_found' })
    expect(await rejection(files.read('reader', 'missing/deeper.mjs'))).toMatchObject({ code: 'not_found' })
    expect(await rejection(files.read('unknown', 'plugin.json'))).toMatchObject({ code: 'not_found' })
    expect(await rejection(files.read('core-tools', 'plugin.json'))).toMatchObject({ code: 'forbidden' })
    expect(await rejection(files.list('core-tools'))).toMatchObject({ code: 'forbidden' })
  })

  it('never opens .git or node_modules and keeps hidden files read-only', async () => {
    await files.scaffold({ id: 'hidden', name: 'Hidden', template: 'tool' })
    writeFiles(h.pluginDir('hidden'), {
      '.git/config': '[remote "origin"]\n  url = https://token@example.com/repo.git\n',
      'node_modules/pkg/index.js': 'x',
      '.gitignore': 'dist\n',
    })
    expect(await rejection(files.read('hidden', '.git/config'))).toMatchObject({ code: 'validation_error' })
    expect(await rejection(files.read('hidden', 'node_modules/pkg/index.js'))).toMatchObject({ code: 'validation_error' })
    expect((await files.read('hidden', '.gitignore')).content).toBe('dist\n')
    expect((await files.list('hidden')).find(entry => entry.path === '.gitignore')).toMatchObject({ editable: false })
    for (const path of ['.git/hooks/pre-commit', '.vscode/tasks.json', '.gitignore', 'lib/.env'])
      expect(await rejection(files.write('hidden', path, { content: 'x' }, freshAuth())), path).toMatchObject({ code: 'validation_error' })
    expect(await rejection(files.remove('hidden', '.gitignore', freshAuth()))).toMatchObject({ code: 'validation_error' })
    expect(existsSync(join(h.pluginDir('hidden'), '.git/hooks'))).toBe(false)
  })

  it('refuses a letter-case alias of an existing file', async () => {
    await files.scaffold({ id: 'cased', name: 'Cased', template: 'tool' })
    const error = await rejection(files.read('cased', 'PLUGIN.json'))
    expect(error.code).toBe(caseInsensitiveFs() ? 'validation_error' : 'not_found')
    if (caseInsensitiveFs()) {
      // Writing "Plugin.json" would overwrite plugin.json without its manifest checks.
      expect(await rejection(files.write('cased', 'Plugin.json', { content: '{}' }, freshAuth()))).toMatchObject({ code: 'validation_error' })
    }
    else {
      await files.write('cased', 'Plugin.json', { content: '{}' }, freshAuth())
      expect(readFileSync(join(h.pluginDir('cased'), 'plugin.json'), 'utf8')).not.toBe('{}')
    }
  })
})

describe('write', () => {
  it('creates files and folders, checks the etag and keeps the file on a stale write', async () => {
    await files.scaffold({ id: 'writer', name: 'Writer', template: 'tool' })
    const options = freshAuth()
    const entry = await files.write('writer', 'lib/deep/util.mjs', { content: 'export const answer = 42\n' }, options)
    expect(entry).toMatchObject({ path: 'lib/deep/util.mjs', type: 'file', size: 25, editable: true })
    expect(readFileSync(join(h.pluginDir('writer'), 'lib/deep/util.mjs'), 'utf8')).toBe('export const answer = 42\n')
    expect(options.requireFreshAuth).toHaveBeenCalledTimes(1)

    const current = await files.read('writer', 'README.md')
    await files.write('writer', 'README.md', { content: '# Changed\n', baseEtag: current.etag }, options)
    const stale = await rejection(files.write('writer', 'README.md', { content: '# Lost\n', baseEtag: current.etag }, options))
    expect(stale).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    expect(readFileSync(join(h.pluginDir('writer'), 'README.md'), 'utf8')).toBe('# Changed\n')
    const deleted = await rejection(files.write('writer', 'gone.md', { content: 'x', baseEtag: current.etag }, options))
    expect(deleted).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    // No temporary files are left behind.
    expect(readdirSync(h.pluginDir('writer')).some(name => name.startsWith('.hf-write-'))).toBe(false)
  })

  it('serializes concurrent writes: only one of two writes with the same etag wins', async () => {
    await files.scaffold({ id: 'racer', name: 'Racer', template: 'tool' })
    const { etag } = await files.read('racer', 'README.md')
    const results = await Promise.allSettled([
      files.write('racer', 'README.md', { content: 'first\n', baseEtag: etag }, freshAuth()),
      files.write('racer', 'README.md', { content: 'second\n', baseEtag: etag }, freshAuth()),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('validates plugin.json: JSON, the manifest schema and the same id', async () => {
    await files.scaffold({ id: 'manifested', name: 'Manifested', template: 'tool' })
    const options = freshAuth()
    const current = JSON.parse(readFileSync(join(h.pluginDir('manifested'), 'plugin.json'), 'utf8')) as Record<string, unknown>
    expect(await rejection(files.write('manifested', 'plugin.json', { content: '{ nope' }, options))).toMatchObject({ code: 'validation_error' })
    expect(await rejection(files.write('manifested', 'plugin.json', { content: JSON.stringify({ ...current, id: 'other' }) }, options)))
      .toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['id'] }] } })
    expect(await rejection(files.write('manifested', 'plugin.json', { content: JSON.stringify({ ...current, unknown: 1 }) }, options)))
      .toMatchObject({ code: 'validation_error' })
    await files.write('manifested', 'plugin.json', { content: `${JSON.stringify({ ...current, description: 'Updated.' }, null, 2)}\n` }, options)
    expect(JSON.parse(readFileSync(join(h.pluginDir('manifested'), 'plugin.json'), 'utf8'))).toMatchObject({ description: 'Updated.' })
  })

  it('refuses NUL characters and files over 1 MB', async () => {
    await files.scaffold({ id: 'limits', name: 'Limits', template: 'tool' })
    expect(await rejection(files.write('limits', 'a.md', { content: 'a\0b' }, freshAuth()))).toMatchObject({ code: 'validation_error' })
    const big = '\u00E9'.repeat(LIMITS.pluginFileBytes / 2 + 1)
    expect(await rejection(files.write('limits', 'a.md', { content: big }, freshAuth())))
      .toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.pluginFileBytes } })
    expect(existsSync(join(h.pluginDir('limits'), 'a.md'))).toBe(false)
  })

  it('refuses writes through links and into folders outside the plugin', async () => {
    await files.scaffold({ id: 'linked', name: 'Linked', template: 'tool' })
    const outside = tempDir('hf-outside-')
    symlinkSync(outside, join(h.pluginDir('linked'), 'out'))
    symlinkSync(join(outside, 'x.md'), join(h.pluginDir('linked'), 'dangling.md'))
    expect(await rejection(files.write('linked', 'out/evil.mjs', { content: 'x' }, freshAuth()))).toMatchObject({ code: 'validation_error' })
    expect(await rejection(files.write('linked', 'dangling.md', { content: 'x' }, freshAuth()))).toMatchObject({ code: 'validation_error' })
    expect(readdirSync(outside)).toEqual([])
  })

  it('asks for fresh auth for plugins that run code, also when plugin.json would add code', async () => {
    await files.scaffold({ id: 'code-plugin', name: 'Code', template: 'tool' })
    const denied = await rejection(files.write('code-plugin', 'README.md', { content: 'x' }, denyFreshAuth()))
    expect(denied).toMatchObject({ code: 'forbidden', action: 'login' })
    expect(readFileSync(join(h.pluginDir('code-plugin'), 'README.md'), 'utf8')).not.toBe('x')

    // A declarative plugin (copied folder): plain edits need no fresh auth...
    await h.install({ id: 'plain', files: { 'plugin.json': manifest('plain') }, enabled: true })
    await h.t.deps.plugins.load('plain')
    const options = freshAuth()
    await files.write('plain', 'notes.md', { content: 'notes' }, options)
    expect(options.requireFreshAuth).not.toHaveBeenCalled()
    // ...but a manifest that adds an entry (or a stdio MCP server) does.
    const withMain = JSON.stringify(manifest('plain', { main: 'index.mjs' }))
    expect(await rejection(files.write('plain', 'plugin.json', { content: withMain }, denyFreshAuth()))).toMatchObject({ code: 'forbidden' })
    const withStdio = JSON.stringify(manifest('plain', {
      contributes: { mcpServers: [{ id: 'plain', name: 'Plain', transport: { type: 'stdio', command: 'node' } }] },
    }))
    expect(await rejection(files.write('plain', 'plugin.json', { content: withStdio }, denyFreshAuth()))).toMatchObject({ code: 'forbidden' })
    expect(JSON.parse(readFileSync(join(h.pluginDir('plain'), 'plugin.json'), 'utf8'))).toEqual(manifest('plain'))
  })

  it('reloads a declarative plugin when its plugin.json is written', async () => {
    await h.install({ id: 'decl', files: { 'plugin.json': manifest('decl') }, enabled: true })
    await h.t.deps.plugins.load('decl')
    const command = { name: 'decl-hello', description: 'Say hello', template: 'Say hello to {{input}}' }
    await files.write('decl', 'plugin.json', { content: JSON.stringify(manifest('decl', { contributes: { commands: [command] } })) }, freshAuth())
    expect(h.t.deps.registry.commands.get('decl-hello')?.definition.template).toBe(command.template)
    expect((await h.t.deps.plugins.get('decl')).contributions.commands).toEqual(['decl-hello'])
  })

  it('refuses writes to plugins installed from npm, zip or URL, and to builtins', async () => {
    await h.install({ id: 'from-npm', files: { 'plugin.json': manifest('from-npm') }, enabled: true })
    await h.t.deps.plugins.saveRecord({ id: 'from-npm', source: 'npm', sourceRef: 'from-npm@1.0.0', version: '1.0.0' })
    await h.t.deps.plugins.load('from-npm')
    const forbidden = await rejection(files.write('from-npm', 'notes.md', { content: 'x' }, freshAuth()))
    expect(forbidden).toMatchObject({ code: 'forbidden', message: 'Installed from npm. Editing is disabled.' })
    expect(await rejection(files.remove('from-npm', 'plugin.json', freshAuth()))).toMatchObject({ code: 'forbidden' })
    // Reading stays possible (read-only source view).
    expect((await files.read('from-npm', 'plugin.json')).content).toContain('"from-npm"')
    expect((await files.list('from-npm')).every(entry => !entry.editable)).toBe(true)
    expect(await rejection(files.write('core-tools', 'x.md', { content: 'x' }, freshAuth()))).toMatchObject({ code: 'forbidden' })
  })
})

describe('trust re-pinning (ADR-017)', () => {
  it('a save of a created plugin keeps it trusted across a reload', async () => {
    await files.scaffold({ id: 'keeps-trust', name: 'Keeps trust', template: 'tool' })
    const source = (await files.read('keeps-trust', 'index.mjs')).content
    await files.write('keeps-trust', 'index.mjs', { content: source.replace('estimate its reading time', 'estimate the reading time') }, freshAuth())
    const reloaded = await h.t.deps.plugins.reload('keeps-trust')
    expect(reloaded).toMatchObject({ state: 'active', trust: { trusted: true } })
    expect(h.t.deps.registry.tools.get('keeps_trust_text_stats')?.definition.description).toContain('estimate the reading time')
  })

  it('files changed outside the editor still need re-trust after an editor save', async () => {
    await files.scaffold({ id: 'tampered', name: 'Tampered', template: 'tool' })
    const entryPath = join(h.pluginDir('tampered'), 'index.mjs')
    writeFileSync(entryPath, `${readFileSync(entryPath, 'utf8')}\n// changed on disk\n`)
    await files.write('tampered', 'README.md', { content: '# Edited\n' }, freshAuth())
    expect(await h.t.deps.plugins.reload('tampered')).toMatchObject({ state: 'untrusted' })
    expect(h.events.ofType('plugin.log').map(event => event.data.entry.message))
      .toContain('Saved. The plugin stays untrusted: its files were changed outside the editor. Review and trust it.')
  })

  it('a copied code plugin becomes untrusted when its entry changes', async () => {
    await h.install({
      id: 'copied',
      files: { 'plugin.json': manifest('copied', { main: 'index.mjs' }), 'index.mjs': 'export default { setup() {} }\n' },
      trust: true,
    })
    await h.t.deps.plugins.load('copied')
    expect((await h.t.deps.plugins.get('copied')).state).toBe('active')
    await files.write('copied', 'index.mjs', { content: 'export default { setup() { } }\n' }, freshAuth())
    expect(await h.t.deps.plugins.reload('copied')).toMatchObject({ state: 'untrusted' })
  })
})

describe('remove', () => {
  it('deletes files and empty folders; refuses plugin.json, the entry, the icon, folders and missing files', async () => {
    await files.scaffold({ id: 'remover', name: 'Remover', template: 'tool' })
    const options = freshAuth()
    await files.write('remover', 'lib/deep/util.mjs', { content: 'x\n' }, options)
    await files.remove('remover', 'lib/deep/util.mjs', options)
    expect(existsSync(join(h.pluginDir('remover'), 'lib'))).toBe(false)
    await files.remove('remover', 'README.md', options)
    expect(existsSync(join(h.pluginDir('remover'), 'README.md'))).toBe(false)

    for (const path of ['plugin.json', 'index.mjs'])
      expect(await rejection(files.remove('remover', path, options)), path).toMatchObject({ code: 'validation_error' })
    mkdirSync(join(h.pluginDir('remover'), 'folder'))
    expect(await rejection(files.remove('remover', 'folder', options))).toMatchObject({ code: 'validation_error' })
    expect(await rejection(files.remove('remover', 'missing.md', options))).toMatchObject({ code: 'not_found' })
    expect(await rejection(files.remove('remover', 'harness-forge.d.ts', denyFreshAuth()))).toMatchObject({ code: 'forbidden' })
    expect(existsSync(join(h.pluginDir('remover'), 'harness-forge.d.ts'))).toBe(true)

    await h.install({ id: 'iconic', files: { 'plugin.json': manifest('iconic', { icon: 'icon.svg' }), 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' }, enabled: true })
    await h.t.deps.plugins.load('iconic')
    expect(await rejection(files.remove('iconic', 'icon.svg', options))).toMatchObject({ code: 'validation_error' })
  })
})

describe('build', () => {
  it('reports syntax errors as diagnostics, keeps the running version and logs the build', async () => {
    await files.scaffold({ id: 'builder', name: 'Builder', template: 'tool' })
    const pinBefore = (await h.t.deps.plugins.record('builder'))?.trustedHash
    await files.write('builder', 'index.mjs', { content: 'export default {\n  setup(ctx) {\n    const = 1\n  },\n}\n' }, freshAuth())
    h.events.clear()
    const result = await files.build('builder', {})
    expect(result).toMatchObject({ ok: false, hash: null, state: 'active' })
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', file: 'index.mjs', line: 3, column: 11 })
    expect(result.diagnostics[0]?.message).toMatch(/Expected identifier/)
    expect(h.t.deps.registry.tools.get('builder_text_stats')).toBeDefined()
    const messages = h.events.ofType('plugin.log').map(event => event.data.entry.message)
    expect(messages[0]).toBe('Build started.')
    expect(messages.some(message => message.startsWith('index.mjs:3:11: '))).toBe(true)
    expect(messages).toContain('Build failed with 1 error.')
    // The save re-pinned the files; the failed build pinned nothing new.
    expect((await h.t.deps.plugins.record('builder'))?.trustedHash).not.toBe(pinBefore)
  })

  it('re-pins and reloads on success', async () => {
    await files.scaffold({ id: 'rebuilt', name: 'Rebuilt', template: 'tool' })
    const source = (await files.read('rebuilt', 'index.mjs')).content
    // Changed on disk (not through the editor): the build makes the reviewed code the trusted version.
    writeFileSync(join(h.pluginDir('rebuilt'), 'index.mjs'), source.replace('policy: \'ask\'', 'policy: \'safe\''))
    const result = await files.build('rebuilt', { reload: true })
    const inspection = await h.t.deps.plugins.inspectDirectory(h.pluginDir('rebuilt'))
    expect(result).toMatchObject({ ok: true, diagnostics: [], hash: inspection.sha256, state: 'active' })
    expect((await h.t.deps.plugins.get('rebuilt')).trust.trusted).toBe(true)
    expect(h.t.deps.registry.tools.get('rebuilt_text_stats')?.definition.policy).toBe('safe')
  })

  it('compiles TypeScript entries into the cache', async () => {
    await files.scaffold({ id: 'typed', name: 'Typed', template: 'command-pack', language: 'ts' })
    const result = await files.build('typed', {})
    expect(result).toMatchObject({ ok: true, state: 'active' })
    expect(readdirSync(join(h.t.env.paths.pluginCache, 'typed')).filter(name => name.endsWith('.mjs'))).toHaveLength(1)
  })

  it('reports a setup failure after a successful build as an error diagnostic', async () => {
    await files.scaffold({ id: 'thrower', name: 'Thrower', template: 'tool' })
    await files.write('thrower', 'index.mjs', { content: 'export default { setup() { throw new Error(\'boom\') } }\n' }, freshAuth())
    const result = await files.build('thrower', {})
    expect(result).toMatchObject({ ok: false, state: 'error' })
    expect(result.diagnostics.at(-1)?.message).toContain('boom')
  })

  it('without reload only checks and pins; a disabled plugin stays disabled', async () => {
    await files.scaffold({ id: 'quiet', name: 'Quiet', template: 'tool' })
    await h.t.deps.plugins.disable('quiet')
    expect(await files.build('quiet', { reload: false })).toMatchObject({ ok: true, state: 'disabled' })
    expect(await files.build('quiet', {})).toMatchObject({ ok: true, state: 'disabled' })
  })

  it('refuses declarative plugins, read-only sources and builtins', async () => {
    await h.install({ id: 'declarative', files: { 'plugin.json': manifest('declarative') }, enabled: true })
    await h.t.deps.plugins.load('declarative')
    expect(await rejection(files.build('declarative', {}))).toMatchObject({ code: 'forbidden' })
    expect(await rejection(files.build('core-tools', {}))).toMatchObject({ code: 'forbidden' })
    expect(await rejection(files.build('unknown', {}))).toMatchObject({ code: 'not_found' })
  })
})
