import type { PluginManifest } from './plugin-manifest.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { flattenValidationIssues } from '../errors.ts'
import {
  applyDeclarativeProviderDefaults,
  credentialFieldSchema,
  declarativeCommandSchema,
  declarativeProviderSchema,
  mcpServerDeclSchema,
  modelInfoSchema,
  templateKeys,
} from './plugin-data.ts'
import {
  declaresStdioMcpServer,
  manifestRequiresTrust,
  pluginManifestBaseSchema,
  pluginManifestSchema,
} from './plugin-manifest.ts'
import { settingsSchemaSchema } from './plugin-settings.ts'

const PLUGINS_MD = readFileSync(new URL('../../../../docs/PLUGINS.md', import.meta.url), 'utf8')

/** Every ```json block of PLUGINS.md that is a manifest. */
function manifestExamples(): unknown[] {
  return [...PLUGINS_MD.matchAll(/```json\n([\s\S]*?)```/g)]
    .map(match => match[1] ?? '')
    .filter(block => block.includes('"manifestVersion"'))
    .map(block => JSON.parse(block) as unknown)
}

function issuePaths(result: { success: boolean, error?: { issues: readonly { path: readonly PropertyKey[], code: string, message: string }[] } }): string[] {
  expect(result.success).toBe(false)
  return flattenValidationIssues(result.error!).map(issue => issue.path.join('.'))
}

const base = {
  manifestVersion: 1,
  id: 'acme',
  name: 'Acme',
  version: '1.0.0',
  engines: { harness: '^1.0.0' },
} as const

function provider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'acme', name: 'Acme', baseURL: 'https://api.example.com/v1', apiFormat: 'openai-chat', ...overrides }
}

describe('manifest examples of PLUGINS.md', () => {
  const examples = manifestExamples()

  it('finds the declarative and code manifest examples', () => {
    const ids = examples.map(example => (example as PluginManifest).id)
    expect(ids).toEqual(expect.arrayContaining(['acme-docs', 'together-ai', 'dice-roller', 'acme-gateway', 'mcp-everything']))
  })

  it('parses every example with pluginManifestSchema', () => {
    for (const example of examples) {
      const result = pluginManifestSchema.safeParse(example)
      expect(result.success ? [] : flattenValidationIssues(result.error), (example as PluginManifest).id).toEqual([])
    }
  })

  it('detects trust requirements', () => {
    const byId = new Map(examples.map(example => [(example as PluginManifest).id, pluginManifestSchema.parse(example)]))
    expect(manifestRequiresTrust(byId.get('dice-roller')!)).toBe(true)
    expect(manifestRequiresTrust(byId.get('together-ai')!)).toBe(false)
    expect(declaresStdioMcpServer(byId.get('mcp-everything')!)).toBe(true)
    expect(manifestRequiresTrust(byId.get('acme-docs')!)).toBe(false)
  })
})

describe('pluginManifestSchema', () => {
  it('accepts a minimal manifest', () => {
    expect(pluginManifestSchema.parse(base)).toEqual(base)
  })

  it('rejects reserved ids with a clear path', () => {
    for (const id of ['core-x', 'core-providers', 'mock', 'openai', 'ollama']) {
      const result = pluginManifestSchema.safeParse({ ...base, id })
      expect(issuePaths(result), id).toEqual(['id'])
      expect(result.error?.issues[0]?.message).toContain('reserved')
    }
    // Builtin manifests pass the base schema used by DTOs.
    expect(pluginManifestBaseSchema.safeParse({ ...base, id: 'core-providers' }).success).toBe(true)
  })

  it('rejects invalid ids', () => {
    for (const id of ['Acme', 'a'.repeat(41), '-acme', 'acme-', 'ac_me', ''])
      expect(issuePaths(pluginManifestSchema.safeParse({ ...base, id })), id).toContain('id')
  })

  it('rejects provider ids outside the plugin namespace', () => {
    const manifest = { ...base, contributes: { providers: [provider({ id: 'acme-eu' }), provider({ id: 'other' }), provider({ id: 'acmeplus' })] } }
    expect(issuePaths(pluginManifestSchema.safeParse(manifest))).toEqual([
      'contributes.providers.1.id',
      'contributes.providers.2.id',
    ])
  })

  it('rejects duplicate providers, MCP servers and commands', () => {
    const manifest = {
      ...base,
      contributes: {
        providers: [provider(), provider()],
        mcpServers: [
          { id: 'acme', name: 'A', transport: { type: 'http', url: 'https://mcp.example.com' } },
          { id: 'acme', name: 'B', transport: { type: 'sse', url: 'https://mcp.example.com/sse' } },
        ],
        commands: [
          { name: 'go', description: 'Go', template: '{{input}}' },
          { name: 'go', description: 'Go again', template: '{{input}}' },
        ],
      },
    }
    expect(issuePaths(pluginManifestSchema.safeParse(manifest)).sort()).toEqual([
      'contributes.commands.1.name',
      'contributes.mcpServers.1.id',
      'contributes.providers.1.id',
    ])
  })

  it('validates versions, ranges, homepage, icon, main and permissions', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ version: '1.0' }, 'version'],
      [{ version: 'v1.0.0' }, 'version'],
      [{ engines: { harness: 'latest' } }, 'engines.harness'],
      [{ engines: {} }, 'engines.harness'],
      [{ homepage: 'ftp://example.com' }, 'homepage'],
      [{ icon: '../icon.svg' }, 'icon'],
      [{ icon: 'icon.gif' }, 'icon'],
      [{ icon: 'lobe:Bad Slug' }, 'icon'],
      [{ main: '/abs/index.mjs' }, 'main'],
      [{ main: 'index.cjs' }, 'main'],
      [{ main: 'src\\index.ts' }, 'main'],
      [{ permissions: ['network', 'network'] }, 'permissions'],
      [{ permissions: ['root'] }, 'permissions.0'],
      [{ unknown: true }, ''],
      [{ manifestVersion: 2 }, 'manifestVersion'],
      [{ description: 'x'.repeat(281) }, 'description'],
    ]
    for (const [overrides, path] of cases)
      expect(issuePaths(pluginManifestSchema.safeParse({ ...base, ...overrides })), JSON.stringify(overrides)).toContain(path)
    for (const range of ['^1.0.0', '>=1.0.0 <2.0.0', '1.x', '*', '~1.2', '>= 1.0.0', '1.0.0 - 2.0.0', '^1.0.0 || ^2.0.0', '1.0.0-beta.1'])
      expect(pluginManifestSchema.safeParse({ ...base, engines: { harness: range } }).success, range).toBe(true)
    expect(pluginManifestSchema.safeParse({ ...base, version: '2.0.0-beta.1+build.5', icon: 'assets/icon.png', main: 'dist/index.ts' }).success).toBe(true)
  })

  it('checks settings references of MCP servers', () => {
    const manifest = {
      ...base,
      settings: { type: 'object', properties: { token: { type: 'string', format: 'secret', title: 'Token' } } },
      contributes: {
        mcpServers: [{
          id: 'acme',
          name: 'Acme',
          transport: { type: 'http', url: 'https://{{settings.host}}/mcp', headers: { Authorization: 'Bearer {{settings.token}}' } },
        }],
      },
    }
    const result = pluginManifestSchema.safeParse(manifest)
    expect(issuePaths(result)).toEqual(['contributes.mcpServers.0.transport'])
    expect(result.error?.issues[0]?.message).toContain('settings.host')
  })
})

describe('declarativeProviderSchema', () => {
  it('applies the PLUGINS.md defaults', () => {
    const parsed = declarativeProviderSchema.parse(provider({ baseURL: 'https://api.example.com/v1/' }))
    expect(applyDeclarativeProviderDefaults(parsed)).toMatchObject({
      baseURL: 'https://api.example.com/v1',
      auth: { type: 'bearer' },
      credentials: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }],
      headers: {},
      models: [],
      listModels: true,
      reasoningStyle: 'none',
      modelsDevId: 'acme',
    })
    expect(applyDeclarativeProviderDefaults(declarativeProviderSchema.parse(provider({ apiFormat: 'anthropic' }))).auth)
      .toEqual({ type: 'header', header: 'x-api-key' })
    expect(applyDeclarativeProviderDefaults(declarativeProviderSchema.parse(provider({ auth: { type: 'none' } }))).credentials).toEqual([])
  })

  it('validates auth, credentials and headers', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ auth: { type: 'header' } }, 'auth.header'],
      [{ auth: { type: 'bearer', header: 'x' } }, 'auth.header'],
      [{ credentials: [{ key: 'token', label: 'Token', type: 'secret' }] }, 'credentials'],
      [{ credentials: [{ key: 'apiKey', label: 'Key', type: 'secret', envVar: 'OPENAI_API_KEY' }] }, 'credentials.0.envVar'],
      [{ credentials: [{ key: 'apiKey', label: 'Key', type: 'secret' }, { key: 'apiKey', label: 'Again', type: 'text' }] }, 'credentials.1.key'],
      [{ headers: { Authorization: 'Token x' } }, 'headers.Authorization'],
      [{ headers: { Host: 'evil' } }, 'headers.Host'],
      [{ headers: { 'X-Team': '{{credentials.team}}' } }, 'headers.X-Team'],
      [{ headers: { 'X-Team': '{{ credentials.apiKey }}' } }, 'headers.X-Team'],
      [{ headers: { 'X-Team': '{{settings.apiKey}}' } }, 'headers.X-Team'],
      [{ headers: { 'X-Line': 'a\r\nInjected: 1' } }, 'headers.X-Line'],
      [{ headers: { 'Bad Header': 'x' } }, 'headers.Bad Header'],
      [{ baseURL: 'https://user:pass@api.example.com' }, 'baseURL'],
      [{ baseURL: 'https://api.example.com/v1?x=1' }, 'baseURL'],
      [{ baseURL: '/relative' }, 'baseURL'],
      [{ listModels: { path: 'models' } }, 'listModels.path'],
      [{ listModels: { path: 'https://other.example.com/models' } }, 'listModels.path'],
      [{ listModels: { include: '(' } }, 'listModels.include'],
      [{ reasoningStyle: 'anthropic-thinking' }, 'reasoningStyle'],
      [{ icon: 'icon.svg' }, 'icon'],
      [{ models: [{ id: 'a' }, { id: 'a' }] }, 'models.1.id'],
    ]
    for (const [overrides, path] of cases)
      expect(issuePaths(declarativeProviderSchema.safeParse(provider(overrides))), JSON.stringify(overrides)).toContain(path)
  })

  it('accepts templated headers, header auth and same-origin listing URLs', () => {
    const result = declarativeProviderSchema.safeParse(provider({
      apiFormat: 'openai-responses',
      auth: { type: 'header', header: 'api-key' },
      credentials: [
        { key: 'apiKey', label: 'API key', type: 'secret', required: true },
        { key: 'tenant', label: 'Tenant', type: 'text', default: 'main' },
        { key: 'region', label: 'Region', type: 'select', options: ['eu', 'us'], default: 'eu' },
      ],
      headers: { 'X-Tenant': 'tenant-{{credentials.tenant}}', 'Authorization': 'Bearer {{credentials.apiKey}}' },
      listModels: { path: 'https://api.example.com/v2/models', exclude: 'embed|tts' },
      reasoningStyle: 'openai-effort',
      smallModelId: 'small',
    }))
    expect(result.success ? [] : flattenValidationIssues(result.error)).toEqual([])
  })
})

describe('credential fields, models, commands and MCP servers', () => {
  it('validates credential fields', () => {
    expect(credentialFieldSchema.safeParse({ key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar: ['OPENAI_API_KEY', 'OPENAI_KEY'] }).success).toBe(true)
    expect(credentialFieldSchema.safeParse({ key: 'baseURL', label: 'Base URL', type: 'url', default: 'https://api.openai.com/v1', advanced: true }).success).toBe(true)
    expect(issuePaths(credentialFieldSchema.safeParse({ key: 'region', label: 'Region', type: 'select' }))).toEqual(['options'])
    expect(issuePaths(credentialFieldSchema.safeParse({ key: 'region', label: 'Region', type: 'select', options: ['eu'], default: 'us' }))).toEqual(['default'])
    expect(issuePaths(credentialFieldSchema.safeParse({ key: 'apiKey', label: 'Key', type: 'secret', default: 'sk-1' }))).toEqual(['default'])
    expect(issuePaths(credentialFieldSchema.safeParse({ key: 'baseURL', label: 'URL', type: 'url', default: 'nope' }))).toEqual(['default'])
    expect(issuePaths(credentialFieldSchema.safeParse({ key: '1key', label: 'Key', type: 'text' }))).toEqual(['key'])
  })

  it('validates model info', () => {
    expect(modelInfoSchema.safeParse({ id: 'openai/gpt-oss-120b', name: 'gpt-oss', contextWindow: 131072, capabilities: { tools: true }, reasoningEfforts: ['low', 'high'], cost: { input: 0.15, output: 0.6 } }).success).toBe(true)
    expect(issuePaths(modelInfoSchema.safeParse({ id: 'x', reasoningEfforts: ['low', 'low'] }))).toEqual(['reasoningEfforts'])
    expect(issuePaths(modelInfoSchema.safeParse({ id: 'x', contextWindow: 0 }))).toEqual(['contextWindow'])
    expect(issuePaths(modelInfoSchema.safeParse({ id: 'x', capabilities: { telepathy: true } }))).toEqual(['capabilities'])
  })

  it('validates declarative commands', () => {
    expect(declarativeCommandSchema.safeParse({ name: 'tldr', description: 'Summarize', template: 'Summarize:\n\n{{input}}' }).success).toBe(true)
    for (const name of ['new', 'model', 'effort', 'mode', 'help'])
      expect(issuePaths(declarativeCommandSchema.safeParse({ name, description: 'x', template: 'x' }))).toEqual(['name'])
    expect(issuePaths(declarativeCommandSchema.safeParse({ name: 'big', description: 'x', template: 'x'.repeat(16_385) }))).toEqual(['template'])
  })

  it('validates MCP server declarations', () => {
    expect(mcpServerDeclSchema.safeParse({ id: 'srv', name: 'Server', transport: { type: 'stdio', command: 'npx', args: ['-y', 'pkg', '--token={{settings.token}}'], env: { TOKEN: '{{settings.token}}' } } }).success).toBe(true)
    expect(issuePaths(mcpServerDeclSchema.safeParse({ id: 'srv', name: 'S', transport: { type: 'stdio', command: '{{settings.cmd}}' } }))).toEqual(['transport.command'])
    expect(issuePaths(mcpServerDeclSchema.safeParse({ id: 'srv', name: 'S', transport: { type: 'http', url: 'file:///etc/passwd' } }))).toEqual(['transport.url'])
    expect(issuePaths(mcpServerDeclSchema.safeParse({ id: 'srv', name: 'S', transport: { type: 'ws', url: 'wss://x' } }))).toEqual(['transport.type'])
    expect(issuePaths(mcpServerDeclSchema.safeParse({ id: 'srv', name: 'S', transport: { type: 'http', url: 'https://x.example.com', headers: { A: '{{input}}' } } }))).toEqual(['transport.headers.A'])
  })

  it('parses template placeholders', () => {
    expect(templateKeys('Bearer {{settings.token}} {{settings.other}}', 'settings')).toEqual(['token', 'other'])
    expect(templateKeys('plain', 'credentials')).toEqual([])
    expect(templateKeys('{{credentials.key', 'credentials')).toBeNull()
    expect(templateKeys('{{credentials.key}}', 'settings')).toBeNull()
  })
})

describe('settingsSchemaSchema', () => {
  const property = { type: 'string', title: 'Name' }

  it('accepts every property type', () => {
    const result = settingsSchemaSchema.safeParse({
      type: 'object',
      required: ['name', 'token'],
      properties: {
        name: { ...property, pattern: '^[a-z]+$', default: 'abc' },
        token: { type: 'string', title: 'Token', format: 'secret' },
        endpoint: { type: 'string', title: 'Endpoint', format: 'url', default: 'https://example.com' },
        notes: { type: 'string', title: 'Notes', format: 'multiline' },
        mode: { type: 'string', title: 'Mode', enum: ['fast', 'slow'], default: 'fast' },
        count: { type: 'integer', title: 'Count', minimum: 1, maximum: 10, default: 3 },
        ratio: { type: 'number', title: 'Ratio', minimum: 0, maximum: 1 },
        enabled: { type: 'boolean', title: 'Enabled', default: true },
        tags: { type: 'array', title: 'Tags', items: { type: 'string' }, default: ['a', 'b'] },
        colors: { type: 'array', title: 'Colors', items: { type: 'string', enum: ['red', 'blue'] } },
      },
    })
    expect(result.success ? [] : flattenValidationIssues(result.error)).toEqual([])
  })

  it('enforces the rules of PLUGINS.md section 7', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ properties: { '1bad': property } }, 'properties.1bad'],
      [{ required: ['missing'], properties: { name: property } }, 'required.0'],
      [{ properties: { name: { ...property, enum: ['a'], format: 'url' } } }, 'properties.name.format'],
      [{ properties: { name: { ...property, format: 'secret', default: 'x' } } }, 'properties.name.default'],
      [{ properties: { name: { ...property, pattern: '(' } } }, 'properties.name.pattern'],
      [{ properties: { name: { ...property, default: 3 } } }, 'properties.name.default'],
      [{ properties: { name: { ...property, enum: ['a', 'b'], default: 'c' } } }, 'properties.name.default'],
      [{ properties: { n: { type: 'integer', title: 'N', default: 1.5 } } }, 'properties.n.default'],
      [{ properties: { n: { type: 'number', title: 'N', minimum: 5, maximum: 1 } } }, 'properties.n.maximum'],
      [{ properties: { n: { type: 'number', title: 'N', minimum: 5, default: 1 } } }, 'properties.n.default'],
      [{ properties: { t: { type: 'array', title: 'T', items: { type: 'string' }, default: ['a', 'a'] } } }, 'properties.t.default'],
      [{ properties: { name: { ...property, enum: ['a', 'a'] } } }, 'properties.name.enum'],
      [{ properties: { name: { type: 'object', title: 'Nested' } } }, 'properties.name.type'],
      [{ properties: { name: { type: 'string' } } }, 'properties.name.title'],
      [{ properties: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, property])) }, 'properties'],
    ]
    for (const [overrides, path] of cases)
      expect(issuePaths(settingsSchemaSchema.safeParse({ type: 'object', properties: {}, ...overrides })), JSON.stringify(overrides).slice(0, 80)).toContain(path)
  })
})
