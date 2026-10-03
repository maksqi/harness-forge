import type { TestApp } from './create-test-app.ts'
import type { FakeProjectService } from './fake-projects.ts'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS, projectBrowseSchema, projectSummarySchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from './create-test-app.ts'
import { createFakeProjectService, FAKE_PROJECT_FILE_TRUNCATED } from './fake-projects.ts'
import { createFakeChatRunner, createRecordingEventBus } from './fakes.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

const CHAT_A = '0199a8f0-0000-7000-8000-0000000000a1'
const CHAT_B = '0199a8f0-0000-7000-8000-0000000000a2'

async function setup(options: Parameters<typeof createTestApp>[0] = {}): Promise<{ t: TestApp, projects: FakeProjectService, events: ReturnType<typeof createRecordingEventBus>, runs: ReturnType<typeof createFakeChatRunner> }> {
  const events = createRecordingEventBus()
  const runs = createFakeChatRunner()
  const t = await createTestApp({ ...options, factories: { projects: createFakeProjectService, ...options.factories }, overrides: { events, runs, ...options.overrides } })
  cleanups.push(() => t.close())
  return { t, projects: t.deps.projects as FakeProjectService, events, runs }
}

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('fake project service: add and openWorkspace', () => {
  it('adds a project with a real folder below the default root and opens it', async () => {
    const { t, projects, events } = await setup()
    const project = await projects.add({ name: 'Demo App', instructions: 'Use tabs.' })
    expect(projectSummarySchema.parse(project)).toEqual(project)
    expect(project).toMatchObject({ name: 'Demo App', instructions: 'Use tabs.', available: true, issue: null, instructionsFile: null, chatCount: 0 })
    expect(project.path.startsWith(`${await realpath(t.env.paths.workspaces)}/`)).toBe(true)
    expect(await realpath(project.path)).toBe(project.path)
    expect(events.ofType('project.changed').map(event => event.data)).toEqual([{ id: project.id, project }])

    const opened = await t.deps.projects.openWorkspace(project.id)
    expect(opened).toEqual({
      ok: true,
      workspace: { projectId: project.id, name: 'Demo App', root: project.path, instructions: 'Use tabs.', projectFile: null },
    })
    expect(projects.opened).toEqual([project.id])
  })

  it('reads AGENTS.md before CLAUDE.md, falls back to CLAUDE.md, cuts at LIMITS.projectFileBytes', async () => {
    const { t, projects } = await setup()
    const both = await projects.add({ files: { 'AGENTS.md': 'agents rules', 'CLAUDE.md': 'claude rules' } })
    expect(both.instructionsFile).toBe('AGENTS.md')
    expect(await t.deps.projects.openWorkspace(both.id)).toMatchObject({ ok: true, workspace: { projectFile: { name: 'AGENTS.md', content: 'agents rules', truncated: false } } })
    const claude = await projects.add({ files: { 'CLAUDE.md': '@AGENT.md' } })
    expect(await t.deps.projects.openWorkspace(claude.id)).toMatchObject({ ok: true, workspace: { projectFile: { name: 'CLAUDE.md', content: '@AGENT.md' } } })
    const long = await projects.add({ files: { 'AGENTS.md': 'x'.repeat(LIMITS.projectFileBytes + 10) } })
    const opened = await t.deps.projects.openWorkspace(long.id)
    expect(opened.ok && opened.workspace.projectFile).toMatchObject({ truncated: true, content: `${'x'.repeat(LIMITS.projectFileBytes)}${FAKE_PROJECT_FILE_TRUNCATED}` })
  })

  it('an unknown project or a moved / deleted folder is not available (never throws)', async () => {
    const { t, projects } = await setup()
    expect(await t.deps.projects.openWorkspace('prj_AAAAAAAAAAAAAAAA')).toEqual({ ok: false, name: null, message: 'The project of this chat no longer exists.' })
    const moved = await projects.add({ name: 'Moved' })
    await rename(moved.path, `${moved.path}-elsewhere`)
    expect(await t.deps.projects.openWorkspace(moved.id)).toEqual({ ok: false, name: 'Moved', message: `The project folder ${moved.path} is not available: The folder no longer exists.` })
    expect(await t.deps.projects.get(moved.id)).toMatchObject({ available: false, issue: 'The folder no longer exists.' })
  })

  it('uses the first explicit root when HF_WORKSPACE_ROOTS is set', async () => {
    const root = await tempFolder()
    const { projects } = await setup({ workspaceRoots: [root] })
    expect(await projects.roots()).toEqual([root])
    expect((await projects.add()).path.startsWith(`${root}/`)).toBe(true)
  })
})

describe('fake project service: the HTTP-facing members', () => {
  it('create: fresh auth first, folder inside a root, newFolder created, duplicates refused (and the new folder removed)', async () => {
    const { t, projects, events } = await setup()
    await projects.start()
    const root = await realpath(t.env.paths.workspaces)
    const existing = join(root, 'existing')
    await mkdir(existing)
    const freshAuth: string[] = []
    const created = await t.deps.projects.create({ name: 'Existing', path: existing }, { requireFreshAuth: () => void freshAuth.push('checked') })
    expect(freshAuth).toEqual(['checked'])
    expect(created).toMatchObject({ name: 'Existing', path: existing })
    expect(events.ofType('project.changed')).toHaveLength(1)

    const fresh = await t.deps.projects.create({ name: 'Fresh', path: root, newFolder: 'fresh-app' })
    expect(fresh.path).toBe(join(root, 'fresh-app'))
    expect(existsSync(fresh.path)).toBe(true)
    await expect(t.deps.projects.create({ name: 'Again', path: root, newFolder: 'fresh-app' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists' } })

    await expect(t.deps.projects.create({ name: 'Dup', path: existing })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    await expect(t.deps.projects.create({ name: 'Bad', path: join(root, 'missing') })).rejects.toMatchObject({ code: 'not_found' })
    const outside = await tempFolder()
    await expect(t.deps.projects.create({ name: 'Out', path: outside })).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
    await expect(t.deps.projects.create({ name: '', path: existing })).rejects.toMatchObject({ code: 'validation_error' })
    // A refused fresh auth writes nothing.
    await expect(t.deps.projects.create({ name: 'No', path: root, newFolder: 'never' }, { requireFreshAuth: () => {
      throw new Error('not fresh')
    } })).rejects.toThrow('not fresh')
    expect(existsSync(join(root, 'never'))).toBe(false)
  })

  it('list sorted by name with chat counts; get; update', async () => {
    const { t, projects, events } = await setup()
    const zeta = await projects.add({ name: 'Zeta' })
    const alpha = await projects.add({ name: 'Alpha' })
    await t.deps.chats.ensure(CHAT_A, { projectId: alpha.id })
    await t.deps.chats.ensure(CHAT_B, { projectId: alpha.id })
    expect((await t.deps.chats.find(CHAT_A))?.projectId).toBe(alpha.id)
    expect((await t.deps.projects.list()).map(project => [project.name, project.chatCount])).toEqual([['Alpha', 2], ['Zeta', 0]])
    expect(await t.deps.projects.get(zeta.id)).toMatchObject({ id: zeta.id, chatCount: 0 })
    await expect(t.deps.projects.get('prj_BBBBBBBBBBBBBBBB')).rejects.toMatchObject({ code: 'not_found' })

    events.clear()
    const renamed = await t.deps.projects.update(alpha.id, { name: 'Alpha 2', instructions: 'Be brief.' })
    expect(renamed).toMatchObject({ name: 'Alpha 2', instructions: 'Be brief.', path: alpha.path, chatCount: 2 })
    expect((await t.deps.projects.update(alpha.id, { instructions: '' })).instructions).toBeNull()
    expect(events.ofType('project.changed')).toHaveLength(2)
    await expect(t.deps.projects.update(alpha.id, {} as never)).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('remove: 409 while a chat of the project runs; otherwise detaches its chats, keeps the folder, one event', async () => {
    const { t, projects, events, runs } = await setup()
    const project = await projects.add({ files: { 'keep.txt': 'still here' } })
    await t.deps.chats.ensure(CHAT_A, { projectId: project.id })
    runs.phases.set(CHAT_A, 'streaming')
    await expect(t.deps.projects.remove(project.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId: CHAT_A } })
    runs.phases.delete(CHAT_A)

    events.clear()
    await t.deps.projects.remove(project.id)
    expect((await t.deps.chats.find(CHAT_A))?.projectId).toBeNull()
    expect(await readdir(project.path)).toEqual(['keep.txt'])
    expect(events.ofType('project.changed').map(event => event.data)).toEqual([{ id: project.id, project: null }])
    await expect(t.deps.projects.remove(project.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('browse: the roots without a path; subfolders with their project ids, dot folders and node_modules hidden', async () => {
    const { t, projects } = await setup()
    await projects.start()
    const root = await realpath(t.env.paths.workspaces)
    expect(projectBrowseSchema.parse(await t.deps.projects.browse())).toEqual({ path: null, parent: null, roots: [{ path: root, available: true }], entries: [], truncated: false })
    const project = await projects.add({ name: 'Web' })
    await mkdir(join(root, 'b-folder', 'inner'), { recursive: true })
    await mkdir(join(root, '.hidden'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'a-file.txt'), 'x')
    const listing = projectBrowseSchema.parse(await t.deps.projects.browse(root))
    expect(listing).toMatchObject({ path: root, parent: null, truncated: false })
    expect(listing.entries).toEqual([
      { name: 'b-folder', path: join(root, 'b-folder'), projectId: null },
      { name: project.path.split('/').at(-1), path: project.path, projectId: project.id },
    ])
    expect(await t.deps.projects.browse(join(root, 'b-folder'))).toMatchObject({ parent: root, entries: [{ name: 'inner' }] })
    const outside = await tempFolder()
    await expect(t.deps.projects.browse(outside)).rejects.toMatchObject({ code: 'validation_error' })
  })
})
