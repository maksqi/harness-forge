// Code plugin templates (W3.4-T1): rendering, names, and two TypeScript checks: every template type-checks (strict,
// checkJs) against the vendored `harness-forge.d.ts`, and the vendored types stay compatible with the real SDK.
import type { PluginTemplateId } from '@harness-forge/shared'
import type { NameRegistry } from './names.ts'
import type { TemplateLanguage } from './source.ts'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessError, pluginManifestSchema, pluginTemplateIdSchema } from '@harness-forge/shared'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { PLUGIN_TEMPLATES, renderPluginTemplate, TEMPLATE_ENGINES_RANGE } from './index.ts'
import { EMPTY_NAME_REGISTRY, pickTemplateNames } from './names.ts'
import { SDK_TYPES_SOURCE } from './sdk-types.ts'
import { commentText, jsString, SDK_TYPES_FILE } from './source.ts'

const TEMPLATES = pluginTemplateIdSchema.options
const LANGUAGES: readonly TemplateLanguage[] = ['js', 'ts']
const VARIANTS = TEMPLATES.flatMap(template => LANGUAGES.map(language => [template, language] as const))

function registryTaking(taken: Partial<Record<keyof NameRegistry, string[]>>): NameRegistry {
  return {
    tool: name => taken.tool?.includes(name) ?? false,
    provider: id => taken.provider?.includes(id) ?? false,
    mcpServer: id => taken.mcpServer?.includes(id) ?? false,
    command: name => taken.command?.includes(name) ?? false,
  }
}

/** The value of a JavaScript string literal, parsed (not evaluated) by the TypeScript scanner. */
function literalValue(literal: string): string {
  const file = ts.createSourceFile('literal.js', `x = ${literal}`, ts.ScriptTarget.ES2022, true)
  const statement = file.statements[0] as ts.ExpressionStatement
  const expression = (statement.expression as ts.BinaryExpression).right
  if (!ts.isStringLiteral(expression))
    throw new Error(`Not a string literal: ${literal}`)
  return expression.text
}

describe('renderPluginTemplate', () => {
  it('covers every template id of the API', () => {
    expect(Object.keys(PLUGIN_TEMPLATES).sort()).toEqual([...TEMPLATES].sort())
  })

  it.each(VARIANTS)('%s (%s) renders a valid manifest, the entry, the vendored types and a README', (template, language) => {
    const rendered = renderPluginTemplate({ template, id: 'my-plugin', name: 'My plugin', language })
    const entry = language === 'ts' ? 'index.ts' : 'index.mjs'
    expect(rendered.entry).toBe(entry)
    expect(Object.keys(rendered.files).sort()).toEqual(['README.md', SDK_TYPES_FILE, entry, 'plugin.json'].sort())
    const manifest = pluginManifestSchema.parse(JSON.parse(rendered.files['plugin.json']!))
    expect(manifest).toEqual(rendered.manifest)
    expect(manifest).toMatchObject({ id: 'my-plugin', name: 'My plugin', main: entry, engines: { harness: TEMPLATE_ENGINES_RANGE } })
    expect(rendered.files[SDK_TYPES_FILE]).toBe(SDK_TYPES_SOURCE)
    const code = rendered.files[entry]!
    const directives = language === 'js'
      ? '// @ts-check\n/// <reference path="./harness-forge.d.ts" />'
      : '/// <reference path="./harness-forge.d.ts" />'
    expect(code.startsWith(directives)).toBe(true)
    // Only `ctx` APIs: no runtime imports except the SDK shim of a TypeScript entry.
    const imports = [...code.matchAll(/^import\s(?!type\s).*$/gm)].map(match => match[0])
    expect(imports).toEqual(language === 'ts' ? ['import { definePlugin } from \'@harness-forge/plugin-sdk\''] : [])
    expect(rendered.files['README.md']).toContain('# My plugin')
    expect(rendered.files['README.md']).toContain(entry)
  })

  it('declares the settings of the MCP bridge and the network permission where code talks to the network', () => {
    const bridge = renderPluginTemplate({ template: 'mcp-bridge', id: 'bridge', name: 'Bridge' }).manifest
    expect(Object.keys(bridge.settings?.properties ?? {})).toEqual(['serverUrl', 'token'])
    expect(bridge.permissions).toEqual(['network'])
    expect(renderPluginTemplate({ template: 'provider', id: 'gw', name: 'Gateway' }).manifest.permissions).toEqual(['network'])
    expect(renderPluginTemplate({ template: 'tool', id: 'tool', name: 'Tool' }).manifest.permissions).toEqual([])
  })

  it('embeds the plugin name as an escaped string literal only', () => {
    const name = 'It\'s "quoted" \\ `back`'
    const rendered = renderPluginTemplate({ template: 'provider', id: 'quoted', name })
    expect(rendered.files['index.mjs']).toContain(`name: ${jsString(name)},`)
    expect(rendered.manifest.name).toBe(name)
  })
})

describe('names', () => {
  it('namespaces tools and providers by the plugin id', () => {
    expect(pickTemplateNames('acme-tools', 'tool').tool).toBe('acme_tools_text_stats')
    expect(pickTemplateNames('acme-tools', 'provider').provider).toBe('acme-tools')
    expect(pickTemplateNames('acme', 'mcp-bridge').mcpServer).toBe('acme')
    expect(pickTemplateNames('acme', 'command-pack').commands).toEqual({ summary: 'tldr', count: 'wordcount' })
  })

  it('picks free names when another plugin registered them', () => {
    const registry = registryTaking({
      tool: ['acme_text_stats'],
      provider: ['acme'],
      mcpServer: ['acme'],
      command: ['tldr', 'tldr-2', 'wordcount'],
    })
    expect(pickTemplateNames('acme', 'tool', registry).tool).toBe('acme_text_stats_2')
    expect(pickTemplateNames('acme', 'provider', registry).provider).toBe('acme-llm')
    expect(pickTemplateNames('acme', 'mcp-bridge', registry).mcpServer).toBe('acme-mcp')
    expect(pickTemplateNames('acme', 'command-pack', registry).commands).toEqual({ summary: 'tldr-3', count: 'wordcount-2' })
  })

  it('keeps long tool names within 64 characters', () => {
    const id = `a${'b'.repeat(38)}c`
    const name = pickTemplateNames(id, 'tool', registryTaking({ tool: [`${id}_text_stats`] })).tool
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name).toMatch(/^[\w-]+_2$/)
  })

  it('refuses an MCP bridge whose plugin id is too long for an MCP server id', () => {
    const id = 'a'.repeat(33)
    let thrown: unknown
    try {
      pickTemplateNames(id, 'mcp-bridge')
    }
    catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HarnessError)
    expect(thrown).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['id'] }] } })
    expect(pickTemplateNames(id, 'tool', EMPTY_NAME_REGISTRY).tool).toBe(`${id}_text_stats`)
  })
})

describe('source helpers', () => {
  it('jsString escapes quotes, backslashes and control characters, and round-trips', () => {
    expect(jsString('a\'b')).toBe('\'a\\\'b\'')
    expect(jsString('a\\b')).toBe('\'a\\\\b\'')
    expect(jsString('a\nb\u2028')).toBe('\'a\\nb\\u2028\'')
    // eslint-disable-next-line no-template-curly-in-string -- a literal "${x}" must survive the escaping
    for (const value of ['x\'y\\z\n\u0001', 'plain', '"double" `back` ${x}'])
      expect(literalValue(jsString(value))).toBe(value)
  })

  it('commentText keeps one line', () => {
    expect(commentText(' a\nb\r\tc ')).toBe('a b c')
  })
})

// ---------- TypeScript checks ----------

const VIRTUAL_ROOT = '/virtual-plugins'

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    if (!diagnostic.file || diagnostic.start === undefined)
      return message
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    return `${diagnostic.file.fileName}:${line + 1}:${character + 1}: ${message}`
  })
}

/** Type-checks virtual files that only see the TypeScript default libraries (as a plain editor would). */
function checkVirtual(files: Record<string, string>): string[] {
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    skipDefaultLibCheck: true,
  }
  const host = ts.createCompilerHost(options, true)
  const libDir = dirname(ts.getDefaultLibFilePath(options))
  const virtual = new Map(Object.entries(files).map(([path, content]) => [`${VIRTUAL_ROOT}/${path}`, content]))
  const baseGetSourceFile = host.getSourceFile.bind(host)
  host.fileExists = file => virtual.has(file) || (file.startsWith(libDir) && ts.sys.fileExists(file))
  host.readFile = file => virtual.get(file) ?? (file.startsWith(libDir) ? ts.sys.readFile(file) : undefined)
  host.directoryExists = dir => dir === VIRTUAL_ROOT || dir.startsWith(libDir)
  host.getDirectories = () => []
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = virtual.get(fileName)
    return text === undefined
      ? baseGetSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true)
  }
  const roots = [...virtual.keys()].filter(file => !file.endsWith('.d.ts'))
  const program = ts.createProgram(roots, options, host)
  return formatDiagnostics(ts.getPreEmitDiagnostics(program))
}

describe('typescript', () => {
  it('every template type-checks against the vendored plugin API types (strict, checkJs)', () => {
    // One folder with every entry (distinct names) and one shared harness-forge.d.ts.
    const files: Record<string, string> = { [SDK_TYPES_FILE]: SDK_TYPES_SOURCE }
    for (const [template, language] of VARIANTS) {
      const rendered = renderPluginTemplate({ template: template as PluginTemplateId, id: `my-${template}`, name: `My ${template}`, language })
      files[`${template}.${language === 'ts' ? 'ts' : 'mjs'}`] = rendered.files[rendered.entry]!
    }
    expect(checkVirtual(files)).toEqual([])
  }, 60_000)

  it('the vendored types reject a wrong plugin (the check is effective)', () => {
    const errors = checkVirtual({
      [SDK_TYPES_FILE]: SDK_TYPES_SOURCE,
      'wrong.mjs': [
        '// @ts-check',
        `/// <reference path="./${SDK_TYPES_FILE}" />`,
        '/** @type {import(\'@harness-forge/plugin-sdk\').PluginModule} */',
        'export default {',
        '  setup(ctx) {',
        '    ctx.tools.register({ name: \'x\', description: \'y\', inputSchema: {}, policy: \'sometimes\', async execute() { return 1 } })',
        '  },',
        '}',
        '',
      ].join('\n'),
    })
    expect(errors.join('\n')).toContain('sometimes')
  }, 60_000)

  it('the vendored types match the real @harness-forge/plugin-sdk', () => {
    // A virtual file inside this package resolves the real SDK from node_modules; the vendored module is renamed.
    const here = dirname(fileURLToPath(import.meta.url))
    const checkFile = join(here, '__vendored_check__.ts')
    const vendoredFile = join(here, '__vendored_sdk__.d.ts')
    const vendored = SDK_TYPES_SOURCE.replace('declare module \'@harness-forge/plugin-sdk\'', 'declare module \'vendored-plugin-sdk\'')
    const check = [
      '/// <reference path="./__vendored_sdk__.d.ts" />',
      'import type * as Real from \'@harness-forge/plugin-sdk\'',
      'import type * as Vendored from \'vendored-plugin-sdk\'',
      '',
      'type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false',
      '',
      'export const enums: [',
      '  Equal<Real.PluginKind, Vendored.PluginKind>,',
      '  Equal<Real.PluginSource, Vendored.PluginSource>,',
      '  Equal<Real.PluginState, Vendored.PluginState>,',
      '  Equal<Real.PluginPermission, Vendored.PluginPermission>,',
      '  Equal<Real.ToolMode, Vendored.ToolMode>,',
      '  Equal<Real.ToolPolicy, Vendored.ToolPolicy>,',
      '  Equal<Real.ReasoningEffort, Vendored.ReasoningEffort>,',
      '  Equal<Real.ReasoningLevel, Vendored.ReasoningLevel>,',
      '  Equal<Real.ApiFormat, Vendored.ApiFormat>,',
      '  Equal<Real.ReasoningStyle, Vendored.ReasoningStyle>,',
      '  Equal<Real.HarnessErrorCode, Vendored.HarnessErrorCode>,',
      '  Equal<Real.HarnessErrorAction, Vendored.HarnessErrorAction>,',
      '  Equal<Real.HookName, Vendored.HookName>,',
      '  Equal<Real.ModelKind, Vendored.ModelKind>,',
      '  Equal<Real.ImageAspectRatio, Vendored.ImageAspectRatio>,',
      '  Equal<Real.ToolWorkspaceAccess, Vendored.ToolWorkspaceAccess>,',
      '  Equal<Real.PluginFormat, Vendored.PluginFormat>,',
      '  Equal<Real.AgentColor, Vendored.AgentColor>,',
      '] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]',
      '',
      '// The shapes added by plugin API 1.1.0 (images, transcription and speech) are interchangeable.',
      'export const media: [',
      '  Equal<Real.ImageParamsRequest, Vendored.ImageParamsRequest>,',
      '  Equal<Real.ImageParamsResult, Vendored.ImageParamsResult>,',
      '  Equal<Real.TranscriptionHints, Vendored.TranscriptionHints>,',
      '  Equal<Real.ImageGenerateOptions, Vendored.ImageGenerateOptions>,',
      '  Equal<Real.GeneratedImageFile, Vendored.GeneratedImageFile>,',
      '  Equal<Real.ImageGenerateResult, Vendored.ImageGenerateResult>,',
      '] = [true, true, true, true, true, true]',
      '',
      '// The workspace shapes added by plugin API 1.2.0 are interchangeable.',
      'export const workspace: [',
      '  Equal<Real.ToolWorkspace, Vendored.ToolWorkspace>,',
      '  Equal<Real.ToolCallContext[\'workspace\'], Vendored.ToolCallContext[\'workspace\']>,',
      '  Equal<Real.ToolDefinition[\'workspace\'], Vendored.ToolDefinition[\'workspace\']>,',
      '] = [true, true, true]',
      '',
      '// The async-generator execute of plugin API 1.3.0 (preliminary outputs) is interchangeable.',
      'export const streaming: [',
      '  Equal<ReturnType<Real.ToolDefinition<{ text: string }, number>[\'execute\']>, ReturnType<Vendored.ToolDefinition<{ text: string }, number>[\'execute\']>>,',
      '] = [true]',
      '',
      '// The agents and skills of plugin API 1.4.0 are interchangeable.',
      'export const customization: [',
      '  Equal<Real.AgentDefinition, Vendored.AgentDefinition>,',
      '  Equal<Real.SkillDefinition, Vendored.SkillDefinition>,',
      '  Equal<Real.DeclarativeAgent, Vendored.DeclarativeAgent>,',
      '  Equal<Real.DeclarativeSkill, Vendored.DeclarativeSkill>,',
      '  Equal<Real.PluginContext[\'agents\'], Vendored.PluginContext[\'agents\']>,',
      '  Equal<Real.PluginContext[\'skills\'], Vendored.PluginContext[\'skills\']>,',
      '] = [true, true, true, true, true, true]',
      '',
      '// The command hooks, output styles and hook events of plugin API 1.5.0 are interchangeable.',
      'export const hooks: [',
      '  Equal<Real.OutputStyleDefinition, Vendored.OutputStyleDefinition>,',
      '  Equal<Real.DeclarativeOutputStyle, Vendored.DeclarativeOutputStyle>,',
      '  Equal<Real.PluginContext[\'outputStyles\'], Vendored.PluginContext[\'outputStyles\']>,',
      '  Equal<Real.HookEventName, Vendored.HookEventName>,',
      '  Equal<Real.CommandHookSpec, Vendored.CommandHookSpec>,',
      '  Equal<Real.HookMatcherGroup, Vendored.HookMatcherGroup>,',
      '  Equal<Real.HooksConfig, Vendored.HooksConfig>,',
      '  Equal<Real.RunOrigin, Vendored.RunOrigin>,',
      '  Equal<Real.HookMap[\'prompt.submit\'], Vendored.HookMap[\'prompt.submit\']>,',
      '  Equal<Real.HookMap[\'session.start\'], Vendored.HookMap[\'session.start\']>,',
      '  Equal<Real.HookMap[\'run.stop\'], Vendored.HookMap[\'run.stop\']>,',
      '  Equal<Real.HookMap[\'subagent.stop\'], Vendored.HookMap[\'subagent.stop\']>,',
      '  Equal<Real.HookMap[\'compact.before\'], Vendored.HookMap[\'compact.before\']>,',
      '  Equal<Real.HookMap[\'notification\'], Vendored.HookMap[\'notification\']>,',
      '  Equal<Real.HookMap[\'tool.after\'][1], Vendored.HookMap[\'tool.after\'][1]>,',
      '] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]',
      '',
      '// The command, skill and agent fields, prompt hooks and handler fields of plugin API 1.6.0 are interchangeable.',
      'export const claude: [',
      '  Equal<Real.CommandDefinition, Vendored.CommandDefinition>,',
      '  Equal<Real.PromptHookSpec, Vendored.PromptHookSpec>,',
      '  Equal<Real.HookHandlerSpec, Vendored.HookHandlerSpec>,',
      '  Equal<Real.PluginContext[\'commands\'], Vendored.PluginContext[\'commands\']>,',
      '] = [true, true, true, true]',
      '',
      'export function compatible(',
      '  real: { context: Real.PluginContext, model: Real.ModelInfo, manifest: Real.PluginManifest, credential: Real.CredentialField,',
      '    mcp: Real.McpServerDecl, settings: Real.SettingsSchema, error: Real.HarnessErrorInit, runtime: Real.ProviderRuntime },',
      '  vendored: { module: Vendored.PluginModule, tool: Vendored.ToolDefinition<{ text: string }, number>,',
      '    provider: Vendored.ProviderDefinition, command: Vendored.CommandDefinition, model: Vendored.ModelInfo,',
      '    manifest: Vendored.PluginManifest, mcp: Vendored.McpServerDecl, settings: Vendored.SettingsSchema,',
      '    credential: Vendored.CredentialField, error: Vendored.HarnessErrorInit },',
      '): unknown[] {',
      '  // What the host hands to plugin code satisfies the vendored types (ctx.images included)...',
      '  const context: Vendored.PluginContext = real.context',
      '  const runtime: Vendored.ProviderRuntime = real.runtime',
      '  // ...and what plugin code typed with the vendored types hands back satisfies the real types.',
      '  const module: Real.PluginModule = vendored.module',
      '  const tool: Real.ToolDefinition<{ text: string }, number> = vendored.tool',
      '  const provider: Real.ProviderDefinition = vendored.provider',
      '  const command: Real.CommandDefinition = vendored.command',
      '  // Data shapes are interchangeable.',
      '  const models: [Real.ModelInfo, Vendored.ModelInfo] = [vendored.model, real.model]',
      '  const manifests: [Real.PluginManifest, Vendored.PluginManifest] = [vendored.manifest, real.manifest]',
      '  const servers: [Real.McpServerDecl, Vendored.McpServerDecl] = [vendored.mcp, real.mcp]',
      '  const settings: [Real.SettingsSchema, Vendored.SettingsSchema] = [vendored.settings, real.settings]',
      '  const credentials: [Real.CredentialField, Vendored.CredentialField] = [vendored.credential, real.credential]',
      '  const errors: [Real.HarnessErrorInit, Vendored.HarnessErrorInit] = [vendored.error, real.error]',
      '  return [context, runtime, module, tool, provider, command, models, manifests, servers, settings, credentials, errors]',
      '}',
      '',
    ].join('\n')
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      lib: ['lib.es2023.d.ts'],
      types: ['node'],
    }
    const host = ts.createCompilerHost(options, true)
    const virtual = new Map([[checkFile, check], [vendoredFile, vendored]])
    const baseFileExists = host.fileExists.bind(host)
    const baseReadFile = host.readFile.bind(host)
    const baseGetSourceFile = host.getSourceFile.bind(host)
    host.fileExists = file => virtual.has(file) || baseFileExists(file)
    host.readFile = file => virtual.get(file) ?? baseReadFile(file)
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
      const text = virtual.get(fileName)
      return text === undefined
        ? baseGetSourceFile(fileName, languageVersion, onError, shouldCreate)
        : ts.createSourceFile(fileName, text, languageVersion, true)
    }
    const program = ts.createProgram([checkFile], options, host)
    const source = program.getSourceFile(checkFile)!
    const diagnostics = [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
      ...program.getSemanticDiagnostics(program.getSourceFile(vendoredFile)!),
    ]
    expect(formatDiagnostics(diagnostics)).toEqual([])
  }, 120_000)
})
