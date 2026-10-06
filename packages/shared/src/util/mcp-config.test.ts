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

describe('fuzzing', () => {
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
