import type { TestWorkspace } from './test-helpers.ts'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { readFileToolOutputSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openWorkspaceFile } from '../../workspace/paths.ts'
import { NO_WORKSPACE_MESSAGE } from './common.ts'
import { createReadFileTool, readFileModelText, readFileOutput, readWindow } from './read-file.ts'
import { contextWithoutWorkspace, createTestWorkspace, modelTextOf, promiseTool } from './test-helpers.ts'

const tool = promiseTool(createReadFileTool())
let ws: TestWorkspace

function numbered(count: number, from = 1): string {
  return Array.from({ length: count }, (_, index) => `line ${from + index}`).join('\n')
}

beforeEach(async () => {
  ws = await createTestWorkspace()
})

afterEach(async () => {
  await ws.cleanup()
})

describe('read_file', () => {
  it('reads a whole small file: raw content, line range, total, project-relative path', async () => {
    await ws.write({ 'src/a.txt': 'alpha\nbeta\n' })
    const output = await tool.execute({ path: 'src/a.txt' }, ws.context())
    expect(readFileToolOutputSchema.parse(output)).toEqual({ path: 'src/a.txt', content: 'alpha\nbeta', startLine: 1, endLine: 2, totalLines: 2, truncated: false })
    expect(await modelTextOf(tool, output, { path: 'src/a.txt' })).toBe('     1\talpha\n     2\tbeta')
  })

  it('accepts an absolute path inside the project and reports it relative', async () => {
    await ws.write({ 'b.txt': 'x' })
    const output = await tool.execute({ path: join(ws.root, 'b.txt') }, ws.context())
    expect(output).toMatchObject({ path: 'b.txt', content: 'x', totalLines: 1 })
  })

  it('honors offset and limit and tells the model where to continue', async () => {
    await ws.write({ 'long.txt': `${numbered(10)}\n` })
    const output = await tool.execute({ path: 'long.txt', offset: 3, limit: 4 }, ws.context())
    expect(output).toEqual({ path: 'long.txt', content: 'line 3\nline 4\nline 5\nline 6', startLine: 3, endLine: 6, totalLines: 10, truncated: true })
    expect(await modelTextOf(tool, output, { path: 'long.txt', offset: 3, limit: 4 })).toBe([
      '     3\tline 3',
      '     4\tline 4',
      '     5\tline 5',
      '     6\tline 6',
      '[truncated; continue with offset=7]',
    ].join('\n'))
    const tail = await tool.execute({ path: 'long.txt', offset: 9 }, ws.context())
    expect(tail).toMatchObject({ content: 'line 9\nline 10', startLine: 9, endLine: 10, totalLines: 10, truncated: false })
  })

  it('answers an offset past the end with an empty window', async () => {
    await ws.write({ 'short.txt': 'a\nb' })
    const output = await tool.execute({ path: 'short.txt', offset: 5 }, ws.context())
    expect(output).toEqual({ path: 'short.txt', content: '', startLine: 5, endLine: 4, totalLines: 2, truncated: false })
    expect(readFileModelText(output)).toBe('(short.txt has 2 lines; offset 5 is past the end)')
  })

  it('reads an empty file', async () => {
    await ws.write({ 'empty.txt': '' })
    const output = await tool.execute({ path: 'empty.txt' }, ws.context())
    expect(output).toEqual({ path: 'empty.txt', content: '', startLine: 1, endLine: 0, totalLines: 0, truncated: false })
    expect(readFileModelText(output)).toBe('(empty.txt is empty)')
  })

  it('drops CR line endings and a BOM, keeps empty lines', async () => {
    await ws.write({ 'crlf.txt': '\uFEFFone\r\n\r\nthree\r\n' })
    const output = await tool.execute({ path: 'crlf.txt' }, ws.context())
    expect(output).toMatchObject({ content: 'one\n\nthree', startLine: 1, endLine: 3, totalLines: 3, truncated: false })
  })

  it('cuts lines at 2000 characters', async () => {
    await ws.write({ 'wide.txt': `${'x'.repeat(2500)}\nshort\n` })
    const output = await tool.execute({ path: 'wide.txt' }, ws.context())
    expect(output.content.split('\n')[0]).toHaveLength(2000)
    expect(output).toMatchObject({ endLine: 2, totalLines: 2, truncated: true })
    expect(readFileModelText(output)).toMatch(/\[lines longer than 2000 characters were cut\]$/)
  })

  it('stops the window at 48 KiB', async () => {
    const line = 'y'.repeat(999)
    await ws.write({ 'big.txt': `${Array.from({ length: 100 }).fill(line).join('\n')}\n` })
    const output = await tool.execute({ path: 'big.txt' }, ws.context())
    // 49 lines of 1000 bytes (with the newline) fit in 49152 bytes.
    expect(output).toMatchObject({ startLine: 1, endLine: 49, totalLines: 100, truncated: true })
    expect(readFileModelText(output)).toMatch(/\[truncated; continue with offset=50\]$/)
  })

  it('leaves totalLines null when the rest of the file is not counted', async () => {
    await ws.write({ 'huge.txt': `${numbered(5)}\n${'z\n'.repeat(70_000)}` })
    const { handle } = await openWorkspaceFile(ws.root, 'huge.txt')
    try {
      const window = await readWindow(handle, { offset: 1, limit: 2, countMaxBytes: 10 })
      expect(window).toMatchObject({ lines: ['line 1', 'line 2'], endLine: 2, totalLines: null })
      const output = readFileOutput('huge.txt', window)
      expect(output.truncated).toBe(true)
      expect(readFileModelText(output)).toMatch(/\[truncated; continue with offset=3\]$/)
    }
    finally {
      await handle.close()
    }
  })

  it('trims the stored output to 60 KiB of JSON', async () => {
    // Tabs double when escaped: 48 KiB of tabs serialize to about 96 KiB.
    await ws.write({ 'tabs.txt': `${Array.from({ length: 200 }, () => '\t'.repeat(200)).join('\n')}\n` })
    const output = await tool.execute({ path: 'tabs.txt' }, ws.context())
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(61_440)
    expect(output.truncated).toBe(true)
    expect(output.content.split('\n')).toHaveLength(output.endLine)
  })

  it('refuses binary files', async () => {
    await writeFile(join(ws.root, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]))
    await expect(tool.execute({ path: 'image.png' }, ws.context())).rejects.toThrow(/binary file/)
  })

  it.skipIf(process.platform === 'win32')('refuses a FIFO without blocking', async () => {
    execFileSync('mkfifo', [join(ws.root, 'pipe')])
    await expect(tool.execute({ path: 'pipe' }, ws.context())).rejects.toThrow(/not a regular file/)
  })

  it('refuses folders, missing files and paths outside the project', async () => {
    await ws.write({ 'dir/a.txt': 'a' })
    await expect(tool.execute({ path: 'dir' }, ws.context())).rejects.toThrow(/is a folder/)
    await expect(tool.execute({ path: 'missing.txt' }, ws.context())).rejects.toMatchObject({ code: 'not_found' })
    await expect(tool.execute({ path: '../outside.txt' }, ws.context())).rejects.toThrow(/outside the project folder/)
  })

  it.skipIf(process.platform === 'win32')('follows a link inside the project, refuses one that leaves it', async () => {
    await ws.write({ 'target.txt': 'inside' })
    await writeFile(join(ws.root, '..', 'outside.txt'), 'outside')
    await symlink(join(ws.root, 'target.txt'), join(ws.root, 'link.txt'))
    await symlink(join(ws.root, '..', 'outside.txt'), join(ws.root, 'escape.txt'))
    expect(await tool.execute({ path: 'link.txt' }, ws.context())).toMatchObject({ path: 'target.txt', content: 'inside' })
    await expect(tool.execute({ path: 'escape.txt' }, ws.context())).rejects.toThrow(/outside the project folder/)
  })

  it('fails without a project folder', async () => {
    await expect(tool.execute({ path: 'a.txt' }, contextWithoutWorkspace())).rejects.toThrow(NO_WORKSPACE_MESSAGE)
  })

  it('gives the model JSON for an output it cannot parse', async () => {
    const result = await tool.toModelOutput!({ truncated: true } as never, { toolCallId: 'x', input: { path: 'a' } })
    expect(result).toEqual({ type: 'json', value: { truncated: true } })
  })
})
