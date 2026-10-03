import type { TestApp, TestAppOptions } from '../../testing/create-test-app.ts'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvError } from '../../env.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { checkRoots, FOLDER_DATA_DIR_ISSUE, FOLDER_MISSING_ISSUE, FOLDER_NOT_DIRECTORY_ISSUE, FOLDER_OUTSIDE_ROOTS_ISSUE, FOLDER_REPLACED_ISSUE, folderIssue, insideDataDir, overlapsDataDir } from './roots.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A test app whose boot has not run, so `projects.start()` can be called (and fail) by the test. */
async function unstarted(options: TestAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp({ ...options, start: false })
  cleanups.push(() => t.close())
  return t
}

describe('projects.start(): the workspace roots', () => {
  it('creates the default root with mode 0700 and answers its realpath', async () => {
    const t = await unstarted()
    expect(existsSync(t.env.paths.workspaces)).toBe(false)
    await t.deps.projects.start()
    expect(statSync(t.env.paths.workspaces).isDirectory()).toBe(true)
    if (process.platform !== 'win32')
      expect(statSync(t.env.paths.workspaces).mode & 0o777).toBe(0o700)
    expect(await t.deps.projects.roots()).toEqual([await realpath(t.env.paths.workspaces)])
    // Idempotent.
    await t.deps.projects.start()
    expect(await t.deps.projects.roots()).toEqual([await realpath(t.env.paths.workspaces)])
  })

  it('a missing explicit root fails the boot (EnvError naming the root)', async () => {
    const base = await tempFolder()
    const missing = join(base, 'missing')
    const t = await unstarted({ workspaceRoots: [missing] })
    const error = await t.deps.projects.start().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EnvError)
    expect((error as Error).message).toBe(`HF_WORKSPACE_ROOTS: ${missing} does not exist. Create the folder or remove it from the list.`)
    // The default root is not created for explicit roots.
    expect(existsSync(t.env.paths.workspaces)).toBe(false)
  })

  it('a root that is a file is refused', async () => {
    const base = await tempFolder()
    const file = join(base, 'file.txt')
    await writeFile(file, 'x')
    const t = await unstarted({ workspaceRoots: [file] })
    await expect(t.deps.projects.start()).rejects.toThrow(`HF_WORKSPACE_ROOTS: ${file} is not a folder.`)
  })

  it('the data dir itself is refused, also through a link', async () => {
    const t = await unstarted()
    await expect(checkRoots({ ...t.env, workspaceRoots: [t.env.dataDir] })).rejects.toThrow(/is the data directory \(HF_DATA_DIR\)/)
    const base = await tempFolder()
    const link = join(base, 'data-link')
    await symlink(t.env.dataDir, link)
    await expect(checkRoots({ ...t.env, workspaceRoots: [link] })).rejects.toBeInstanceOf(EnvError)
  })

  it('a root inside the data dir is refused unless it lies in <dataDir>/workspaces', async () => {
    const t = await unstarted()
    const files = t.env.paths.files
    await expect(checkRoots({ ...t.env, workspaceRoots: [files] })).rejects.toThrow(`HF_WORKSPACE_ROOTS: ${files} is inside the data directory (HF_DATA_DIR).`)
    const team = join(t.env.paths.workspaces, 'team')
    await mkdir(team, { recursive: true })
    const context = await checkRoots({ ...t.env, workspaceRoots: [team] })
    expect(context.roots).toEqual([team])
  })

  it('a root that contains the data dir is allowed', async () => {
    const parent = await tempFolder()
    const dataDir = join(parent, 'data')
    await mkdir(dataDir)
    const t = await unstarted({ dataDir, workspaceRoots: [parent] })
    await t.deps.projects.start()
    expect(await t.deps.projects.roots()).toEqual([parent])
  })

  it('resolves links, keeps the order and drops duplicates', async () => {
    const a = await tempFolder()
    const b = await tempFolder()
    const linkBase = await tempFolder()
    const linkToA = join(linkBase, 'to-a')
    await symlink(a, linkToA)
    const t = await unstarted({ workspaceRoots: [b, linkToA, a] })
    await t.deps.projects.start()
    expect(await t.deps.projects.roots()).toEqual([b, a])
  })

  it('a link to a filesystem root is refused', async () => {
    if (process.platform === 'win32')
      return
    const base = await tempFolder()
    const link = join(base, 'slash')
    await symlink('/', link)
    const t = await unstarted({ workspaceRoots: [link] })
    await expect(t.deps.projects.start()).rejects.toThrow(/resolves to a filesystem root/)
  })

  it('a failed start fails the whole boot of createTestApp', async () => {
    const base = await tempFolder()
    await expect(createTestApp({ workspaceRoots: [join(base, 'nope')] })).rejects.toBeInstanceOf(EnvError)
  })
})

describe('folder rules', () => {
  it('overlapsDataDir / insideDataDir: equal, inside, containing; the default root subtree is allowed', () => {
    const context = { roots: ['/srv'], dataDir: '/srv/hf/data', defaultRoot: '/srv/hf/data/workspaces' }
    expect(overlapsDataDir('/srv/hf/data', context)).toBe(true)
    expect(overlapsDataDir('/srv/hf/data/files', context)).toBe(true)
    expect(overlapsDataDir('/srv/hf', context)).toBe(true)
    expect(overlapsDataDir('/srv', context)).toBe(true)
    expect(overlapsDataDir('/srv/other', context)).toBe(false)
    expect(overlapsDataDir('/srv/hf/data-other', context)).toBe(false)
    expect(overlapsDataDir('/srv/hf/data/workspaces', context)).toBe(false)
    expect(overlapsDataDir('/srv/hf/data/workspaces/demo', context)).toBe(false)
    expect(insideDataDir('/srv/hf', context)).toBe(false)
    expect(insideDataDir('/srv/hf/data', context)).toBe(true)
    expect(insideDataDir('/srv/hf/data/cache', context)).toBe(true)
    expect(insideDataDir('/srv/hf/data/workspaces/demo', context)).toBe(false)
  })

  it('folderIssue: missing, replaced by a link, not a folder, outside the roots, overlapping the data dir', async () => {
    const root = await tempFolder()
    const dataDir = join(await tempFolder(), 'data')
    await mkdir(dataDir)
    const context = { roots: [root], dataDir, defaultRoot: join(dataDir, 'workspaces') }
    const ok = join(root, 'ok')
    await mkdir(ok)
    expect(await folderIssue(ok, context)).toBeNull()
    expect(await folderIssue(join(root, 'gone'), context)).toBe(FOLDER_MISSING_ISSUE)
    const target = join(root, 'target')
    await mkdir(target)
    const link = join(root, 'link')
    await symlink(target, link)
    expect(await folderIssue(link, context)).toBe(FOLDER_REPLACED_ISSUE)
    const file = join(root, 'file')
    await writeFile(file, 'x')
    expect(await folderIssue(file, context)).toBe(FOLDER_NOT_DIRECTORY_ISSUE)
    const outside = await tempFolder()
    expect(await folderIssue(outside, context)).toBe(FOLDER_OUTSIDE_ROOTS_ISSUE)
    expect(await folderIssue(root, { ...context, dataDir: join(root, 'ok') })).toBe(FOLDER_DATA_DIR_ISSUE)
  })
})
