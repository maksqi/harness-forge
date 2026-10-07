/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}` and `${user_config.KEY}` are literal plugin content */
// No plugin option value in an API answer, a record or the log (W12.16; gate P12-A, probe group 1). A Claude Code plugin
// with a sensitive `userConfig` option used in exec-form hook `args` and in MCP headers / env: the registration keeps
// every `${user_config.KEY}` of the hooks as written (the hook runner substitutes the values at spawn from
// `CLAUDE_PLUGIN_OPTION_<KEY>` of the registration's environment) and the MCP declarations keep `{{settings.KEY}}`
// (resolved only in the MCP manager's in-memory transport). End to end (POSIX): the real plugin host, hook service and
// MCP manager, a `mock:hooks` chat whose `write_file` call fires the plugin's PostToolUse hooks; `print-args` receives
// the secret as its argument and the http MCP server its header, while `GET /hooks`, `GET /hooks?projectId`,
// `GET /hooks/runs`, the stored `data-hook` part, the stream, the plugin answers, `GET /mcp` and every log line never
// hold it (the redactor is kept from learning it, so a leak would show). A missing option stays as written (the hook
// gets the literal `${user_config.KEY}`, as before). Every spawned pid is dead at the end.
import type { HooksConfig, McpServerDecl, PluginContext } from '@harness-forge/plugin-sdk'
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FixtureTree } from '../../testing/claude-fixtures.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { ClaudeRegistrationRuntime } from './register.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { chatDetailSchema, hookListSchema, hookRunListSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from '../../chat/testing.ts'
import { startDeps } from '../../deps.ts'
import { createHookService } from '../../services/hooks/index.ts'
import { alive, waitFor } from '../../services/hooks/testing.ts'
import { writeFileTree } from '../../testing/claude-fixtures.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { HOOK_SCRIPT_TEXT, hookScriptSource, readHookArgs } from '../../testing/hook-scripts.ts'
import { readClaudePluginDirectory } from './reader.ts'
import { registerClaudeContributions } from './register.ts'

const posix = process.platform !== 'win32'
/** The sensitive option's value (`HF_CANARY-…`: no redactor pattern masks it, so a leak stays visible). */
const SECRET = 'HF_CANARY-w1216-opt-7f3a91'
/** The non-sensitive option's value. */
const PLAIN = 'plain-w1216-value'
/** In `process.env` under the missing option's names: never read. */
const ENV_CANARY = 'HF_CANARY-w1216-process-env'
const PLUGIN_ID = 'secret-kit'
/** `args` of the `print-args` handler as written. */
const PRINT_ARGS = ['${CLAUDE_PLUGIN_ROOT}/hooks/print-args.sh', 'first', '${user_config.SECRET_KEY}', '--plain=${user_config.PLAIN}', '${user_config.MISSING}', '\\${user_config.SECRET_KEY}']
/** `args` of the `context` handler as written (it answers additional context, so the event leaves a record). */
const CONTEXT_ARGS = ['${CLAUDE_PLUGIN_ROOT}/hooks/context.sh', '${user_config.SECRET_KEY}']

const cleanups: Array<() => Promise<void> | void> = []
const pids: number[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
  const started = pids.splice(0)
  await waitFor(() => started.every(pid => !alive(pid)))
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-w1216-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function file(content: string, mode = 0o644): { content: string, mode: number } {
  return { content, mode }
}

/** The plugin: three options (sensitive, plain, never set), two exec-form PostToolUse hooks, an http (+ a stdio) MCP server. */
function secretKitFiles(options: { mcpUrl: string, stdio?: boolean }): FixtureTree {
  return {
    '.claude-plugin/plugin.json': file(JSON.stringify({
      name: PLUGIN_ID,
      version: '1.0.0',
      description: 'A sensitive option in exec-form hook arguments and MCP headers.',
      userConfig: {
        SECRET_KEY: { type: 'string', title: 'Secret key', description: 'A secret.', sensitive: true },
        PLAIN: { type: 'string', title: 'Plain', description: 'Not a secret.' },
        MISSING: { type: 'string', title: 'Missing', description: 'Never set.' },
      },
      mcpServers: {
        api: { type: 'http', url: options.mcpUrl, headers: { 'X-Secret': '${user_config.SECRET_KEY}', 'X-Plain': '${user_config.PLAIN}' } },
        ...(options.stdio === true
          ? { tools: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs', '--token', '${user_config.SECRET_KEY}'], env: { TOKEN: '${user_config.SECRET_KEY}' } } }
          : {}),
      },
    })),
    'hooks/hooks.json': file(JSON.stringify({
      hooks: {
        PostToolUse: [{
          matcher: 'Write',
          hooks: [
            { type: 'command', command: 'sh', args: PRINT_ARGS },
            { type: 'command', command: 'sh', args: CONTEXT_ARGS },
          ],
        }],
      },
    })),
    'hooks/print-args.sh': file(hookScriptSource('print-args'), 0o755),
    'hooks/context.sh': file(hookScriptSource('context'), 0o755),
  }
}

/** `PRINT_ARGS` / `CONTEXT_ARGS` as registered: the plugin folder substituted, every option reference as written. */
function registeredArgs(root: string): { print: string[], context: string[] } {
  const folder = (args: readonly string[]): string[] => args.map(arg => arg.replace('${CLAUDE_PLUGIN_ROOT}', root))
  return { print: folder(PRINT_ARGS), context: folder(CONTEXT_ARGS) }
}

describe('registerClaudeContributions keeps option values out of the registered hooks and MCP declarations (W12.16)', () => {
  it('hooks: every ${user_config.KEY} as written, the values only in the environment; MCP: {{settings.KEY}} placeholders', async () => {
    const root = await tempDir()
    await writeFileTree(root, secretKitFiles({ mcpUrl: 'https://mcp.example.com/api', stdio: true }))
    const read = (await readClaudePluginDirectory(root, { expectedId: PLUGIN_ID })).claude
    expect(read).not.toBeNull()
    const hooks: Array<{ config: HooksConfig, env: Readonly<Record<string, string>> | undefined }> = []
    const servers: McpServerDecl[] = []
    const logged: string[] = []
    const register = { register: () => ({ dispose: () => {} }) }
    const log = (message: string): void => void logged.push(message)
    const ctx = {
      plugin: { id: PLUGIN_ID, dir: root, dataDir: '/srv/data/plugins/.data/secret-kit' },
      settings: { get: () => ({ SECRET_KEY: SECRET, PLAIN }) },
      logger: { debug: log, info: log, warn: log, error: log },
      commands: register,
      agents: register,
      skills: register,
      outputStyles: register,
    } as unknown as PluginContext
    const runtime: ClaudeRegistrationRuntime = {
      registerHookCommands: (config, extra) => {
        hooks.push({ config, env: extra?.env })
        return { dispose: () => {} }
      },
      registerMcpServer: (decl) => {
        servers.push(decl)
        return { dispose: () => {} }
      },
    }
    registerClaudeContributions(ctx, read!, runtime)

    expect(hooks).toHaveLength(1)
    const handlers = (hooks[0]!.config as unknown as { PostToolUse: [{ hooks: Array<{ command: string, args: string[] }> }] }).PostToolUse[0].hooks
    const expected = registeredArgs(root)
    expect(handlers.map(handler => [handler.command, handler.args])).toEqual([['sh', expected.print], ['sh', expected.context]])
    // The values (a sensitive one too) only in the environment the runner reads at spawn.
    expect(hooks[0]!.env).toEqual({ CLAUDE_PLUGIN_DATA: '/srv/data/plugins/.data/secret-kit', CLAUDE_PLUGIN_OPTION_SECRET_KEY: SECRET, CLAUDE_PLUGIN_OPTION_PLAIN: PLAIN })
    expect(servers.map(server => server.transport)).toEqual([
      { type: 'http', url: 'https://mcp.example.com/api', headers: { 'X-Secret': '{{settings.SECRET_KEY}}', 'X-Plain': '{{settings.PLAIN}}' } },
      { type: 'stdio', command: 'node', args: [`${root}/server.mjs`, '--token', '{{settings.SECRET_KEY}}'], env: { TOKEN: '{{settings.SECRET_KEY}}' } },
    ])
    for (const text of [JSON.stringify(hooks.map(hook => hook.config)), JSON.stringify(servers), JSON.stringify(logged)]) {
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(PLAIN)
    }
  })
})

/** A loopback http server standing in for the plugin's MCP endpoint: records the `x-secret` header, answers 404. */
async function headerSink(): Promise<{ url: string, headers: string[], close: () => Promise<void> }> {
  const headers: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const value = request.headers['x-secret']
    if (typeof value === 'string')
      headers.push(value)
    request.resume()
    response.writeHead(404, { 'content-type': 'application/json' }).end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

interface SecretKitApp {
  readonly t: TestApp
  readonly projectId: string
  /** The project folder (canonical): `print-args` writes `.hook-args` here. */
  readonly root: string
  /** The installed plugin folder (canonical). */
  readonly pluginDir: string
  readonly sink: Awaited<ReturnType<typeof headerSink>>
}

/** The real composition with the plugin installed and pinned, its options saved and a project opened. */
async function secretKitApp(): Promise<SecretKitApp> {
  const base = await tempDir()
  const sink = await headerSink()
  cleanups.push(() => sink.close())
  const t = await createTestApp({
    start: false,
    workspaceRoots: [base],
    env: { HF_MOCK_PROVIDER: '1' },
    factories: { hooks: deps => createHookService(deps, { runner: { killGraceMs: 200, onSpawn: pid => void pids.push(pid) } }) },
  })
  cleanups.push(() => t.close())
  // The redactor never learns the secret: a value that reached a log line or a label would stay visible.
  vi.spyOn(t.deps.redactor, 'addSecret').mockImplementation(() => {})
  const pluginDir = join(t.env.paths.plugins, PLUGIN_ID)
  await writeFileTree(pluginDir, secretKitFiles({ mcpUrl: sink.url }))
  const inspection = await t.deps.plugins.inspectDirectory(pluginDir, { format: 'claude' })
  await t.deps.plugins.saveRecord({ id: PLUGIN_ID, source: 'copy', format: 'claude', version: inspection.manifest.version, trustedHash: inspection.sha256 })
  await startDeps(t.deps)
  await t.deps.plugins.updateSettings(PLUGIN_ID, { SECRET_KEY: SECRET, PLAIN })
  expect(t.deps.plugins.state(PLUGIN_ID)).toBe('active')
  const project = await t.deps.projects.create({ name: 'Demo', path: base, newFolder: 'demo' })
  const opened = await t.deps.projects.openWorkspace(project.id)
  if (!opened.ok)
    throw new Error(opened.message)
  return { t, projectId: project.id, root: opened.workspace.root, pluginDir, sink }
}

async function getJson(t: TestApp, path: string): Promise<unknown> {
  const response = await t.request(path)
  expect(response.status, path).toBe(200)
  return response.json()
}

describe.skipIf(!posix)('a sensitive plugin option end to end (W12.16)', () => {
  it('the hook process gets the values; no API answer, record, stream or log line holds the secret', async () => {
    const h = await secretKitApp()
    const { t } = h
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_MISSING', ENV_CANARY)
    vi.stubEnv('MISSING', ENV_CANARY)
    const chatId = testChatId(0xE916)
    const response = await postChat(t, chatBody(chatId, 'call write_file {"path":"notes.txt","content":"hi"}', { modelRef: 'mock:hooks', projectId: h.projectId, toolMode: 'auto' }))
    expect(response.status).toBe(200)
    const stream = await readSse(response)
    await runnerOf(t).idle()
    expect(streamedText(stream.chunks)).toContain(`hooks: ${HOOK_SCRIPT_TEXT.context}`)

    // The hook process got the sensitive and the plain value; the missing option and the escaped reference as written.
    expect(await readHookArgs(h.root)).toEqual(['first', SECRET, `--plain=${PLAIN}`, '${user_config.MISSING}', '${user_config.SECRET_KEY}'])
    // The MCP transport (in memory) carries the secret to the endpoint.
    await waitFor(() => h.sink.headers.includes(SECRET), 8000)

    // The registry and every answer keep the references as written.
    const registered = t.deps.registry.hookCommands.get(PLUGIN_ID)!
    const expected = registeredArgs(h.pluginDir)
    expect(registered.hooks.map(hook => hook.args)).toEqual([expected.print, expected.context])
    const list = hookListSchema.parse(await getJson(t, '/api/hooks'))
    const listed = list.items.filter(item => item.kind === 'command' && item.pluginId === PLUGIN_ID)
    expect(listed.map(item => item.kind === 'command' ? [item.command, item.args, item.state] : null)).toEqual([['sh', expected.print, 'active'], ['sh', expected.context, 'active']])
    const projectList = hookListSchema.parse(await getJson(t, `/api/hooks?projectId=${h.projectId}`))
    expect(projectList.items.filter(item => item.kind === 'command' && item.pluginId === PLUGIN_ID)).toHaveLength(2)
    const runs = hookRunListSchema.parse(await getJson(t, '/api/hooks/runs'))
    expect(runs.items.filter(run => run.pluginId === PLUGIN_ID)).toHaveLength(2)

    // The stored data-hook part: both handlers, the option references in the labels, never a value.
    const chat = chatDetailSchema.parse(await getJson(t, `/api/chats/${chatId}`))
    const records = chat.messages.flatMap((message: HarnessUIMessage) => message.parts.flatMap(part => part.type === 'data-hook' ? [part.data as { event: string, hooks: Array<{ label: string, pluginId?: string }> }] : []))
    const record = records.find(item => item.event === 'PostToolUse')
    expect(record?.hooks.filter(entry => entry.pluginId === PLUGIN_ID)).toHaveLength(2)
    expect(record?.hooks.find(entry => entry.label.includes('context.sh'))?.label).toBe(`sh ${h.pluginDir}/hooks/context.sh \${user_config.SECRET_KEY}`)

    const answers: Array<[string, string]> = [
      ['GET /hooks', JSON.stringify(list)],
      ['GET /hooks?projectId', JSON.stringify(projectList)],
      ['GET /hooks/runs', JSON.stringify(runs)],
      ['the stored chat', JSON.stringify(chat)],
      ['the stream', JSON.stringify(stream.chunks)],
      ['GET /plugins/:id', JSON.stringify(await getJson(t, `/api/plugins/${PLUGIN_ID}`))],
      ['GET /plugins/:id/settings', JSON.stringify(await getJson(t, `/api/plugins/${PLUGIN_ID}/settings`))],
      ['GET /plugins', JSON.stringify(await getJson(t, '/api/plugins'))],
      ['GET /mcp', JSON.stringify(await getJson(t, '/api/mcp'))],
      ['the registered hooks', JSON.stringify(t.deps.registry.hookCommands.list().map(entry => entry.hooks))],
      ['the log', t.logs.text()],
    ]
    for (const [where, text] of answers) {
      expect(text.includes(SECRET), where).toBe(false)
      expect(text.includes(ENV_CANARY), where).toBe(false)
    }
    // The log is not vacuous: the hook ran at debug level with its command line (the references as written).
    expect(t.logs.text()).toContain('hooks: running a command hook')
    expect(t.logs.text()).toContain('user_config.SECRET_KEY')
  })
})
