import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { safeGitignoreLines, walkWorkspace } from './walk.ts'

let base: string
let root: string

async function write(files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

async function walkedFiles(options: { start?: string, includeIgnored?: boolean } = {}): Promise<string[]> {
  const result = await walkWorkspace({ root, start: options.start ?? root, includeIgnored: options.includeIgnored })
  return result.files.map(file => file.rel).sort()
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  await mkdir(root)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('walkWorkspace', () => {
  it('skips .git always and node_modules unless includeIgnored', async () => {
    await write({
      'a.txt': 'a',
      'src/b.ts': 'b',
      '.git/config': 'c',
      'sub/.git': 'gitdir: ../.git/worktrees/sub',
      'node_modules/pkg/index.js': 'x',
      'src/node_modules/inner/index.js': 'y',
    })
    expect(await walkedFiles()).toEqual(['a.txt', 'src/b.ts'])
    expect(await walkedFiles({ includeIgnored: true })).toEqual(['a.txt', 'node_modules/pkg/index.js', 'src/b.ts', 'src/node_modules/inner/index.js'])
  })

  it('honors nested .gitignore files (one rule set per folder, deeper negations win)', async () => {
    await write({
      '.gitignore': '*.log\ndist/\n',
      'app.log': '',
      'keep.txt': '',
      'dist/out.js': '',
      'pkg/.gitignore': '!important.log\nbuild/\n',
      'pkg/important.log': '',
      'pkg/other.log': '',
      'pkg/build/x.js': '',
      'pkg/src/build.ts': '',
      'other/build/y.js': '',
    })
    expect(await walkedFiles()).toEqual([
      '.gitignore',
      'keep.txt',
      'other/build/y.js',
      'pkg/.gitignore',
      'pkg/important.log',
      'pkg/src/build.ts',
    ])
    expect(await walkedFiles({ includeIgnored: true })).toContain('dist/out.js')
  })

  it('applies the .gitignore files above the start folder and walks an ignored start folder', async () => {
    await write({
      '.gitignore': '*.log\ngenerated/\n',
      'src/a.ts': '',
      'src/debug.log': '',
      'generated/g.ts': '',
      'generated/g.log': '',
    })
    const src = await walkWorkspace({ root, start: join(root, 'src') })
    expect(src.files.map(file => [file.rel, file.fromStart])).toEqual([['src/a.ts', 'a.ts']])
    // The caller named the ignored folder: it is walked with only the rules inside it.
    await write({ 'generated/.gitignore': '*.tmp\n', 'generated/x.tmp': '' })
    const generated = await walkWorkspace({ root, start: join(root, 'generated') })
    expect(generated.files.map(file => file.rel)).toEqual(['generated/.gitignore', 'generated/g.log', 'generated/g.ts'])
  })

  it('returns files in walk order: the files of a folder by name, then its subfolders', async () => {
    await write({ 'b.txt': '', 'a/z.txt': '', 'a/y/x.txt': '', 'c.txt': '', 'a/b.txt': '' })
    const result = await walkWorkspace({ root, start: root })
    expect(result.files.map(file => file.rel)).toEqual(['b.txt', 'c.txt', 'a/b.txt', 'a/z.txt', 'a/y/x.txt'])
    expect(result.truncated).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('never enters folder links; keeps file links whose target is a file inside the root', async () => {
    await write({ 'real/inside.txt': 'x', 'target.txt': 't' })
    await mkdir(join(base, 'outside'))
    await writeFile(join(base, 'outside', 'secret.txt'), 's')
    await writeFile(join(base, 'outside.txt'), 'o')
    await symlink(join(root, 'real'), join(root, 'dir-link'))
    await symlink(join(base, 'outside'), join(root, 'outside-dir-link'))
    await symlink(join(root, 'target.txt'), join(root, 'file-link.txt'))
    await symlink(join(base, 'outside.txt'), join(root, 'outside-link.txt'))
    await symlink(join(root, 'missing.txt'), join(root, 'dangling.txt'))
    const result = await walkWorkspace({ root, start: root })
    expect(result.files.map(file => [file.rel, file.link])).toEqual([
      ['file-link.txt', true],
      ['target.txt', false],
      ['real/inside.txt', false],
    ])
  })

  it('stops at the entry cap, the depth cap and the time cap with truncated', async () => {
    await write({ 'a.txt': '', 'b.txt': '', 'c.txt': '', 'd.txt': '' })
    const capped = await walkWorkspace({ root, start: root, maxEntries: 2 })
    expect(capped.files.map(file => file.rel)).toEqual(['a.txt', 'b.txt'])
    expect(capped.truncated).toBe(true)

    await write({ 'deep/1/2/3/file.txt': '', 'deep/1/top.txt': '' })
    const shallow = await walkWorkspace({ root, start: join(root, 'deep'), maxDepth: 2 })
    expect(shallow.files.map(file => file.rel)).toEqual(['deep/1/top.txt'])
    expect(shallow.truncated).toBe(true)

    let clock = 0
    const slow = await walkWorkspace({ root, start: root, timeoutMs: 5, now: () => (clock += 10) })
    expect(slow.files).toEqual([])
    expect(slow.truncated).toBe(true)
  })

  it('throws the abort reason when the signal is aborted', async () => {
    await write({ 'a.txt': '' })
    const controller = new AbortController()
    controller.abort()
    await expect(walkWorkspace({ root, start: root, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('skips the temp files of atomic writes', async () => {
    await write({ 'a.txt': '', '.hf-write-0123456789abcdef': '' })
    expect(await walkedFiles()).toEqual(['a.txt'])
  })

  it('drops .gitignore lines that could backtrack badly', async () => {
    expect(safeGitignoreLines('*.log\n**/*.min.*\n*a*a*a*a*b\r\n# comment\n')).toEqual(['*.log', '**/*.min.*', '# comment', ''])
    expect(safeGitignoreLines(`${'x'.repeat(600)}\nok`)).toEqual(['ok'])
    await write({ '.gitignore': '*a*a*a*a*a*a*a*a*a*a*b\n', [`${'a'.repeat(120)}.txt`]: '' })
    const started = Date.now()
    expect(await walkedFiles()).toHaveLength(2)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
