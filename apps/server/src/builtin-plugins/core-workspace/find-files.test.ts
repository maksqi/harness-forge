import type { TestWorkspace } from './test-helpers.ts'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { findFilesToolOutputSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_WORKSPACE_MESSAGE } from './common.ts'
import { createFindFilesTool, findFilesModelText } from './find-files.ts'
import { contextWithoutWorkspace, createTestWorkspace, modelTextOf, promiseTool } from './test-helpers.ts'

const tool = promiseTool(createFindFilesTool())
let ws: TestWorkspace

beforeEach(async () => {
  ws = await createTestWorkspace()
  await ws.write({
    'README.md': '',
    'src/index.ts': '',
    'src/lib/util.ts': '',
    'src/lib/util.test.ts': '',
    'src/.hidden.ts': '',
    'docs/guide.md': '',
    '.gitignore': 'dist/\n*.log\n',
    'dist/bundle.ts': '',
    'debug.log': '',
    'node_modules/pkg/index.ts': '',
    '.git/HEAD.ts': '',
  })
})

afterEach(async () => {
  await ws.cleanup()
})

describe('find_files', () => {
  it('matches a pattern without "/" against file names at any depth (dot files included), sorted', async () => {
    const output = await tool.execute({ pattern: '*.ts' }, ws.context())
    expect(findFilesToolOutputSchema.parse(output)).toEqual({
      pattern: '*.ts',
      paths: ['src/.hidden.ts', 'src/index.ts', 'src/lib/util.test.ts', 'src/lib/util.ts'],
      truncated: false,
    })
    expect(await modelTextOf(tool, output, { pattern: '*.ts' })).toBe('src/.hidden.ts\nsrc/index.ts\nsrc/lib/util.test.ts\nsrc/lib/util.ts')
  })

  it('matches a pattern with "/" against the path relative to the searched folder', async () => {
    expect((await tool.execute({ pattern: 'src/*.ts' }, ws.context())).paths).toEqual(['src/.hidden.ts', 'src/index.ts'])
    expect((await tool.execute({ pattern: 'lib/**/*.test.ts', path: 'src' }, ws.context())).paths).toEqual(['src/lib/util.test.ts'])
    expect((await tool.execute({ pattern: '**/*.md' }, ws.context())).paths).toEqual(['README.md', 'docs/guide.md'])
  })

  it('skips node_modules and gitignored files unless include_ignored; .git always', async () => {
    const all = await tool.execute({ pattern: '*', include_ignored: true }, ws.context())
    expect(all.paths).toContain('node_modules/pkg/index.ts')
    expect(all.paths).toContain('dist/bundle.ts')
    expect(all.paths).toContain('debug.log')
    expect(all.paths.some(path => path.startsWith('.git/'))).toBe(false)
    const visible = await tool.execute({ pattern: '*' }, ws.context())
    expect(visible.paths).toEqual(['.gitignore', 'README.md', 'docs/guide.md', 'src/.hidden.ts', 'src/index.ts', 'src/lib/util.test.ts', 'src/lib/util.ts'])
  })

  it('honors a nested .gitignore', async () => {
    await ws.write({ 'src/lib/.gitignore': '*.test.ts\n' })
    expect((await tool.execute({ pattern: '*.ts', path: 'src' }, ws.context())).paths).toEqual(['src/.hidden.ts', 'src/index.ts', 'src/lib/util.ts'])
  })

  it('caps the result at max_results and says so', async () => {
    const output = await tool.execute({ pattern: '*.ts', max_results: 2 }, ws.context())
    expect(output).toEqual({ pattern: '*.ts', paths: ['src/.hidden.ts', 'src/index.ts'], truncated: true })
    expect(findFilesModelText(output)).toMatch(/\[truncated: showing 2 paths; narrow the pattern or the path\]$/)
  })

  it('answers "No files match."', async () => {
    const output = await tool.execute({ pattern: '*.rs' }, ws.context())
    expect(output).toEqual({ pattern: '*.rs', paths: [], truncated: false })
    expect(findFilesModelText(output)).toBe('No files match.')
  })

  it.skipIf(process.platform === 'win32')('does not enter folder links; keeps file links inside the project', async () => {
    await mkdir(join(ws.root, '..', 'outside'))
    await writeFile(join(ws.root, '..', 'outside', 'secret.ts'), '')
    await symlink(join(ws.root, '..', 'outside'), join(ws.root, 'outside-link'))
    await symlink(join(ws.root, 'src'), join(ws.root, 'src-link'))
    await symlink(join(ws.root, 'src', 'index.ts'), join(ws.root, 'index-link.ts'))
    const output = await tool.execute({ pattern: '*.ts' }, ws.context())
    expect(output.paths).toEqual(['index-link.ts', 'src/.hidden.ts', 'src/index.ts', 'src/lib/util.test.ts', 'src/lib/util.ts'])
  })

  it('refuses a file as the search folder and a path outside the project', async () => {
    await expect(tool.execute({ pattern: '*', path: 'README.md' }, ws.context())).rejects.toThrow(/not a folder/)
    await expect(tool.execute({ pattern: '*', path: '..' }, ws.context())).rejects.toThrow(/outside the project folder/)
  })

  it('times out a pathological glob in the Worker', async () => {
    await ws.write({ [`${'a'.repeat(200)}.txt`]: '' })
    const slow = createFindFilesTool({ workerTimeoutMs: 300 })
    const started = Date.now()
    await expect(slow.execute({ pattern: `${'*a'.repeat(12)}*b` }, ws.context())).rejects.toThrow(/The search timed out/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('fails without a project folder', async () => {
    await expect(tool.execute({ pattern: '*' }, contextWithoutWorkspace())).rejects.toThrow(NO_WORKSPACE_MESSAGE)
  })
})
