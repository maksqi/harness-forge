import type { TestApp, TestAppOptions } from '../../testing/create-test-app.ts'
import type { FakeChatRunner, RecordingEventBus } from '../../testing/fakes.ts'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectId, LIMITS, listResponseSchema, projectBrowseSchema, projectSummarySchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { chats, projects, projectTrust } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeChatRunner, createRecordingEventBus } from '../../testing/fakes.ts'
import {
  CONTAINS_DATA_DIR_MESSAGE,
  FOLDER_EXISTS_MESSAGE,
  folderUnavailableMessage,
  INSIDE_DATA_DIR_MESSAGE,
  OUTSIDE_ROOTS_MESSAGE,
  PROJECT_EXISTS_MESSAGE,
  PROJECT_GONE_MESSAGE,
  PROJECTS_MAX_MESSAGE,
} from './index.ts'
import { PROJECT_FILE_TRUNCATED_MARKER } from './project-file.ts'
import { FOLDER_MISSING_ISSUE, FOLDER_NOT_DIRECTORY_ISSUE, FOLDER_OUTSIDE_ROOTS_ISSUE, FOLDER_REPLACED_ISSUE } from './roots.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

const CHAT_A = '0199a8f0-0000-7000-8000-0000000000a1'
const CHAT_B = '0199a8f0-0000-7000-8000-0000000000a2'
const CHAT_C = '0199a8f0-0000-7000-8000-0000000000a3'

interface Setup {
  t: TestApp
  events: RecordingEventBus
  runs: FakeChatRunner
  /** Realpath of the first root. */
  root: string
}

async function setup(options: TestAppOptions = {}): Promise<Setup> {
  const events = createRecordingEventBus()
  const runs = createFakeChatRunner()
  const t = await createTestApp({ ...options, overrides: { events, runs, ...options.overrides } })
  cleanups.push(() => t.close())
  const [root] = await t.deps.projects.roots()
  return { t, events, runs, root: root! }
}

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A folder below `parent` with `files` (relative path -> text). */
async function folder(parent: string, name: string, files: Record<string, string> = {}): Promise<string> {
  const path = join(parent, name)
  await mkdir(path, { recursive: true })
  for (const [rel, text] of Object.entries(files))
    await writeFile(join(path, rel), text)
  return path
}

async function addChat(t: TestApp, id: string, projectId: string | null, archived = false): Promise<void> {
  await t.db.insert(chats).values({ id, projectId, archived })
}

describe('project service: create', () => {
  it('checks fresh auth before anything is written; a refusal leaves no folder', async () => {
    const { t, root, events } = await setup()
    const calls: string[] = []
    const refused = t.deps.projects.create({ name: 'No', path: root, newFolder: 'never' }, { requireFreshAuth: () => {
      calls.push('checked')
      throw new Error('not fresh')
    } })
    await expect(refused).rejects.toThrow('not fresh')
    expect(calls).toEqual(['checked'])
    expect(existsSync(join(root, 'never'))).toBe(false)
    expect(events.ofType('project.changed')).toEqual([])
  })

  it('stores an existing folder by its realpath and emits project.changed', async () => {
    const { t, root, events } = await setup()
    const target = await folder(root, 'app', { 'AGENTS.md': 'rules' })
    const linkParent = await tempFolder()
    await symlink(target, join(linkParent, 'link'))
    // The link itself lies outside the roots, but its realpath does not.
    const created = await t.deps.projects.create({ name: '  App  ', path: join(linkParent, 'link') }, { requireFreshAuth: () => {} })
    expect(projectSummarySchema.parse(created)).toEqual(created)
    expect(created).toMatchObject({ name: 'App', path: target, instructions: null, available: true, issue: null, instructionsFile: 'AGENTS.md', chatCount: 0 })
    expect(events.ofType('project.changed').map(event => event.data)).toEqual([{ id: created.id, project: created }])
    expect(t.logs.records.some(record => record.msg === 'project created')).toBe(true)
  })

  it('newFolder: creates the folder inside path (no intermediate folders); an existing one is 409', async () => {
    const { t, root } = await setup()
    const created = await t.deps.projects.create({ name: 'Fresh', path: root, newFolder: 'fresh-app' })
    expect(created.path).toBe(join(root, 'fresh-app'))
    expect(existsSync(created.path)).toBe(true)

    await writeFile(join(root, 'taken'), 'a file')
    for (const name of ['fresh-app', 'taken']) {
      const error = await t.deps.projects.create({ name: 'Again', path: root, newFolder: name }).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ code: 'conflict', message: FOLDER_EXISTS_MESSAGE, details: { reason: 'exists' } })
    }
    expect(await readFile(join(root, 'taken'), 'utf8')).toBe('a file')
    await expect(t.deps.projects.create({ name: 'Deep', path: join(root, 'no', 'such'), newFolder: 'x' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(t.deps.projects.create({ name: 'Bad', path: root, newFolder: '../escape' })).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('a duplicate path is 409 exists, and a folder created by the call is removed again', async () => {
    const { t, root } = await setup()
    const first = await t.deps.projects.create({ name: 'First', path: root, newFolder: 'dup' })
    await expect(t.deps.projects.create({ name: 'Second', path: first.path })).rejects.toMatchObject({ code: 'conflict', message: PROJECT_EXISTS_MESSAGE, details: { reason: 'exists' } })
    // The folder is gone on disk, but the project still uses the path: the new folder is created, then removed again.
    await rmdir(first.path)
    await expect(t.deps.projects.create({ name: 'Third', path: root, newFolder: 'dup' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect(existsSync(first.path)).toBe(false)
    expect(await t.deps.projects.list()).toHaveLength(1)
  })

  it('missing 404; a file, a folder outside the roots and /etc are 400 on path', async () => {
    const { t, root } = await setup()
    await expect(t.deps.projects.create({ name: 'Missing', path: join(root, 'missing') })).rejects.toMatchObject({ code: 'not_found' })
    const dangling = join(root, 'dangling')
    await symlink(join(root, 'nowhere'), dangling)
    await expect(t.deps.projects.create({ name: 'Dangling', path: dangling })).rejects.toMatchObject({ code: 'not_found' })
    await writeFile(join(root, 'file.txt'), 'x')
    await expect(t.deps.projects.create({ name: 'File', path: join(root, 'file.txt') })).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
    const outside = await tempFolder()
    for (const path of [outside, '/etc']) {
      await expect(t.deps.projects.create({ name: 'Out', path })).rejects.toMatchObject({
        code: 'validation_error',
        message: OUTSIDE_ROOTS_MESSAGE,
        details: { issues: [{ path: ['path'], message: OUTSIDE_ROOTS_MESSAGE }] },
      })
    }
    await expect(t.deps.projects.create({ name: 'Rel', path: 'relative/path' })).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
    await expect(t.deps.projects.create({ name: '', path: root })).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('a folder that equals, contains or sits inside the data dir is refused; the default root subtree is fine', async () => {
    const parent = await tempFolder()
    const dataDir = join(parent, 'data')
    await mkdir(dataDir)
    const { t } = await setup({ dataDir, workspaceRoots: [parent] })
    const inside = (message: string) => ({ code: 'validation_error', message, details: { issues: [{ path: ['path'] }] } })
    await expect(t.deps.projects.create({ name: 'Parent', path: parent })).rejects.toMatchObject(inside(CONTAINS_DATA_DIR_MESSAGE))
    await expect(t.deps.projects.create({ name: 'Data', path: dataDir })).rejects.toMatchObject(inside(CONTAINS_DATA_DIR_MESSAGE))
    await expect(t.deps.projects.create({ name: 'Files', path: t.env.paths.files })).rejects.toMatchObject(inside(INSIDE_DATA_DIR_MESSAGE))
    // A new folder inside the data dir is refused before it is created.
    await expect(t.deps.projects.create({ name: 'New', path: dataDir, newFolder: 'sneaky' })).rejects.toMatchObject({ code: 'validation_error' })
    expect(existsSync(join(dataDir, 'sneaky'))).toBe(false)
    // A new folder next to the data dir (inside a root that contains it) is fine.
    expect((await t.deps.projects.create({ name: 'Sibling', path: parent, newFolder: 'sibling' })).path).toBe(join(parent, 'sibling'))
    const workspace = await folder(t.env.paths.workspaces, 'demo')
    expect((await t.deps.projects.create({ name: 'Default', path: workspace })).path).toBe(workspace)
  })

  it('refuses more than LIMITS.projectsMax projects', async () => {
    const { t, root } = await setup()
    const at = Date.now()
    const rows = Array.from({ length: LIMITS.projectsMax }, (_, index) => ({ id: createProjectId(), name: `P${index}`, path: `/nowhere/p${index}`, createdAt: at, updatedAt: at }))
    for (let index = 0; index < rows.length; index += 50)
      await t.db.insert(projects).values(rows.slice(index, index + 50))
    await expect(t.deps.projects.create({ name: 'One more', path: root, newFolder: 'more' })).rejects.toMatchObject({ code: 'validation_error', message: PROJECTS_MAX_MESSAGE, details: { issues: [{ path: ['path'] }] } })
    expect(existsSync(join(root, 'more'))).toBe(false)
  })
})

describe('project service: summaries', () => {
  it('list: sorted by name, chat counts from one grouped query, available / issue, instructionsFile', async () => {
    const { t, root } = await setup()
    const zeta = await t.deps.projects.create({ name: 'zeta', path: await folder(root, 'zeta', { 'CLAUDE.md': 'claude' }) })
    const alpha = await t.deps.projects.create({ name: 'Alpha', path: await folder(root, 'alpha', { 'AGENTS.md': 'a', 'CLAUDE.md': 'c' }) })
    const beta = await t.deps.projects.create({ name: 'beta', path: await folder(root, 'beta') })
    await addChat(t, CHAT_A, alpha.id)
    await addChat(t, CHAT_B, alpha.id, true)
    await addChat(t, CHAT_C, null)
    await rm(beta.path, { recursive: true })

    const list = await t.deps.projects.list()
    expect(listResponseSchema(projectSummarySchema).parse({ items: list }).items).toEqual(list)
    expect(list.map(project => [project.name, project.chatCount, project.available, project.issue, project.instructionsFile])).toEqual([
      ['Alpha', 2, true, null, 'AGENTS.md'],
      ['beta', 0, false, FOLDER_MISSING_ISSUE, null],
      ['zeta', 0, true, null, 'CLAUDE.md'],
    ])
    expect(await t.deps.projects.get(alpha.id)).toEqual(list[0])
    expect(await t.deps.projects.get(zeta.id)).toMatchObject({ id: zeta.id, chatCount: 0 })
    await expect(t.deps.projects.get('prj_BBBBBBBBBBBBBBBB')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a project folder replaced by a link or a file, or outside the current roots, is not available', async () => {
    const { t, root } = await setup()
    const linked = await t.deps.projects.create({ name: 'Linked', path: await folder(root, 'linked') })
    const filed = await t.deps.projects.create({ name: 'Filed', path: await folder(root, 'filed') })
    await rename(linked.path, join(root, 'linked-real'))
    await symlink(join(root, 'linked-real'), linked.path)
    await rmdir(filed.path)
    await writeFile(filed.path, 'now a file')
    const outside = await tempFolder()
    const at = Date.now()
    const foreignId = createProjectId()
    await t.db.insert(projects).values({ id: foreignId, name: 'Foreign', path: outside, createdAt: at, updatedAt: at })
    expect(await t.deps.projects.get(linked.id)).toMatchObject({ available: false, issue: FOLDER_REPLACED_ISSUE, instructionsFile: null })
    expect(await t.deps.projects.get(filed.id)).toMatchObject({ available: false, issue: FOLDER_NOT_DIRECTORY_ISSUE })
    expect(await t.deps.projects.get(foreignId)).toMatchObject({ available: false, issue: FOLDER_OUTSIDE_ROOTS_ISSUE })
  })
})

describe('project service: update and remove', () => {
  it('update: name and instructions (null or empty removes them); the path never changes', async () => {
    const { t, root, events } = await setup()
    const project = await t.deps.projects.create({ name: 'Alpha', path: await folder(root, 'alpha') })
    events.clear()
    const renamed = await t.deps.projects.update(project.id, { name: 'Alpha 2', instructions: 'Be brief.' })
    expect(renamed).toMatchObject({ id: project.id, name: 'Alpha 2', instructions: 'Be brief.', path: project.path })
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(project.updatedAt)
    expect((await t.deps.projects.update(project.id, { instructions: '' })).instructions).toBeNull()
    await t.deps.projects.update(project.id, { instructions: 'again' })
    expect((await t.deps.projects.update(project.id, { instructions: null })).instructions).toBeNull()
    expect(events.ofType('project.changed').map(event => event.data.project?.name)).toEqual(['Alpha 2', 'Alpha 2', 'Alpha 2', 'Alpha 2'])
    await expect(t.deps.projects.update(project.id, { path: '/elsewhere' } as never)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(t.deps.projects.update(project.id, {} as never)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(t.deps.projects.update('prj_BBBBBBBBBBBBBBBB', { name: 'x' })).rejects.toMatchObject({ code: 'not_found' })
    expect((await t.deps.projects.get(project.id)).path).toBe(project.path)
  })

  it('remove: 409 while a chat of the project runs; then detaches its chats, keeps the folder, one event', async () => {
    const { t, root, events, runs } = await setup()
    const project = await t.deps.projects.create({ name: 'Doomed', path: await folder(root, 'doomed', { 'keep.txt': 'still here' }) })
    const other = await t.deps.projects.create({ name: 'Other', path: await folder(root, 'other') })
    await addChat(t, CHAT_A, project.id)
    await addChat(t, CHAT_B, project.id, true)
    await addChat(t, CHAT_C, other.id)

    runs.phases.set(CHAT_B, 'preparing')
    await expect(t.deps.projects.remove(project.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId: CHAT_B } })
    // A run in another project does not block.
    runs.phases.delete(CHAT_B)
    runs.phases.set(CHAT_C, 'streaming')

    events.clear()
    await t.deps.projects.remove(project.id)
    expect(events.events.map(event => [event.type, event.data])).toEqual([['project.changed', { id: project.id, project: null }]])
    const rows = await t.db.select({ id: chats.id, projectId: chats.projectId }).from(chats)
    expect(Object.fromEntries(rows.map(row => [row.id, row.projectId]))).toEqual({ [CHAT_A]: null, [CHAT_B]: null, [CHAT_C]: other.id })
    expect(await readFile(join(project.path, 'keep.txt'), 'utf8')).toBe('still here')
    expect(await t.db.select().from(projects).where(eq(projects.id, project.id))).toEqual([])
    await expect(t.deps.projects.remove(project.id)).rejects.toMatchObject({ code: 'not_found' })
    expect((await t.deps.projects.list()).map(item => item.id)).toEqual([other.id])
  })

  it('outputStyle (Phase 11): null by default, any valid style name stored (unknown ones too), null clears it', async () => {
    const { t, root, events } = await setup()
    const project = await t.deps.projects.create({ name: 'Styled', path: await folder(root, 'styled') })
    expect(project.outputStyle).toBeNull()
    events.clear()
    const styled = await t.deps.projects.update(project.id, { outputStyle: 'learning' })
    expect(projectSummarySchema.parse(styled)).toMatchObject({ outputStyle: 'learning', name: 'Styled' })
    expect((await t.db.select({ outputStyle: projects.outputStyle }).from(projects).where(eq(projects.id, project.id)))).toEqual([{ outputStyle: 'learning' }])
    // A style no catalog knows is accepted: it falls back to `default` at run time with a notice.
    expect((await t.deps.projects.update(project.id, { outputStyle: 'not-installed-yet' })).outputStyle).toBe('not-installed-yet')
    expect((await t.deps.projects.list()).find(item => item.id === project.id)?.outputStyle).toBe('not-installed-yet')
    // Other updates keep it; null clears it.
    expect((await t.deps.projects.update(project.id, { name: 'Styled 2' })).outputStyle).toBe('not-installed-yet')
    expect((await t.deps.projects.update(project.id, { outputStyle: null })).outputStyle).toBeNull()
    expect((await t.deps.projects.get(project.id)).outputStyle).toBeNull()
    expect(events.ofType('project.changed').map(event => event.data.project?.outputStyle)).toEqual(['learning', 'not-installed-yet', 'not-installed-yet', null])
    // Not a style name: 400, nothing changes.
    for (const outputStyle of ['Learning', '', 'x'.repeat(65), 'two words'])
      await expect(t.deps.projects.update(project.id, { outputStyle })).rejects.toMatchObject({ code: 'validation_error' })
    expect((await t.deps.projects.get(project.id)).outputStyle).toBeNull()
  })

  it('remove (Phase 11): the trust approvals of the project go with it (foreign key cascade); other projects keep theirs', async () => {
    const { t, root, events } = await setup()
    const project = await t.deps.projects.create({ name: 'Trusted', path: await folder(root, 'trusted') })
    const other = await t.deps.projects.create({ name: 'Other', path: await folder(root, 'other') })
    const at = Date.now()
    await t.db.insert(projectTrust).values([
      { projectId: project.id, sha256: 'a'.repeat(64), kind: 'hook', label: 'PreToolUse: sh check.sh', createdAt: at },
      { projectId: project.id, sha256: 'b'.repeat(64), kind: 'mcp', label: 'docs', createdAt: at },
      { projectId: other.id, sha256: 'a'.repeat(64), kind: 'hook', label: 'PreToolUse: sh check.sh', createdAt: at },
    ])
    events.clear()
    await t.deps.projects.remove(project.id)
    // The event the project MCP manager and the hook service follow (open point 8).
    expect(events.events.map(event => [event.type, event.data])).toEqual([['project.changed', { id: project.id, project: null }]])
    expect(await t.db.select({ projectId: projectTrust.projectId, kind: projectTrust.kind }).from(projectTrust)).toEqual([{ projectId: other.id, kind: 'hook' }])
  })
})

describe('project service: browse', () => {
  it('without a path: the roots only', async () => {
    const extra = await tempFolder()
    const { t } = await setup({ workspaceRoots: [extra] })
    expect(await t.deps.projects.browse()).toEqual({ path: null, parent: null, roots: [{ path: extra, available: true }], entries: [], truncated: false })
    await rm(extra, { recursive: true })
    expect((await t.deps.projects.browse()).roots).toEqual([{ path: extra, available: false }])
  })

  it('lists subfolders only: dot folders, node_modules, files and links hidden; sorted; projectId; parent', async () => {
    const { t, root } = await setup()
    const apps = await folder(root, 'apps')
    for (const name of ['b-app', 'A-app', 'app10', 'app2', '.git', '.hidden', 'node_modules'])
      await mkdir(join(apps, name))
    await writeFile(join(apps, 'readme.md'), 'x')
    await symlink(join(apps, 'b-app'), join(apps, 'link-to-b'))
    const used = await t.deps.projects.create({ name: 'B', path: join(apps, 'b-app') })

    const result = await t.deps.projects.browse(apps)
    expect(projectBrowseSchema.parse(result)).toEqual(result)
    expect(result).toMatchObject({ path: apps, parent: root, roots: [{ path: root, available: true }], truncated: false })
    expect(result.entries).toEqual([
      { name: 'A-app', path: join(apps, 'A-app'), projectId: null },
      { name: 'app2', path: join(apps, 'app2'), projectId: null },
      { name: 'app10', path: join(apps, 'app10'), projectId: null },
      { name: 'b-app', path: join(apps, 'b-app'), projectId: used.id },
    ])
    expect((await t.deps.projects.browse(root))).toMatchObject({ path: root, parent: null, entries: [{ name: 'apps' }] })
    // A link to a folder inside the root is browsed at its realpath.
    await symlink(apps, join(root, 'apps-link'))
    expect((await t.deps.projects.browse(join(root, 'apps-link'))).path).toBe(apps)
  })

  it('containment: outside the roots and /etc are 400, missing 404, a file 400', async () => {
    const { t, root } = await setup()
    const outside = await tempFolder()
    for (const path of [outside, '/etc'])
      await expect(t.deps.projects.browse(path)).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
    await expect(t.deps.projects.browse(join(root, 'missing'))).rejects.toMatchObject({ code: 'not_found' })
    await writeFile(join(root, 'file.txt'), 'x')
    await expect(t.deps.projects.browse(join(root, 'file.txt'))).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('a root that contains the data dir is browsed with the data dir hidden; inside the data dir is 400', async () => {
    const parent = await tempFolder()
    const dataDir = join(parent, 'data')
    await mkdir(dataDir)
    await mkdir(join(parent, 'code'))
    const { t } = await setup({ dataDir, workspaceRoots: [parent] })
    expect((await t.deps.projects.browse(parent)).entries.map(entry => entry.name)).toEqual(['code'])
    await expect(t.deps.projects.browse(dataDir)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(t.deps.projects.browse(t.env.paths.plugins)).rejects.toMatchObject({ code: 'validation_error', message: INSIDE_DATA_DIR_MESSAGE })
  })

  it(`caps the entries at LIMITS.browseEntriesMax (${LIMITS.browseEntriesMax}) with truncated`, async () => {
    const { t, root } = await setup()
    const many = await folder(root, 'many')
    const names = Array.from({ length: LIMITS.browseEntriesMax + 5 }, (_, index) => `d${String(index).padStart(4, '0')}`)
    await Promise.all(names.map(name => mkdir(join(many, name))))
    const result = await t.deps.projects.browse(many)
    expect(result.truncated).toBe(true)
    expect(result.entries).toHaveLength(LIMITS.browseEntriesMax)
    expect(result.entries.at(-1)?.name).toBe(names[LIMITS.browseEntriesMax - 1])
  })
})

describe('project service: openWorkspace', () => {
  it('opens an available folder with its instructions and project file, read again on every call', async () => {
    const { t, root } = await setup()
    const project = await t.deps.projects.create({ name: 'Demo', path: await folder(root, 'demo', { 'CLAUDE.md': '@AGENT.md\n', 'AGENT.md': 'Use tabs.\n' }) })
    await t.deps.projects.update(project.id, { instructions: 'Be careful.' })
    const opened = await t.deps.projects.openWorkspace(project.id)
    expect(opened).toEqual({
      ok: true,
      workspace: {
        projectId: project.id,
        name: 'Demo',
        root: project.path,
        instructions: 'Be careful.',
        projectFile: { name: 'CLAUDE.md', content: 'Use tabs.\n', truncated: false },
      },
    })
    await writeFile(join(project.path, 'AGENTS.md'), 'x'.repeat(LIMITS.projectFileBytes + 1))
    const again = await t.deps.projects.openWorkspace(project.id)
    expect(again.ok && again.workspace.projectFile).toMatchObject({ name: 'AGENTS.md', truncated: true })
    expect(again.ok && again.workspace.projectFile?.content.endsWith(PROJECT_FILE_TRUNCATED_MARKER)).toBe(true)
  })

  it('an unknown project, a deleted, moved or replaced folder is not available (never throws)', async () => {
    const { t, root } = await setup()
    expect(await t.deps.projects.openWorkspace('prj_AAAAAAAAAAAAAAAA')).toEqual({ ok: false, name: null, message: PROJECT_GONE_MESSAGE })

    const deleted = await t.deps.projects.create({ name: 'Deleted', path: await folder(root, 'deleted') })
    await rm(deleted.path, { recursive: true })
    expect(await t.deps.projects.openWorkspace(deleted.id)).toEqual({ ok: false, name: 'Deleted', message: folderUnavailableMessage(deleted.path, FOLDER_MISSING_ISSUE) })
    expect(folderUnavailableMessage(deleted.path, FOLDER_MISSING_ISSUE)).toBe(`The project folder ${deleted.path} is not available: The folder does not exist.`)

    const moved = await t.deps.projects.create({ name: 'Moved', path: await folder(root, 'moved') })
    await rename(moved.path, join(root, 'moved-away'))
    expect(await t.deps.projects.openWorkspace(moved.id)).toMatchObject({ ok: false, name: 'Moved', message: folderUnavailableMessage(moved.path, FOLDER_MISSING_ISSUE) })

    const replaced = await t.deps.projects.create({ name: 'Replaced', path: await folder(root, 'replaced') })
    await rmdir(replaced.path)
    await symlink(await folder(root, 'elsewhere'), replaced.path)
    expect(await t.deps.projects.openWorkspace(replaced.id)).toMatchObject({ ok: false, name: 'Replaced', message: folderUnavailableMessage(replaced.path, FOLDER_REPLACED_ISSUE) })

    // Back in place: available again.
    await rm(replaced.path)
    await mkdir(replaced.path)
    expect(await t.deps.projects.openWorkspace(replaced.id)).toMatchObject({ ok: true, workspace: { root: replaced.path, projectFile: null } })
  })

  it('a stored folder outside the current roots (HF_WORKSPACE_ROOTS changed) is not available', async () => {
    const { t } = await setup()
    const outside = await tempFolder()
    const at = Date.now()
    const id = createProjectId()
    await t.db.insert(projects).values({ id, name: 'Old root', path: outside, createdAt: at, updatedAt: at })
    expect(await t.deps.projects.openWorkspace(id)).toEqual({ ok: false, name: 'Old root', message: folderUnavailableMessage(outside, FOLDER_OUTSIDE_ROOTS_ISSUE) })
  })
})
