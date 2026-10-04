// Validates the example plugins of `examples/plugins/<id>/` (docs/PLUGINS.md 15, docs/guides/): every manifest parses
// with the shared `pluginManifestSchema`, and every example loads through the real plugin host (`createTestApp`) and
// works: the dice tool rolls, the echo provider (a TypeScript entry compiled by the host) streams a chat answer, the
// LM Studio and Together AI manifests talk to a fake OpenAI-compatible server, and the agent pack (plugin API 1.4.0)
// registers its agents and skills from the manifest and from code. The code snippets of PLUGINS.md section 15 (and the
// agent pack's `index.mjs` shown in PLUGINS.md 9 "Agents and skills") must equal the example files, and the plugins
// shown in docs/guides/ must load too.
//
// The MCP manager is replaced by a no-op fake, so the stdio server of `mcp-everything` (`npx -y ...`) never runs here.
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpManager } from '../../apps/server/src/mcp/types.ts'
import type { TestApp } from '../../apps/server/src/testing/create-test-app.ts'
import { Buffer } from 'node:buffer'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatBody, postChat, readSse, streamedText, testChatId } from '../../apps/server/src/chat/testing.ts'
import { SDK_TYPES_SOURCE } from '../../apps/server/src/plugins/templates/sdk-types.ts'
import { createTestApp } from '../../apps/server/src/testing/create-test-app.ts'
import { HarnessError, manifestRequiresTrust, pluginManifestSchema } from '../../packages/shared/src/index.ts'

const EXAMPLES_DIR = dirname(fileURLToPath(import.meta.url))
/** Folder name = plugin id (DECISIONS.md "Example plugins"). */
const EXAMPLE_IDS = ['agent-pack', 'dice-roller', 'echo-provider', 'lmstudio', 'mcp-everything', 'together-ai'] as const
type ExampleId = (typeof EXAMPLE_IDS)[number]
/** `engines.harness` of each example: `^1.0.0` unless it uses a newer plugin API member (PLUGINS.md 3 "Versioning"). */
const EXAMPLE_ENGINES: Record<ExampleId, string> = {
  'agent-pack': '^1.4.0',
  'dice-roller': '^1.0.0',
  'echo-provider': '^1.0.0',
  'lmstudio': '^1.0.0',
  'mcp-everything': '^1.0.0',
  'together-ai': '^1.0.0',
}
/** First line of the vendored `harness-forge.d.ts` copies (the root ESLint config lints them; the scaffold's are not). */
const EDITOR_TYPES_HEADER = '/* eslint-disable -- copy of the harness-forge.d.ts that the code plugin templates write */\n'

function exampleDir(id: ExampleId): string {
  return join(EXAMPLES_DIR, id)
}

function readManifestJson(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Record<string, unknown>
}

const DOCS_DIR = join(EXAMPLES_DIR, '..', '..', 'docs')
const GUIDES = ['writing-a-declarative-provider.md', 'writing-a-code-plugin.md', 'adding-an-mcp-server.md'] as const

function readDoc(path: string): string {
  return readFileSync(join(DOCS_DIR, path), 'utf8')
}

/** The fenced code block after the first mention of `` `<file>` `` in `doc`. */
function snippet(doc: string, file: string): string {
  const mention = doc.indexOf(`\`${file}\``)
  expect(mention, `the document mentions ${file}`).toBeGreaterThan(-1)
  const fence = doc.indexOf('\n```', mention) + 1
  const start = doc.indexOf('\n', fence) + 1
  return doc.slice(start, doc.indexOf('\n```', start) + 1)
}

/** The fenced `lang` code block after the first occurrence of `heading` (a line of its own) in `doc`. */
function blockAfterHeading(doc: string, heading: string, lang: string): string {
  const at = doc.indexOf(`\n${heading}\n`)
  expect(at, `the document has the heading ${heading}`).toBeGreaterThan(-1)
  const fence = doc.indexOf(`\n\`\`\`${lang}\n`, at) + 1
  expect(fence, `a ${lang} block follows ${heading}`).toBeGreaterThan(0)
  const start = doc.indexOf('\n', fence) + 1
  return doc.slice(start, doc.indexOf('\n```', start) + 1)
}

/** Every complete manifest (a JSON block with `manifestVersion`) of a document. */
function manifestBlocks(doc: string): Record<string, unknown>[] {
  return [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map(match => match[1] ?? '')
    .filter(block => block.includes('"manifestVersion"'))
    .map(block => JSON.parse(block) as Record<string, unknown>)
}

describe('example manifests', () => {
  it('ships exactly the documented examples', () => {
    const folders = readdirSync(EXAMPLES_DIR).filter(name => statSync(join(EXAMPLES_DIR, name)).isDirectory()).sort()
    expect(folders).toEqual([...EXAMPLE_IDS])
  })

  it.each(EXAMPLE_IDS)('%s: plugin.json parses with pluginManifestSchema and matches its folder', (id) => {
    const dir = exampleDir(id)
    const manifest = pluginManifestSchema.parse(readManifestJson(dir))
    expect(manifest.id).toBe(id)
    expect(manifest.engines.harness).toBe(EXAMPLE_ENGINES[id])
    expect(existsSync(join(dir, 'README.md'))).toBe(true)
    if (manifest.icon !== undefined && !manifest.icon.startsWith('lobe:'))
      expect(existsSync(join(dir, manifest.icon))).toBe(true)
    if (manifest.main !== undefined) {
      expect(existsSync(join(dir, manifest.main))).toBe(true)
      // The editor types must stay identical to what the scaffold writes (regenerate from SDK_TYPES_SOURCE).
      expect(readFileSync(join(dir, 'harness-forge.d.ts'), 'utf8')).toBe(`${EDITOR_TYPES_HEADER}${SDK_TYPES_SOURCE}`)
    }
  })
})

describe('docs/PLUGINS.md section 15 shows the examples as shipped', () => {
  const doc = readDoc('PLUGINS.md')

  it.each(['together-ai', 'dice-roller', 'mcp-everything'] as const)('%s/plugin.json', (id) => {
    expect(JSON.parse(snippet(doc, `${id}/plugin.json`))).toEqual(readManifestJson(exampleDir(id)))
  })

  it('dice-roller/index.mjs', () => {
    expect(snippet(doc, 'dice-roller/index.mjs')).toBe(readFileSync(join(exampleDir('dice-roller'), 'index.mjs'), 'utf8'))
  })

  it('agent-pack/plugin.json (example (f)) and its index.mjs (section 9 "Agents and skills")', () => {
    expect(JSON.parse(blockAfterHeading(doc, '### (f) Agents and skills: `agent-pack` (plugin API 1.4.0)', 'json'))).toEqual(readManifestJson(exampleDir('agent-pack')))
    expect(blockAfterHeading(doc, '### Agents and skills', 'js')).toBe(readFileSync(join(exampleDir('agent-pack'), 'index.mjs'), 'utf8'))
  })
})

describe('docs/guides manifests', () => {
  it.each(GUIDES)('%s: every complete manifest parses with pluginManifestSchema', (guide) => {
    const manifests = manifestBlocks(readDoc(`guides/${guide}`))
    expect(manifests.length).toBeGreaterThan(0)
    for (const manifest of manifests)
      expect(pluginManifestSchema.safeParse(manifest).error?.issues ?? []).toEqual([])
  })
})

// ---------- a fake OpenAI-compatible server (LM Studio and Together AI flavors) ----------

interface FakeRequest {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown> | null
}

interface FakeServer {
  url: string
  requests: FakeRequest[]
  close: () => Promise<void>
}

const LMSTUDIO_MODELS = {
  object: 'list',
  data: [
    { id: 'qwen3-8b', object: 'model', owned_by: 'organization_owner' },
    { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model', owned_by: 'organization_owner' },
  ],
}

/** Together AI answers `GET /models` with a bare array and a `type` per model. */
const TOGETHER_MODELS = [
  { id: 'openai/gpt-oss-120b', object: 'model', type: 'chat', display_name: 'OpenAI gpt-oss 120B', context_length: 131072 },
  { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', object: 'model', type: 'chat', context_length: 131072 },
  { id: 'meta-llama/Llama-Guard-4-12B', object: 'model', type: 'chat', context_length: 1048576 },
  { id: 'black-forest-labs/FLUX.1-schnell', object: 'model', type: 'image' },
  { id: 'BAAI/bge-large-en-v1.5', object: 'model', type: 'embedding' },
]

const FAKE_REPLY = 'Hello from a local model.'

function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/** `POST /chat/completions`: an SSE stream (`stream: true`) or one JSON completion (titles). */
function sendCompletion(res: ServerResponse, body: Record<string, unknown> | null): void {
  const model = typeof body?.model === 'string' ? body.model : 'unknown'
  const usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
  if (body?.stream !== true) {
    sendJson(res, {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: FAKE_REPLY }, finish_reason: 'stop' }],
      usage,
    })
    return
  }
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}): string =>
    `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model, choices, ...extra })}\n\n`
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const word of FAKE_REPLY.match(/\S+\s*/g) ?? [])
    res.write(chunk([{ index: 0, delta: { role: 'assistant', content: word }, finish_reason: null }]))
  res.write(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]))
  res.write(chunk([], { usage }))
  res.end('data: [DONE]\n\n')
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req)
    chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? null : JSON.parse(text) as Record<string, unknown>
}

/** Serves `/lmstudio/v1/*` and `/together/v1/*`; records every request. */
async function startFakeServer(): Promise<FakeServer> {
  const requests: FakeRequest[] = []
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      const body = await readBody(req)
      requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body })
      if (req.method === 'GET' && path === '/lmstudio/v1/models')
        return sendJson(res, LMSTUDIO_MODELS)
      if (req.method === 'GET' && path === '/together/v1/models')
        return sendJson(res, TOGETHER_MODELS)
      if (req.method === 'POST' && path.endsWith('/v1/chat/completions'))
        return sendCompletion(res, body)
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `No route ${req.method} ${path}` } }))
    })().catch((error: unknown) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

// ---------- the examples in the plugin host ----------

/** An MCP manager that never connects anything: declared servers stay in the registry only. */
function createIdleMcpManager(): McpManager {
  const unavailable = async (): Promise<never> => {
    throw new HarnessError({ code: 'not_found', message: 'MCP servers are not connected in the example tests.' })
  }
  return { start: async () => {}, stop: async () => {}, list: async () => [], get: unavailable, create: unavailable, update: unavailable, remove: unavailable, reconnect: unavailable }
}

describe('examples in the plugin host', () => {
  let t: TestApp
  let fake: FakeServer

  beforeAll(async () => {
    fake = await startFakeServer()
    // The real builtins (core-providers, core-tools, core-commands, core-mcp) load too, so name clashes would show.
    t = await createTestApp({ env: { HF_OFFLINE: '1' }, start: false, overrides: { mcp: createIdleMcpManager() } })
    for (const id of EXAMPLE_IDS) {
      const dir = join(t.env.paths.plugins, id)
      cpSync(exampleDir(id), dir, { recursive: true })
      // What "Install -> Local folder -> Copy" + "I trust ..." records: code and stdio plugins pin their hash.
      const inspection = await t.deps.plugins.inspectDirectory(dir)
      await t.deps.plugins.saveRecord({
        id,
        source: 'copy',
        version: inspection.manifest.version,
        ...(inspection.requiresTrust ? { trustedHash: inspection.sha256 } : {}),
      })
    }
    // Not `startDeps()`: only the plugin host and the catalog start (which never refreshes with `HF_OFFLINE=1`).
    await t.deps.plugins.start()
    await t.deps.catalog.start()
  }, 60_000)

  afterAll(async () => {
    await t?.close()
    await fake?.close()
  })

  /** Points an installed declarative example at the fake server and reloads it. */
  async function pointAt(id: 'lmstudio' | 'together-ai', baseURL: string): Promise<void> {
    const file = join(t.env.paths.plugins, id, 'plugin.json')
    const manifest = readManifestJson(join(t.env.paths.plugins, id)) as { contributes: { providers: Array<{ baseURL: string }> } }
    manifest.contributes.providers[0]!.baseURL = baseURL
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
    await t.deps.plugins.reload(id)
    expect(t.deps.plugins.state(id)).toBe('active')
  }

  it('loads every example as active, with trust required only for code and stdio plugins', async () => {
    for (const id of EXAMPLE_IDS) {
      const detail = await t.client.plugins.get({ params: { id } })
      expect({ id, state: detail.state, lastError: detail.lastError }).toEqual({ id, state: 'active', lastError: null })
      const requiresTrust = manifestRequiresTrust(pluginManifestSchema.parse(readManifestJson(exampleDir(id))))
      expect(detail.trust).toMatchObject({ required: requiresTrust, trusted: true })
    }
    expect((await t.client.plugins.get({ params: { id: 'dice-roller' } })).kind).toBe('code')
    expect((await t.client.plugins.get({ params: { id: 'agent-pack' } })).kind).toBe('code')
    expect((await t.client.plugins.get({ params: { id: 'lmstudio' } })).kind).toBe('declarative')
  })

  it('registers the documented contributions', async () => {
    const contributions = async (id: ExampleId): Promise<unknown> => (await t.deps.plugins.summary(id)).contributions
    expect(await contributions('lmstudio')).toMatchObject({ providers: ['lmstudio'], tools: [], mcpServers: [] })
    expect(await contributions('together-ai')).toMatchObject({ providers: ['together-ai'], tools: [] })
    expect(await contributions('dice-roller')).toMatchObject({ providers: [], tools: ['roll_dice'], commands: [], hooks: [] })
    expect(await contributions('echo-provider')).toMatchObject({ providers: ['echo-provider'], tools: [] })
    expect(await contributions('mcp-everything')).toMatchObject({ providers: [], mcpServers: ['mcp-everything'] })
    expect(await contributions('agent-pack')).toEqual({
      providers: [],
      models: 0,
      tools: [],
      mcpServers: [],
      commands: [],
      hooks: [],
      agents: ['code-reviewer', 'docs-writer'],
      skills: ['changelog-entry', 'commit-message'],
    })
    for (const id of EXAMPLE_IDS.filter(other => other !== 'agent-pack'))
      expect(await contributions(id)).toMatchObject({ agents: [], skills: [] })

    const providers = (await t.client.providers.list()).items
    const status = (id: string): unknown => providers.find(provider => provider.id === id)?.status
    expect(status('lmstudio')).toBe('connected')
    expect(status('echo-provider')).toBe('connected')
    expect(status('together-ai')).toBe('not_configured')

    const server = t.deps.registry.mcpServers.get('mcp-everything')
    expect(server?.decl.transport).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] })
  })

  it('agent-pack: GET /plugins lists it with its agents and skills; the registries hold the manifest and the code entries', async () => {
    const listed = (await t.client.plugins.list()).items.find(plugin => plugin.id === 'agent-pack')
    expect(listed).toMatchObject({ state: 'active', kind: 'code', contributions: { agents: ['code-reviewer', 'docs-writer'], skills: ['changelog-entry', 'commit-message'] } })

    const { agents, skills } = t.deps.registry
    // Declarative (plugin.json) and code (index.mjs) registrations, both owned by the plugin.
    expect(agents.get('code-reviewer')).toEqual({
      pluginId: 'agent-pack',
      definition: {
        name: 'code-reviewer',
        description: 'Reviews a diff or a set of files for bugs, risky changes and missing tests. Use it after larger edits.',
        instructions: 'You review code changes.\n\n1. Read the changed files.\n2. List real bugs first, then risky changes, then missing tests.\n3. Quote file paths and line numbers.',
        tools: ['read_file', 'search_files', 'find_files', 'list_directory'],
      },
    })
    expect(agents.get('docs-writer')?.definition).toMatchObject({ model: 'inherit', tools: ['read_file', 'find_files', 'search_files', 'write_file', 'edit_file'] })
    expect(skills.get('commit-message')?.definition.content).toMatch(/^# Commit messages\n/)
    expect(skills.get('changelog-entry')?.definition.content).toMatch(/^# Changelog entries\n/)
    expect(agents.list().map(agent => `${agent.pluginId}:${agent.definition.name}`)).toEqual(['agent-pack:code-reviewer', 'agent-pack:docs-writer'])
    expect(skills.list().map(skill => `${skill.pluginId}:${skill.definition.name}`)).toEqual(['agent-pack:changelog-entry', 'agent-pack:commit-message'])
    expect([agents.owner('docs-writer'), skills.owner('commit-message')]).toEqual(['agent-pack', 'agent-pack'])

    // Nothing was skipped or refused.
    const logs = (await t.client.plugins.logs({ params: { id: 'agent-pack' } })).items
    expect(logs.filter(entry => entry.level === 'warn' || entry.level === 'error')).toEqual([])
  })

  it('serves the file icons of the code examples', async () => {
    for (const id of ['dice-roller', 'echo-provider']) {
      const response = await t.request(`/api/plugins/${id}/icon`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('image/svg+xml')
    }
  })

  it('dice-roller: roll_dice is a safe tool that rolls within bounds', async () => {
    const tool = (await t.client.tools.list()).items.find(item => item.name === 'roll_dice')
    expect(tool).toMatchObject({ pluginId: 'dice-roller', policy: 'safe', enabled: true, available: true })

    const definition = t.deps.registry.tools.get('roll_dice')!.definition
    const call = { chatId: testChatId(1), modelRef: 'echo-provider:echo', toolCallId: 'call_1', messages: [], signal: new AbortController().signal }
    const result = await definition.execute({ notation: '3d6+2' }, call) as { rolls: number[], modifier: number, total: number }
    expect(result.rolls).toHaveLength(3)
    for (const roll of result.rolls)
      expect(roll >= 1 && roll <= 6).toBe(true)
    expect(result.modifier).toBe(2)
    expect(result.total).toBe(result.rolls.reduce((sum, roll) => sum + roll, 0) + 2)
    await expect(definition.execute({ notation: '0d6' }, call)).rejects.toThrow('1-100 dice')
  })

  it('echo-provider: the TypeScript entry is compiled and its models stream a chat answer', async () => {
    expect(existsSync(join(t.env.paths.pluginCache, 'echo-provider'))).toBe(true)
    const models = (await t.client.models.list({ query: { providerId: 'echo-provider' } })).items.map(model => model.ref)
    expect(models).toEqual(expect.arrayContaining(['echo-provider:echo', 'echo-provider:reverse']))
    expect(await t.client.providers.test({ params: { id: 'echo-provider' }, body: {} })).toMatchObject({ ok: true })

    const echo = await readSse(await postChat(t, chatBody(testChatId(11), 'Hello from the examples', { modelRef: 'echo-provider:echo', toolMode: 'off' })))
    expect(streamedText(echo.chunks)).toBe('Hello from the examples')
    const reverse = await readSse(await postChat(t, chatBody(testChatId(12), 'abc def', { modelRef: 'echo-provider:reverse', toolMode: 'off' })))
    expect(streamedText(reverse.chunks)).toBe('fed cba')

    const logs = (await t.client.plugins.logs({ params: { id: 'echo-provider' } })).items
    expect(logs.some(entry => entry.message.includes('Echo provider ready'))).toBe(true)
  })

  it('lmstudio: keyless listing (embeddings excluded) and a streamed chat against an OpenAI-compatible server', async () => {
    await pointAt('lmstudio', `${fake.url}/lmstudio/v1`)
    expect(await t.client.providers.test({ params: { id: 'lmstudio' }, body: {} })).toMatchObject({ ok: true })
    const refs = (await t.client.models.refresh({ params: { id: 'lmstudio' } })).items.map(model => model.ref)
    expect(refs).toContain('lmstudio:qwen3-8b')
    expect(refs.some(ref => ref.includes('embed'))).toBe(false)

    const result = await readSse(await postChat(t, chatBody(testChatId(21), 'Say hello', { modelRef: 'lmstudio:qwen3-8b', toolMode: 'off' })))
    expect(streamedText(result.chunks)).toBe(FAKE_REPLY)
    const lmstudioRequests = fake.requests.filter(request => request.path.startsWith('/lmstudio/'))
    expect(lmstudioRequests.some(request => request.path === '/lmstudio/v1/chat/completions')).toBe(true)
    // `auth: none`: no credential ever leaves the server.
    expect(lmstudioRequests.every(request => request.headers.authorization === undefined)).toBe(true)
  })

  it('together-ai: bearer key, bare-array listing filtered by type and exclude, reasoning effort on the wire', async () => {
    await pointAt('together-ai', `${fake.url}/together/v1`)
    await t.client.credentials.set({ params: { id: 'together-ai' }, body: { values: { apiKey: 'tgp-test-key' } } })
    const listed = (await t.client.models.refresh({ params: { id: 'together-ai' } })).items
    // `exclude` removes models by id; `type: 'embedding'` makes a model an embedding model, hidden from the picker.
    expect(listed.some(model => /guard|flux/i.test(model.ref))).toBe(false)
    const visible = listed.filter(model => !model.hidden).map(model => model.ref)
    expect(visible.sort()).toEqual(['together-ai:meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together-ai:openai/gpt-oss-120b'])

    const body = chatBody(testChatId(31), 'Think, then say hello', { modelRef: 'together-ai:openai/gpt-oss-120b', toolMode: 'off', reasoningEffort: 'high' })
    const result = await readSse(await postChat(t, body))
    expect(streamedText(result.chunks)).toBe(FAKE_REPLY)
    const requests = fake.requests.filter(request => request.path.startsWith('/together/'))
    expect(requests.every(request => request.headers.authorization === 'Bearer tgp-test-key')).toBe(true)
    const chat = requests.find(request => request.path === '/together/v1/chat/completions' && request.body?.stream === true)
    expect(chat?.body).toMatchObject({ model: 'openai/gpt-oss-120b', reasoning_effort: 'high' })
  })

  /** Writes a plugin into `data/plugins/<id>`, pins it when it needs trust, loads it and returns its state. */
  async function installFromDocs(id: string, files: Record<string, string>): Promise<string | null> {
    const dir = join(t.env.paths.plugins, id)
    mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(dir, name), content)
    const inspection = await t.deps.plugins.inspectDirectory(dir)
    await t.deps.plugins.saveRecord({
      id,
      source: 'copy',
      version: inspection.manifest.version,
      ...(inspection.requiresTrust ? { trustedHash: inspection.sha256 } : {}),
    })
    const detail = await t.deps.plugins.load(id)
    expect(detail.lastError).toBeNull()
    return detail.state
  }

  it('the manifests of the declarative and MCP guides load as active plugins', async () => {
    const manifests = [...manifestBlocks(readDoc('guides/writing-a-declarative-provider.md')), ...manifestBlocks(readDoc('guides/adding-an-mcp-server.md'))]
    for (const manifest of manifests) {
      const id = String(manifest.id)
      expect({ id, state: await installFromDocs(id, { 'plugin.json': JSON.stringify(manifest) }) }).toEqual({ id, state: 'active' })
      await t.deps.plugins.uninstall(id, { keepData: false })
    }
  })

  it.each(['index.mjs', 'index.ts'] as const)('the house-style plugin of the code plugin guide works (%s)', async (entry) => {
    const guide = readDoc('guides/writing-a-code-plugin.md')
    const manifest = JSON.parse(snippet(guide, 'house-style/plugin.json')) as Record<string, unknown>
    const state = await installFromDocs('house-style', {
      'plugin.json': JSON.stringify({ ...manifest, main: entry }),
      [entry]: snippet(guide, `house-style/${entry}`),
    })
    expect(state).toBe('active')
    expect((await t.deps.plugins.summary('house-style')).contributions).toMatchObject({
      tools: ['house_style_check'],
      commands: ['style'],
      hooks: ['chat.params'],
    })

    const call = { chatId: testChatId(41), modelRef: 'echo-provider:echo', toolCallId: 'call_41', messages: [], signal: new AbortController().signal }
    const check = t.deps.registry.tools.get('house_style_check')!.definition
    expect(await check.execute({ text: 'Let us leverage our Synergy.' }, call)).toEqual({ ok: false, found: ['synergy', 'leverage'] })
    const style = t.deps.registry.commands.get('style')!.definition
    const reply = await style.run!({ input: '', chatId: testChatId(41), signal: new AbortController().signal })
    expect(reply).toMatchObject({ type: 'reply' })
    expect(reply.type === 'reply' ? reply.markdown : '').toContain('British English')

    await t.deps.plugins.uninstall('house-style', { keepData: false })
  })
})
