import { describe, expect, it } from 'vitest'
import { EntryCollector } from './archive.ts'
import { checkEntryPath, parentPaths, pathKey } from './paths.ts'

describe('checkEntryPath', () => {
  it.each([
    ['plugin.json', 'plugin.json', false],
    ['src/index.mjs', 'src/index.mjs', false],
    ['folder/', 'folder', true],
    ['./plugin.json', 'plugin.json', false],
    ['a/./b.txt', 'a/b.txt', false],
    ['./', '', true],
    ['caf\u00E9/men\u00FC.md', 'caf\u00E9/men\u00FC.md', false],
  ])('accepts %j', (raw, path, trailingSlash) => {
    expect(checkEntryPath(raw)).toEqual({ ok: true, path, trailingSlash })
  })

  it.each([
    ['', 'empty name'],
    ['../evil', '".." segment'],
    ['a/../../evil', '".." segment'],
    ['a/..', '".." segment'],
    ['/abs', 'absolute path'],
    ['/', 'absolute path'],
    ['C:\\x', 'backslash'],
    ['C:/x', 'drive letter'],
    ['c:x', 'drive letter'],
    ['a\\b', 'backslash'],
    ['..\\evil', 'backslash'],
    ['file.txt:stream', '":"'],
    ['a//b', 'empty path segment'],
    ['nul\u0000.txt', 'control characters'],
    ['line\nbreak', 'control characters'],
    ['esc\u001B', 'control characters'],
    ['c1\u0085', 'control characters'],
    ['con', 'reserved device name'],
    ['dir/NUL.txt', 'reserved device name'],
    ['lpt1', 'reserved device name'],
    [`${'x'.repeat(256)}`, 'longer than 255 bytes'],
    [`${Array.from({ length: 33 }).fill('d').join('/')}`, 'deeper than 32 levels'],
    [`${Array.from({ length: 8 }, () => 'x'.repeat(200)).join('/')}`, 'longer than 1024 bytes'],
  ])('refuses %j', (raw, reason) => {
    const result = checkEntryPath(raw)
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toContain(reason)
  })

  it('folds case and Unicode normalization for comparisons', () => {
    expect(pathKey('Caf\u00E9/A.TXT')).toBe(pathKey('cafe\u0301/a.txt'))
    expect(parentPaths('a/b/c.txt')).toEqual(['a', 'a/b'])
  })
})

describe('entryCollector', () => {
  const limits = { entries: 5, expandedBytes: 100 }

  it('admits entries and skips macOS metadata and the root', () => {
    const collector = new EntryCollector(limits)
    expect(collector.admit('./', 'dir', 0)).toBeNull()
    expect(collector.admit('__MACOSX/._plugin.json', 'file', 4)).toBeNull()
    expect(collector.admit('sub/.DS_Store', 'file', 4)).toBeNull()
    expect(collector.admit('sub/a.txt', 'file', 10)).toBe('sub/a.txt')
    expect(collector.admit('sub/', 'dir', 0)).toBe('sub')
    expect(collector.bytes).toBe(18)
  })

  it('refuses duplicates, case-insensitive duplicates and file/folder conflicts', () => {
    const collector = new EntryCollector({ entries: 50, expandedBytes: 100 })
    collector.admit('a.txt', 'file', 1)
    expect(() => collector.admit('a.txt', 'file', 1)).toThrow(/more than once/)
    expect(() => collector.admit('A.TXT', 'file', 1)).toThrow(/more than once/)
    collector.admit('dir/b.txt', 'file', 1)
    expect(() => collector.admit('dir', 'file', 1)).toThrow(/both as a file and as a folder/)
    collector.admit('file', 'file', 1)
    expect(() => collector.admit('file/child.txt', 'file', 1)).toThrow(/both as a file and as a folder/)
    expect(() => collector.admit('x/', 'file', 1)).toThrow(/ends with "\/"/)
    expect(() => collector.admit('folder/', 'dir', 5)).toThrow(/carries data/)
  })

  it('enforces the entry count and the expanded size', () => {
    const counted = new EntryCollector(limits)
    for (let index = 0; index < 5; index++)
      counted.admit(`f${index}`, 'file', 1)
    expect(() => counted.admit('f5', 'file', 1)).toThrow(/more than 5 entries/)

    const sized = new EntryCollector(limits)
    sized.admit('a', 'file', 60)
    expect(() => sized.admit('b', 'file', 41)).toThrow(/expands to more than/)
    let thrown: unknown
    try {
      new EntryCollector(limits).admit('big', 'file', 101)
    }
    catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'payload_too_large', details: { limitBytes: 100 } })
  })
})
