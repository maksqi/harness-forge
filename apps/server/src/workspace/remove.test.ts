import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeWorkspaceFile } from './remove.ts'

let base: string
let root: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  await mkdir(root)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('removeWorkspaceFile', () => {
  it('unlinks a regular file and keeps its folder', async () => {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.txt'), 'a')
    expect(await removeWorkspaceFile(root, 'src/a.txt')).toEqual({ absolute: join(root, 'src', 'a.txt'), rel: 'src/a.txt' })
    expect(existsSync(join(root, 'src', 'a.txt'))).toBe(false)
    expect(existsSync(join(root, 'src'))).toBe(true)
  })

  it('accepts an absolute path inside the project', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    await removeWorkspaceFile(root, join(root, 'a.txt'))
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
  })

  it('a missing file is not_found', async () => {
    await expect(removeWorkspaceFile(root, 'missing.txt')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses a folder, the project folder itself, a .git path and a path outside the project', async () => {
    await mkdir(join(root, 'dir'))
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'config'), 'x')
    await writeFile(join(base, 'outside.txt'), 'x')
    for (const input of ['dir', '.', '.git/config', '.GIT/config', '../outside.txt', join(base, 'outside.txt')])
      await expect(removeWorkspaceFile(root, input), input).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
    expect(existsSync(join(root, 'dir'))).toBe(true)
    expect(existsSync(join(root, '.git', 'config'))).toBe(true)
    expect(existsSync(join(base, 'outside.txt'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('never follows a symbolic link: the link is refused and its target stays', async () => {
    await writeFile(join(root, 'target.txt'), 'keep')
    await symlink('target.txt', join(root, 'link.txt'))
    await writeFile(join(base, 'secret.txt'), 'keep')
    await symlink(join(base, 'secret.txt'), join(root, 'out.txt'))
    await expect(removeWorkspaceFile(root, 'link.txt')).rejects.toMatchObject({ code: 'validation_error' })
    await expect(removeWorkspaceFile(root, 'out.txt')).rejects.toMatchObject({ code: 'validation_error' })
    expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('keep')
    expect(await readFile(join(base, 'secret.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(root, 'link.txt'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('removes a file below a linked folder inside the project (its real location)', async () => {
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', 'a.txt'), 'a')
    await symlink('real', join(root, 'alias'))
    expect(await removeWorkspaceFile(root, 'alias/a.txt')).toEqual({ absolute: join(root, 'real', 'a.txt'), rel: 'real/a.txt' })
    expect(existsSync(join(root, 'real', 'a.txt'))).toBe(false)
  })
})
