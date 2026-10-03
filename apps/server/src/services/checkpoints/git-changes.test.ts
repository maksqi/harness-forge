import type { GitStatusFile } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { TempGitRepo } from '../../workspace/git.test-util.ts'
import type { GitOrdinaryEntry, GitRepoInfo, GitStatusEntry } from '../../workspace/git.ts'
import type { CheckpointContext } from './types.ts'
import { Buffer } from 'node:buffer'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileDiffSchema, gitStatusSchema, LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { chats, projects } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeCheckpointBlobStore, createTestChangeRowWriter } from '../../testing/fake-checkpoints.ts'
import { createTempGitRepo, hasGit, makeTempDir } from '../../workspace/git.test-util.ts'
import { clearGitMissingCache, killLiveGitGroups } from '../../workspace/git.ts'
import { changesFileDiff } from './changes.ts'
import { sha256Hex } from './disk.ts'
import { chatGitStatus, gitFileDiff, mapGitEntry, mapGitStatus } from './git-changes.ts'

const OID = 'a'.repeat(40)
const INFO: GitRepoInfo = { branch: 'main', head: 'b'.repeat(40), prefix: 'app' }

function ordinary(path: string, xy: string, extra: Partial<GitOrdinaryEntry> = {}): GitStatusEntry {
  return { type: 'ordinary', path, xy, submodule: 'N...', modeHead: '100644', modeIndex: '100644', modeWorktree: '100644', oidHead: OID, oidIndex: OID, ...extra }
}

function renamed(path: string, xy: string, score: string, origPath: string | null): GitStatusEntry {
  return { type: 'renamed', path, xy, submodule: 'N...', modeHead: '100644', modeIndex: '100644', modeWorktree: '100644', oidHead: OID, oidIndex: OID, score, origPath }
}

function unmerged(path: string, xy: string): GitStatusEntry {
  return { type: 'unmerged', path, xy, submodule: 'N...', modeStage1: '100644', modeStage2: '100644', modeStage3: '100644', modeWorktree: '100644', oidStage1: OID, oidStage2: OID, oidStage3: OID }
}

function untracked(path: string): GitStatusEntry {
  return { type: 'untracked', path }
}

function file(path: string, status: GitStatusFile['status'], staged: boolean, unstaged: boolean, origPath: string | null = null): GitStatusFile {
  return { path, origPath, status, staged, unstaged }
}

describe('mapGitEntry / mapGitStatus (pure)', () => {
  it.each([
    [ordinary('a', 'M.'), file('a', 'modified', true, false)],
    [ordinary('a', '.M'), file('a', 'modified', false, true)],
    [ordinary('a', 'MM'), file('a', 'modified', true, true)],
    [ordinary('a', 'A.'), file('a', 'added', true, false)],
    [ordinary('a', 'AM'), file('a', 'added', true, true)],
    [ordinary('a', 'AD'), file('a', 'added', true, true)],
    [ordinary('a', '.A'), file('a', 'added', false, true)],
    [ordinary('a', 'D.'), file('a', 'deleted', true, false)],
    [ordinary('a', '.D'), file('a', 'deleted', false, true)],
    [ordinary('a', 'MD'), file('a', 'deleted', true, true)],
    [ordinary('a', 'T.'), file('a', 'typechange', true, false)],
    [ordinary('a', '.T'), file('a', 'typechange', false, true)],
    [ordinary('a', 'MT'), file('a', 'typechange', true, true)],
    [renamed('new', 'R.', 'R100', 'old'), file('new', 'renamed', true, false, 'old')],
    [renamed('new', 'RM', 'R87', 'old'), file('new', 'renamed', true, true, 'old')],
    [renamed('new', 'R.', 'R100', null), file('new', 'added', true, false)],
    [renamed('copy', 'C.', 'C75', 'orig'), file('copy', 'added', true, false)],
    [unmerged('c', 'UU'), file('c', 'conflicted', true, true)],
    [unmerged('c', 'AA'), file('c', 'conflicted', true, true)],
    [unmerged('c', 'DU'), file('c', 'conflicted', true, true)],
    [untracked('u'), file('u', 'untracked', false, false)],
    [untracked('nested/'), file('nested/', 'untracked', false, false)],
  ])('maps %o', (entry, expected) => {
    expect(mapGitEntry(entry)).toEqual(expected)
  })

  it('keeps the repository facts, sorts by path and merges a path listed twice', () => {
    const status = mapGitStatus(INFO, [untracked('z'), ordinary('b', '.M'), untracked('a'), ordinary('gone', 'D.'), untracked('gone'), untracked('back'), ordinary('back', 'D.')])
    expect(gitStatusSchema.parse(status)).toEqual({
      available: true,
      reason: null,
      branch: 'main',
      head: 'b'.repeat(40),
      prefix: 'app',
      files: [
        file('a', 'untracked', false, false),
        file('b', 'modified', false, true),
        file('back', 'deleted', true, true),
        file('gone', 'deleted', true, true),
        file('z', 'untracked', false, false),
      ],
      truncated: false,
    })
    expect(mapGitStatus({ branch: null, head: null, prefix: '' }, [], true)).toMatchObject({ branch: null, head: null, prefix: '', files: [], truncated: true })
  })

  it('caps the list at 2000 files', () => {
    const entries = Array.from({ length: LIMITS.gitStatusFilesMax + 1 }, (_, index) => untracked(`f${String(index).padStart(5, '0')}`))
    const status = mapGitStatus(INFO, entries.reverse())
    expect(status.files).toHaveLength(LIMITS.gitStatusFilesMax)
    expect(status.truncated).toBe(true)
    expect(status.files[0]?.path).toBe('f00000')
    expect(status.files.at(-1)?.path).toBe('f01999')
  })
})

// ---------- real repositories ----------

const CHAT = '0199a8f0-0000-7000-8000-000000000311'
const NO_PROJECT_CHAT = '0199a8f0-0000-7000-8000-000000000312'
const PROJECT = 'prj_GGGGGGGGGGGGGGGG'
const posix = process.platform !== 'win32'

let t: TestApp | undefined
const temps: string[] = []

afterEach(async () => {
  killLiveGitGroups()
  clearGitMissingCache()
  await t?.close()
  t = undefined
  for (const dir of temps.splice(0))
    await rm(dir, { recursive: true, force: true })
})

interface Setup {
  readonly repo: TempGitRepo
  readonly ctx: CheckpointContext
  readonly project: string
  readonly env: Record<string, string>
}

/** A temp repository, a test app whose only root is its temp folder, and a chat of a project at `projectPath`. */
async function setup(options: { projectPath?: string, init?: boolean } = {}): Promise<Setup> {
  const repo = await createTempGitRepo({ init: options.init ?? true })
  temps.push(repo.base)
  const project = join(repo.dir, options.projectPath ?? '.')
  await mkdir(project, { recursive: true })
  t = await createTestApp({ start: false, workspaceRoots: [repo.base] })
  await t.db.insert(projects).values({ id: PROJECT, name: 'Git', path: project, createdAt: 1, updatedAt: 1 })
  await t.db.insert(chats).values([{ id: CHAT, projectId: PROJECT }, { id: NO_PROJECT_CHAT, projectId: null }])
  const ctx: CheckpointContext = { deps: t.deps, blobs: createFakeCheckpointBlobStore(), rows: createTestChangeRowWriter(t.db), now: () => 1 }
  return { repo, ctx, project, env: repo.env }
}

async function diffOf(s: Setup, path: string) {
  return fileDiffSchema.parse(await gitFileDiff(s.ctx, CHAT, path, { gitEnv: s.env }))
}

describe.skipIf(!hasGit())('chatGitStatus', () => {
  it('maps a real repository', async () => {
    const s = await setup()
    const { repo } = s
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'clean.txt'])
      await repo.write(name, `${name}\n`)
    await repo.write('old.txt', `${Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')}\n`)
    await repo.write('bin.dat', Buffer.from([0, 1, 2, 3]))
    const head = await repo.commitAll()
    await repo.write('a.txt', 'a changed\n')
    await repo.write('b.txt', 'b staged\n')
    await repo.git(['add', 'b.txt'])
    await rm(join(repo.dir, 'c.txt'))
    await repo.git(['rm', '-q', 'd.txt'])
    await repo.git(['mv', 'old.txt', 'new.txt'])
    await repo.write('e.txt', 'e\n')
    await repo.git(['add', 'e.txt'])
    await repo.write('u dir/ü.txt', 'u\n')
    await repo.write('bin.dat', Buffer.from([0, 9, 8, 7, 255]))

    const status = gitStatusSchema.parse(await chatGitStatus(s.ctx, CHAT, { gitEnv: s.env }))
    expect(status).toEqual({
      available: true,
      reason: null,
      branch: 'main',
      head,
      prefix: '',
      files: [
        file('a.txt', 'modified', false, true),
        file('b.txt', 'modified', true, false),
        file('bin.dat', 'modified', false, true),
        file('c.txt', 'deleted', false, true),
        file('d.txt', 'deleted', true, false),
        file('e.txt', 'added', true, false),
        file('new.txt', 'renamed', true, false, 'old.txt'),
        file('u dir/ü.txt', 'untracked', false, false),
      ],
      truncated: false,
    })
  })

  it.skipIf(!posix)('maps a type change and a merge conflict', async () => {
    const s = await setup()
    const { repo } = s
    await repo.write('a.txt', 'a\n')
    await repo.write('tc.txt', 'tc\n')
    await repo.write('merge.txt', 'base\n')
    await repo.commitAll()
    await repo.git(['checkout', '-q', '-b', 'other'])
    await repo.write('merge.txt', 'theirs\n')
    await repo.commitAll('theirs')
    await repo.git(['checkout', '-q', 'main'])
    await repo.write('merge.txt', 'ours\n')
    await repo.commitAll('ours')
    await expect(repo.git(['merge', '-q', '--no-edit', 'other'])).rejects.toThrow()
    await rm(join(repo.dir, 'tc.txt'))
    await symlink('a.txt', join(repo.dir, 'tc.txt'))

    const status = await chatGitStatus(s.ctx, CHAT, { gitEnv: s.env })
    expect(status.files).toEqual([
      file('merge.txt', 'conflicted', true, true),
      file('tc.txt', 'typechange', false, true),
    ])
    expect(await diffOf(s, 'merge.txt')).toMatchObject({ status: 'modified', baseAvailable: true, diff: { added: expect.any(Number) } })
  })

  it('lists only the files of a project in a repository subfolder, with project paths', async () => {
    const s = await setup({ projectPath: 'app' })
    const { repo } = s
    await repo.write('app/x.txt', 'x\n')
    await repo.write('app/sub/y.txt', 'y\n')
    await repo.write('lib/z.txt', 'z\n')
    await repo.commitAll()
    await repo.write('app/x.txt', 'x2\n')
    await repo.write('lib/z.txt', 'z2\n')
    await repo.write('app/new.txt', 'n\n')
    await repo.git(['mv', 'app/sub/y.txt', 'app/y2.txt'])

    const status = await chatGitStatus(s.ctx, CHAT, { gitEnv: s.env })
    expect(status).toMatchObject({ available: true, prefix: 'app' })
    expect(status.files).toEqual([
      file('new.txt', 'untracked', false, false),
      file('x.txt', 'modified', false, true),
      file('y2.txt', 'renamed', true, false, 'sub/y.txt'),
    ])
    expect(await diffOf(s, 'x.txt')).toMatchObject({ path: 'x.txt', status: 'modified', diff: { added: 1, removed: 1 } })
    expect(await diffOf(s, 'y2.txt')).toMatchObject({ path: 'y2.txt', origPath: 'sub/y.txt', status: 'renamed', diff: { hunks: [], added: 0, removed: 0 } })
  })

  it('reports an unborn HEAD: no head, every file added or untracked', async () => {
    const s = await setup()
    const { repo } = s
    await repo.write('staged.txt', 'staged\n')
    await repo.git(['add', 'staged.txt'])
    await repo.write('loose.txt', 'loose\n')

    const status = await chatGitStatus(s.ctx, CHAT, { gitEnv: s.env })
    expect(status).toMatchObject({ available: true, branch: 'main', head: null, prefix: '' })
    expect(status.files).toEqual([file('loose.txt', 'untracked', false, false), file('staged.txt', 'added', true, false)])
    expect(await diffOf(s, 'staged.txt')).toMatchObject({ status: 'added', baseAvailable: true, currentSha: sha256Hex('staged\n'), diff: { added: 1, removed: 0 } })
    expect(await diffOf(s, 'loose.txt')).toMatchObject({ status: 'untracked', diff: { added: 1, removed: 0 } })
  })

  it('answers the unavailable reasons', async () => {
    const s = await setup({ projectPath: 'proj' })
    const unavailable = { available: false, branch: null, head: null, prefix: '', files: [], truncated: false }
    expect(await chatGitStatus(s.ctx, NO_PROJECT_CHAT, { gitEnv: s.env })).toEqual({ ...unavailable, reason: 'no-project' })
    await expect(chatGitStatus(s.ctx, '0199a8f0-0000-7000-8000-0000000003ff', { gitEnv: s.env })).rejects.toMatchObject({ code: 'not_found' })

    const emptyPath = await makeTempDir('hf-nogit-')
    temps.push(emptyPath)
    expect(gitStatusSchema.parse(await chatGitStatus(s.ctx, CHAT, { gitEnv: { ...s.env, PATH: emptyPath } }))).toEqual({ ...unavailable, reason: 'git-missing' })

    await rm(join(s.repo.dir, '.git'), { recursive: true, force: true })
    expect(await chatGitStatus(s.ctx, CHAT, { gitEnv: s.env })).toEqual({ ...unavailable, reason: 'not-a-repo' })
    await expect(gitFileDiff(s.ctx, CHAT, 'a.txt', { gitEnv: s.env })).rejects.toMatchObject({
      code: 'validation_error',
      details: { issues: [{ path: ['source'] }] },
      message: 'The Git view is not available: The project folder is not inside a Git repository.',
    })
    expect(t?.logs.records.some(record => record.level === 'debug' && record.msg === 'git status not available')).toBe(true)
    expect(t?.logs.records.filter(record => record.level !== 'debug' && JSON.stringify(record).includes(s.repo.base))).toEqual([])

    await rm(s.project, { recursive: true, force: true })
    expect(await chatGitStatus(s.ctx, CHAT, { gitEnv: s.env })).toEqual({ ...unavailable, reason: 'folder-unavailable' })
    await expect(gitFileDiff(s.ctx, CHAT, 'a.txt', { gitEnv: s.env })).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('is not available') })
  })

  it('stops when the request is aborted', async () => {
    const s = await setup()
    await expect(chatGitStatus(s.ctx, CHAT, { gitEnv: s.env, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe.skipIf(!hasGit())('gitFileDiff', () => {
  it('diffs HEAD against the disk for every status', async () => {
    const s = await setup()
    const { repo } = s
    await repo.write('a.txt', 'one\ntwo\n')
    await repo.write('gone.txt', 'gone\n')
    await repo.write('old.txt', 'kept\nmoved\n')
    await repo.write('clean.txt', 'clean\n')
    await repo.commitAll()
    await repo.write('a.txt', 'one\nthree\n')
    await rm(join(repo.dir, 'gone.txt'))
    await repo.git(['mv', 'old.txt', 'new.txt'])
    await repo.write('new.txt', 'kept\nmoved again\n')
    await repo.write('added.txt', 'added\n')
    await repo.git(['add', 'added.txt'])
    await repo.write('loose.txt', 'loose\n')

    expect(await diffOf(s, 'a.txt')).toEqual({
      source: 'git',
      path: 'a.txt',
      origPath: null,
      status: 'modified',
      binary: false,
      tooLarge: false,
      diff: { hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one', '-two', '+three'] }], added: 1, removed: 1, truncated: false },
      currentSha: sha256Hex('one\nthree\n'),
      baseAvailable: true,
    })
    expect(await diffOf(s, './a.txt')).toMatchObject({ path: 'a.txt' })
    expect(await diffOf(s, 'gone.txt')).toMatchObject({ status: 'deleted', currentSha: null, baseAvailable: true, diff: { added: 0, removed: 1 } })
    expect(await diffOf(s, 'new.txt')).toMatchObject({ status: 'renamed', origPath: 'old.txt', diff: { added: 1, removed: 1 } })
    expect(await diffOf(s, 'added.txt')).toMatchObject({ status: 'added', diff: { added: 1, removed: 0 } })
    expect(await diffOf(s, 'loose.txt')).toMatchObject({ status: 'untracked', origPath: null, diff: { added: 1, removed: 0 } })
    // The chat source of the same route delegates here.
    expect(await changesFileDiff(s.ctx, CHAT, { source: 'git', path: 'a.txt' }, { gitEnv: s.env })).toEqual(await diffOf(s, 'a.txt'))

    // Only listed paths: a clean file, an unknown one and a folder are 404; a path outside the project is refused.
    for (const path of ['clean.txt', 'missing.txt', 'old.txt'])
      await expect(gitFileDiff(s.ctx, CHAT, path, { gitEnv: s.env }), path).rejects.toMatchObject({ code: 'not_found' })
    for (const path of ['../outside.txt', '.'])
      await expect(gitFileDiff(s.ctx, CHAT, path, { gitEnv: s.env }), path).rejects.toMatchObject({ code: 'validation_error' })
    await expect(gitFileDiff(s.ctx, NO_PROJECT_CHAT, 'a.txt', { gitEnv: s.env })).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('gives no diff for binary and too large sides', async () => {
    const s = await setup()
    const { repo } = s
    const large = 'x'.repeat(LIMITS.changeDiffSideMaxBytes + 1)
    await repo.write('bin.dat', Buffer.from([0, 1, 2]))
    await repo.write('head-binary.txt', Buffer.from([0x61, 0, 0x62]))
    await repo.write('large-head.txt', large)
    await repo.write('large-disk.txt', 'small\n')
    await repo.commitAll()
    await repo.write('bin.dat', Buffer.from([0, 1, 3]))
    await repo.write('head-binary.txt', 'text now\n')
    await repo.write('large-head.txt', 'small\n')
    await repo.write('large-disk.txt', large)
    await repo.write('invalid.txt', Buffer.from([0xC3, 0x28]))

    expect(await diffOf(s, 'bin.dat')).toMatchObject({ binary: true, tooLarge: false, diff: null, baseAvailable: true, currentSha: sha256Hex(Buffer.from([0, 1, 3])) })
    expect(await diffOf(s, 'head-binary.txt')).toMatchObject({ binary: true, diff: null })
    expect(await diffOf(s, 'invalid.txt')).toMatchObject({ status: 'untracked', binary: true, diff: null })
    expect(await diffOf(s, 'large-head.txt')).toMatchObject({ tooLarge: true, binary: false, diff: null, baseAvailable: true })
    expect(await diffOf(s, 'large-disk.txt')).toMatchObject({ tooLarge: true, binary: false, diff: null, currentSha: sha256Hex(large) })
  })

  it('logs no path at info and never more than the runner detail at debug', async () => {
    const s = await setup()
    await s.repo.write('zebra.txt', 'zebra\n')
    await chatGitStatus(s.ctx, CHAT, { gitEnv: s.env })
    await diffOf(s, 'zebra.txt')
    expect(t?.logs.text()).not.toContain('zebra')
  })
})
