// The project file index of `@` mentions (W9.6-T1, T2, T4; ARCHITECTURE.md 6.21): the index rules (the walker's
// `.gitignore`, `node_modules` and `.git` handling, secret-looking paths and links to them left out, folders derived),
// the shared ranking, the cap (`truncated`), the TTL, the invalidation (`workspace.changed`, `project.changed`,
// `run.finished`, `invalidate`), single-flight builds, the bounded cache, `stop()`, and the logging rule. Real project
// folders in `realpath(mkdtemp())` roots; the clock and the timers are faked where time matters.
import type { HarnessError, ProjectFileEntry, ProjectFileSearch, ProjectSummary } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { WalkOptions, WalkResult } from '../../workspace/walk.ts'
import type { ProjectFileServiceOptions } from './index.ts'
import type { ProjectFileService } from './types.ts'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LIMITS, projectFileSearchSchema, rankPaths } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { walkWorkspace } from '../../workspace/walk.ts'
import { createProjectFileService, MENTION_INDEX_PROJECTS_MAX } from './index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function write(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content)
  }
}

/** A walker that records every walk (and how many ran at once) and can hold a walk's answer until released. */
function recordingWalk() {
  const roots: string[] = []
  let running = 0
  let maxRunning = 0
  const gates: Array<() => void> = []
  let holding = false
  const walk = async (options: WalkOptions): Promise<WalkResult> => {
    roots.push(options.root)
    running++
    maxRunning = Math.max(maxRunning, running)
    try {
      const result = await walkWorkspace(options)
      if (holding)
        await new Promise<void>(resolve => gates.push(resolve))
      options.signal?.throwIfAborted()
      return result
    }
    finally {
      running--
    }
  }
  return {
    walk,
    roots,
    get count() {
      return roots.length
    },
    get maxRunning() {
      return maxRunning
    },
    /** Walks started from now on wait for `release()` before they answer. */
    hold: () => {
      holding = true
    },
    /** Lets every held walk answer (and stops holding). */
    release: () => {
      holding = false
      for (const gate of gates.splice(0))
        gate()
    },
    /** Walks waiting for `release()`. */
    held: () => gates.length,
  }
}

interface Harness {
  t: TestApp
  root: string
  project: ProjectSummary
  /** The project folder (canonical). */
  dir: string
  service: ProjectFileService
  walks: ReturnType<typeof recordingWalk>
}

async function harness(options: ProjectFileServiceOptions = {}, files: Record<string, string> = {}): Promise<Harness> {
  const root = await tempFolder()
  // The app's own service is the fake: the tests below drive their own instance (with test seams) over the real
  // projects, events, chats and files services.
  const t = await createTestApp({ builtins: [], workspaceRoots: [root], projectFiles: 'fake' })
  cleanups.push(() => t.close())
  const project = await t.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })
  const dir = join(root, 'demo')
  await write(dir, files)
  const walks = recordingWalk()
  const service = createProjectFileService(t.deps, { walk: walks.walk, ...options })
  cleanups.push(() => service.stop())
  return { t, root, project, dir, service, walks }
}

async function addProject(h: Harness, folder: string, files: Record<string, string>): Promise<ProjectSummary> {
  const project = await h.t.deps.projects.create({ name: folder, path: h.root, newFolder: folder })
  await write(join(h.root, folder), files)
  return project
}

async function search(service: ProjectFileService, projectId: string, q = '', limit: number = LIMITS.mentionResultsMax): Promise<ProjectFileSearch> {
  return projectFileSearchSchema.parse(await service.search(projectId, { q, limit }))
}

async function paths(service: ProjectFileService, projectId: string): Promise<string[]> {
  return (await search(service, projectId)).items.map(item => item.path)
}

async function failure(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

const FILES: Record<string, string> = {
  'README.md': '# Demo\n',
  'checkpoint.txt': 'checkpoint\n',
  'src/app.ts': 'export {}\n',
  'src/util/paths.ts': 'export {}\n',
  '.gitignore': 'dist/\n*.log\n',
  'dist/bundle.js': 'ignored\n',
  'debug.log': 'ignored\n',
  'node_modules/pkg/index.js': 'ignored\n',
  '.git/config': '[core]\n',
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.env': 'TOKEN=secret\n',
  '.env.example': 'TOKEN=\n',
  'config/.env.local': 'TOKEN=secret\n',
  'keys/server.pem': 'pem\n',
  'id_rsa': 'key\n',
  'credentials.json': '{}\n',
  '.github/workflows/ci.yml': 'on: push\n',
}

const LISTED: ProjectFileEntry[] = [
  { path: '.env.example', kind: 'file' },
  { path: '.github', kind: 'dir' },
  { path: '.github/workflows', kind: 'dir' },
  { path: '.github/workflows/ci.yml', kind: 'file' },
  { path: '.gitignore', kind: 'file' },
  { path: 'README.md', kind: 'file' },
  { path: 'checkpoint.txt', kind: 'file' },
  { path: 'readme-link.md', kind: 'file' },
  { path: 'src', kind: 'dir' },
  { path: 'src/app.ts', kind: 'file' },
  { path: 'src/util', kind: 'dir' },
  { path: 'src/util/paths.ts', kind: 'file' },
]

function sorted(entries: readonly ProjectFileEntry[]): ProjectFileEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

describe.skipIf(process.platform === 'win32')('project file index: what is listed', () => {
  it('lists the files and the folders derived from them; gitignored paths, node_modules, .git, secret-looking paths and links to them are left out', async () => {
    const h = await harness({}, FILES)
    const outside = await tempFolder()
    await write(outside, { 'outside.txt': 'outside\n' })
    await symlink(join(h.dir, 'README.md'), join(h.dir, 'readme-link.md'))
    await symlink(join(h.dir, '.env'), join(h.dir, 'env-link.txt'))
    await symlink(join(h.dir, '.git', 'config'), join(h.dir, 'git-config.txt'))
    await symlink(join(outside, 'outside.txt'), join(h.dir, 'outside-link.txt'))
    await symlink(outside, join(h.dir, 'outside-folder'))

    const result = await search(h.service, h.project.id)
    expect(sorted(result.items)).toEqual(LISTED)
    expect(result.truncated).toBe(false)
    expect(result.indexedAt).toBeGreaterThan(0)
    // The empty query keeps the shared order: shallower paths first, then by path.
    expect(result.items).toEqual(rankPaths('', LISTED, LIMITS.mentionResultsMax).items.map(({ path, kind }) => ({ path, kind })))
    expect(h.walks.count).toBe(1)
  })

  it('ranks only through the shared rankPaths: "chk" puts checkpoint.txt first; the limit applies', async () => {
    const h = await harness({}, { ...FILES, 'docs/hacking.md': '', 'src/kitchen.ts': '' })
    const ranked = await search(h.service, h.project.id, 'chk')
    expect(ranked.items[0]).toEqual({ path: 'checkpoint.txt', kind: 'file' })
    const entries = [...LISTED.filter(entry => entry.path !== 'readme-link.md'), { path: 'docs', kind: 'dir' as const }, { path: 'docs/hacking.md', kind: 'file' as const }, { path: 'src/kitchen.ts', kind: 'file' as const }]
    expect(ranked.items).toEqual(rankPaths('chk', entries, LIMITS.mentionResultsMax).items.map(({ path, kind }) => ({ path, kind })))
    expect((await search(h.service, h.project.id, 'src', 2)).items).toEqual(rankPaths('src', entries, 2).items.map(({ path, kind }) => ({ path, kind })))
    expect((await search(h.service, h.project.id, 'zzzz-nothing')).items).toEqual([])
    // `truncated` also tells that more entries matched than the limit (the composer's "Showing the first N matches").
    expect((await search(h.service, h.project.id, 'src', 2)).truncated).toBe(true)
    expect((await search(h.service, h.project.id, 'zzzz-nothing')).truncated).toBe(false)
    // One build answered every search.
    expect(h.walks.count).toBe(1)
  })

  it('cuts the index at maxFiles (truncated); a walk ended by its own limits is truncated too', async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`f${index}.txt`, '']))
    const h = await harness({ maxFiles: 4 }, files)
    const cut = await search(h.service, h.project.id)
    expect(cut.truncated).toBe(true)
    expect(cut.items.filter(item => item.kind === 'file')).toHaveLength(4)
    expect(cut.items.map(item => item.path)).toEqual(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt'])

    const exact = createProjectFileService(h.t.deps, { maxFiles: 6 })
    cleanups.push(() => exact.stop())
    expect(await search(exact, h.project.id)).toMatchObject({ truncated: false })

    const limited = createProjectFileService(h.t.deps, { walk: options => walkWorkspace({ ...options, maxEntries: 2 }) })
    cleanups.push(() => limited.stop())
    const walked = await search(limited, h.project.id)
    expect(walked.truncated).toBe(true)
    expect(walked.items).toHaveLength(2)
    // The production limits.
    expect(LIMITS.mentionIndexFilesMax).toBe(50_000)
  })

  it('returns within 2 s for a hostile .gitignore (the walker drops patterns that could backtrack badly)', async () => {
    const h = await harness({}, {
      '.gitignore': `${'*a'.repeat(12)}*b\n${'x'.repeat(600)}\n${'**/'.repeat(40)}*.tmp\n`,
      [`${'a'.repeat(120)}.txt`]: '',
      'notes.txt': '',
    })
    const started = Date.now()
    const listed = await paths(h.service, h.project.id)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(listed).toEqual(expect.arrayContaining(['notes.txt', `${'a'.repeat(120)}.txt`, '.gitignore']))
  })
})

describe('project file index: errors', () => {
  it('an unknown project is not_found; an unavailable folder is a validation_error with the openWorkspace message', async () => {
    const h = await harness({}, { 'a.txt': '' })
    const unknown = await failure(h.service.search('prj_ZZZZZZZZZZZZZZZZ', { q: '', limit: 50 }))
    expect([unknown.code, unknown.message]).toEqual(['not_found', 'Project prj_ZZZZZZZZZZZZZZZZ not found.'])
    expect((await failure(h.service.attach('prj_ZZZZZZZZZZZZZZZZ', { path: 'a.txt' }))).code).toBe('not_found')

    expect(await paths(h.service, h.project.id)).toEqual(['a.txt'])
    await rm(h.dir, { recursive: true, force: true })
    const opened = await h.t.deps.projects.openWorkspace(h.project.id)
    expect(opened.ok).toBe(false)
    const unavailable = await failure(h.service.search(h.project.id, { q: '', limit: 50 }))
    expect(unavailable.code).toBe('validation_error')
    expect(unavailable.message).toBe(opened.ok ? '' : opened.message)
    expect(unavailable.message).toMatch(/^The project folder .+ is not available: /)
    const attach = await failure(h.service.attach(h.project.id, { path: 'a.txt' }))
    expect([attach.code, attach.message]).toEqual(['validation_error', unavailable.message])

    // The cached index was dropped with the folder: a re-created folder is walked again.
    await write(h.dir, { 'b.txt': '' })
    expect(await paths(h.service, h.project.id)).toEqual(['b.txt'])
    expect(h.walks.count).toBe(2)
  })
})

describe('project file index: lifetime and invalidation', () => {
  it('keeps an index for 30 s (fake timers), then rebuilds it; indexedAt is when the build started', async () => {
    const h = await harness({}, { 'a.txt': '' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(1_000_000)
    const first = await search(h.service, h.project.id)
    expect(first.indexedAt).toBe(Date.now())
    await write(h.dir, { 'b.txt': '' })
    vi.advanceTimersByTime(LIMITS.mentionIndexTtlMs - 1)
    expect((await search(h.service, h.project.id)).items.map(item => item.path)).toEqual(['a.txt'])
    expect(h.walks.count).toBe(1)
    vi.advanceTimersByTime(1)
    const second = await search(h.service, h.project.id)
    expect(second.items.map(item => item.path)).toEqual(['a.txt', 'b.txt'])
    expect(second.indexedAt).toBe(first.indexedAt + LIMITS.mentionIndexTtlMs)
    expect(h.walks.count).toBe(2)
    expect(LIMITS.mentionIndexTtlMs).toBe(30_000)
    // The expiry timer is unref'd and cleared by stop().
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    h.service.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops the index on workspace.changed and project.changed of its project, and on invalidate(); other projects keep theirs', async () => {
    const h = await harness({}, { 'a.txt': '' })
    const other = await addProject(h, 'other', { 'o.txt': '' })
    expect(await paths(h.service, h.project.id)).toEqual(['a.txt'])
    expect(await paths(h.service, other.id)).toEqual(['o.txt'])
    expect(h.walks.count).toBe(2)

    await write(h.dir, { 'b.txt': '' })
    expect(await paths(h.service, h.project.id)).toEqual(['a.txt'])
    h.t.deps.events.emit('workspace.changed', { projectId: h.project.id, chatId: null, batchId: null, source: 'tool', paths: ['b.txt'] })
    expect(await paths(h.service, h.project.id)).toEqual(['a.txt', 'b.txt'])
    expect(await paths(h.service, other.id)).toEqual(['o.txt'])
    expect(h.walks.count).toBe(3)

    await write(h.dir, { 'c.txt': '' })
    await h.t.deps.projects.update(h.project.id, { name: 'Renamed' })
    expect(await paths(h.service, h.project.id)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(h.walks.count).toBe(4)

    await write(h.dir, { 'd.txt': '' })
    h.service.invalidate(h.project.id)
    h.service.invalidate('prj_ZZZZZZZZZZZZZZZZ')
    expect(await paths(h.service, h.project.id)).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt'])
    expect(h.walks.count).toBe(5)

    // Deleting the project drops its index; the next search is not_found.
    await h.t.deps.projects.remove(other.id)
    expect((await failure(h.service.search(other.id, { q: '', limit: 50 }))).code).toBe('not_found')
    expect(h.walks.count).toBe(5)
  })

  it('drops the index when a run of a chat of the project finishes (shell writes and coalesced tool events)', async () => {
    const h = await harness({}, { 'a.txt': '' })
    const chat = await h.t.deps.chats.create({ projectId: h.project.id })
    const loose = await h.t.deps.chats.create({})
    expect(await paths(h.service, h.project.id)).toEqual(['a.txt'])
    await write(h.dir, { 'b.txt': '' })

    h.t.deps.events.emit('run.finished', { chatId: loose.id, messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaa', outcome: 'completed', awaitingApproval: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await paths(h.service, h.project.id)).toEqual(['a.txt'])

    h.t.deps.events.emit('run.finished', { chatId: chat.id, messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaa', outcome: 'completed', awaitingApproval: false })
    await vi.waitFor(async () => expect(await paths(h.service, h.project.id)).toEqual(['a.txt', 'b.txt']))
    expect(h.walks.count).toBe(2)
  })

  it('builds once for concurrent searches (single-flight)', async () => {
    const h = await harness({}, { 'a.txt': '', 'b.txt': '' })
    h.walks.hold()
    const pending = [search(h.service, h.project.id, 'a'), search(h.service, h.project.id, 'b'), search(h.service, h.project.id)]
    await vi.waitFor(() => expect(h.walks.held()).toBe(1))
    h.walks.release()
    const [a, b, all] = await Promise.all(pending)
    expect(a!.items[0]).toEqual({ path: 'a.txt', kind: 'file' })
    expect(b!.items[0]).toEqual({ path: 'b.txt', kind: 'file' })
    expect(all!.items).toHaveLength(2)
    expect(new Set([a!.indexedAt, b!.indexedAt, all!.indexedAt]).size).toBe(1)
    expect(h.walks.count).toBe(1)
  })

  it('an invalidation during a walk discards it: its searches still get its answer, the next search queues a fresh walk behind it (one walk at a time)', async () => {
    const h = await harness({}, { 'a.txt': '' })
    h.walks.hold()
    const early = search(h.service, h.project.id)
    await vi.waitFor(() => expect(h.walks.held()).toBe(1))
    await write(h.dir, { 'b.txt': '' })
    h.service.invalidate(h.project.id)
    const late = search(h.service, h.project.id)
    const later = search(h.service, h.project.id)
    // The fresh walk waits for the discarded one.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.walks.count).toBe(1)
    h.walks.release()
    expect((await early).items.map(item => item.path)).toEqual(['a.txt'])
    expect((await late).items.map(item => item.path)).toEqual(['a.txt', 'b.txt'])
    expect((await later).items.map(item => item.path)).toEqual(['a.txt', 'b.txt'])
    expect(h.walks.count).toBe(2)
    expect(h.walks.maxRunning).toBe(1)
    // The fresh index is kept; the discarded one never was.
    expect(await paths(h.service, h.project.id)).toEqual(['a.txt', 'b.txt'])
    expect(h.walks.count).toBe(2)
  })

  it('an invalidation before a queued walk starts keeps it (it walks after the invalidation anyway)', async () => {
    const h = await harness({}, { 'a.txt': '' })
    h.walks.hold()
    const first = search(h.service, h.project.id)
    await vi.waitFor(() => expect(h.walks.held()).toBe(1))
    h.service.invalidate(h.project.id)
    const queued = search(h.service, h.project.id)
    h.service.invalidate(h.project.id)
    const joined = search(h.service, h.project.id)
    h.walks.release()
    await Promise.all([first, queued, joined])
    expect(h.walks.count).toBe(2)
    expect((await joined).indexedAt).toBe((await queued).indexedAt)
  })

  it(`keeps at most ${MENTION_INDEX_PROJECTS_MAX} indexes (the least recently searched is dropped first)`, async () => {
    const h = await harness({ maxProjects: 2 }, { 'a.txt': '' })
    const b = await addProject(h, 'b', { 'b.txt': '' })
    const c = await addProject(h, 'c', { 'c.txt': '' })
    await paths(h.service, h.project.id)
    await paths(h.service, b.id)
    await paths(h.service, c.id)
    expect(h.walks.count).toBe(3)
    // b and c are cached; a was dropped.
    await paths(h.service, b.id)
    await paths(h.service, c.id)
    expect(h.walks.count).toBe(3)
    await paths(h.service, h.project.id)
    expect(h.walks.count).toBe(4)
    // Searching a dropped b (the least recently searched), c is still cached.
    await paths(h.service, c.id)
    expect(h.walks.count).toBe(4)
    await paths(h.service, b.id)
    expect(h.walks.count).toBe(5)
    expect(MENTION_INDEX_PROJECTS_MAX).toBe(8)
  })

  it('stop() aborts a walk in flight, drops every index and the event subscription; idempotent; a later search works again', async () => {
    const h = await harness({}, { 'a.txt': '' })
    const listeners = h.t.deps.events.subscriberCount()
    expect(await paths(h.service, h.project.id)).toEqual(['a.txt'])
    expect(h.t.deps.events.subscriberCount()).toBe(listeners + 1)
    h.service.stop()
    expect(h.t.deps.events.subscriberCount()).toBe(listeners)
    expect(() => h.service.stop()).not.toThrow()

    h.walks.hold()
    const inFlight = search(h.service, h.project.id)
    await vi.waitFor(() => expect(h.walks.held()).toBe(1))
    h.service.stop()
    h.walks.release()
    await expect(inFlight).rejects.toMatchObject({ name: 'AbortError' })
    expect(await paths(h.service, h.project.id)).toEqual(['a.txt'])
    expect(h.walks.count).toBe(3)
  })
})

describe('project file service: logging (W9.6-T4)', () => {
  it('never logs a query, a path or file content (counts only, at debug)', async () => {
    const QUERY = 'zebrasentinelquery'
    const PATH = 'docs/sentinel-zebra-name.txt'
    const CONTENT = 'CONTENT-SENTINEL-4242'
    const h = await harness({}, { [PATH]: CONTENT })
    await search(h.service, h.project.id, QUERY)
    await search(h.service, h.project.id, 'sentinel')
    const ref = await h.service.attach(h.project.id, { path: PATH })
    expect(ref.name).toBe('sentinel-zebra-name.txt')
    await failure(h.service.attach(h.project.id, { path: 'docs/.env' }))
    const text = h.t.logs.text()
    expect(text).not.toContain(QUERY)
    expect(text).not.toContain('sentinel-zebra')
    expect(text).not.toContain(CONTENT)
    expect(text).not.toContain(Buffer.from(CONTENT).toString('base64'))
    const mine = h.t.logs.records.filter(record => record.component === 'project-files')
    expect(mine.map(record => record.msg)).toEqual(expect.arrayContaining(['project files searched', 'project file attached']))
    expect(mine.every(record => record.level === 'debug')).toBe(true)
  })
})
