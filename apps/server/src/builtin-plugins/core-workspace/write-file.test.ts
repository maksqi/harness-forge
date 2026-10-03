import type { TestWorkspace } from './test-helpers.ts'
import { Buffer } from 'node:buffer'
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { writeFileToolOutputSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_WORKSPACE_MESSAGE } from './common.ts'
import { contextWithoutWorkspace, createTestWorkspace, modelTextOf, promiseTool } from './test-helpers.ts'
import { createWriteFileTool, writeFileModelText } from './write-file.ts'

const tool = promiseTool(createWriteFileTool())
let ws: TestWorkspace

beforeEach(async () => {
  ws = await createTestWorkspace()
})

afterEach(async () => {
  await ws.cleanup()
})

describe('write_file', () => {
  it('creates a file and its folders; the diff adds every line', async () => {
    const output = await tool.execute({ path: 'src/new/hello.ts', content: 'one\ntwo\n' }, ws.context())
    expect(writeFileToolOutputSchema.parse(output)).toEqual({
      path: 'src/new/hello.ts',
      created: true,
      bytes: 8,
      lines: 2,
      diff: { hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+one', '+two'] }], added: 2, removed: 0, truncated: false },
    })
    expect(await readFile(join(ws.root, 'src/new/hello.ts'), 'utf8')).toBe('one\ntwo\n')
    expect(await modelTextOf(tool, output, { path: 'src/new/hello.ts', content: 'one\ntwo\n' })).toBe('Created src/new/hello.ts (2 lines).')
  })

  it('replaces an existing file; the diff shows the change and the model the counts', async () => {
    await ws.write({ 'a.txt': 'keep\nold\n' })
    const output = await tool.execute({ path: 'a.txt', content: 'keep\nnew\nmore\n' }, ws.context())
    expect(output).toMatchObject({ path: 'a.txt', created: false, bytes: 14, lines: 3, diff: { added: 2, removed: 1, truncated: false } })
    expect(writeFileModelText(output)).toBe('Updated a.txt (+2 -1 lines).')
    expect(await readFile(join(ws.root, 'a.txt'), 'utf8')).toBe('keep\nnew\nmore\n')
  })

  it.skipIf(process.platform === 'win32')('keeps the mode of the replaced file and leaves no temp file', async () => {
    await ws.write({ 'run.sh': 'echo old\n' })
    await chmod(join(ws.root, 'run.sh'), 0o755)
    await tool.execute({ path: 'run.sh', content: 'echo new\n' }, ws.context())
    expect((await stat(join(ws.root, 'run.sh'))).mode & 0o777).toBe(0o755)
    expect(await readdir(ws.root)).toEqual(['run.sh'])
  })

  it('writes over a binary file without a diff', async () => {
    await writeFile(join(ws.root, 'blob.dat'), Buffer.from([0, 1, 2, 3]))
    const output = await tool.execute({ path: 'blob.dat', content: 'text now\n' }, ws.context())
    expect(output).toMatchObject({ created: false, diff: null, lines: 1 })
    expect(writeFileModelText(output)).toBe('Updated blob.dat (1 line).')
  })

  it('refuses .git, folders and paths outside the project', async () => {
    await mkdir(join(ws.root, '.git'))
    await mkdir(join(ws.root, 'dir'))
    await expect(tool.execute({ path: '.git/hooks/pre-commit', content: 'x' }, ws.context())).rejects.toThrow(/\.git folder/)
    await expect(tool.execute({ path: 'dir', content: 'x' }, ws.context())).rejects.toThrow(/is a folder/)
    await expect(tool.execute({ path: '../escape.txt', content: 'x' }, ws.context())).rejects.toThrow(/outside the project folder/)
  })

  it('counts lines like read_file', async () => {
    expect((await tool.execute({ path: 'e.txt', content: '' }, ws.context())).lines).toBe(0)
    expect((await tool.execute({ path: 'f.txt', content: 'no newline' }, ws.context())).lines).toBe(1)
    const output = await tool.execute({ path: 'g.txt', content: 'x' }, ws.context())
    expect(writeFileModelText(output)).toBe('Created g.txt (1 line).')
  })

  it('fails without a project folder', async () => {
    await expect(tool.execute({ path: 'a.txt', content: 'x' }, contextWithoutWorkspace())).rejects.toThrow(NO_WORKSPACE_MESSAGE)
  })
})
