// `readCommandFile` / `readCommandFiles` (W11.5-T3): a referenced project file is inlined through the path guard; a
// secret-looking, `.git`, linked (file or folder on the path), missing or non-regular file stays text (null); at most
// 32 KiB are kept (`truncated`); a NUL in the first 8 KiB makes a binary marker. Temp projects are canonical
// (`realpath(mkdtemp())`).
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { LIMITS, planCommandExpansion, renderCommandExpansion } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isRefusedCommandFilePath, readCommandFile, readCommandFiles } from './files.ts'

const posix = process.platform !== 'win32'

describe.skipIf(!posix)('readCommandFile', () => {
  let base: string
  let root: string

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    root = join(base, 'project')
    await mkdir(join(root, 'docs'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, 'README.md'), 'Hello readme\n')
    await writeFile(join(root, 'docs', 'guide.md'), 'Guide é\n')
    await writeFile(join(root, '.env'), 'SECRET=1\n')
    await writeFile(join(root, '.env.example'), 'SECRET=\n')
    await writeFile(join(root, '.git', 'config'), '[core]\n')
    await writeFile(join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    await writeFile(join(root, 'big.txt'), `${'é'.repeat(LIMITS.commandFileRefBytes)}end`)
    await writeFile(join(base, 'outside.md'), 'outside\n')
    await symlink(join(root, 'README.md'), join(root, 'link.md'))
    await symlink(join(base, 'outside.md'), join(root, 'out.md'))
    await symlink(join(root, 'docs'), join(root, 'linked-docs'))
  })

  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('reads a project file as written', async () => {
    expect(await readCommandFile(root, 'README.md')).toEqual({ path: 'README.md', content: 'Hello readme\n', truncated: false })
    expect(await readCommandFile(root, 'docs/guide.md')).toEqual({ path: 'docs/guide.md', content: 'Guide é\n', truncated: false })
    // A template of a secret file is not secret-looking.
    expect(await readCommandFile(root, '.env.example')).toMatchObject({ content: 'SECRET=\n' })
  })

  it('refuses secret-looking and .git paths, links anywhere on the path, missing files and folders', async () => {
    expect(isRefusedCommandFilePath('.env')).toBe(true)
    expect(isRefusedCommandFilePath('keys/id_rsa')).toBe(true)
    expect(isRefusedCommandFilePath('.git/config')).toBe(true)
    expect(isRefusedCommandFilePath('README.md')).toBe(false)
    for (const path of ['.env', '.git/config', 'link.md', 'out.md', 'linked-docs/guide.md', 'missing.md', 'docs', '../outside.md'])
      expect(await readCommandFile(root, path), path).toBeNull()
  })

  it('cuts a long file at 32 KiB on a character boundary and marks a binary file', async () => {
    const big = await readCommandFile(root, 'big.txt')
    expect(big?.truncated).toBe(true)
    expect(Buffer.byteLength(big!.content)).toBeLessThanOrEqual(LIMITS.commandFileRefBytes)
    expect(big!.content.endsWith('é')).toBe(true)
    expect(await readCommandFile(root, 'image.bin')).toEqual({ path: 'image.bin', content: '', truncated: false, binary: true })
  })

  it('reads the references of a plan in order and renders them as file blocks (refused ones stay text)', async () => {
    const plan = planCommandExpansion('See @README.md @.env and @image.bin for $ARGUMENTS')
    expect(plan.filePaths).toEqual(['README.md', '.env', 'image.bin'])
    const blocks = await readCommandFiles(root, plan.filePaths)
    expect(blocks.map(block => block?.path ?? null)).toEqual(['README.md', null, 'image.bin'])
    expect(renderCommandExpansion(plan, { shell: [], files: blocks }, 'review').text).toBe(
      'See @README.md @.env and @image.bin for review\n\n<file path="README.md">\nHello readme\n</file>\n\n<file path="image.bin" binary="true">\n[binary file not inlined]\n</file>',
    )
  })

  it('stops at an aborted signal', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('stopped', 'AbortError'))
    await expect(readCommandFiles(root, ['README.md'], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
