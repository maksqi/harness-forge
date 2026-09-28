import type { PluginFileEntry } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { pluginIdProblem, pluginNameProblem, slugifyPluginId } from './code-plugin-form'
import {
  baseName,
  buildFileTree,
  byteColumnToIndex,
  existingPaths,
  folderOf,
  folderPaths,
  languageOf,
  newFilePathProblem,
  problemsText,
  sha256Hex,
} from './source-files'

function entry(path: string, type: 'file' | 'dir' = 'file', editable = true): PluginFileEntry {
  return { path, type, size: type === 'dir' ? 0 : 10, mtime: 1_759_000_000_000, editable: type === 'file' && editable }
}

describe('languageOf', () => {
  it.each([
    ['index.mjs', 'javascript'],
    ['lib/a.js', 'javascript'],
    ['x.cjs', 'javascript'],
    ['index.ts', 'typescript'],
    ['types.d.ts', 'typescript'],
    ['plugin.json', 'json'],
    ['README.md', 'markdown'],
    ['notes.txt', 'text'],
    ['icon.svg', 'text'],
  ] as const)('%s -> %s', (path, language) => {
    expect(languageOf(path)).toBe(language)
  })
})

describe('paths and tree', () => {
  it('splits names and folders', () => {
    expect(baseName('lib/deep/a.mjs')).toBe('a.mjs')
    expect(baseName('a.mjs')).toBe('a.mjs')
    expect(folderOf('lib/deep/a.mjs')).toBe('lib/deep')
    expect(folderOf('a.mjs')).toBe('')
  })

  it('builds a nested tree with folders first, implicit folders included', () => {
    const tree = buildFileTree([
      entry('lib', 'dir'),
      entry('b.md'),
      entry('a.mjs'),
      entry('lib/z.mjs'),
      entry('lib/inner/y.mjs'),
    ])
    expect(tree.map(node => `${node.type}:${node.path}`)).toEqual(['dir:lib', 'file:a.mjs', 'file:b.md'])
    const lib = tree[0]!
    expect(lib.entry?.path).toBe('lib')
    expect(lib.children.map(node => `${node.type}:${node.path}`)).toEqual(['dir:lib/inner', 'file:lib/z.mjs'])
    expect(lib.children[0]!.entry).toBeNull()
    expect(folderPaths(tree)).toEqual(['lib', 'lib/inner'])
  })
})

describe('newFilePathProblem', () => {
  const existing = existingPaths([entry('lib', 'dir'), entry('lib/util.mjs'), entry('README.md')])

  it('accepts relative paths with the offered extensions', () => {
    expect(newFilePathProblem('lib/new.mjs', existing)).toBeNull()
    expect(newFilePathProblem('src/deep/types.ts', existing)).toBeNull()
    expect(newFilePathProblem('  notes.md  ', existing)).toBeNull()
  })

  it.each([
    ['', 'Enter a file name.'],
    ['../x.mjs', 'Use a relative path'],
    ['/abs.mjs', 'Use a relative path'],
    ['a b.mjs', 'Use a relative path'],
    ['lib\\x.mjs', 'Use a relative path'],
    ['icon.png', 'Use one of these extensions'],
    ['lib/util.mjs', 'already exists'],
    ['readme.md', 'already exists'],
    ['lib', 'Use one of these extensions'],
    ['README.md/x.md', 'is a file, not a folder'],
    ['.github/x.md', 'Hidden files'],
    ['lib/.hidden.mjs', 'Hidden files'],
  ])('%j is refused', (path, message) => {
    expect(newFilePathProblem(path, existing)).toContain(message)
  })
})

describe('byteColumnToIndex', () => {
  it('converts 1-based UTF-8 byte columns to UTF-16 indexes', () => {
    expect(byteColumnToIndex('const x = 1', 1)).toBe(0)
    expect(byteColumnToIndex('const x = 1', 7)).toBe(6)
    // e-acute is 2 bytes, the euro sign 3 bytes and the emoji 4 bytes (2 UTF-16 units).
    const line = '\u00E9\u20AC\u{1F600}x'
    expect(byteColumnToIndex(line, 3)).toBe(1)
    expect(byteColumnToIndex(line, 6)).toBe(2)
    expect(byteColumnToIndex(line, 10)).toBe(4)
    expect(byteColumnToIndex(line, 99)).toBe(line.length)
  })
})

describe('formatters', () => {
  it('counts problems', () => {
    const diagnostic = { severity: 'error' as const, file: 'a', line: 1, column: 1, message: 'x' }
    expect(problemsText([])).toBe('')
    expect(problemsText([diagnostic])).toBe('1 problem')
    expect(problemsText([diagnostic, diagnostic, diagnostic])).toBe('3 problems')
  })

  it('computes the etag of the server (SHA-256 of the UTF-8 text)', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('code plugin form rules', () => {
  it('derives an id from the name', () => {
    expect(slugifyPluginId('Weather Tools!')).toBe('weather-tools')
    expect(slugifyPluginId('  Caf\u00E9  cr\u00E8me ')).toBe('cafe-creme')
    expect(slugifyPluginId('---')).toBe('')
    expect(slugifyPluginId('x'.repeat(50)).length).toBe(40)
    expect(slugifyPluginId(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39))
  })

  it('checks names and ids like the server', () => {
    expect(pluginNameProblem('')).toBe('Enter a name.')
    expect(pluginNameProblem('x'.repeat(65))).toContain('64')
    expect(pluginNameProblem('a\nb')).toContain('line breaks')
    expect(pluginNameProblem('Weather')).toBeNull()

    const exists = (id: string) => id === 'taken'
    expect(pluginIdProblem('', 'tool', exists)).toBe('Enter an id.')
    expect(pluginIdProblem('Bad_Id', 'tool', exists)).toContain('a-z')
    expect(pluginIdProblem('-x', 'tool', exists)).toContain('a-z')
    expect(pluginIdProblem('core-x', 'tool', exists)).toContain('reserved')
    expect(pluginIdProblem('openai', 'tool', exists)).toContain('reserved')
    expect(pluginIdProblem('taken', 'tool', exists)).toContain('already exists')
    expect(pluginIdProblem('a'.repeat(33), 'mcp-bridge', exists)).toContain('32')
    expect(pluginIdProblem('a'.repeat(33), 'tool', exists)).toBeNull()
  })
})
