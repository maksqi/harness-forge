import { Buffer } from 'node:buffer'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fixturePath, removeTempDirs, tempDir, writeFiles } from './__fixtures__/harness.ts'
import { compiledFileName, compileEntry, forbiddenImportMessage, SDK_SHIM_SOURCE } from './compile.ts'
import { importEntry, pluginModuleOf } from './loader.ts'

afterEach(() => {
  removeTempDirs()
})

async function compile(files: Record<string, string>, entry: string, force = false) {
  const dir = realpathSync(writeFiles(tempDir(), files))
  const entryPath = join(dir, entry)
  const cacheDir = join(tempDir(), 'cache', 'plugin')
  const result = await compileEntry({ dir, entryPath, entryBytes: readFileSync(entryPath), cacheDir, force })
  return { dir, cacheDir, result }
}

describe('.ts entries', () => {
  it('bundles into the cache with the SDK shim and imports the result', async () => {
    const source = readFileSync(join(fixturePath('word-count'), 'src', 'index.ts'), 'utf8')
    const { dir, cacheDir, result } = await compile({ 'src/index.ts': source }, 'src/index.ts')
    expect(result).toMatchObject({ ok: true, diagnostics: [] })
    expect(result.outputFile).toBe(join(cacheDir, compiledFileName(Buffer.from(source))))
    expect(readdirSync(dir).sort()).toEqual(['src'])
    const output = readFileSync(result.outputFile as string, 'utf8')
    expect(output).toContain('function definePlugin(m)')
    expect(output).toContain('sourceMappingURL=data:application/json')
    expect(output).not.toContain('@harness-forge/plugin-sdk\'')
    const exported = pluginModuleOf(await importEntry(result.outputFile as string, 'compiled'))
    expect('module' in exported).toBe(true)
  })

  it('reuses the cached output for the same source unless forced, and prunes older builds', async () => {
    const files = { 'index.ts': 'export default { setup() {} }\n' }
    const first = await compile(files, 'index.ts')
    const dir = first.dir
    const again = await compileEntry({ dir, entryPath: join(dir, 'index.ts'), entryBytes: Buffer.from(files['index.ts']), cacheDir: first.cacheDir })
    expect(again).toMatchObject({ ok: true, outputFile: first.result.outputFile })
    const changed = 'export default { setup() { return 1 } }\n'
    const next = await compileEntry({ dir, entryPath: join(dir, 'index.ts'), entryBytes: Buffer.from(changed), cacheDir: first.cacheDir, force: true })
    expect(next.ok).toBe(true)
    expect(readdirSync(first.cacheDir)).toEqual([compiledFileName(Buffer.from(changed))])
  })

  it('returns diagnostics with 1-based positions for syntax errors', async () => {
    const { result, cacheDir } = await compile({ 'index.ts': 'export default {\n  setup(ctx) {\n    const a =\n  }\n}\n' }, 'index.ts')
    expect(result.ok).toBe(false)
    expect(result.outputFile).toBeNull()
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', file: 'index.ts', line: 4, column: 3, lineText: '  }' })
    expect(existsSync(cacheDir)).toBe(false)
  })

  it('rejects packages with a ctx.ai hint, relative imports, and non-exported SDK values', async () => {
    const { result } = await compile({
      'index.ts': [
        'import { z } from \'zod\'',
        'import { helper } from \'./helper\'',
        'import { readFileSync } from \'node:fs\'',
        'export default { setup() { return [z, helper, readFileSync] } }',
        '',
      ].join('\n'),
      'helper.ts': 'export const helper = 1\n',
    }, 'index.ts')
    expect(result.ok).toBe(false)
    const messages = result.diagnostics.map(diagnostic => diagnostic.message)
    expect(messages).toEqual(expect.arrayContaining([
      'Code plugins cannot import packages ("zod"): use ctx.ai.z instead.',
      'Code plugins are a single file: the import "./helper" is not allowed. Move the code into the entry file.',
    ]))
    expect(result.diagnostics.find(diagnostic => diagnostic.message.includes('zod'))).toMatchObject({ file: 'index.ts', line: 1 })

    const sdk = await compile({ 'index.ts': 'import { settingsValuesSchema } from \'@harness-forge/plugin-sdk\'\nexport default { setup() { return settingsValuesSchema } }\n' }, 'index.ts')
    expect(sdk.result.ok).toBe(false)
    expect(sdk.result.diagnostics[0]?.message).toBe('"@harness-forge/plugin-sdk" provides only definePlugin and PLUGIN_API_VERSION at runtime: import "settingsValuesSchema" with "import type" if it is a type, or use ctx instead.')
  })
})

describe('.mjs / .js entries', () => {
  it('checks syntax and imports without writing output', async () => {
    const ok = await compile({ 'index.mjs': 'import { randomInt } from \'node:crypto\'\nimport path from \'path\'\nexport default { setup() { return randomInt(2) + path.sep } }\n' }, 'index.mjs')
    expect(ok.result).toMatchObject({ ok: true, outputFile: join(ok.dir, 'index.mjs') })
    expect(existsSync(ok.cacheDir)).toBe(false)

    const sdk = await compile({ 'index.js': 'import { definePlugin } from \'@harness-forge/plugin-sdk\'\nexport default definePlugin({ setup() {} })\n' }, 'index.js')
    expect(sdk.result.ok).toBe(false)
    expect(sdk.result.diagnostics[0]?.message).toMatch(/JSDoc types/)

    const broken = await compile({ 'index.mjs': 'export default { setup( }\n' }, 'index.mjs')
    expect(broken.result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ severity: 'error', line: 1 })] })
  })
})

describe('messages', () => {
  it('names the host library for known packages', () => {
    expect(forbiddenImportMessage('@ai-sdk/openai-compatible/internal', true)).toMatch(/ctx\.ai\.createOpenAICompatible/)
    expect(forbiddenImportMessage('ai', true)).toMatch(/ctx\.ai\.tool, ctx\.ai\.jsonSchema and ctx\.ai\.generateText/)
    expect(forbiddenImportMessage('left-pad', true)).toMatch(/Node built-ins and the host libraries/)
    expect(forbiddenImportMessage('/abs/path.mjs', false)).toMatch(/single file/)
    expect(SDK_SHIM_SOURCE).toContain('PLUGIN_API_VERSION = "1.0.0"')
  })
})
