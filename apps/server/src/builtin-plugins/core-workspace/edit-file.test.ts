import type { TestWorkspace } from './test-helpers.ts'
import { Buffer } from 'node:buffer'
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { editFileToolOutputSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_WORKSPACE_MESSAGE } from './common.ts'
import { applyEdit, countOccurrences, createEditFileTool, editFileModelText, isCrlfThroughout } from './edit-file.ts'
import { contextWithoutWorkspace, createTestWorkspace, modelTextOf } from './test-helpers.ts'

const tool = createEditFileTool()
let ws: TestWorkspace

beforeEach(async () => {
  ws = await createTestWorkspace()
})

afterEach(async () => {
  await ws.cleanup()
})

async function content(path: string): Promise<string> {
  return readFile(join(ws.root, path), 'utf8')
}

describe('edit_file', () => {
  it('replaces a unique match and reports the diff; the model sees the counts', async () => {
    await ws.write({ 'src/a.ts': 'const a = 1\nconst b = 2\nconst c = 3\n' })
    const input = { path: 'src/a.ts', old_string: 'const b = 2', new_string: 'const b = 20\nconst bb = 21' }
    const output = await tool.execute(input, ws.context())
    expect(editFileToolOutputSchema.parse(output)).toEqual({
      path: 'src/a.ts',
      replacements: 1,
      diff: {
        hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' const a = 1', '-const b = 2', '+const b = 20', '+const bb = 21', ' const c = 3'] }],
        added: 2,
        removed: 1,
        truncated: false,
      },
    })
    expect(await content('src/a.ts')).toBe('const a = 1\nconst b = 20\nconst bb = 21\nconst c = 3\n')
    expect(await modelTextOf(tool, output, input)).toBe('Edited src/a.ts: 1 replacement (+2 -1 lines).')
  })

  it('refuses an ambiguous match unless replace_all, then replaces every occurrence', async () => {
    await ws.write({ 'x.txt': 'foo bar foo baz foo\n' })
    await expect(tool.execute({ path: 'x.txt', old_string: 'foo', new_string: 'qux' }, ws.context()))
      .rejects
      .toThrow('old_string occurs 3 times in x.txt. Add more surrounding lines to old_string to make it unique, or set replace_all to true to replace every occurrence.')
    const output = await tool.execute({ path: 'x.txt', old_string: 'foo', new_string: 'qux', replace_all: true }, ws.context())
    expect(output.replacements).toBe(3)
    expect(await content('x.txt')).toBe('qux bar qux baz qux\n')
    expect(editFileModelText(output)).toBe('Edited x.txt: 3 replacements (+1 -1 lines).')
  })

  it('tells the model to read the file again when old_string is not found', async () => {
    await ws.write({ 'y.txt': '  indented\n' })
    await expect(tool.execute({ path: 'y.txt', old_string: 'indented  ', new_string: 'z' }, ws.context()))
      .rejects
      .toMatchObject({ code: 'validation_error', message: 'old_string was not found in y.txt. Read the file again and copy the text exactly, including whitespace and indentation.' })
  })

  it('refuses old_string equal to new_string', async () => {
    await ws.write({ 'z.txt': 'same\n' })
    await expect(tool.execute({ path: 'z.txt', old_string: 'same', new_string: 'same' }, ws.context())).rejects.toThrow(/the same/)
  })

  it('replaces literally ($ patterns are not expanded)', async () => {
    await ws.write({ 'p.txt': 'price: X\n' })
    await tool.execute({ path: 'p.txt', old_string: 'X', new_string: '$& $1 $$' }, ws.context())
    expect(await content('p.txt')).toBe('price: $& $1 $$\n')
  })

  it('matches a CRLF file on LF text and writes CRLF back', async () => {
    await ws.write({ 'win.txt': 'one\r\ntwo\r\nthree\r\n' })
    const output = await tool.execute({ path: 'win.txt', old_string: 'one\ntwo', new_string: 'one\n2\nzwei' }, ws.context())
    expect(await content('win.txt')).toBe('one\r\n2\r\nzwei\r\nthree\r\n')
    expect(output.diff).toMatchObject({ added: 2, removed: 1 })
    expect(output.diff!.hunks[0]!.lines.every(line => !line.endsWith('\r'))).toBe(true)
    // CRLF in the strings is read as LF.
    await tool.execute({ path: 'win.txt', old_string: 'zwei\r\nthree', new_string: 'drei' }, ws.context())
    expect(await content('win.txt')).toBe('one\r\n2\r\ndrei\r\n')
  })

  it('matches a mixed-ending file raw', async () => {
    await ws.write({ 'mixed.txt': 'a\r\nb\nc\r\n' })
    await expect(tool.execute({ path: 'mixed.txt', old_string: 'a\nb', new_string: 'x' }, ws.context())).rejects.toThrow(/not found/)
    await tool.execute({ path: 'mixed.txt', old_string: 'a\r\nb', new_string: 'x' }, ws.context())
    expect(await content('mixed.txt')).toBe('x\nc\r\n')
  })

  it('keeps a BOM', async () => {
    await writeFile(join(ws.root, 'bom.txt'), '\uFEFFhello world\n')
    await tool.execute({ path: 'bom.txt', old_string: 'world', new_string: 'there' }, ws.context())
    const bytes = await readFile(join(ws.root, 'bom.txt'))
    expect([...bytes.subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF])
    expect(bytes.subarray(3).toString('utf8')).toBe('hello there\n')
  })

  it.skipIf(process.platform === 'win32')('keeps the file mode and leaves no temp file', async () => {
    await ws.write({ 'tool.sh': 'echo a\n' })
    await chmod(join(ws.root, 'tool.sh'), 0o750)
    await tool.execute({ path: 'tool.sh', old_string: 'a', new_string: 'b' }, ws.context())
    expect((await stat(join(ws.root, 'tool.sh'))).mode & 0o777).toBe(0o750)
    expect(await readdir(ws.root)).toEqual(['tool.sh'])
  })

  it('refuses .git, binary files, files over 1 MiB and missing files', async () => {
    await mkdir(join(ws.root, '.git'))
    await writeFile(join(ws.root, '.git', 'config'), '[core]\n')
    await expect(tool.execute({ path: '.git/config', old_string: 'core', new_string: 'x' }, ws.context())).rejects.toThrow(/\.git folder/)
    await writeFile(join(ws.root, 'bin.dat'), Buffer.from([0x61, 0, 0x62]))
    await expect(tool.execute({ path: 'bin.dat', old_string: 'a', new_string: 'b' }, ws.context())).rejects.toThrow(/not a UTF-8 text file/)
    await writeFile(join(ws.root, 'big.txt'), 'x'.repeat(1_048_577))
    await expect(tool.execute({ path: 'big.txt', old_string: 'x', new_string: 'y' }, ws.context())).rejects.toMatchObject({ code: 'payload_too_large' })
    await expect(tool.execute({ path: 'none.txt', old_string: 'a', new_string: 'b' }, ws.context())).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses an edit that makes the file larger than 1 MiB', async () => {
    await ws.write({ 'grow.txt': 'ab'.repeat(30_000) })
    await expect(tool.execute({ path: 'grow.txt', old_string: 'a', new_string: 'x'.repeat(40), replace_all: true }, ws.context())).rejects.toThrow(/larger than 1 MiB/)
    expect(await content('grow.txt')).toBe('ab'.repeat(30_000))
  })

  it('fails without a project folder', async () => {
    await expect(tool.execute({ path: 'a', old_string: 'a', new_string: 'b' }, contextWithoutWorkspace())).rejects.toThrow(NO_WORKSPACE_MESSAGE)
  })
})

describe('edit helpers', () => {
  it('isCrlfThroughout and countOccurrences', () => {
    expect(isCrlfThroughout('a\r\nb\r\n')).toBe(true)
    expect(isCrlfThroughout('a\r\nb')).toBe(true)
    expect(isCrlfThroughout('a\nb\r\n')).toBe(false)
    expect(isCrlfThroughout('no newline')).toBe(false)
    expect(isCrlfThroughout('\n')).toBe(false)
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
    expect(countOccurrences('abc', 'd')).toBe(0)
  })

  it('applyEdit returns the LF texts for the diff', () => {
    const edit = applyEdit('\uFEFFx\r\ny\r\n', { old_string: 'y', new_string: 'z' }, 'f.txt')
    expect(edit).toEqual({ text: '\uFEFFx\r\nz\r\n', before: 'x\ny\n', after: 'x\nz\n', replacements: 1 })
  })
})
