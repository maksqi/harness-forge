// Code plugin entries (PLUGINS.md 8 "Allowed imports", ".ts entries"). Owner: W1.3 (W1.3-T7).
//
// - `.ts` entries are bundled by esbuild into one ESM file `data/cache/plugins/<id>/<sha256>.mjs` (never inside the
//   plugin directory): `bundle`, `format: 'esm'`, `platform: 'node'`, `target: 'node22'`, inline source map. The SDK
//   (`@harness-forge/plugin-sdk`) resolves to a virtual shim that exports `definePlugin` and `PLUGIN_API_VERSION`.
// - `.mjs` / `.js` entries are imported as they are; the same esbuild pass (without output) checks their syntax and
//   imports.
// Only Node built-ins may be imported (kept external). Relative imports and packages fail with a diagnostic, because a
// code plugin is one file (the trust hash covers `plugin.json` and the entry only) and gets its libraries from `ctx.ai`.
import type { BuildDiagnostic } from '@harness-forge/shared'
import type { Message, Plugin } from 'esbuild'
import type { PluginCompileResult } from './types.ts'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { extname, isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { build, version as esbuildVersion } from 'esbuild'
import { sha256Hex } from './loader.ts'

/** The only package a `.ts` entry may import (values: `definePlugin`, `PLUGIN_API_VERSION`; everything else is types). */
export const SDK_PACKAGE = '@harness-forge/plugin-sdk'

const SHIM_NAMESPACE = 'harness-forge-sdk-shim'

/** Runtime of the SDK inside a compiled plugin. */
export const SDK_SHIM_SOURCE = [
  'export function definePlugin(m) { return m }',
  `export const PLUGIN_API_VERSION = ${JSON.stringify(PLUGIN_API_VERSION)}`,
  '',
].join('\n')

/** Changes whenever the compiler output for the same source could change (cache key salt). */
const BUILD_SALT = `esbuild@${esbuildVersion};target=node22;sdk=${PLUGIN_API_VERSION};v1\n`

/** Suggestions for packages a plugin gets from `ctx.ai`. */
const HOST_LIBRARY_HINTS: Readonly<Record<string, string>> = {
  'zod': 'ctx.ai.z',
  'ai': 'ctx.ai.tool, ctx.ai.jsonSchema and ctx.ai.generateText',
  '@ai-sdk/openai-compatible': 'ctx.ai.createOpenAICompatible',
  '@ai-sdk/anthropic': 'ctx.ai.createAnthropic',
  '@ai-sdk/openai': 'ctx.ai.createOpenAI',
  '@ai-sdk/google': 'ctx.ai.createGoogleGenerativeAI',
}

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier
}

/** The diagnostic of a forbidden import. */
export function forbiddenImportMessage(specifier: string, typescript: boolean): string {
  if (specifier === SDK_PACKAGE && !typescript) {
    return `"${SDK_PACKAGE}" cannot be imported at runtime from a .mjs or .js entry: use JSDoc types `
      + `(/** @type {import('${SDK_PACKAGE}').PluginModule} */) and a plain "export default { setup(ctx) {} }".`
  }
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:') || isAbsolute(specifier)) {
    return `Code plugins are a single file: the import "${specifier}" is not allowed. Move the code into the entry file.`
  }
  const hint = HOST_LIBRARY_HINTS[packageName(specifier)]
  if (hint)
    return `Code plugins cannot import packages ("${specifier}"): use ${hint} instead.`
  return `Code plugins cannot import packages ("${specifier}"): use Node built-ins and the host libraries in ctx.ai `
    + '(z, tool, jsonSchema, generateText, createOpenAICompatible, createAnthropic, createOpenAI, createGoogleGenerativeAI).'
}

/** esbuild plugin enforcing the import rules: built-ins external, the SDK shimmed (`.ts` only), everything else an error. */
function importPolicy(typescript: boolean): Plugin {
  return {
    name: 'harness-forge-plugin-imports',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point')
          return undefined
        if (args.path === SDK_PACKAGE && typescript)
          return { path: SDK_PACKAGE, namespace: SHIM_NAMESPACE }
        if (isBuiltin(args.path))
          return { path: args.path, external: true }
        return { errors: [{ text: forbiddenImportMessage(args.path, typescript) }] }
      })
      builder.onLoad({ filter: /.*/, namespace: SHIM_NAMESPACE }, () => ({ contents: SDK_SHIM_SOURCE, loader: 'js' }))
    },
  }
}

/** esbuild's text for a missing export of the shim, rewritten for plugin authors. */
function friendlyText(text: string): string {
  const missing = text.match(/^No matching export in "[^"]*" for import "([^"]+)"$/)
  if (missing && text.includes(`${SHIM_NAMESPACE}:${SDK_PACKAGE}`)) {
    return `"${SDK_PACKAGE}" provides only definePlugin and PLUGIN_API_VERSION at runtime: `
      + `import "${missing[1]}" with "import type" if it is a type, or use ctx instead.`
  }
  return text
}

function toDiagnostic(severity: BuildDiagnostic['severity'], message: Message): BuildDiagnostic {
  const location = message.location
  const inFile = location !== null && (location.namespace === '' || location.namespace === 'file')
  const text = message.notes.length > 0
    ? `${friendlyText(message.text)} (${message.notes.map(note => note.text).join(' ')})`
    : friendlyText(message.text)
  const diagnostic: BuildDiagnostic = {
    severity,
    file: inFile ? location.file.replaceAll('\\', '/') : null,
    line: location && location.line > 0 ? location.line : null,
    column: location ? location.column + 1 : null,
    message: text,
  }
  if (location?.lineText)
    diagnostic.lineText = location.lineText
  return diagnostic
}

function failureMessages(error: unknown): { errors: Message[], warnings: Message[] } | null {
  if (typeof error !== 'object' || error === null)
    return null
  const { errors, warnings } = error as { errors?: unknown, warnings?: unknown }
  if (!Array.isArray(errors))
    return null
  return { errors: errors as Message[], warnings: Array.isArray(warnings) ? warnings as Message[] : [] }
}

export interface CompileEntryInput {
  /** Realpath of the plugin directory (diagnostic paths are relative to it). */
  dir: string
  /** Realpath of the entry file. */
  entryPath: string
  /** Contents of the entry (hashed for the cache file name). */
  entryBytes: Uint8Array
  /** `data/cache/plugins/<id>`. */
  cacheDir: string
  /** Rebuild even when the cached output exists (`POST /plugins/:id/build` wants fresh diagnostics). */
  force?: boolean
}

/** Name of the compiled output of `.ts` source bytes. */
export function compiledFileName(entryBytes: Uint8Array): string {
  return `${sha256Hex(new TextEncoder().encode(BUILD_SALT), entryBytes)}.mjs`
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  }
  catch {
    return false
  }
}

/** Removes earlier compiled outputs of a plugin (the modules already imported stay in memory). */
async function pruneCache(cacheDir: string, keep: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(cacheDir)
  }
  catch {
    return
  }
  await Promise.all(names
    .filter(name => name !== keep && (name.endsWith('.mjs') || name.endsWith('.tmp')))
    .map(name => rm(join(cacheDir, name), { force: true })))
}

/**
 * Compiles a `.ts` entry into the cache, or checks a `.mjs` / `.js` entry. Never throws for problems of the plugin
 * code: they are returned as diagnostics (`ok: false`, `outputFile: null`).
 */
export async function compileEntry(input: CompileEntryInput): Promise<PluginCompileResult> {
  const started = performance.now()
  const typescript = extname(input.entryPath) === '.ts'
  const outputName = typescript ? compiledFileName(input.entryBytes) : null
  const outputFile = outputName === null ? null : join(input.cacheDir, outputName)
  const elapsed = (): number => Math.round((performance.now() - started) * 100) / 100

  if (outputFile !== null && !input.force && await exists(outputFile))
    return { ok: true, durationMs: elapsed(), diagnostics: [], outputFile }

  let errors: Message[] = []
  let warnings: Message[] = []
  let code: Uint8Array | null = null
  try {
    const result = await build({
      entryPoints: [input.entryPath],
      absWorkingDir: input.dir,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      sourcemap: typescript ? 'inline' : false,
      write: false,
      outfile: outputFile ?? join(input.cacheDir, 'check.mjs'),
      logLevel: 'silent',
      charset: 'utf8',
      // Deterministic TypeScript semantics wherever the plugin lives (no tsconfig.json lookup in parent folders).
      tsconfigRaw: {},
      plugins: [importPolicy(typescript)],
    })
    warnings = result.warnings
    code = result.outputFiles?.[0]?.contents ?? null
  }
  catch (error) {
    const messages = failureMessages(error)
    if (!messages)
      throw error
    errors = messages.errors
    warnings = messages.warnings
  }

  const diagnostics = [
    ...errors.map(message => toDiagnostic('error', message)),
    ...warnings.map(message => toDiagnostic('warning', message)),
  ]
  if (errors.length > 0)
    return { ok: false, durationMs: elapsed(), diagnostics, outputFile: null }
  if (!typescript)
    return { ok: true, durationMs: elapsed(), diagnostics, outputFile: input.entryPath }
  if (code === null || outputFile === null || outputName === null) {
    return {
      ok: false,
      durationMs: elapsed(),
      diagnostics: [...diagnostics, { severity: 'error', file: null, line: null, column: null, message: 'The compiler produced no output.' }],
      outputFile: null,
    }
  }

  await mkdir(input.cacheDir, { recursive: true, mode: 0o755 })
  const temporary = `${outputFile}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, code, { mode: 0o644 })
  await rename(temporary, outputFile)
  await pruneCache(input.cacheDir, outputName)
  return { ok: true, durationMs: elapsed(), diagnostics, outputFile }
}
