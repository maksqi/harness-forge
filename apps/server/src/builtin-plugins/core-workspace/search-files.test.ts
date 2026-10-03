import type { TestWorkspace } from './test-helpers.ts'
import { Buffer } from 'node:buffer'
import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { searchFilesToolOutputSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_WORKSPACE_MESSAGE } from './common.ts'
import { createSearchFilesTool, searchFilesModelText } from './search-files.ts'
import { contextWithoutWorkspace, createTestWorkspace, modelTextOf, promiseTool } from './test-helpers.ts'

const tool = promiseTool(createSearchFilesTool())
let ws: TestWorkspace

beforeEach(async () => {
  ws = await createTestWorkspace()
  await ws.write({
    'src/a.ts': 'const TODO = 1\n// todo: lower\nexport {}\n',
    'src/b.md': 'TODO in markdown\n',
    'README.md': 'nothing here\n',
    '.gitignore': 'dist/\n',
    'dist/out.ts': 'TODO built\n',
    'node_modules/pkg/index.ts': 'TODO dependency\n',
    '.env': 'TODO=secret\n',
    '.env.example': 'TODO=placeholder\n',
    'config/secrets.json': '{"TODO": "secret"}\n',
  })
})

afterEach(async () => {
  await ws.cleanup()
})

describe('search_files', () => {
  it('finds matching lines (case-sensitive by default) and skips ignored and secret-looking files', async () => {
    const output = await tool.execute({ pattern: 'TODO' }, ws.context())
    expect(searchFilesToolOutputSchema.parse(output)).toEqual({
      pattern: 'TODO',
      matches: [
        { path: '.env.example', line: 1, text: 'TODO=placeholder' },
        { path: 'src/a.ts', line: 1, text: 'const TODO = 1' },
        { path: 'src/b.md', line: 1, text: 'TODO in markdown' },
      ],
      filesSearched: 5,
      truncated: false,
    })
    expect(await modelTextOf(tool, output, { pattern: 'TODO' })).toBe('.env.example:1: TODO=placeholder\nsrc/a.ts:1: const TODO = 1\nsrc/b.md:1: TODO in markdown')
  })

  it('searches ignored files with include_ignored, but never secret-looking ones', async () => {
    const output = await tool.execute({ pattern: 'TODO', include_ignored: true }, ws.context())
    const paths = output.matches.map(match => match.path)
    expect(paths).toContain('dist/out.ts')
    expect(paths).toContain('node_modules/pkg/index.ts')
    expect(paths).not.toContain('.env')
    expect(paths).not.toContain('config/secrets.json')
  })

  it('supports case_sensitive: false, literal, glob and path', async () => {
    expect((await tool.execute({ pattern: 'todo', case_sensitive: false, glob: '*.ts' }, ws.context())).matches).toEqual([
      { path: 'src/a.ts', line: 1, text: 'const TODO = 1' },
      { path: 'src/a.ts', line: 2, text: '// todo: lower' },
    ])
    await ws.write({ 'src/c.ts': 'call(a.b)\ncall(axb)\n' })
    expect((await tool.execute({ pattern: 'call(a.b)', literal: true }, ws.context())).matches).toEqual([{ path: 'src/c.ts', line: 1, text: 'call(a.b)' }])
    expect((await tool.execute({ pattern: 'TODO', path: 'src', glob: '*.md' }, ws.context())).matches).toEqual([{ path: 'src/b.md', line: 1, text: 'TODO in markdown' }])
  })

  it('searches a single file named in path, and refuses a secret-looking one', async () => {
    const output = await tool.execute({ pattern: 'export', path: 'src/a.ts' }, ws.context())
    expect(output).toMatchObject({ matches: [{ path: 'src/a.ts', line: 3, text: 'export {}' }], filesSearched: 1 })
    await expect(tool.execute({ pattern: 'TODO', path: '.env' }, ws.context())).rejects.toThrow(/looks like a secret file/)
  })

  it.skipIf(process.platform === 'win32')('skips a link to a secret-looking file', async () => {
    await symlink(join(ws.root, '.env'), join(ws.root, 'innocent.txt'))
    const output = await tool.execute({ pattern: 'secret' }, ws.context())
    expect(output.matches).toEqual([])
  })

  it('skips binary files and files over 1 MiB', async () => {
    await writeFile(join(ws.root, 'blob.bin'), Buffer.concat([Buffer.from('TODO'), Buffer.alloc(16)]))
    await writeFile(join(ws.root, 'large.txt'), `TODO\n${'x'.repeat(1_048_576)}`)
    const output = await tool.execute({ pattern: 'TODO', glob: '*.{bin,txt}' }, ws.context())
    expect(output).toEqual({ pattern: 'TODO', matches: [], filesSearched: 0, truncated: false })
    expect(searchFilesModelText(output)).toBe('No matches (0 files searched).')
  })

  it('caps the matches at max_results', async () => {
    await ws.write({ 'many.txt': `${Array.from({ length: 30 }, (_, index) => `hit ${index}`).join('\n')}\n` })
    const output = await tool.execute({ pattern: '^hit', max_results: 5 }, ws.context())
    expect(output.matches).toHaveLength(5)
    expect(output.truncated).toBe(true)
    expect(searchFilesModelText(output)).toMatch(/\[truncated: showing 5 matches; narrow the pattern, the glob or the path\]$/)
    const exact = await tool.execute({ pattern: '^hit (0|1)$', max_results: 2 }, ws.context())
    expect(exact).toMatchObject({ truncated: false })
    expect(exact.matches).toHaveLength(2)
  })

  it('refuses an invalid regular expression before reading any file', async () => {
    await expect(tool.execute({ pattern: '(unclosed' }, ws.context())).rejects.toMatchObject({ code: 'validation_error', message: expect.stringMatching(/Invalid regular expression/) })
  })

  it('times out a catastrophic pattern in the Worker while the event loop stays responsive', async () => {
    await ws.write({ 'redos.txt': `${'a'.repeat(5000)}!\n` })
    const slow = createSearchFilesTool({ workerTimeoutMs: 300 })
    let ticks = 0
    const interval = setInterval(() => ticks++, 10)
    const started = Date.now()
    try {
      await expect(slow.execute({ pattern: '(a+)+$', glob: 'redos.txt' }, ws.context())).rejects.toThrow('The search timed out — use a simpler pattern or a narrower path.')
    }
    finally {
      clearInterval(interval)
    }
    expect(Date.now() - started).toBeLessThan(5000)
    expect(ticks).toBeGreaterThanOrEqual(10)
  })

  it('stops when the run is aborted', async () => {
    await ws.write({ 'redos.txt': `${'a'.repeat(5000)}!\n` })
    const controller = new AbortController()
    const pending = tool.execute({ pattern: '(a+)+$', glob: 'redos.txt' }, ws.context(controller.signal))
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fails without a project folder', async () => {
    await expect(tool.execute({ pattern: 'x' }, contextWithoutWorkspace())).rejects.toThrow(NO_WORKSPACE_MESSAGE)
  })
})
