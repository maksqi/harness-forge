import type { TestWorkspace } from './test-helpers.ts'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { listDirectoryToolOutputSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_WORKSPACE_MESSAGE } from './common.ts'
import { createListDirectoryTool, listDirectoryModelText } from './list-directory.ts'
import { contextWithoutWorkspace, createTestWorkspace, modelTextOf, promiseTool } from './test-helpers.ts'

const tool = promiseTool(createListDirectoryTool())
let ws: TestWorkspace

beforeEach(async () => {
  ws = await createTestWorkspace()
})

afterEach(async () => {
  await ws.cleanup()
})

describe('list_directory', () => {
  it('lists the project folder by default, sorted, with types; the model sees dir/ suffixes', async () => {
    await ws.write({ 'b.txt': '', 'a.txt': '', 'src/index.ts': '', '.gitignore': '', '.hf-write-0011223344556677': '' })
    await mkdir(join(ws.root, 'empty'))
    const output = await tool.execute({}, ws.context())
    expect(listDirectoryToolOutputSchema.parse(output)).toEqual({
      path: '.',
      entries: [
        { name: '.gitignore', type: 'file' },
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
        { name: 'empty', type: 'dir' },
        { name: 'src', type: 'dir' },
      ],
      truncated: false,
    })
    expect(await modelTextOf(tool, output, {})).toBe('.gitignore\na.txt\nb.txt\nempty/\nsrc/')
  })

  it('lists a subfolder with a project-relative path', async () => {
    await ws.write({ 'src/lib/a.ts': '' })
    const output = await tool.execute({ path: 'src/' }, ws.context())
    expect(output).toEqual({ path: 'src', entries: [{ name: 'lib', type: 'dir' }], truncated: false })
    const empty = await tool.execute({ path: 'src/lib/../lib/a.ts/..' }, ws.context())
    expect(empty.path).toBe('src/lib')
  })

  it.skipIf(process.platform === 'win32')('reports links as symlink (not followed) and shows them with @', async () => {
    await ws.write({ 'target.txt': '' })
    await symlink(join(ws.root, 'target.txt'), join(ws.root, 'link.txt'))
    const output = await tool.execute({}, ws.context())
    expect(output.entries).toContainEqual({ name: 'link.txt', type: 'symlink' })
    expect(listDirectoryModelText(output)).toContain('link.txt@')
  })

  it('caps the listing at 1000 entries', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 1005; index++)
      files[`many/f${String(index).padStart(4, '0')}.txt`] = ''
    await ws.write(files)
    const output = await tool.execute({ path: 'many' }, ws.context())
    expect(output.entries).toHaveLength(1000)
    expect(output.truncated).toBe(true)
    expect(listDirectoryModelText(output)).toMatch(/\[truncated: only the first 1000 entries are listed\]$/)
  })

  it('describes an empty folder; refuses files, missing paths and paths outside', async () => {
    await mkdir(join(ws.root, 'empty'))
    await ws.write({ 'file.txt': '' })
    expect(listDirectoryModelText(await tool.execute({ path: 'empty' }, ws.context()))).toBe('(empty is an empty folder)')
    await expect(tool.execute({ path: 'file.txt' }, ws.context())).rejects.toThrow(/not a folder/)
    await expect(tool.execute({ path: 'nope' }, ws.context())).rejects.toMatchObject({ code: 'not_found' })
    await expect(tool.execute({ path: '/' }, ws.context())).rejects.toThrow(/outside the project folder/)
  })

  it('fails without a project folder', async () => {
    await expect(tool.execute({}, contextWithoutWorkspace())).rejects.toThrow(NO_WORKSPACE_MESSAGE)
  })
})
