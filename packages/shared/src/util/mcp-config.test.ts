/* eslint-disable no-template-curly-in-string -- `${VAR}` references are the subject of these tests */
import type { McpJsonRemoteServer, McpJsonStdioServer, ParseMcpJsonResult } from './mcp-config.ts'
import { describe, expect, it } from 'vitest'
import { MCP_SERVER_ID_PATTERN } from '../ids.ts'
import {
  expandVariables,
  extractVariables,
  isAllowedMcpUrl,
  MCP_CONFIG_DIAGNOSTIC_CODES,
  MCP_CONFIG_LIMITS,
  MCP_VARIABLE_NAME_PATTERN,
  mcpServerIdFromName,
  parseMcpJson,
  serverVariables,
} from './mcp-config.ts'
import { trustHashInput } from './trust.ts'

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function codes(result: ParseMcpJsonResult): string[] {
  return result.diagnostics.map(entry => `${entry.level}:${entry.code}${entry.server === undefined ? '' : `@${entry.server}`}`)
}

/** A `.mcp.json` like the ones Claude Code projects ship. */
const SAMPLE = {
  mcpServers: {
    'memory': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: '${MEMORY_FILE:-./memory.json}' } },
    'local-db': { type: 'stdio', command: 'node', args: ['tools/mcp-min.mjs', '--token', '${MCP_TOKEN}'] },
    'api': { type: 'http', url: 'https://api.example.invalid/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } },
    'events': { type: 'sse', url: 'http://localhost:${MCP_PORT:-9}/sse' },
    'My_Server.v2': { url: '${API_BASE_URL:-https://api.example.invalid}/mcp' },
    'broken': { type: 'websocket', url: 'ws://example.invalid' },
  },
}

describe('parseMcpJson', () => {
  it('reads a Claude Code .mcp.json', () => {
    const result = parseMcpJson(JSON.stringify(SAMPLE, null, 2))
    expect(result.servers.map(server => [server.name, server.id, server.transport.type])).toEqual([
      ['memory', 'memory', 'stdio'],
      ['local-db', 'local-db', 'stdio'],
      ['api', 'api', 'http'],
      ['events', 'events', 'sse'],
      ['My_Server.v2', 'my-server-v2', 'http'],
    ])
    expect(result.servers[0]?.transport).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: '${MEMORY_FILE:-./memory.json}' } })
    expect(result.servers[2]?.transport).toEqual({ type: 'http', url: 'https://api.example.invalid/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } })
    expect(result.servers[3]?.transport).toEqual({ type: 'sse', url: 'http://localhost:${MCP_PORT:-9}/sse', headers: {} })
    expect(result.servers[1]?.raw).toEqual(SAMPLE.mcpServers['local-db'])
    expect(codes(result)).toEqual(['error:unsupported-type@broken'])
  })

  it('infers the type and refuses non-http URLs', () => {
    const parse = (server: unknown): ParseMcpJsonResult => parseMcpJson(JSON.stringify({ mcpServers: { s: server } }))
    expect(parse({ command: 'x', type: 'http' }).servers[0]?.transport.type).toBe('stdio')
    expect(codes(parse({ command: 'x', type: 'http' }))).toEqual(['warning:ignored-field@s'])
    expect(parse({ url: 'https://a.example.invalid' }).servers[0]?.transport.type).toBe('http')
    expect(codes(parse({ url: 'file:///etc/passwd' }))).toEqual(['error:invalid-url@s'])
    expect(codes(parse({ url: 'javascript:alert(1)' }))).toEqual(['error:invalid-url@s'])
    expect(codes(parse({ url: 'ftp://a.example.invalid' }))).toEqual(['error:invalid-url@s'])
    expect(codes(parse({ url: 'no scheme' }))).toEqual(['error:invalid-url@s'])
    expect(codes(parse({ url: 'ws${X}://a' }))).toEqual(['error:invalid-url@s'])
    expect(codes(parse({}))).toEqual(['error:invalid-url@s'])
    expect(codes(parse({ type: 'stdio' }))).toEqual(['error:invalid-server@s'])
    expect(codes(parse({ type: 'streamable-http', url: 'https://a.example.invalid' }))).toEqual(['error:unsupported-type@s'])
  })

  it('validates commands, arguments, environments and headers', () => {
    const parse = (server: unknown): string[] => codes(parseMcpJson(JSON.stringify({ mcpServers: { s: server } })))
    expect(parse({ command: '' })).toEqual(['error:invalid-server@s'])
    expect(parse({ command: 5 })).toEqual(['error:invalid-server@s'])
    expect(parse({ command: 'a\u0007' })).toEqual(['error:invalid-server@s'])
    expect(parse({ command: 'x'.repeat(MCP_CONFIG_LIMITS.valueMaxChars + 1) })).toEqual(['error:invalid-server@s'])
    expect(parse({ command: 'x', args: 'a b' })).toEqual(['error:invalid-server@s'])
    expect(parse({ command: 'x', args: [1] })).toEqual(['error:invalid-server@s'])
    expect(parse({ command: 'x', args: Array.from({ length: 65 }).fill('a') })).toEqual(['error:too-many@s'])
    expect(parse({ command: 'x', env: { 'BAD-NAME': 'v' } })).toEqual(['error:invalid-server@s'])
    expect(parse({ command: 'x', env: { A: 1 } })).toEqual(['error:invalid-server@s'])
    expect(parse({ command: 'x', env: [] })).toEqual(['error:invalid-server@s'])
    expect(parse({ url: 'https://a.example.invalid', headers: { 'X-Token': 'a\r\nInjected: 1' } })).toEqual(['error:invalid-server@s'])
    expect(parse({ url: 'https://a.example.invalid', headers: { 'Bad Header': 'v' } })).toEqual(['error:invalid-server@s'])
    expect(parse({ url: 'https://a.example.invalid', command: undefined, env: { A: 'b' }, disabled: true })).toEqual(['info:ignored-field@s', 'info:ignored-field@s'])
    expect(parse({ command: 'x', args: ['${}', '${1X}', '${A B}'] })).toEqual(['warning:invalid-variable@s', 'warning:invalid-variable@s', 'warning:invalid-variable@s'])
    const env = parseMcpJson(JSON.stringify({ mcpServers: { s: { command: 'x', env: JSON.parse('{"__proto__":"v"}') as unknown } } })).servers[0]?.transport as McpJsonStdioServer
    expect(Object.getPrototypeOf(env.env)).toBe(Object.prototype)
    expect(Object.keys(env.env)).toEqual(['__proto__'])
  })

  it('maps names to unique ids and reports collisions', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { 'My Server': { command: 'a' }, 'my_server': { command: 'b' }, 'MY.SERVER': { command: 'c' }, '!!!': { command: 'd' }, '': { command: 'e' } } }))
    expect(result.servers.map(server => server.id)).toEqual(['my-server', 'my-server-2', 'my-server-3', 'server'])
    expect(codes(result)).toEqual(['info:id-collision@my_server', 'info:id-collision@MY.SERVER', 'error:invalid-server'])
  })

  it('reports file-level problems', () => {
    expect(codes(parseMcpJson('{'))).toEqual(['error:invalid-json'])
    expect(codes(parseMcpJson('[]'))).toEqual(['error:not-an-object'])
    expect(codes(parseMcpJson('{}'))).toEqual(['error:missing-servers'])
    expect(codes(parseMcpJson('{"mcpServers":[]}'))).toEqual(['error:missing-servers'])
    expect(codes(parseMcpJson('{"mcpServers":{},"other":1}'))).toEqual(['info:ignored-field'])
    expect(parseMcpJson('\uFEFF{"mcpServers":{}}')).toEqual({ servers: [], diagnostics: [] })
    expect(codes(parseMcpJson(`{"mcpServers":{},"pad":"${'x'.repeat(MCP_CONFIG_LIMITS.fileBytes)}"`))).toEqual(['error:too-large'])
    expect(codes(parseMcpJson('{"mcpServers":{}}', { maxBytes: 4 }))).toEqual(['error:too-large'])
    expect(codes(parseMcpJson('{"mcpServers":{}}', { maxBytes: 1e9 }))).toEqual([])
    expect(codes(parseMcpJson(null as unknown as string))).toEqual(['error:invalid-json'])
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`s${index}`, { command: 'x' }]))
    const result = parseMcpJson(JSON.stringify({ mcpServers: many }))
    expect(result.servers).toHaveLength(MCP_CONFIG_LIMITS.serversMax)
    expect(codes(result)).toEqual(['warning:too-many'])
    const variables = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`V${index}`, `\${V${index}}`]))
    expect(codes(parseMcpJson(JSON.stringify({ mcpServers: { s: { command: 'x', env: variables } } })))).toEqual(['warning:too-many'])
  })

  it('never quotes values in messages', () => {
    const secret = 'SecretValue'
    const result = parseMcpJson(JSON.stringify({ mcpServers: { s: { command: `${secret}\u0001`, env: { A: secret } }, t: { url: `ftp://${secret}` }, u: { url: 'https://a.example.invalid', headers: { H: `${secret}\n` } } } }))
    for (const entry of result.diagnostics)
      expect(entry.message).not.toContain(secret)
  })
})

describe('variables', () => {
  it('extracts ${VAR} and ${VAR:-default} references', () => {
    expect(extractVariables('Bearer ${TOKEN}')).toEqual([{ name: 'TOKEN', defaultValue: null }])
    expect(extractVariables('${A:-x}${A:-x}${A}${b_2:-}')).toEqual([{ name: 'A', defaultValue: 'x' }, { name: 'A', defaultValue: null }, { name: 'b_2', defaultValue: '' }])
    expect(extractVariables('$TOKEN $$ ${} ${1A} ${A-B} ${A:x} ${A B} ${unclosed')).toEqual([])
    expect(extractVariables('${A:-${B}}')).toEqual([{ name: 'A', defaultValue: '${B' }])
    expect(extractVariables('${URL:-http://a:1/b}')).toEqual([{ name: 'URL', defaultValue: 'http://a:1/b' }])
    expect(extractVariables(7 as unknown as string)).toEqual([])
    expect(MCP_VARIABLE_NAME_PATTERN.test('_a1')).toBe(true)
    expect(MCP_VARIABLE_NAME_PATTERN.test(`A${'b'.repeat(64)}`)).toBe(false)
  })

  it('lists the variables of a server once, required when any use has no default', () => {
    const stdio: McpJsonStdioServer = { type: 'stdio', command: '${BIN:-node}', args: ['${TOKEN}', '${PORT:-9}'], env: { A: '${TOKEN:-x}', B: '${PORT}' } }
    expect(serverVariables(stdio)).toEqual([{ name: 'BIN', defaultValue: 'node' }, { name: 'TOKEN', defaultValue: null }, { name: 'PORT', defaultValue: null }])
    const remote: McpJsonRemoteServer = { type: 'http', url: '${BASE:-https://a.example.invalid}/mcp', headers: { Authorization: 'Bearer ${KEY}' } }
    expect(serverVariables(remote)).toEqual([{ name: 'BASE', defaultValue: 'https://a.example.invalid' }, { name: 'KEY', defaultValue: null }])
    expect(serverVariables(null as unknown as McpJsonRemoteServer)).toEqual([])
  })

  it('expands only from the given values', () => {
    expect(expandVariables('Bearer ${TOKEN}', { TOKEN: 'abc' })).toEqual({ ok: true, value: 'Bearer abc' })
    expect(expandVariables('http://localhost:${PORT:-9}/mcp', {})).toEqual({ ok: true, value: 'http://localhost:9/mcp' })
    expect(expandVariables('${PORT:-9}', { PORT: '' })).toEqual({ ok: true, value: '9' })
    expect(expandVariables('${PORT}', { PORT: '' })).toEqual({ ok: true, value: '' })
    expect(expandVariables('${A}-${B}-${A}', {})).toEqual({ ok: false, missing: ['A', 'B'] })
    expect(expandVariables('$$ $HOME ${} ${1A} cost: $5', {})).toEqual({ ok: true, value: '$$ $HOME ${} ${1A} cost: $5' })
    expect(expandVariables('${A:-${B}}', { B: 'b' })).toEqual({ ok: true, value: '${B}' })
    expect(expandVariables('${A}', { A: '${B}', B: 'nested' })).toEqual({ ok: true, value: '${B}' })
    expect(expandVariables('${constructor}${toString}', {})).toEqual({ ok: false, missing: ['constructor', 'toString'] })
    expect(expandVariables('${A}', { A: 5 } as unknown as Record<string, string>)).toEqual({ ok: false, missing: ['A'] })
    expect(expandVariables('${A}', null as unknown as Record<string, string>)).toEqual({ ok: false, missing: ['A'] })
  })

  it('never reads the server environment', () => {
    const name = 'HF_C35_TEST_VARIABLE'
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    if (env === undefined)
      return
    env[name] = 'from-environment'
    try {
      expect(expandVariables(`\${${name}}`, {})).toEqual({ ok: false, missing: [name] })
      expect(expandVariables('${HOME}${PATH:-p}', {})).toEqual({ ok: false, missing: ['HOME'] })
    }
    finally {
      delete env[name]
    }
  })

  it('checks expanded URLs', () => {
    expect(['http://localhost:9/mcp', 'https://a.example.invalid', 'https://user:pass@a.example.invalid/x'].map(isAllowedMcpUrl)).toEqual([true, true, true])
    expect(['ftp://a', 'file:///x', 'https://', 'http://a b', '//a.example.invalid', '', 'http://a\n', 42].map(url => isAllowedMcpUrl(url as string))).toEqual([false, false, false, false, false, false, false, false])
  })
})

describe('mcpServerIdFromName', () => {
  it.each([
    ['memory', 'memory'],
    ['My_Server.v2', 'my-server-v2'],
    ['  GitHub  MCP ', 'github-mcp'],
    ['a__b..c', 'a-b-c'],
    ['-x-', 'x'],
    ['Café ☕', 'caf'],
    ['!!!', 'server'],
    ['', 'server'],
    ['x'.repeat(40), 'x'.repeat(32)],
    [`${'a'.repeat(31)}_b`, 'a'.repeat(31)],
  ])('%j → %j', (name, id) => {
    expect(mcpServerIdFromName(name, new Set())).toBe(id)
    expect(MCP_SERVER_ID_PATTERN.test(id)).toBe(true)
  })

  it('adds a counter when the id is taken', () => {
    expect(mcpServerIdFromName('db', new Set(['db']))).toBe('db-2')
    expect(mcpServerIdFromName('db', new Set(['db', 'db-2', 'db-3']))).toBe('db-4')
    expect(mcpServerIdFromName('x'.repeat(40), new Set(['x'.repeat(32)]))).toBe(`${'x'.repeat(30)}-2`)
    expect(mcpServerIdFromName(`${'a'.repeat(29)}-bc`, new Set([`${'a'.repeat(29)}-bc`]))).toBe(`${'a'.repeat(29)}-2`)
    expect(mcpServerIdFromName(5 as unknown as string, null as unknown as Set<string>)).toBe('server')
  })
})

// Seeded fuzz loops run several times slower on CI runners than locally: a generous timeout above the time budget.
describe('fuzzing', { timeout: 30_000 }, () => {
  it('never throws on random files and keeps its invariants', () => {
    const random = prng(0x3C35)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
    const leaves: unknown[] = [null, 1, true, '', 'node', 'https://a.example.invalid/mcp', 'http://localhost:${P:-1}', '${A}', '${', '$$', 'ftp://x', 'stdio', 'http', 'sse', 'é', '\0', 'a\r\nb']
    const keys = ['mcpServers', 'type', 'command', 'args', 'env', 'url', 'headers', 'A', 'B_1', 'X-Key', 'My Server', '__proto__']
    const value = (depth: number): unknown => {
      const roll = random()
      if (depth > 4 || roll < 0.4)
        return pick(leaves)
      if (roll < 0.6)
        return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1))
      const object: Record<string, unknown> = {}
      for (let index = Math.floor(random() * 5); index > 0; index--)
        Object.defineProperty(object, pick(keys), { value: value(depth + 1), enumerable: true, configurable: true, writable: true })
      return object
    }
    const started = Date.now()
    for (let iteration = 0; iteration < 3000; iteration++) {
      const root = random() < 0.7 ? { mcpServers: value(1) } : value(0)
      const text = JSON.stringify(root) ?? ''
      for (const input of [text, text.slice(0, Math.floor(random() * text.length))]) {
        const result = parseMcpJson(input)
        expect(result.servers.length).toBeLessThanOrEqual(MCP_CONFIG_LIMITS.serversMax)
        expect(new Set(result.servers.map(server => server.id)).size).toBe(result.servers.length)
        for (const server of result.servers) {
          expect(MCP_SERVER_ID_PATTERN.test(server.id)).toBe(true)
          expect(['stdio', 'http', 'sse']).toContain(server.transport.type)
          for (const ref of serverVariables(server.transport))
            expect(MCP_VARIABLE_NAME_PATTERN.test(ref.name)).toBe(true)
        }
        for (const entry of result.diagnostics)
          expect(MCP_CONFIG_DIAGNOSTIC_CODES).toContain(entry.code)
      }
      const template = Array.from({ length: Math.floor(random() * 20) }, () => pick(['$', '{', '}', ':-', 'A', '${A}', '${B:-x}', ' ', '$$'])).join('')
      const expanded = expandVariables(template, { A: 'a' })
      if (expanded.ok)
        expect(expanded.value).not.toContain('${A}')
    }
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Phase 14 (ADR-059, C49): `oauth` of remote servers

/** sha256 of `text` (UTF-8) in lowercase hex, with WebCrypto (the server hashes with `node:crypto`; same bytes). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** A `.mcp.json` with Claude Code `oauth` objects (example hosts only). */
const OAUTH_FILE = {
  mcpServers: {
    github: { type: 'http', url: 'https://mcp.example.com/github/', oauth: { clientId: 'Iv1.0123456789abcdef', scopes: 'repo read:org' } },
    linear: { type: 'sse', url: 'https://mcp.example.com/linear/sse', oauth: { clientId: 'lin_123', callbackPort: 8080 } },
    scoped: { url: 'https://mcp.example.com/mcp', oauth: { scopes: ['read', 'write'] }, headers: { 'X-Team': '${TEAM:-core}' } },
    remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' } },
    db: { command: 'node', args: ['tools/mcp-min.mjs'], oauth: { clientId: 'x' } },
  },
}

/**
 * The trust hash input and sha256 of each server of `OAUTH_FILE`, computed by the v1.8.1 code (before Phase 14 read
 * `oauth`): every approval of a v1.8.1 project pins these bytes, so reading `oauth` must never change them.
 */
const GOLDEN_V181: ReadonlyArray<{ name: string, text: string, sha256: string }> = [
  {
    name: 'github',
    text: '["mcp",1,"github",{"oauth":{"clientId":"Iv1.0123456789abcdef","scopes":"repo read:org"},"type":"http","url":"https://mcp.example.com/github/"},[]]',
    sha256: '8f352e1158d80315d563aa70091a1297f69097404b39aa4756b26232b0d3e333',
  },
  {
    name: 'linear',
    text: '["mcp",1,"linear",{"oauth":{"callbackPort":8080,"clientId":"lin_123"},"type":"sse","url":"https://mcp.example.com/linear/sse"},[]]',
    sha256: '43b50243d2b590c6259a2987cb8459ae6eed42e0b9944ae7777a2a8ffef19ece',
  },
  {
    name: 'scoped',
    text: '["mcp",1,"scoped",{"headers":{"X-Team":"${TEAM:-core}"},"oauth":{"scopes":["read","write"]},"url":"https://mcp.example.com/mcp"},[]]',
    sha256: '50c9b1086e6f678334bb9c0b05bf5af31f304b65697f5c7f1e376d980d67d153',
  },
  {
    name: 'remote',
    text: '["mcp",1,"remote",{"headers":{"Authorization":"Bearer ${API_TOKEN}"},"type":"http","url":"https://mcp.example.com/mcp"},[]]',
    sha256: '5426466b9e7a8cc12ed96920b148c6a3eb437a3a4ceba9c6561f34ee36f29592',
  },
  {
    name: 'db',
    text: '["mcp",1,"db",{"args":["tools/mcp-min.mjs"],"command":"node","oauth":{"clientId":"x"}},[]]',
    sha256: '7cd227b916a7da553a1376c05f7139f237dd6996f9cc8be52f8cf80ac7adbab1',
  },
]

describe('parseMcpJson: oauth (Phase 14)', () => {
  const parse = (server: unknown): ParseMcpJsonResult => parseMcpJson(JSON.stringify({ mcpServers: { s: server } }))
  const remote = (server: unknown): McpJsonRemoteServer => parse(server).servers[0]?.transport as McpJsonRemoteServer
  const messages = (result: ParseMcpJsonResult): string[] => result.diagnostics.map(entry => `${entry.level}:${entry.code}:${entry.message}`)

  it('reads the client id and scopes of remote servers', () => {
    const result = parseMcpJson(JSON.stringify(OAUTH_FILE, null, 2))
    const byName = new Map(result.servers.map(server => [server.name, server.transport]))
    expect(byName.get('github')).toEqual({ type: 'http', url: 'https://mcp.example.com/github/', headers: {}, oauth: { clientId: 'Iv1.0123456789abcdef', scopes: 'repo read:org' } })
    expect(byName.get('linear')).toEqual({ type: 'sse', url: 'https://mcp.example.com/linear/sse', headers: {}, oauth: { clientId: 'lin_123' } })
    expect(byName.get('scoped')).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Team': '${TEAM:-core}' }, oauth: { scopes: 'read write' } })
    expect(byName.get('remote')).not.toHaveProperty('oauth')
    expect(byName.get('db')).toEqual({ type: 'stdio', command: 'node', args: ['tools/mcp-min.mjs'], env: {} })
    expect(messages(result)).toEqual([
      'info:ignored-field:The OAuth callback port is ignored; the harness signs in through its own callback page.',
      'info:ignored-field:The field "oauth" is ignored.',
    ])
    expect(codes(result)).toEqual(['info:ignored-field@linear', 'info:ignored-field@db'])
  })

  it('keeps the v1.8.1 trust hash of every server, with and without oauth', async () => {
    const servers = parseMcpJson(JSON.stringify(OAUTH_FILE, null, 2)).servers
    expect(servers.map(server => server.name)).toEqual(GOLDEN_V181.map(entry => entry.name))
    for (const [index, server] of servers.entries()) {
      const golden = GOLDEN_V181[index]!
      expect(server.raw).toEqual(OAUTH_FILE.mcpServers[server.name as keyof typeof OAUTH_FILE.mcpServers])
      const text = trustHashInput({ kind: 'mcp', name: server.name, server: server.raw, refs: [] })
      expect(text, server.name).toBe(golden.text)
      expect(await sha256Hex(text), server.name).toBe(golden.sha256)
    }
  })

  it('ignores callbackPort and unknown OAuth keys with info diagnostics that never quote values', () => {
    const secret = 'SecretValue'
    const result = parse({ url: 'https://a.example.invalid', oauth: { clientId: 'app', clientSecret: secret, authServerMetadataUrl: `https://${secret}.example.invalid`, callbackPort: 9 } })
    expect((result.servers[0]?.transport as McpJsonRemoteServer).oauth).toEqual({ clientId: 'app' })
    expect(messages(result)).toEqual([
      'info:ignored-field:The OAuth callback port is ignored; the harness signs in through its own callback page.',
      'info:ignored-field:The OAuth field "clientSecret" is ignored.',
      'info:ignored-field:The OAuth field "authServerMetadataUrl" is ignored.',
    ])
    for (const entry of result.diagnostics)
      expect(entry.message).not.toContain(secret)
    expect(remote({ url: 'https://a.example.invalid', oauth: { callbackPort: 9 } })).not.toHaveProperty('oauth')
  })

  it.each([
    [{ clientId: 'app' }, { clientId: 'app' }, []],
    [{ clientId: '  app  ' }, { clientId: 'app' }, []],
    [{ clientId: 'c'.repeat(256) }, { clientId: 'c'.repeat(256) }, []],
    [{ clientId: '${CLIENT_ID}' }, { clientId: '${CLIENT_ID}' }, []],
    [{ scopes: '  read   write\tadmin ' }, { scopes: 'read write admin' }, []],
    [{ scopes: ['read', ' write ', 'a b'] }, { scopes: 'read write a b' }, []],
    [{ scopes: 's'.repeat(1024) }, { scopes: 's'.repeat(1024) }, []],
    [{ clientId: 'app', scopes: 'read' }, { clientId: 'app', scopes: 'read' }, []],
    [{}, undefined, []],
    [{ scopes: '' }, undefined, []],
    [{ scopes: [] }, undefined, []],
    [{ clientId: null, scopes: null }, undefined, []],
    [{ clientId: '' }, undefined, ['warning:ignored-field@s']],
    [{ clientId: '   ' }, undefined, ['warning:ignored-field@s']],
    [{ clientId: 'c'.repeat(257) }, undefined, ['warning:ignored-field@s']],
    [{ clientId: 7 }, undefined, ['warning:ignored-field@s']],
    [{ clientId: 'a\u0001b' }, undefined, ['warning:ignored-field@s']],
    [{ scopes: 's'.repeat(1025) }, undefined, ['warning:ignored-field@s']],
    [{ scopes: ['read', 1] }, undefined, ['warning:ignored-field@s']],
    [{ scopes: { read: true } }, undefined, ['warning:ignored-field@s']],
    [{ scopes: 'read\u0000' }, undefined, ['warning:ignored-field@s']],
    [{ clientId: 'app', scopes: 5 }, { clientId: 'app' }, ['warning:ignored-field@s']],
  ] as Array<[unknown, unknown, string[]]>)('oauth %j → %j', (oauth, expected, diagnostics) => {
    const result = parse({ url: 'https://a.example.invalid', oauth })
    const transport = result.servers[0]?.transport as McpJsonRemoteServer
    if (expected === undefined)
      expect(transport).not.toHaveProperty('oauth')
    else
      expect(transport.oauth).toEqual(expected)
    expect(codes(result)).toEqual(diagnostics)
  })

  it('keeps the server when oauth is not an object', () => {
    for (const oauth of ['x', 1, true, ['clientId']]) {
      const result = parse({ type: 'sse', url: 'https://a.example.invalid', oauth })
      expect(result.servers).toHaveLength(1)
      expect(result.servers[0]?.transport).not.toHaveProperty('oauth')
      expect(messages(result)).toEqual(['warning:ignored-field:The OAuth settings must be an object; they are ignored.'])
    }
    expect(codes(parse({ url: 'https://a.example.invalid', oauth: null }))).toEqual([])
  })

  it('reads no variables from oauth and keeps an stdio server without oauth', () => {
    const transport = remote({ url: 'https://a.example.invalid', oauth: { clientId: '${CLIENT_ID}', scopes: '${SCOPES}' } })
    expect(serverVariables(transport)).toEqual([])
    const stdio = parse({ command: 'x', oauth: { clientId: 'app' } })
    expect(stdio.servers[0]?.transport).toEqual({ type: 'stdio', command: 'x', args: [], env: {} })
    expect(codes(stdio)).toEqual(['info:ignored-field@s'])
  })

  it('never throws on random oauth objects and keeps the raw object', () => {
    const random = prng(0xC49A)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
    const values: unknown[] = [null, 1, true, '', ' ', 'app', 'read write', '\u0000', 'x'.repeat(300), ['a', 'b'], [1], {}, '${A}']
    const keys = ['clientId', 'scopes', 'callbackPort', 'clientSecret', '__proto__', 'x']
    for (let iteration = 0; iteration < 2000; iteration++) {
      const oauth: Record<string, unknown> = {}
      for (let index = Math.floor(random() * 4); index > 0; index--)
        Object.defineProperty(oauth, pick(keys), { value: pick(values), enumerable: true, configurable: true, writable: true })
      const server = { type: pick(['http', 'sse']), url: 'https://a.example.invalid/mcp', oauth: random() < 0.9 ? oauth : pick(values) }
      const result = parseMcpJson(JSON.stringify({ mcpServers: { s: server } }))
      const parsed = result.servers[0]
      expect(parsed, JSON.stringify(server)).toBeDefined()
      expect(parsed!.raw).toEqual(JSON.parse(JSON.stringify(server)))
      const read = (parsed!.transport as McpJsonRemoteServer).oauth
      if (read !== undefined) {
        expect(read.clientId !== undefined || read.scopes !== undefined).toBe(true)
        if (read.clientId !== undefined)
          expect(read.clientId.length > 0 && read.clientId.length <= MCP_CONFIG_LIMITS.oauthClientIdMaxChars && read.clientId === read.clientId.trim()).toBe(true)
        if (read.scopes !== undefined)
          expect(read.scopes.length > 0 && read.scopes.length <= MCP_CONFIG_LIMITS.oauthScopesMaxChars && !/\s{2}|^\s|\s$/.test(read.scopes)).toBe(true)
      }
      for (const entry of result.diagnostics) {
        expect(entry.code).toBe('ignored-field')
        expect(entry.level === 'error').toBe(false)
      }
    }
  }, 30_000)
})
