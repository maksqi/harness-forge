// Phase 12 (W12.2-T1): owner exec bits (zip Unix modes, tar header modes, folder copies) kept only with
// `preserveExec` (the Claude Code format), subtree selection (entries outside are skipped before admission: never
// written, not counted, links there ignored) and the layout of a staged plugin (`layout.ts`).
import type { ArchiveEntry } from './archive.ts'
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeTgzOf } from '../../testing/fake-remote.ts'
import { EntryCollector, subtreeSelector, verifyTree, writeEntries } from './archive.ts'
import { INSTALL_LIMITS } from './errors.ts'
import { readFolder } from './folder.ts'
import { layoutOf, NO_PLUGIN_MESSAGE } from './layout.ts'
import { readTarGz } from './tar.ts'
import { removeTempDirs, tempDir, tgzOf, unixMode, zipOf } from './testing.ts'
import { readZip, readZipComment } from './zip.ts'

afterEach(() => removeTempDirs())

const posix = process.platform !== 'win32'

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

function entry(path: string, type: 'file' | 'dir' = 'file', executable = false): ArchiveEntry {
  return { path, type, data: type === 'file' ? new TextEncoder().encode(path) : null, ...(executable ? { executable: true } : {}) }
}

describe('exec bits', () => {
  it('readZip records the owner exec bit of Unix entries only', async () => {
    const entries = await readZip(zipOf({
      'hooks/format.sh': ['#!/bin/sh\n', unixMode(0o100755)],
      'hooks/data.txt': ['text\n', unixMode(0o100644)],
      'plain.txt': 'no unix mode\n',
    }), new EntryCollector(INSTALL_LIMITS))
    const executable = Object.fromEntries(entries.filter(item => item.type === 'file').map(item => [item.path, item.executable === true]))
    expect(executable).toEqual({ 'hooks/format.sh': true, 'hooks/data.txt': false, 'plain.txt': false })
  })

  it('readTarGz records the owner exec bit of the header mode', async () => {
    const tgz = fakeTgzOf({ 'package/run.sh': { content: '#!/bin/sh\n', mode: 0o755 }, 'package/a.md': 'a' })
    const entries = await readTarGz(tgz, new EntryCollector(INSTALL_LIMITS), INSTALL_LIMITS)
    expect(Object.fromEntries(entries.map(item => [item.path, item.executable === true]))).toEqual({ 'package/run.sh': true, 'package/a.md': false })
  })

  it.skipIf(!posix)('readFolder records the owner exec bit from lstat', async () => {
    const root = tempDir()
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'tool'), '#!/bin/sh\n')
    chmodSync(join(root, 'bin', 'tool'), 0o755)
    writeFileSync(join(root, 'readme.md'), 'x')
    const entries = await readFolder(root, new EntryCollector(INSTALL_LIMITS))
    expect(entries.find(item => item.path === 'bin/tool')?.executable).toBe(true)
    expect(entries.find(item => item.path === 'readme.md')?.executable).toBeUndefined()
  })

  it.skipIf(!posix)('writeEntries / verifyTree keep 0755 only with preserveExec; harness trees stay 0644', async () => {
    const entries = [entry('hooks', 'dir'), entry('hooks/format.sh', 'file', true), entry('README.md')]
    const claude = tempDir()
    await writeEntries(claude, entries, '', { preserveExec: true })
    expect(await verifyTree(claude, INSTALL_LIMITS, { preserveExec: true })).toEqual({ count: 2, bytes: 24 })
    expect(modeOf(join(claude, 'hooks', 'format.sh'))).toBe(0o755)
    expect(modeOf(join(claude, 'README.md'))).toBe(0o644)
    expect(modeOf(join(claude, 'hooks'))).toBe(0o755)

    const harness = tempDir()
    await writeEntries(harness, entries, '')
    await verifyTree(harness, INSTALL_LIMITS)
    expect(modeOf(join(harness, 'hooks', 'format.sh'))).toBe(0o644)
    expect(modeOf(join(harness, 'README.md'))).toBe(0o644)
  })

  it('readZipComment reads the archive comment; null for other bytes', () => {
    const zip = zipOf({ 'a.txt': 'a' })
    expect(readZipComment(zip)).toBe('')
    expect(readZipComment(new TextEncoder().encode('not a zip'))).toBeNull()
  })
})

describe('subtree selection', () => {
  const big = (count: number): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`top/other/file-${index}.txt`, 'x'.repeat(100)]))

  it('skips entries outside the subtree before admission: not written, not counted, links there ignored', async () => {
    const limits = { ...INSTALL_LIMITS, entries: 5, expandedBytes: 1000 }
    const zip = zipOf({
      ...big(50),
      'top/other/link': ['/etc/passwd', unixMode(0o120777)],
      'top/plugins/x/plugin.json': '{}',
      'top/plugins/x/a.md': 'a',
    })
    const entries = await readZip(zip, new EntryCollector(limits, ['repo'], { select: subtreeSelector('top/plugins/x/') }))
    expect(entries.map(item => item.path).sort()).toEqual(['top/plugins/x/a.md', 'top/plugins/x/plugin.json'])
  })

  it('a link inside the subtree is refused; the caps count the subtree', async () => {
    const select = subtreeSelector('top/plugins/x/')
    await expect(readZip(zipOf({ 'top/plugins/x/plugin.json': '{}', 'top/plugins/x/link': ['/etc/passwd', unixMode(0o120777)] }), new EntryCollector(INSTALL_LIMITS, ['repo'], { select })))
      .rejects
      .toMatchObject({ code: 'validation_error', message: expect.stringContaining('symbolic link') })
    const limits = { ...INSTALL_LIMITS, entries: 2 }
    await expect(readZip(zipOf({ 'top/plugins/x/a': 'a', 'top/plugins/x/b': 'b', 'top/plugins/x/c': 'c' }), new EntryCollector(limits, ['repo'], { select })))
      .rejects
      .toMatchObject({ code: 'validation_error', message: expect.stringContaining('more than 2 entries') })
  })

  it('tar readers honor the selector too', async () => {
    const tgz = tgzOf([{ name: 'package/x/a.md', data: 'a' }, { name: 'package/y/link', type: '2', linkname: '/etc/passwd' }])
    const entries = await readTarGz(tgz, new EntryCollector(INSTALL_LIMITS, [], { select: subtreeSelector('package/x/') }), INSTALL_LIMITS)
    expect(entries.map(item => item.path)).toEqual(['package/x/a.md'])
  })

  it('subtreeSelector selects the folder itself and its content, never its parents', () => {
    const select = subtreeSelector('top/plugins/x/')
    expect(['top/', 'top/plugins/', 'top/plugins/x/', 'top/plugins/x', 'top/plugins/x/a', 'top/plugins/xy/a'].map(select)).toEqual([false, false, true, true, true, false])
  })
})

describe('layoutOf', () => {
  it('a root plugin.json is a harness plugin at the root; one in a single top folder is unwrapped', () => {
    expect(layoutOf([entry('plugin.json'), entry('index.mjs')])).toEqual({ format: 'harness', prefix: '' })
    expect(layoutOf([entry('pkg', 'dir'), entry('pkg/plugin.json')])).toEqual({ format: 'harness', prefix: 'pkg/' })
  })

  it('without a layout: the message names both formats (issue path kept)', () => {
    expect(() => layoutOf([entry('readme.md')], { issuePath: ['file'] })).toThrow(NO_PLUGIN_MESSAGE)
    expect(() => layoutOf([], { issuePath: ['file'] })).toThrow('empty')
  })

  it('a requested claude format takes the detected root, else the single top folder, else the root', () => {
    expect(layoutOf([entry('commands/a.md')], { format: 'claude' })).toEqual({ format: 'claude', prefix: '' })
    expect(layoutOf([entry('kit/SKILL.md'), entry('kit/reference.md')], { format: 'claude' })).toEqual({ format: 'claude', prefix: 'kit/' })
    expect(layoutOf([entry('.claude-plugin/plugin.json'), entry('commands/a.md')], { format: 'claude' })).toEqual({ format: 'claude', prefix: '' })
  })

  it('a requested harness format still needs its plugin.json', () => {
    expect(() => layoutOf([entry('commands/a.md')], { format: 'harness', issuePath: ['file'] })).toThrow('plugin.json must be at the root')
  })

  it('base limits the search to a subtree (a repository folder)', () => {
    const entries = [entry('repo-abc/README.md'), entry('repo-abc/plugins/x/plugin.json'), entry('repo-abc/plugins/x/index.mjs')]
    expect(layoutOf(entries, { base: 'repo-abc/plugins/x/' })).toEqual({ format: 'harness', prefix: 'repo-abc/plugins/x/' })
    expect(layoutOf(entries, { base: 'repo-abc/plugins/x/', format: 'claude' })).toEqual({ format: 'claude', prefix: 'repo-abc/plugins/x/' })
  })

  it.skipIf(!posix)('links in a copied folder stay refused', async () => {
    const root = tempDir()
    writeFileSync(join(root, 'plugin.json'), '{}')
    symlinkSync('/etc/passwd', join(root, 'link'))
    await expect(readFolder(root, new EntryCollector(INSTALL_LIMITS, ['path']))).rejects.toMatchObject({ code: 'validation_error' })
  })
})
