// SEC-D1 / SEC-D2 / SEC-D3 / SEC-D5: no stored secret ever leaves the server. Sentinel values are stored in every scope
// the server knows (the password, the master key and its HKDF subkeys, provider credentials stored and from the
// environment, plugin secret settings, MCP header and env values, draft test credentials), the provider calls go to a
// local fake upstream that echoes the API key in its error answers (as real providers do), then every GET route of the
// route table (concrete ids, exports included), the answers of the writes, the server events and every log record are
// searched for them. Secrets may only show up as masked hints (first 3 + last 4 characters, services/secrets/hint.ts),
// so the searched fragment is the middle of each value. Session tokens and the password hash never appear in a body
// or a log line, and message contents never appear in logs at info level or above.
import type { ApiRouteKey, ServerEvent } from '@harness-forge/shared'
import type { AddressInfo } from 'node:net'
import type { TestApp } from '../testing/create-test-app.ts'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { API_ROUTE_KEYS, apiRoutes, apiUrl, createChatId, createMessageId, listResponseSchema, pluginSummarySchema } from '@harness-forge/shared'
import { unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatBody } from '../chat/testing.ts'
import { SESSION_COOKIE_NAME } from '../http/middleware/session-auth.ts'
import { stubRouteKeys } from '../http/validate.ts'
import { SAMPLE_SHARE_TOKEN } from '../testing/api-samples.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createKeyring } from './keyring.ts'

/** A sentinel secret: 40 characters, so a hint shows `hfs…` + the last 4 and the middle stays hidden. */
function sentinel(label: string): string {
  return `hfs${label}${randomBytes(20).toString('hex')}`.slice(0, 40)
}

const MASTER_KEY = randomBytes(32)
const SECRETS = {
  password: sentinel('password'),
  providerDraftKey: sentinel('draftcred'),
  providerStoredKey: sentinel('providerkey'),
  envProviderKey: sentinel('envkey'),
  settingSecret: sentinel('setting'),
  mcpHeader: sentinel('mcpheader'),
  mcpEnv: sentinel('mcpenv'),
  draftTestKey: sentinel('drafttest'),
  wrongPassword: sentinel('wrongpass'),
} as const
const CHAT_CONTENT = `chat message ${sentinel('chat')}`
const PLUGIN_ID = 'leak-check'
const PROVIDER_ID = 'leak-check'

/**
 * A fake OpenAI-compatible upstream on 127.0.0.1 that rejects every call with 401 and quotes the bearer token back
 * ("Incorrect API key provided: <key>"), so provider errors carry the secret before the server sanitizes them.
 */
let upstream: http.Server
let upstreamBaseUrl: string
const upstreamKeys: string[] = []

async function startEchoUpstream(): Promise<void> {
  upstream = http.createServer((request, response) => {
    const key = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    upstreamKeys.push(key)
    request.resume()
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}. Header was: ${request.headers.authorization}`, type: 'invalid_request_error', code: 'invalid_api_key' } }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  upstreamBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`
}

let t: TestApp
let cookie: string
const sessionTokens: string[] = []
const events: ServerEvent[] = []
/** Answers of the writes made while storing the secrets. */
const writeAnswers: Array<{ what: string, text: string }> = []
let chatId: string
/** The user message of the chat (the target of the rewind preview). */
let userMessageId: string
let fileId: string

/** Every form a secret could take in a body or a log line (the searched fragments). */
function needles(): Array<{ name: string, value: string }> {
  const out: Array<{ name: string, value: string }> = []
  for (const [name, value] of Object.entries(SECRETS))
    out.push({ name, value: value.slice(4, 32) })
  const master = Buffer.from(MASTER_KEY)
  out.push({ name: 'master key (base64)', value: master.toString('base64').slice(4, 36) })
  out.push({ name: 'master key (base64url)', value: master.toString('base64url').slice(4, 36) })
  out.push({ name: 'master key (hex)', value: master.toString('hex').slice(4, 40) })
  for (const name of ['session', 'encryption', 'approval', 'share'] as const) {
    const subkey = Buffer.from(t.deps.keyring.subkey(name))
    out.push({ name: `${name} subkey (base64)`, value: subkey.toString('base64').slice(4, 36) })
    out.push({ name: `${name} subkey (base64url)`, value: subkey.toString('base64url').slice(4, 36) })
    out.push({ name: `${name} subkey (hex)`, value: subkey.toString('hex').slice(4, 40) })
  }
  out.push({ name: 'password hash', value: 'scrypt$' })
  return out
}

function leaksIn(text: string): string[] {
  return needles().filter(needle => text.includes(needle.value)).map(needle => needle.name)
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { cookie }
  if (body !== undefined)
    headers['content-type'] = 'application/json'
  return t.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

async function write(what: string, method: string, path: string, body?: unknown): Promise<Response> {
  const response = await call(method, path, body)
  const text = await response.clone().text()
  writeAnswers.push({ what, text: `${response.status} ${[...response.headers.entries()].filter(([name]) => name !== 'set-cookie').join(' ')} ${text}` })
  return response
}

/** Body text of an answer (binary bodies as latin1, so ASCII sentinels still match); SSE is read briefly. */
async function bodyText(response: Response): Promise<string> {
  if (response.body === null)
    return ''
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const reader = response.body.getReader()
    let text = ''
    const deadline = Date.now() + 300
    while (Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise<null>(resolve => setTimeout(resolve, 100, null))])
      if (next === null)
        continue
      if (next.done)
        break
      text += Buffer.from(next.value).toString('utf8')
    }
    await reader.cancel().catch(() => {})
    return text
  }
  return Buffer.from(await response.arrayBuffer()).toString('latin1')
}

beforeAll(async () => {
  await startEchoUpstream()
  t = await createTestApp({
    env: {
      HF_MASTER_KEY: MASTER_KEY.toString('base64'),
      HF_MOCK_PROVIDER: '1',
      HF_OFFLINE: '1',
      ANTHROPIC_API_KEY: SECRETS.envProviderKey,
    },
    factories: { keyring: createKeyring },
  })
  t.deps.events.subscribe(event => events.push(event))

  // The first password needs no login; the answer carries the session of the caller.
  const setPassword = await t.request('/api/auth/password', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newPassword: SECRETS.password }),
  })
  expect(setPassword.status).toBe(200)
  const login = await t.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: SECRETS.password }) })
  expect(login.status).toBe(200)
  const token = login.headers.getSetCookie()[0]?.split(';')[0]?.slice(SESSION_COOKIE_NAME.length + 1) ?? ''
  sessionTokens.push(token, setPassword.headers.getSetCookie()[0]?.split(';')[0]?.slice(SESSION_COOKIE_NAME.length + 1) ?? '')
  cookie = `${SESSION_COOKIE_NAME}=${token}`
  const wrong = await t.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: SECRETS.wrongPassword }) })
  expect(wrong.status).toBe(401)

  // A declarative plugin with a provider (credentials saved at creation) and a secret setting.
  const manifest = {
    manifestVersion: 1,
    id: PLUGIN_ID,
    name: 'Leak check',
    version: '1.0.0',
    engines: { harness: '^1.0.0' },
    settings: { type: 'object', properties: { token: { type: 'string', title: 'Token', format: 'secret' }, region: { type: 'string', title: 'Region' } } },
    contributes: { providers: [{ id: PROVIDER_ID, name: 'Leak check', baseURL: upstreamBaseUrl, apiFormat: 'openai-chat', models: [{ id: 'model-a' }] }] },
  }
  expect((await write('draft', 'POST', '/api/plugins', { manifest, credentials: { [PROVIDER_ID]: { apiKey: SECRETS.providerDraftKey } } })).status).toBe(201)
  expect((await write('settings', 'PUT', `/api/plugins/${PLUGIN_ID}/settings`, { values: { token: SECRETS.settingSecret, region: 'eu' } })).status).toBe(200)
  expect((await write('credentials', 'PUT', `/api/providers/${PROVIDER_ID}/credentials`, { values: { apiKey: SECRETS.providerStoredKey } })).status).toBe(200)
  // The provider tests reach the echoing upstream with the stored key: their errors must not quote it.
  expect((await write('provider test', 'POST', `/api/providers/${PROVIDER_ID}/test`, {})).status).toBe(200)
  expect((await write('provider test with values', 'POST', `/api/providers/${PROVIDER_ID}/test`, { values: { apiKey: SECRETS.draftTestKey } })).status).toBe(200)
  // A listing refused upstream is an error answer (502 auth_invalid) whose message must not quote the key either.
  expect((await write('model refresh', 'POST', `/api/providers/${PROVIDER_ID}/models/refresh`)).status).toBe(502)
  expect((await write('draft test', 'POST', '/api/plugins/drafts/test', {
    provider: { id: 'leak-draft', name: 'Draft', baseURL: upstreamBaseUrl, apiFormat: 'openai-chat' },
    credentials: { apiKey: SECRETS.draftTestKey },
    action: 'list-models',
  })).status).toBe(200)

  // MCP servers with a secret header and a secret environment variable (disabled: nothing is started).
  expect((await write('mcp http', 'POST', '/api/mcp', { id: 'leak-web', name: 'Web', enabled: false, transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${SECRETS.mcpHeader}` } } })).status).toBe(201)
  expect((await write('mcp stdio', 'POST', '/api/mcp', { id: 'leak-local', name: 'Local', enabled: false, transport: { type: 'stdio', command: 'node', args: ['server.mjs'], env: { API_TOKEN: SECRETS.mcpEnv } } })).status).toBe(201)
  expect((await write('mcp update', 'PATCH', '/api/mcp/leak-web', { transport: { type: 'http', url: 'https://mcp.example.com/v2', headers: { Authorization: `Bearer ${SECRETS.mcpHeader}` } } })).status).toBe(200)

  // A chat (message contents are not secrets, but must stay out of info-level logs) and an uploaded file.
  chatId = createChatId()
  userMessageId = createMessageId()
  const chat = await call('POST', '/api/chat', chatBody(chatId, CHAT_CONTENT, { message: { id: userMessageId, role: 'user', parts: [{ type: 'text', text: CHAT_CONTENT }] } }))
  expect(chat.status).toBe(200)
  await chat.text()
  const form = new FormData()
  form.append('file', new File(['notes'], 'notes.txt', { type: 'text/plain' }))
  const upload = await t.request('/api/files', { method: 'POST', headers: { cookie }, body: form })
  expect(upload.status).toBe(201)
  fileId = ((await upload.json()) as { id: string }).id

  // Secrets sent where they do not belong: a query string, an Authorization header, an x-api-key header.
  await t.request(`/api/settings?api_key=${SECRETS.providerStoredKey}`, { headers: { cookie, 'authorization': `Bearer ${SECRETS.providerStoredKey}`, 'x-api-key': SECRETS.envProviderKey } })
}, 30_000)

afterAll(async () => {
  await t?.close()
  upstream?.closeAllConnections()
  await new Promise(resolve => upstream?.close(resolve))
})

/** Concrete inputs of the GET routes that need params (every other GET route takes none). */
function getInputs(): Partial<Record<ApiRouteKey, Array<{ params?: Record<string, string>, query?: Record<string, string> }>>> {
  return {
    'chats.get': [{ params: { id: chatId } }],
    'chats.export': [{ params: { id: chatId }, query: { format: 'md' } }, { params: { id: chatId }, query: { format: 'json' } }],
    'chat.resume': [{ params: { id: chatId } }],
    'files.get': [{ params: { id: fileId } }],
    'icons.get': [{ params: { slug: 'openai' } }],
    'plugins.get': [{ params: { id: PLUGIN_ID } }],
    'plugins.getSettings': [{ params: { id: PLUGIN_ID } }],
    'plugins.icon': [{ params: { id: PLUGIN_ID } }],
    'plugins.logs': [{ params: { id: PLUGIN_ID } }, { params: { id: 'core-providers' } }, { params: { id: 'core-mcp' } }],
    'pluginInstall.export': [{ params: { id: PLUGIN_ID } }],
    'pluginFiles.list': [{ params: { id: PLUGIN_ID } }],
    'pluginFiles.read': [{ params: { id: PLUGIN_ID, path: 'plugin.json' } }],
    'models.list': [{}, { query: { includeHidden: 'true' } }],
    'shares.view': [{ params: { token: SAMPLE_SHARE_TOKEN } }],
    'shares.file': [{ params: { token: SAMPLE_SHARE_TOKEN, fileId } }],
    // Phase 8 (ADR-036, ADR-037): the chat has no project, so the views answer `available: false`.
    'changes.list': [{ params: { id: chatId } }],
    'changes.diff': [{ params: { id: chatId }, query: { source: 'chat', path: 'notes.txt' } }, { params: { id: chatId }, query: { source: 'git', path: 'notes.txt' } }],
    'changes.git': [{ params: { id: chatId } }],
    'changes.rewindPreview': [{ params: { id: chatId }, query: { messageId: userMessageId } }],
    // Phase 9 (ADR-042): the queue of an idle chat is empty; the project does not exist (404 once implemented).
    'chatQueue.list': [{ params: { id: chatId } }],
    'projectFiles.search': [{ params: { id: 'prj_ABCdef0123456789' }, query: { q: 'notes' } }],
    // Phase 10 (ADR-044, ADR-046): the global catalog, a builtin body, an unknown personal definition (404 once
    // implemented) and the background tasks of the chat (none).
    'customizations.list': [{}, { query: { kind: 'agent' } }],
    'customizations.source': [{ query: { kind: 'agent', name: 'explore', source: 'builtin' } }],
    'customizations.get': [{ params: { id: 'cus_ABCdef0123456789' } }],
    'chatTasks.list': [{ params: { id: chatId } }],
  }
}

const GET_KEYS = API_ROUTE_KEYS.filter(key => apiRoutes[key].method === 'GET')

describe('the sweep is not vacuous', () => {
  it('every secret was stored, every error path ran, and the matcher finds each form of a secret', async () => {
    expect(await t.deps.secrets.get(`plugin:${PLUGIN_ID}`, 'settings.token')).toBe(SECRETS.settingSecret)
    const credentials = await t.deps.credentials.resolve(PROVIDER_ID)
    expect(Object.values(credentials.values)).toContain(SECRETS.providerStoredKey)
    expect(Object.values((await t.deps.credentials.resolve('anthropic')).values)).toContain(SECRETS.envProviderKey)
    expect(await t.deps.passwords.check(SECRETS.password)).toBe(true)
    const providers = JSON.parse(await bodyText(await call('GET', '/api/providers'))) as { items: Array<{ id: string, lastError: { code: string } | null }> }
    expect(providers.items.find(provider => provider.id === PROVIDER_ID)?.lastError?.code).toBe('auth_invalid')
    // The upstream really received (and echoed) the stored, the tested and the draft keys.
    expect(upstreamKeys).toEqual(expect.arrayContaining([SECRETS.providerStoredKey, SECRETS.draftTestKey]))
    expect(t.logs.records.some(record => record.msg === 'password check failed')).toBe(true)
    expect(await bodyText(await call('GET', `/api/chats/${chatId}/export?format=md`))).toContain(CHAT_CONTENT)

    for (const [name, value] of Object.entries(SECRETS))
      expect(leaksIn(`prefix ${value} suffix`)).toContain(name)
    expect(leaksIn(MASTER_KEY.toString('base64'))).toContain('master key (base64)')
    expect(leaksIn(Buffer.from(t.deps.keyring.subkey('session')).toString('base64url'))).toContain('session subkey (base64url)')
    // A masked hint (first 3 + last 4 characters) is not a leak.
    expect(leaksIn(`${SECRETS.providerStoredKey.slice(0, 3)}…${SECRETS.providerStoredKey.slice(-4)}`)).toEqual([])
  })
})

describe('sEC-D1 / SEC-D5: no secret in any answer', () => {
  it('every GET route with params has concrete inputs here', () => {
    const inputs = getInputs()
    for (const key of GET_KEYS) {
      if ('params' in apiRoutes[key])
        expect(inputs[key], key).toBeDefined()
    }
  })

  it.each(GET_KEYS)('%s', async (key) => {
    const inputs = getInputs()[key] ?? [{}]
    for (const input of inputs) {
      const path = (apiUrl as (key: ApiRouteKey, input?: unknown, baseUrl?: string) => string)(key, input, '/api')
      const response = await call('GET', path)
      // A route that is still a stub (a contract wave mounts new routes as 501 stubs) answers 501 from its own handler;
      // every implemented route answers < 500. Only GET routes are swept: the Phase 6 routes (audio, version delete)
      // are writes, covered by their own route tests.
      if (stubRouteKeys().has(key))
        expect(response.status, path).toBe(501)
      else
        expect(response.status, path).toBeLessThan(500)
      const headers = [...response.headers.entries()].filter(([name]) => name !== 'set-cookie').join('\n')
      let text = `${headers}\n${await bodyText(response)}`
      // Zips (the plugin export, the data backup) are searched entry by entry: deflated bytes hide a sentinel.
      if ((key === 'pluginInstall.export' || key === 'data.export') && response.status === 200) {
        const entries = unzipSync(new Uint8Array(Buffer.from(text.slice(text.indexOf('\n', headers.length) + 1), 'latin1')))
        text += Object.values(entries).map(bytes => Buffer.from(bytes).toString('latin1')).join('\n')
        if (key === 'pluginInstall.export')
          expect(Object.keys(entries)).toContain(`${PLUGIN_ID}/plugin.json`)
      }
      expect(leaksIn(text), path).toEqual([])
      for (const token of sessionTokens)
        expect(text.includes(token), `${path}: session token`).toBe(false)
    }
  })

  it('every plugin, provider and MCP server (list and detail) shows secrets as states only', async () => {
    const plugins = listResponseSchema(pluginSummarySchema).parse(await (await call('GET', '/api/plugins')).json()).items
    expect(plugins.map(plugin => plugin.id)).toContain(PLUGIN_ID)
    for (const plugin of plugins) {
      for (const path of [`/api/plugins/${plugin.id}`, `/api/plugins/${plugin.id}/settings`, `/api/plugins/${plugin.id}/logs`])
        expect(leaksIn(await bodyText(await call('GET', path))), path).toEqual([])
    }
    const settings = await (await call('GET', `/api/plugins/${PLUGIN_ID}/settings`)).json() as { values: Record<string, unknown>, secrets: Record<string, unknown> }
    expect(settings.values).toEqual({ region: 'eu' })
    expect(settings.secrets.token).toMatchObject({ set: true })
    const mcp = await bodyText(await call('GET', '/api/mcp'))
    expect(mcp).toContain('leak-local')
    expect(leaksIn(mcp)).toEqual([])
    const providers = await bodyText(await call('GET', '/api/providers'))
    expect(providers).toContain(PROVIDER_ID)
    expect(leaksIn(providers)).toEqual([])
  })

  it('the answers of the writes that stored the secrets', () => {
    expect(writeAnswers.length).toBeGreaterThan(8)
    for (const answer of writeAnswers)
      expect(leaksIn(answer.text), answer.what).toEqual([])
  })

  it('the server events (GET /events payloads)', () => {
    expect(events.length).toBeGreaterThan(0)
    expect(leaksIn(JSON.stringify(events))).toEqual([])
  })
})

describe('sEC-D2: logs', () => {
  it('no secret, password hash or session token in any log record, at any level', () => {
    const text = t.logs.text()
    expect(t.logs.records.length).toBeGreaterThan(10)
    expect(leaksIn(text)).toEqual([])
    for (const token of sessionTokens)
      expect(text.includes(token)).toBe(false)
  })

  it('message contents never appear at info level or above', () => {
    const informative = t.logs.records.filter(record => record.level !== 'debug')
    expect(informative.length).toBeGreaterThan(0)
    expect(JSON.stringify(informative)).not.toContain(CHAT_CONTENT.slice(-24))
  })

  it('the access log records method, path and status, never query strings or headers', () => {
    const settingsLines = t.logs.records.filter(record => record.msg === 'request' && record.path === '/api/settings')
    expect(settingsLines.length).toBeGreaterThan(0)
    for (const record of settingsLines) {
      expect(Object.keys(record).sort()).toEqual(expect.arrayContaining(['method', 'path', 'status']))
      expect(JSON.stringify(record)).not.toContain('api_key')
      expect(JSON.stringify(record).toLowerCase()).not.toContain('authorization')
    }
  })
})
