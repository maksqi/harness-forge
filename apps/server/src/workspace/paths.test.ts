import type { HarnessError } from '@harness-forge/shared'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hasGitSegment,
  openWorkspaceFile,
  OUTSIDE_PROJECT_MESSAGE,
  PROJECT_FOLDER_MISSING_MESSAGE,
  PROJECT_FOLDER_MOVED_MESSAGE,
  readWorkspaceFile,
  resolveWorkspacePath,
  toWorkspaceRel,
  WORKSPACE_TEMP_PREFIX,
  writeWorkspaceFile,
} from './paths.ts'

const posix = process.platform !== 'win32'
const temps: string[] = []

/** A canonical temp folder: macOS `/var` is a link to `/private/var`, so an unresolved path fails every check. */
async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  temps.push(dir)
  return dir
}

let root: string
let outside: string

beforeEach(async () => {
  root = await tempFolder()
  outside = await tempFolder()
  await writeFile(join(root, 'a.txt'), 'alpha\n')
  await mkdir(join(root, 'sub', 'deep'), { recursive: true })
  await writeFile(join(root, 'sub', 'b.txt'), 'beta\n')
  await writeFile(join(outside, 'secret.txt'), 'top secret\n')
})

afterEach(async () => {
  for (const dir of temps.splice(0))
    await rm(dir, { recursive: true, force: true })
})

/** The rejection of `promise` (fails the test when it resolves). */
async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

async function refused(promise: Promise<unknown>, message: string | RegExp): Promise<void> {
  const error = await rejection(promise)
  expect(error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
  if (typeof message === 'string')
    expect(error.message).toBe(message)
  else
    expect(error.message).toMatch(message)
}

/** Resolves within a time limit, so a blocking open fails the test instead of hanging it. */
function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

describe('resolveWorkspacePath: inputs inside the folder', () => {
  it('resolves relative paths to the canonical absolute path and a POSIX rel', async () => {
    expect(await resolveWorkspacePath(root, 'a.txt')).toEqual({ absolute: join(root, 'a.txt'), rel: 'a.txt', exists: true })
    expect(await resolveWorkspacePath(root, 'sub/b.txt')).toEqual({ absolute: join(root, 'sub', 'b.txt'), rel: 'sub/b.txt', exists: true })
    expect(await resolveWorkspacePath(root, './sub/deep/../b.txt')).toMatchObject({ rel: 'sub/b.txt', exists: true })
    expect(await resolveWorkspacePath(root, 'sub/')).toMatchObject({ rel: 'sub', exists: true })
  })

  it('the root itself is "."', async () => {
    expect(await resolveWorkspacePath(root, '.')).toEqual({ absolute: root, rel: '.', exists: true })
    expect(await resolveWorkspacePath(root, root)).toEqual({ absolute: root, rel: '.', exists: true })
    expect(await resolveWorkspacePath(root, 'sub/..')).toMatchObject({ rel: '.' })
  })

  it('accepts an absolute path inside the folder', async () => {
    expect(await resolveWorkspacePath(root, join(root, 'sub', 'b.txt'))).toMatchObject({ rel: 'sub/b.txt', exists: true })
  })

  it('a missing target is not_found without allowMissing, and a missing tail with it', async () => {
    const error = await rejection(resolveWorkspacePath(root, 'missing.txt'))
    expect(error).toMatchObject({ code: 'not_found', message: '"missing.txt" does not exist in the project folder.' })
    expect(await resolveWorkspacePath(root, 'missing.txt', { allowMissing: true })).toEqual({ absolute: join(root, 'missing.txt'), rel: 'missing.txt', exists: false })
    expect(await resolveWorkspacePath(root, 'new/dir/file.txt', { allowMissing: true })).toEqual({ absolute: join(root, 'new', 'dir', 'file.txt'), rel: 'new/dir/file.txt', exists: false })
  })

  it('eNOTDIR: a path below a file does not exist; with allowMissing its base is not a folder', async () => {
    await expect(resolveWorkspacePath(root, 'a.txt/x')).rejects.toMatchObject({ code: 'not_found' })
    await refused(resolveWorkspacePath(root, 'a.txt/x', { allowMissing: true }), '"a.txt" is not a folder.')
    await refused(resolveWorkspacePath(root, 'a.txt/x/y.txt', { allowMissing: true }), '"a.txt" is not a folder.')
  })
})

describe('resolveWorkspacePath: inputs that leave the folder', () => {
  it.each(['..', '../x', 'a/../../x', 'sub/../../a.txt', '../../../../../../etc/passwd'])('refuses %s', async (input) => {
    await refused(resolveWorkspacePath(root, input), OUTSIDE_PROJECT_MESSAGE)
    await refused(resolveWorkspacePath(root, input, { allowMissing: true }), OUTSIDE_PROJECT_MESSAGE)
  })

  it('refuses absolute paths outside the folder', async () => {
    await refused(resolveWorkspacePath(root, join(outside, 'secret.txt')), OUTSIDE_PROJECT_MESSAGE)
    await refused(resolveWorkspacePath(root, '/etc/passwd'), OUTSIDE_PROJECT_MESSAGE)
    await refused(resolveWorkspacePath(root, join(outside, 'new.txt'), { allowMissing: true }), OUTSIDE_PROJECT_MESSAGE)
  })

  it('refuses a sibling folder that shares the root as a name prefix', async () => {
    const sibling = `${root}-other`
    temps.push(sibling)
    await mkdir(sibling)
    await refused(resolveWorkspacePath(root, sibling), OUTSIDE_PROJECT_MESSAGE)
    await refused(resolveWorkspacePath(root, `../${sibling.split('/').at(-1)}`), OUTSIDE_PROJECT_MESSAGE)
  })

  it.each([
    ['', 'The path is empty.'],
    ['a\u0000b', 'Paths cannot contain control characters.'],
    ['a\nb.txt', 'Paths cannot contain control characters.'],
    ['tab\there', 'Paths cannot contain control characters.'],
    ['x'.repeat(4097), 'The path is longer than 4096 characters.'],
  ])('refuses the input %j', async (input, message) => {
    await refused(resolveWorkspacePath(root, input, { allowMissing: true }), message)
  })

  it('accepts 4096 characters (then fails on the filesystem name limit, not on the input check)', async () => {
    const error = await rejection(resolveWorkspacePath(root, 'x'.repeat(4096)))
    expect(error.message).not.toMatch(/longer than|control characters|empty/)
  })
})

describe.runIf(posix)('resolveWorkspacePath: symbolic links', () => {
  it('a file link inside the folder resolves to its target', async () => {
    await symlink('a.txt', join(root, 'link.txt'))
    await symlink(join(root, 'sub', 'b.txt'), join(root, 'abs-link.txt'))
    expect(await resolveWorkspacePath(root, 'link.txt')).toEqual({ absolute: join(root, 'a.txt'), rel: 'a.txt', exists: true })
    expect(await resolveWorkspacePath(root, 'abs-link.txt')).toMatchObject({ rel: 'sub/b.txt', exists: true })
  })

  it('a folder link inside the folder resolves, also with a missing tail', async () => {
    await symlink('sub', join(root, 'alias'))
    expect(await resolveWorkspacePath(root, 'alias/b.txt')).toMatchObject({ absolute: join(root, 'sub', 'b.txt'), rel: 'sub/b.txt' })
    expect(await resolveWorkspacePath(root, 'alias/new/c.txt', { allowMissing: true })).toEqual({ absolute: join(root, 'sub', 'new', 'c.txt'), rel: 'sub/new/c.txt', exists: false })
  })

  it('refuses a file link that points outside the folder', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'evil.txt'))
    await refused(resolveWorkspacePath(root, 'evil.txt'), '"evil.txt" resolves outside the project folder (symbolic link).')
    await refused(resolveWorkspacePath(root, 'evil.txt', { allowMissing: true }), /resolves outside the project folder/)
  })

  it('refuses a relative link that climbs out of the folder', async () => {
    await symlink('../../../../../../../../etc', join(root, 'up'))
    await refused(resolveWorkspacePath(root, 'up/passwd'), /resolves outside the project folder \(symbolic link\)/)
  })

  it('refuses a link inside the missing tail: a folder link out of the root above a missing file', async () => {
    await symlink(outside, join(root, 'out'))
    await refused(resolveWorkspacePath(root, 'out/secret.txt'), '"out/secret.txt" resolves outside the project folder (symbolic link).')
    await refused(resolveWorkspacePath(root, 'out/new.txt', { allowMissing: true }), '"out/new.txt" resolves outside the project folder (symbolic link).')
    await refused(resolveWorkspacePath(root, 'out/a/b/c.txt', { allowMissing: true }), /resolves outside the project folder/)
  })

  it('refuses dangling links (inside, outside, and as a folder of a missing tail)', async () => {
    await symlink('missing-target', join(root, 'dangling'))
    await symlink(join(outside, 'missing'), join(root, 'dangling-out'))
    await refused(resolveWorkspacePath(root, 'dangling'), '"dangling" is a symbolic link whose target does not exist.')
    await refused(resolveWorkspacePath(root, 'dangling', { allowMissing: true }), '"dangling" is a symbolic link whose target does not exist.')
    await refused(resolveWorkspacePath(root, 'dangling-out', { allowMissing: true }), '"dangling-out" is a symbolic link whose target does not exist.')
    await refused(resolveWorkspacePath(root, 'dangling/x/y.txt', { allowMissing: true }), '"dangling" is a symbolic link whose target does not exist.')
  })

  it('refuses a link loop', async () => {
    await symlink('loop-b', join(root, 'loop-a'))
    await symlink('loop-a', join(root, 'loop-b'))
    await refused(resolveWorkspacePath(root, 'loop-a'), '"loop-a" goes through a symbolic link loop.')
    await refused(resolveWorkspacePath(root, 'loop-a/x', { allowMissing: true }), /symbolic link loop/)
  })
})

describe('resolveWorkspacePath: the root', () => {
  it('refuses a root that is not its own realpath (a link to the folder)', async () => {
    if (!posix)
      return
    const parent = await tempFolder()
    const link = join(parent, 'link-to-root')
    await symlink(root, link)
    await refused(resolveWorkspacePath(link, 'a.txt'), PROJECT_FOLDER_MOVED_MESSAGE)
  })

  it('refuses a root that was replaced by a link after the project was created', async () => {
    if (!posix)
      return
    const parent = await tempFolder()
    const project = join(parent, 'project')
    await mkdir(project)
    await writeFile(join(project, 'a.txt'), 'x')
    expect(await resolveWorkspacePath(project, 'a.txt')).toMatchObject({ rel: 'a.txt' })
    await rename(project, join(parent, 'moved'))
    await symlink(outside, project)
    await refused(resolveWorkspacePath(project, 'secret.txt'), PROJECT_FOLDER_MOVED_MESSAGE)
  })

  it('refuses a root that no longer exists', async () => {
    const gone = await tempFolder()
    await rm(gone, { recursive: true })
    await refused(resolveWorkspacePath(gone, 'a.txt'), PROJECT_FOLDER_MISSING_MESSAGE)
    await refused(resolveWorkspacePath(join(gone, 'x'), 'a.txt', { allowMissing: true }), PROJECT_FOLDER_MISSING_MESSAGE)
  })

  it('refuses a relative root', async () => {
    await refused(resolveWorkspacePath('relative-root', 'a.txt'), /The project folder/)
  })
})

describe('reads', () => {
  it('reads a regular file (also through a link inside the folder)', async () => {
    const content = await readWorkspaceFile(root, 'sub/b.txt', { maxBytes: 1024 })
    expect(content.bytes.toString('utf8')).toBe('beta\n')
    expect(content.resolved).toMatchObject({ rel: 'sub/b.txt', exists: true })
    expect(content.stats.isFile()).toBe(true)
    if (posix) {
      await symlink('a.txt', join(root, 'link.txt'))
      expect((await readWorkspaceFile(root, 'link.txt', { maxBytes: 1024 })).bytes.toString('utf8')).toBe('alpha\n')
    }
  })

  it('enforces maxBytes (payload_too_large), exactly maxBytes fits', async () => {
    await writeFile(join(root, 'ten.txt'), '0123456789')
    expect((await readWorkspaceFile(root, 'ten.txt', { maxBytes: 10 })).bytes).toHaveLength(10)
    await expect(readWorkspaceFile(root, 'ten.txt', { maxBytes: 9 })).rejects.toMatchObject({ code: 'payload_too_large', message: '"ten.txt" is larger than 9 bytes.', details: { limitBytes: 9 } })
    await expect(readWorkspaceFile(root, 'ten.txt', { maxBytes: 2048 })).resolves.toBeDefined()
  })

  it('refuses a folder and a missing file', async () => {
    await refused(openWorkspaceFile(root, 'sub'), '"sub" is a folder, not a file.')
    await refused(openWorkspaceFile(root, '.'), '"." is a folder, not a file.')
    await expect(openWorkspaceFile(root, 'nope.txt')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses paths outside the folder before opening anything', async () => {
    await refused(readWorkspaceFile(root, join(outside, 'secret.txt'), { maxBytes: 1024 }), OUTSIDE_PROJECT_MESSAGE)
  })

  it.runIf(posix)('a FIFO is refused at once instead of blocking the read', async () => {
    const fifo = join(root, 'pipe')
    execFileSync('mkfifo', [fifo])
    await refused(within(openWorkspaceFile(root, 'pipe')), '"pipe" is not a regular file.')
    await refused(within(readWorkspaceFile(root, 'pipe', { maxBytes: 1024 })), '"pipe" is not a regular file.')
    // A write never opens (or replaces) the FIFO either.
    await refused(within(writeWorkspaceFile(root, 'pipe', 'x')), '"pipe" is not a regular file.')
    expect((await lstat(fifo)).isFIFO()).toBe(true)
  })

  it('the caller of openWorkspaceFile streams windows from the handle', async () => {
    await writeFile(join(root, 'lines.txt'), 'one\ntwo\nthree\n')
    const opened = await openWorkspaceFile(root, 'lines.txt')
    try {
      const buffer = Buffer.alloc(3)
      const { bytesRead } = await opened.handle.read(buffer, 0, 3, 4)
      expect(buffer.subarray(0, bytesRead).toString()).toBe('two')
      expect(opened.stats.size).toBe(14)
    }
    finally {
      await opened.handle.close()
    }
  })
})

describe('writes', () => {
  async function leftovers(dir: string): Promise<string[]> {
    return (await readdir(dir)).filter(name => name.startsWith(WORKSPACE_TEMP_PREFIX))
  }

  it('creates a file and its missing folders', async () => {
    const result = await writeWorkspaceFile(root, 'new/dir/file.txt', 'hello\n')
    expect(result).toMatchObject({ absolute: join(root, 'new', 'dir', 'file.txt'), rel: 'new/dir/file.txt', created: true, bytes: 6 })
    expect(await readFile(join(root, 'new', 'dir', 'file.txt'), 'utf8')).toBe('hello\n')
    expect(await leftovers(join(root, 'new', 'dir'))).toEqual([])
  })

  it('replaces a file atomically and keeps its mode', async () => {
    if (posix) {
      await chmod(join(root, 'a.txt'), 0o755)
      await chmod(join(root, 'sub', 'b.txt'), 0o600)
    }
    const first = await writeWorkspaceFile(root, 'a.txt', 'changed\n')
    const second = await writeWorkspaceFile(root, 'sub/b.txt', new TextEncoder().encode('bytes\n'))
    expect(first).toMatchObject({ rel: 'a.txt', created: false, bytes: 8 })
    expect(second).toMatchObject({ rel: 'sub/b.txt', created: false, bytes: 6 })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('changed\n')
    expect(await readFile(join(root, 'sub', 'b.txt'), 'utf8')).toBe('bytes\n')
    if (posix) {
      expect((await stat(join(root, 'a.txt'))).mode & 0o777).toBe(0o755)
      expect((await stat(join(root, 'sub', 'b.txt'))).mode & 0o777).toBe(0o600)
      expect(first.mode & 0o777).toBe(0o755)
    }
    expect(await leftovers(root)).toEqual([])
    expect(await leftovers(join(root, 'sub'))).toEqual([])
  })

  it('a new file gets the default mode (0666 minus the umask)', async () => {
    if (!posix)
      return
    const umask = process.umask()
    const result = await writeWorkspaceFile(root, 'fresh.txt', '')
    expect(result.mode & 0o777).toBe(0o666 & ~umask)
    expect(result.bytes).toBe(0)
  })

  it.each([
    '.git/hooks/pre-commit',
    '.git/config',
    'sub/.git/HEAD',
    '.GIT/hooks/x',
    'new/.git',
    './sub/../.git/x',
  ])('refuses a .git segment: %s', async (input) => {
    await refused(writeWorkspaceFile(root, input, 'x'), /inside a \.git folder: the workspace tools never write there\./)
  })

  it.runIf(posix)('refuses .git reached through a link, and keeps reads of .git possible', async () => {
    await mkdir(join(root, '.git', 'hooks'), { recursive: true })
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await symlink('.git', join(root, 'g'))
    await refused(writeWorkspaceFile(root, 'g/hooks/pre-commit', '#!/bin/sh\n'), /inside a \.git folder/)
    expect(await readdir(join(root, '.git', 'hooks'))).toEqual([])
    expect((await readWorkspaceFile(root, '.git/HEAD', { maxBytes: 100 })).bytes.toString()).toContain('refs/heads/main')
  })

  it('refuses folders and paths outside the folder', async () => {
    await refused(writeWorkspaceFile(root, 'sub', 'x'), '"sub" is a folder, not a file.')
    await refused(writeWorkspaceFile(root, '.', 'x'), '"." is a folder, not a file.')
    await refused(writeWorkspaceFile(root, '../escape.txt', 'x'), OUTSIDE_PROJECT_MESSAGE)
    await refused(writeWorkspaceFile(root, 'a.txt/inner.txt', 'x'), '"a.txt" is not a folder.')
    expect(await readdir(outside)).toEqual(['secret.txt'])
  })

  it.runIf(posix)('writes the target of a file link inside the folder and keeps the link', async () => {
    await symlink('a.txt', join(root, 'link.txt'))
    const result = await writeWorkspaceFile(root, 'link.txt', 'through the link\n')
    expect(result).toMatchObject({ rel: 'a.txt', created: false })
    expect((await lstat(join(root, 'link.txt'))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(root, 'link.txt'))).toBe('a.txt')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('through the link\n')
  })

  it.runIf(posix)('never writes through links out of the folder', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'evil.txt'))
    await symlink(outside, join(root, 'out'))
    await refused(writeWorkspaceFile(root, 'evil.txt', 'pwned'), /resolves outside the project folder/)
    await refused(writeWorkspaceFile(root, 'out/planted.txt', 'pwned'), /resolves outside the project folder/)
    await refused(writeWorkspaceFile(root, 'out/deep/planted.txt', 'pwned'), /resolves outside the project folder/)
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('top secret\n')
    expect(await readdir(outside)).toEqual(['secret.txt'])
  })

  it.runIf(posix)('refuses a write into a replaced root', async () => {
    const parent = await tempFolder()
    const project = join(parent, 'project')
    await mkdir(project)
    await rename(project, join(parent, 'moved'))
    await symlink(outside, project)
    await refused(writeWorkspaceFile(project, 'planted.txt', 'x'), PROJECT_FOLDER_MOVED_MESSAGE)
    expect(await readdir(outside)).toEqual(['secret.txt'])
  })
})

describe('helpers', () => {
  it('toWorkspaceRel and hasGitSegment', () => {
    expect(toWorkspaceRel(root, root)).toBe('.')
    expect(toWorkspaceRel(root, join(root, 'a', 'b.txt'))).toBe('a/b.txt')
    expect(hasGitSegment('.git')).toBe(true)
    expect(hasGitSegment('a/.Git/b')).toBe(true)
    expect(hasGitSegment('.github/workflows/ci.yml')).toBe(false)
    expect(hasGitSegment('.gitignore')).toBe(false)
    expect(hasGitSegment('a/b.git')).toBe(false)
  })
})
