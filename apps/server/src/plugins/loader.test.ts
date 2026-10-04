import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginManifestBaseSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { fixturePath, manifest, removeTempDirs, tempDir, writeFiles } from './__fixtures__/harness.ts'
import {
  contentHash,
  countFiles,
  declaredContributions,
  importEntry,
  inspectPluginDirectory,
  isInside,
  lenientManifest,
  pathPin,
  pluginModuleOf,
  readPluginDirectory,
  synthesizeManifest,
} from './loader.ts'

afterEach(() => {
  removeTempDirs()
})

function plugin(id: string, files: Record<string, string | object>): string {
  return writeFiles(join(tempDir(), id), files)
}

describe('readPluginDirectory', () => {
  it('accepts a valid declarative plugin and hashes plugin.json', async () => {
    const dir = join(tempDir(), 'acme-docs')
    cpSync(fixturePath('acme-docs'), dir, { recursive: true })
    const read = await readPluginDirectory(dir, { expectedId: 'acme-docs' })
    expect(read.problem).toBeNull()
    expect(read.manifest?.id).toBe('acme-docs')
    expect(read.dir).toBe(realpathSync(dir))
    expect(read.requiresTrust).toBe(false)
    expect(read.compatible).toBe(true)
    expect(read.hash).toBe(createHash('sha256').update(readFileSync(join(dir, 'plugin.json'))).digest('hex'))
    expect(read.iconVersion).toMatch(/^[\da-f]{8}$/)
  })

  it('hashes code plugins as plugin.json + 0x00 + entry (PLUGINS.md 13)', async () => {
    const dir = join(tempDir(), 'dice-roller')
    cpSync(fixturePath('dice-roller'), dir, { recursive: true })
    const read = await readPluginDirectory(dir, { expectedId: 'dice-roller' })
    const expected = createHash('sha256')
      .update(readFileSync(join(dir, 'plugin.json')))
      .update(Buffer.from([0]))
      .update(readFileSync(join(dir, 'index.mjs')))
      .digest('hex')
    expect(read.hash).toBe(expected)
    expect(read.requiresTrust).toBe(true)
    expect(read.entryPath).toBe(realpathSync(join(dir, 'index.mjs')))
    expect(contentHash(readFileSync(join(dir, 'plugin.json')), readFileSync(join(dir, 'index.mjs')))).toBe(expected)
  })

  it('fails the documented steps in order', async () => {
    const cases: Array<[string, Record<string, string | object>, RegExp, 'error' | 'incompatible']> = [
      ['no-manifest', { 'readme.txt': 'x' }, /plugin\.json is missing/, 'error'],
      ['bad-json', { 'plugin.json': '{ nope' }, /not valid JSON/, 'error'],
      ['too-big', { 'plugin.json': `{"x":"${'y'.repeat(300_000)}"}` }, /larger than 256 KB/, 'error'],
      ['future', { 'plugin.json': manifest('future', { engines: { harness: '>=3.0.0' }, somethingNew: true }) }, /needs plugin API >=3\.0\.0/, 'incompatible'],
      ['strict', { 'plugin.json': manifest('strict', { unknownKey: 1 }) }, /Invalid plugin\.json/, 'error'],
      ['mismatch', { 'plugin.json': manifest('other-id') }, /does not match the directory name "mismatch"/, 'error'],
      ['core-thing', { 'plugin.json': manifest('core-thing') }, /reserved/, 'error'],
      ['no-entry', { 'plugin.json': manifest('no-entry', { main: 'index.mjs' }) }, /entry "index\.mjs" is missing/, 'error'],
      ['bad-icon', { 'plugin.json': manifest('bad-icon', { icon: 'icon.svg' }) }, /icon "icon\.svg" is missing/, 'error'],
      ['big-icon', { 'plugin.json': manifest('big-icon', { icon: 'icon.png' }), 'icon.png': 'x'.repeat(300_000) }, /larger than 256 KB/, 'error'],
    ]
    for (const [id, files, message, state] of cases) {
      const read = await readPluginDirectory(plugin(id, files), { expectedId: id })
      expect(read.problem?.state, id).toBe(state)
      expect(read.problem?.error.message, id).toMatch(message)
      expect(read.problem?.error).toMatchObject({ code: 'plugin_error', details: { phase: 'load' } })
    }
  })

  it('keeps parsing an incompatible manifest for display and pinning', async () => {
    const dir = plugin('later', { 'plugin.json': manifest('later', { engines: { harness: '^2.0.0' }, main: 'index.mjs' }), 'index.mjs': 'export default { setup() {} }\n' })
    const read = await readPluginDirectory(dir, { expectedId: 'later' })
    expect(read.problem?.state).toBe('incompatible')
    expect(read.manifest?.version).toBe('1.0.0')
    expect(read.entryPath).not.toBeNull()
    expect(read.firstError).toBeNull()
  })

  it('rejects entries and icons that escape the directory through symlinks', async () => {
    const outside = tempDir()
    writeFileSync(join(outside, 'secret.mjs'), 'export default {}\n')
    writeFileSync(join(outside, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const dir = plugin('escape', { 'plugin.json': manifest('escape', { main: 'index.mjs', icon: 'logo.svg' }) })
    symlinkSync(join(outside, 'secret.mjs'), join(dir, 'index.mjs'))
    symlinkSync(join(outside, 'logo.svg'), join(dir, 'logo.svg'))
    const read = await readPluginDirectory(dir, { expectedId: 'escape' })
    expect(read.problem?.error.message).toMatch(/outside the plugin directory/)

    const iconOnly = plugin('icon-escape', { 'plugin.json': manifest('icon-escape', { icon: 'logo.svg' }) })
    symlinkSync(join(outside, 'logo.svg'), join(iconOnly, 'logo.svg'))
    expect((await readPluginDirectory(iconOnly, { expectedId: 'icon-escape' })).problem?.error.message).toMatch(/icon "logo\.svg"/)

    const manifestLink = join(tempDir(), 'manifest-link')
    mkdirSync(manifestLink)
    writeFileSync(join(outside, 'plugin.json'), JSON.stringify(manifest('manifest-link')))
    symlinkSync(join(outside, 'plugin.json'), join(manifestLink, 'plugin.json'))
    expect((await readPluginDirectory(manifestLink)).problem?.error.message).toMatch(/plugin\.json is missing/)
  })

  it('accepts files linked inside the directory and reports a missing directory', async () => {
    const dir = plugin('inner-link', { 'plugin.json': manifest('inner-link', { main: 'src/real.mjs' }), 'src/real.mjs': 'export default { setup() {} }\n' })
    symlinkSync(join(dir, 'src', 'real.mjs'), join(dir, 'index.mjs'))
    expect((await readPluginDirectory(dir, { expectedId: 'inner-link' })).problem).toBeNull()
    expect((await readPluginDirectory(join(tempDir(), 'missing'))).problem?.error.message).toMatch(/missing/)
  })
})

describe('inspectPluginDirectory', () => {
  it('reports the manifest, kind, hash, trust, compatibility and file counts; reserved ids are flagged, not rejected', async () => {
    const dir = plugin('openai', { 'plugin.json': manifest('openai', { main: 'index.mjs' }), 'index.mjs': 'export default { setup() {} }\n', 'extra/notes.txt': 'hello' })
    const inspection = await inspectPluginDirectory(dir)
    expect(inspection).toMatchObject({ kind: 'code', requiresTrust: true, compatible: true, reserved: true, files: { count: 3 } })
    expect(inspection.sha256).toMatch(/^[\da-f]{64}$/)
    expect(inspection.files.bytes).toBeGreaterThan(0)
  })

  it('flags incompatible plugins and throws validation_error for invalid ones', async () => {
    const future = plugin('future', { 'plugin.json': manifest('future', { engines: { harness: '^9.0.0' } }) })
    expect(await inspectPluginDirectory(future)).toMatchObject({ compatible: false, reserved: false })
    await expect(inspectPluginDirectory(plugin('broken', { 'plugin.json': '[' }))).rejects.toMatchObject({ code: 'validation_error' })
    await expect(inspectPluginDirectory(plugin('schema', { 'plugin.json': manifest('schema', { name: 7 }) }))).rejects.toMatchObject({
      code: 'validation_error',
      details: { issues: [expect.objectContaining({ path: ['name'] })] },
    })
    const stdio = await inspectPluginDirectory(fixturePath('stdio-server'))
    expect(stdio).toMatchObject({ kind: 'declarative', requiresTrust: true, contributions: { mcpServers: ['stdio-server'] } })
  })
})

describe('manifest helpers', () => {
  it('reads lenient fields and synthesizes a valid manifest', () => {
    expect(lenientManifest({ id: 'x', name: 'X', version: 'nope', engines: { harness: '^1' }, main: 'a.mjs' })).toEqual({ id: 'x', name: 'X', main: 'a.mjs', harness: '^1' })
    expect(lenientManifest('not an object')).toEqual({})
    const synthesized = synthesizeManifest('broken-plugin', { name: 'Broken', version: '2.0.0', description: 'd' })
    expect(pluginManifestBaseSchema.parse(synthesized)).toMatchObject({ id: 'broken-plugin', name: 'Broken', version: '2.0.0', engines: { harness: '*' } })
    expect(pluginManifestBaseSchema.safeParse(synthesizeManifest('core-x', {})).success).toBe(true)
  })

  it('lists declared contributions', () => {
    const acme = JSON.parse(readFileSync(join(fixturePath('acme-docs'), 'plugin.json'), 'utf8')) as Parameters<typeof declaredContributions>[0]
    expect(declaredContributions(acme)).toEqual({ providers: ['acme-docs'], models: 3, tools: [], mcpServers: ['acme-docs'], commands: ['acme'], hooks: [], agents: [], skills: [] })
    expect(declaredContributions(null).providers).toEqual([])
  })

  it('pins linked folders by path and checks containment', () => {
    expect(pathPin('/a/b')).toBe(`path:${createHash('sha256').update('/a/b').digest('hex')}`)
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(false)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a/b/../c')).toBe(false)
  })

  it('counts files without following symlinks', async () => {
    const dir = plugin('count', { 'a.txt': 'abc', 'b/c.txt': 'de' })
    symlinkSync(join(dir, 'a.txt'), join(dir, 'link.txt'))
    expect(await countFiles(dir)).toEqual({ count: 2, bytes: 5 })
  })
})

describe('entry import', () => {
  it('imports with a cache-busting version and re-evaluates after a failed import', async () => {
    const dir = tempDir()
    const file = join(dir, 'index.mjs')
    writeFileSync(file, 'export default { setup() { return 1 } }\n')
    const first = pluginModuleOf(await importEntry(file, 'v1'))
    expect('module' in first && first.module.setup(undefined)).toBe(1)
    writeFileSync(file, 'export default { setup() { return 2 } }\n')
    const cached = pluginModuleOf(await importEntry(file, 'v1'))
    expect('module' in cached && cached.module.setup(undefined)).toBe(1)
    const second = pluginModuleOf(await importEntry(file, 'v2'))
    expect('module' in second && second.module.setup(undefined)).toBe(2)

    writeFileSync(file, 'throw new Error("evaluation failed")\n')
    await expect(importEntry(file, 'v3')).rejects.toThrow('evaluation failed')
    writeFileSync(file, 'export default { setup() { return 3 } }\n')
    const retried = pluginModuleOf(await importEntry(file, 'v3'))
    expect('module' in retried && retried.module.setup(undefined)).toBe(3)
  })

  it('describes modules without a usable default export', () => {
    expect(pluginModuleOf({})).toEqual({ problem: expect.stringMatching(/default-export/) })
    expect(pluginModuleOf({ default: {} })).toEqual({ problem: expect.stringMatching(/no setup/) })
    expect(pluginModuleOf({ default: { setup() {}, dispose: 1 } })).toEqual({ problem: expect.stringMatching(/dispose/) })
    expect('module' in pluginModuleOf({ default: { setup() {} } })).toBe(true)
  })
})
