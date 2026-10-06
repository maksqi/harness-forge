// The customization service over real project folders (W10.1-T1 … T7): the merged catalog of a project (`.harness`
// over `.claude` over a personal definition; invalid YAML, a linked file, a linked folder, a 70 KiB file, a binary
// file and a reserved `explore.md` as diagnostics, no linked content anywhere), an unavailable folder, the cache (TTL,
// single flight, `refresh`) and every invalidation trigger with its `customization.changed`, plugin entries (a plugin
// disposed, safe mode), `load` (deleted, renamed, grown past the cap, swapped for a link, a copied entry), `source`,
// `stop`, and the logs (never a body). Project folders are `realpath(mkdtemp())` workspace roots. Phase 11 (W11.6): output
// styles end to end (builtins, `.harness` over `.claude`, reserved and invalid files, personal rows, plugin styles of a
// fake `registry.styles` until their plugin is disposed, `load` / `source`, the invalidation by a style folder change).
import type { Disposable, OutputStyleDefinition } from '@harness-forge/plugin-sdk'
import type { CustomizationChangedData, ProjectSummary } from '@harness-forge/shared'
import type { RegisteredStyle, Registry, RegistryChange, StyleRegistry } from '../../registry/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { AppDeps } from '../../types.ts'
import type { OpenDefinitionFile } from './discover.ts'
import type { CustomizationService } from './types.ts'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { customizationListSchema, HarnessError } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { openWorkspaceFile } from '../../workspace/paths.ts'
import { createCustomizationService, isDefinitionPath, touchesDefinitions } from './index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

const isWindows = process.platform === 'win32'
const CHAT = '0199a8f0-0000-7000-8000-00000000c001'

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

function agent(name: string, description: string, body = `You are ${name}.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    if (error instanceof HarnessError)
      return error
    throw error
  }
  throw new Error('expected a rejection')
}

interface Harness {
  t: TestApp
  project: ProjectSummary
  /** The project folder (canonical). */
  dir: string
  /** Every `customization.changed` payload. */
  events: CustomizationChangedData[]
}

async function open(options: { builtins?: boolean, env?: Record<string, string> } = {}): Promise<Harness> {
  const root = await tempFolder()
  const t = await createTestApp({ ...(options.builtins === true ? {} : { builtins: [] }), workspaceRoots: [root], env: options.env ?? {} })
  cleanups.push(() => t.close())
  const project = await t.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })
  const events: CustomizationChangedData[] = []
  const subscription = t.deps.events.subscribe((event) => {
    if (event.type === 'customization.changed')
      events.push(event.data)
  })
  cleanups.push(() => subscription.dispose())
  return { t, project, dir: join(root, 'demo'), events }
}

interface Instrumented {
  service: CustomizationService
  /** Project ids passed to `openWorkspace` (one per project build, plus `load` / `source`). */
  opened: string[]
  /** Paths opened by the definition reader. */
  files: string[]
  /** The clock of the service. */
  tick: (ms: number) => void
}

/** A second service over the test app's deps with a manual clock, counted project opens and a file-open spy. */
function instrumented(h: Harness, options: { eventIntervalMs?: number, projectOf?: (chatId: string) => string | null } = {}): Instrumented {
  let clock = 1_000_000
  const opened: string[] = []
  const files: string[] = []
  const projects = h.t.deps.projects
  const chats = h.t.deps.chats
  const deps = {
    ...h.t.deps,
    projects: {
      ...projects,
      openWorkspace: async (id: string) => {
        opened.push(id)
        return projects.openWorkspace(id)
      },
    },
    chats: {
      ...chats,
      find: async (chatId: string) => {
        const projectId = options.projectOf?.(chatId) ?? null
        return projectId === null ? null : { ...(await chats.find(chatId)), id: chatId, projectId } as Awaited<ReturnType<typeof chats.find>>
      },
    },
  } as AppDeps
  const openFile: OpenDefinitionFile = async (root, rel) => {
    files.push(rel)
    return openWorkspaceFile(root, rel)
  }
  const service = createCustomizationService(deps, { now: () => clock, openFile, eventIntervalMs: options.eventIntervalMs ?? 1000 })
  cleanups.push(() => service.stop())
  return { service, opened, files, tick: (ms) => {
    clock += ms
  } }
}

describe('the catalog of a project', () => {
  it('merges .harness over .claude over a personal definition; reports every bad file without linked content', async () => {
    const h = await open()
    const outside = await tempFolder()
    await write(outside, { 'evil.md': agent('evil', 'OUTSIDE-MARKER') })
    await write(h.dir, {
      '.claude/agents/a.md': agent('a', 'From claude.'),
      '.harness/agents/a.md': agent('a', 'From harness.'),
      '.harness/agents/broken.md': '---\n[unclosed\n---\nBody\n',
      '.harness/agents/big.md': `${agent('big', 'Big.')}${'x'.repeat(70 * 1024)}`,
      '.harness/agents/bin.md': Buffer.from([45, 45, 45, 10, 0, 1]),
      '.harness/agents/explore.md': agent('explore', 'Mine.'),
      'shared/linked-agents/b.md': agent('b', 'LINKED-FOLDER-MARKER'),
    })
    if (!isWindows) {
      await symlink(join(outside, 'evil.md'), join(h.dir, '.harness/agents/evil.md'))
      await symlink(join(h.dir, 'shared/linked-agents'), join(h.dir, '.claude/skills'))
    }
    await h.t.deps.customizations.create({ kind: 'agent', content: agent('a', 'Personal.') })
    const list = await h.t.deps.customizations.list({ projectId: h.project.id, kind: 'agent' })
    expect(customizationListSchema.safeParse(list).success).toBe(true)
    const named = list.items.filter(entry => entry.name === 'a')
    expect(named.map(entry => [entry.source, entry.path ?? null, entry.state, entry.description])).toEqual([
      ['project', '.harness/agents/a.md', 'active', 'From harness.'],
      ['project', '.claude/agents/a.md', 'shadowed', 'From claude.'],
      ['user', null, 'shadowed', 'Personal.'],
    ])
    const codes = Object.fromEntries(list.items.filter(entry => entry.state === 'invalid').map(entry => [entry.path, entry.diagnostics.map(item => item.code)]))
    expect(codes).toEqual({
      '.harness/agents/big.md': ['too-large'],
      '.harness/agents/bin.md': ['binary'],
      '.harness/agents/broken.md': ['invalid-frontmatter'],
      '.harness/agents/explore.md': ['reserved-name'],
    })
    expect(list.project).toMatchObject({ id: h.project.id, available: true, folders: ['.claude/agents', '.harness/agents'] })
    if (!isWindows) {
      expect(list.diagnostics.map(item => [item.code, item.path])).toEqual([['link', '.claude/skills'], ['link', '.harness/agents/evil.md']])
      const answer = JSON.stringify(list)
      for (const marker of ['OUTSIDE-MARKER', 'LINKED-FOLDER-MARKER', outside, h.dir])
        expect(answer).not.toContain(marker)
    }
    // The run snapshot resolves the winner; the builtins stay.
    const catalog = await h.t.deps.customizations.catalog(h.project.id)
    expect(catalog.agent('a')?.path).toBe('.harness/agents/a.md')
    expect(catalog.agents().map(entry => entry.name)).toEqual(['a', 'explore', 'general'])
    expect(catalog.agent('explore')?.source).toBe('builtin')
  })

  it('an unknown project is 404 for list but never fails the catalog; an unavailable folder lists no project entries', async () => {
    const h = await open()
    await expect(h.t.deps.customizations.list({ projectId: 'prj_ZZZZZZZZZZZZZZZZ' })).rejects.toMatchObject({ code: 'not_found' })
    const unknown = await h.t.deps.customizations.catalog('prj_ZZZZZZZZZZZZZZZZ')
    expect(unknown.project).toMatchObject({ id: 'prj_ZZZZZZZZZZZZZZZZ', available: false })
    expect(unknown.agents().map(entry => entry.name)).toEqual(['explore', 'general'])

    await write(h.dir, { '.harness/agents/a.md': agent('a', 'A.') })
    await rm(h.dir, { recursive: true, force: true })
    const list = await h.t.deps.customizations.list({ projectId: h.project.id, refresh: true })
    expect(list.project).toMatchObject({ available: false, folders: [] })
    expect(list.project?.issue).toMatch(/is not available/)
    expect(list.diagnostics).toEqual([{ level: 'warning', code: 'project-unavailable', message: 'The project folder is not available; its definitions are not listed.' }])
    expect(list.items.filter(entry => entry.source === 'project')).toEqual([])
  })

  it('lists plugin agents, skills and commands until the plugin is disposed; refresh sees new files at once', async () => {
    const h = await open()
    const agentRegistration = h.t.deps.registry.agents.register('acme', { name: 'helper', description: 'Helps.', instructions: 'Help.' })
    h.t.deps.registry.skills.register('acme', { name: 'pdf', description: 'PDFs.', content: 'Read PDFs.' })
    const command = h.t.deps.registry.commands.register('acme', { name: 'greet', description: 'Greets.', template: 'Hello {{input}}' })
    await write(h.dir, { '.harness/commands/greet.md': '---\ndescription: Project greeting.\n---\nHi $ARGUMENTS' })
    const catalog = await h.t.deps.customizations.catalog(h.project.id)
    expect(catalog.agent('helper')).toMatchObject({ source: 'plugin', pluginId: 'acme' })
    expect(catalog.skill('pdf')).toMatchObject({ source: 'plugin', pluginId: 'acme' })
    expect(catalog.command('greet')).toMatchObject({ source: 'project' })
    expect(catalog.entries.find(entry => entry.kind === 'command' && entry.source === 'plugin')).toMatchObject({ name: 'greet', state: 'shadowed', shadowedBy: { source: 'project', path: '.harness/commands/greet.md' } })
    // The global catalog has no project entries: the plugin command is active there.
    expect((await h.t.deps.customizations.catalog(null)).command('greet')).toMatchObject({ source: 'plugin' })

    agentRegistration.dispose()
    command.dispose()
    const after = await h.t.deps.customizations.catalog(h.project.id)
    expect(after.agent('helper')).toBeNull()
    expect(after.entries.filter(entry => entry.source === 'plugin').map(entry => entry.name)).toEqual(['pdf'])

    await write(h.dir, { '.harness/agents/new.md': agent('new', 'New.') })
    expect((await h.t.deps.customizations.catalog(h.project.id)).agent('new')).toBeNull()
    expect((await h.t.deps.customizations.catalog(h.project.id, { refresh: true })).agent('new')).toMatchObject({ source: 'project' })
  })

  it('in safe mode lists no plugin entries but the builtin plugins (core-commands)', async () => {
    const h = await open({ builtins: true, env: { HF_SAFE_MODE: '1' } })
    h.t.deps.registry.agents.register('acme', { name: 'helper', description: 'Helps.', instructions: 'Help.' })
    const catalog = await h.t.deps.customizations.catalog(null)
    expect(catalog.agent('helper')).toBeNull()
    expect(catalog.command('review')).toMatchObject({ source: 'plugin', pluginId: 'core-commands' })
    await expect(h.t.deps.customizations.source({ kind: 'agent', name: 'helper', source: 'plugin' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('checks tool names against the registry and model refs against the configured providers (warnings only)', async () => {
    const bare = await open()
    await write(bare.dir, { '.harness/agents/a.md': '---\nname: a\ndescription: A.\ntools: Read\nmodel: mock:echo\n---\nBody' })
    const unchecked = (await bare.t.deps.customizations.catalog(bare.project.id)).agent('a')!
    expect(unchecked.state).toBe('active')
    expect(unchecked.diagnostics.map(item => [item.code, item.message])).toEqual([
      ['unknown-tool', 'Unknown tool: read_file; it matches nothing.'],
      ['invalid-model', 'The provider "mock" is not configured; the default sub-agent model is used.'],
    ])
    const full = await open({ builtins: true, env: { HF_MOCK_PROVIDER: '1' } })
    await write(full.dir, { '.harness/agents/a.md': '---\nname: a\ndescription: A.\ntools: Read, Task\nmodel: mock:echo\n---\nBody' })
    const checked = (await full.t.deps.customizations.catalog(full.project.id)).agent('a')!
    expect(checked.diagnostics.map(item => item.code)).toEqual(['unknown-tool'])
    expect(checked.diagnostics[0]!.message).toBe('Unknown tool: Task; it matches nothing.')
  })
})

describe('the cache and its invalidation', () => {
  it('serves a project catalog for 10 s from one build (single flight); refresh rebuilds at once', async () => {
    const h = await open()
    const s = instrumented(h)
    const [a, b] = await Promise.all([s.service.catalog(h.project.id), s.service.catalog(h.project.id)])
    expect(a).toBe(b)
    expect(s.opened).toEqual([h.project.id])
    s.tick(9_999)
    expect(await s.service.catalog(h.project.id)).toBe(a)
    s.tick(1)
    const rebuilt = await s.service.catalog(h.project.id)
    expect(rebuilt).not.toBe(a)
    expect(s.opened).toHaveLength(2)
    await s.service.catalog(h.project.id, { refresh: true })
    expect(s.opened).toHaveLength(3)
    // Nothing changed on disk: a rebuild announces nothing.
    expect(h.events).toEqual([])
  })

  it('drops a project catalog on workspace.changed of its definition folders, project.changed and run.finished', async () => {
    const h = await open()
    const s = instrumented(h, { projectOf: chatId => (chatId === CHAT ? h.project.id : null) })
    const project = h.project.id
    const event = (type: 'workspace.changed', paths: string[]) => h.t.deps.events.emit(type, { projectId: project, chatId: null, batchId: null, source: 'tool', paths })

    await s.service.catalog(project)
    event('workspace.changed', ['src/index.ts'])
    await s.service.catalog(project)
    expect(s.opened).toHaveLength(1)
    expect(h.events).toEqual([])

    event('workspace.changed', ['.harness/agents/x.md'])
    expect(h.events).toEqual([{ projectId: project }])
    await s.service.catalog(project)
    expect(s.opened).toHaveLength(2)

    s.tick(1001)
    h.t.deps.events.emit('project.changed', { id: project, project: h.project })
    expect(h.events).toHaveLength(2)
    await s.service.catalog(project)
    expect(s.opened).toHaveLength(3)

    s.tick(1001)
    h.t.deps.events.emit('run.finished', { chatId: CHAT, messageId: 'msg_AAAAAAAAAAAAAAAAAAAAAA', outcome: 'completed', awaitingApproval: false })
    await vi.waitFor(() => expect(h.events).toHaveLength(3))
    expect(h.events.at(-1)).toEqual({ projectId: project })
    await s.service.catalog(project)
    expect(s.opened).toHaveLength(4)

    // A project nobody cached announces nothing.
    h.t.deps.events.emit('project.changed', { id: 'prj_ZZZZZZZZZZZZZZZZ', project: null })
    expect(h.events).toHaveLength(3)
  })

  it('coalesces the project announcements to one per interval (a trailing one)', async () => {
    const h = await open()
    const s = instrumented(h, { eventIntervalMs: 30 })
    const project = h.project.id
    await s.service.catalog(project)
    s.service.invalidate(project)
    await s.service.catalog(project)
    s.service.invalidate(project)
    await s.service.catalog(project)
    s.service.invalidate(project)
    expect(h.events).toEqual([{ projectId: project }])
    await vi.waitFor(() => expect(h.events).toEqual([{ projectId: project }, { projectId: project }]))
  })

  it('announces a project when a rebuild finds other files', async () => {
    const h = await open()
    const s = instrumented(h)
    await s.service.catalog(h.project.id)
    await write(h.dir, { '.harness/skills/pdf/SKILL.md': '---\ndescription: PDFs.\n---\nRead PDFs.' })
    await s.service.catalog(h.project.id, { refresh: true })
    expect(h.events).toEqual([{ projectId: h.project.id }])
  })

  it('drops every catalog on registry changes of agents, skills and commands ({}) and on personal changes ({ kind, id })', async () => {
    const h = await open()
    const s = instrumented(h)
    await s.service.catalog(h.project.id)
    await s.service.catalog(null)
    const registration = h.t.deps.registry.commands.register('acme', { name: 'hello', description: 'Hello.', template: 'Hi' })
    expect(h.events).toEqual([{}])
    expect((await s.service.catalog(h.project.id)).command('hello')).toMatchObject({ source: 'plugin' })
    expect(s.opened).toHaveLength(2)
    s.tick(1001)
    registration.dispose()
    expect(h.events).toEqual([{}, {}])

    const created = await s.service.create({ kind: 'skill', content: '---\nname: notes\ndescription: Notes.\n---\nWrite notes.' })
    expect(h.events.at(-1)).toEqual({ kind: 'skill', id: created.id })
    expect((await s.service.catalog(h.project.id)).skill('notes')).toMatchObject({ source: 'user', id: created.id })
    await s.service.update(created.id, { enabled: false })
    expect(h.events.at(-1)).toEqual({ kind: 'skill', id: created.id })
    expect((await s.service.catalog(h.project.id)).skill('notes')).toBeNull()
    await s.service.remove(created.id)
    expect(h.events.at(-1)).toEqual({ kind: 'skill', id: created.id })
    // One project build per drop: the first, after the registry change, after the create and after the update.
    expect(s.opened).toHaveLength(4)
  })

  it('stop drops the caches and the subscriptions (idempotent); later calls still answer', async () => {
    const h = await open()
    const s = instrumented(h)
    await s.service.catalog(h.project.id)
    s.service.stop()
    s.service.stop()
    h.t.deps.events.emit('project.changed', { id: h.project.id, project: h.project })
    h.t.deps.registry.commands.register('acme', { name: 'late', description: 'Late.', template: 'Late' })
    expect(h.events).toEqual([])
    expect((await s.service.catalog(h.project.id)).projectId).toBe(h.project.id)
    expect(s.opened).toHaveLength(2)
  })
})

describe('load', () => {
  it('re-reads a project file: deleted, renamed or grown past the cap after listing is refused', async () => {
    const h = await open()
    await write(h.dir, {
      '.harness/agents/a.md': agent('a', 'A.', 'Instructions of a.'),
      '.harness/commands/c.md': '---\ndescription: C.\nallowed-tools: Read\n---\nRun $1.',
      '.harness/skills/pdf/SKILL.md': '---\ndescription: PDFs.\n---\nRead PDFs.',
    })
    const s = instrumented(h)
    const catalog = await s.service.catalog(h.project.id)
    const a = catalog.agent('a')!
    expect(await s.service.load(a)).toEqual({
      entry: a,
      definition: { kind: 'agent', fields: { name: 'a', description: 'A.', tools: null, model: null, instructions: 'Instructions of a.' } },
      diagnostics: [],
    })
    expect((await s.service.load(catalog.command('c')!)).definition).toMatchObject({ kind: 'command', fields: { allowedTools: ['read_file'], body: 'Run $1.' } })
    expect((await s.service.load(catalog.skill('pdf')!)).definition).toEqual({ kind: 'skill', fields: { name: 'pdf', description: 'PDFs.', content: 'Read PDFs.' } })
    // A copy of the entry still finds its project through the cache.
    expect((await s.service.load({ ...a })).definition.kind).toBe('agent')

    await write(h.dir, { '.harness/agents/a.md': agent('renamed', 'A.') })
    await expect(s.service.load(a)).rejects.toMatchObject({ code: 'not_found', message: 'The agent "a" is no longer available.' })
    await write(h.dir, { '.harness/agents/a.md': `${agent('a', 'A.')}${'x'.repeat(70 * 1024)}` })
    const big = await rejection(s.service.load(a))
    expect(big.code).toBe('validation_error')
    expect(big.details).toMatchObject({ diagnostics: [{ code: 'too-large', path: '.harness/agents/a.md' }] })
    await write(h.dir, { '.harness/agents/a.md': '---\nname: a\n---\nNo description.' })
    expect((await rejection(s.service.load(a))).details).toMatchObject({ diagnostics: [{ code: 'missing-field' }] })
    await rm(join(h.dir, '.harness/agents/a.md'))
    await expect(s.service.load(a)).rejects.toMatchObject({ code: 'not_found' })
    // A forged path outside the definition folders is never read.
    await expect(s.service.load({ ...a, path: 'AGENTS.md' })).rejects.toMatchObject({ code: 'not_found' })
    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(s.service.load(catalog.command('c')!, aborted.signal)).rejects.toThrow('stopped')
  })

  it.skipIf(isWindows)('refuses a file swapped for a link (never opening the target)', async () => {
    const h = await open()
    await write(h.dir, { '.harness/agents/a.md': agent('a', 'A.'), 'other.md': agent('a', 'LINK-TARGET') })
    const s = instrumented(h)
    const a = (await s.service.catalog(h.project.id)).agent('a')!
    await rm(join(h.dir, '.harness/agents/a.md'))
    await symlink(join(h.dir, 'other.md'), join(h.dir, '.harness/agents/a.md'))
    s.files.splice(0)
    const error = await rejection(s.service.load(a))
    expect(error.code).toBe('validation_error')
    expect(error.details).toMatchObject({ diagnostics: [{ code: 'link' }] })
    expect(JSON.stringify(error)).not.toContain('LINK-TARGET')
    expect(s.files).toEqual([])
  })

  it('loads builtin and plugin entries from their source; a plugin entry of a disposed plugin is gone', async () => {
    const h = await open()
    const registration = h.t.deps.registry.agents.register('acme', { name: 'helper', description: 'Helps.', instructions: 'Help well.', tools: ['read_file'] })
    const catalog = await h.t.deps.customizations.catalog(null)
    expect((await h.t.deps.customizations.load(catalog.agent('general')!)).definition).toMatchObject({ kind: 'agent', fields: { name: 'general', instructions: '' } })
    const helper = catalog.agent('helper')!
    expect((await h.t.deps.customizations.load(helper)).definition).toEqual({ kind: 'agent', fields: { name: 'helper', description: 'Helps.', tools: ['read_file'], model: null, instructions: 'Help well.' } })
    registration.dispose()
    await expect(h.t.deps.customizations.load(helper)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('source', () => {
  it('answers the markdown of project files (the winner, or a shadowed path), plugin and builtin entries', async () => {
    const h = await open()
    const claude = agent('a', 'From claude.')
    const harness = agent('a', 'From harness.')
    await write(h.dir, { '.claude/agents/a.md': claude, '.harness/agents/a.md': harness, '.harness/agents/bad.md': '---\n[x\n---\n' })
    const service = h.t.deps.customizations
    const project = h.project.id
    expect(await service.source({ projectId: project, kind: 'agent', name: 'a', source: 'project' })).toEqual({ content: harness, path: '.harness/agents/a.md' })
    expect(await service.source({ projectId: project, kind: 'agent', name: 'a', source: 'project', path: '.claude/agents/a.md' })).toEqual({ content: claude, path: '.claude/agents/a.md' })
    // An invalid file can be viewed too.
    expect(await service.source({ projectId: project, kind: 'agent', name: 'bad', source: 'project' })).toEqual({ content: '---\n[x\n---\n', path: '.harness/agents/bad.md' })
    // A file added after the cached listing is found with one rebuild.
    await write(h.dir, { '.harness/agents/late.md': agent('late', 'Late.') })
    expect((await service.source({ projectId: project, kind: 'agent', name: 'late', source: 'project' })).path).toBe('.harness/agents/late.md')

    expect((await service.source({ kind: 'agent', name: 'explore', source: 'builtin' })).content).toMatch(/^---\nname: explore\ndescription: /)
    h.t.deps.registry.skills.register('acme', { name: 'pdf', description: 'PDFs.', content: 'Read PDFs.' })
    expect(await service.source({ kind: 'skill', name: 'pdf', source: 'plugin' })).toEqual({ content: '---\nname: pdf\ndescription: PDFs.\n---\n\nRead PDFs.\n' })
  })

  it('refuses user sources and a project source without a project (400), unknown projects and entries (404)', async () => {
    const h = await open()
    const service = h.t.deps.customizations
    await expect(service.source({ kind: 'agent', name: 'a', source: 'user' })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(service.source({ kind: 'agent', name: 'a', source: 'project' })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(service.source({ projectId: 'prj_ZZZZZZZZZZZZZZZZ', kind: 'agent', name: 'a', source: 'project' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.source({ projectId: h.project.id, kind: 'agent', name: 'nope', source: 'project' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.source({ kind: 'agent', name: 'nope', source: 'builtin' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.source({ kind: 'skill', name: 'explore', source: 'builtin' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.source({ kind: 'command', name: 'nope', source: 'plugin' })).rejects.toMatchObject({ code: 'not_found' })
    await rm(h.dir, { recursive: true, force: true })
    await expect(service.source({ projectId: h.project.id, kind: 'agent', name: 'a', source: 'project' })).rejects.toMatchObject({ code: 'validation_error' })
  })
})

describe('logging', () => {
  it('never logs a definition body, a file content or a description', async () => {
    const h = await open()
    await write(h.dir, { '.harness/agents/a.md': agent('a', 'FILE-DESCRIPTION', 'FILE-BODY-MARKER') })
    const created = await h.t.deps.customizations.create({ kind: 'command', content: '---\nname: mine\ndescription: USER-DESCRIPTION\n---\nUSER-BODY-MARKER' })
    await h.t.deps.customizations.update(created.id, { content: '---\nname: mine\ndescription: USER-DESCRIPTION-2\n---\nUSER-BODY-MARKER-2' })
    const catalog = await h.t.deps.customizations.catalog(h.project.id)
    await h.t.deps.customizations.load(catalog.agent('a')!)
    await h.t.deps.customizations.load(catalog.command('mine')!)
    await h.t.deps.customizations.source({ projectId: h.project.id, kind: 'agent', name: 'a', source: 'project' })
    await h.t.deps.customizations.restoreBackup([{ kind: 'skill', name: 's', content: '---\nname: s\ndescription: RESTORED-MARKER\n---\nRESTORED-BODY', enabled: true }])
    await h.t.deps.customizations.remove(created.id)
    // Phase 11: output styles (a project file, a personal row, a restored command with a span).
    await write(h.dir, { '.harness/output-styles/s.md': '---\nname: s\ndescription: STYLE-DESCRIPTION\n---\nSTYLE-BODY-MARKER' })
    await h.t.deps.customizations.create({ kind: 'style', content: '---\nname: Mine\ndescription: USER-STYLE-DESCRIPTION\n---\nUSER-STYLE-BODY' })
    const styles = await h.t.deps.customizations.catalog(h.project.id, { refresh: true })
    await h.t.deps.customizations.load(styles.style('s')!)
    await h.t.deps.customizations.load(styles.style('mine')!)
    await h.t.deps.customizations.restoreBackup([{ kind: 'command', name: 'st', content: '---\nname: st\ndescription: SPAN-DESCRIPTION\n---\nStatus: !`git status SPAN-MARKER`', enabled: true }])
    const logs = h.t.logs.text()
    expect(logs).toContain('customization created')
    for (const marker of ['FILE-DESCRIPTION', 'FILE-BODY-MARKER', 'USER-DESCRIPTION', 'USER-BODY-MARKER', 'RESTORED-MARKER', 'RESTORED-BODY', 'STYLE-DESCRIPTION', 'STYLE-BODY-MARKER', 'USER-STYLE-BODY', 'SPAN-DESCRIPTION', 'SPAN-MARKER'])
      expect(logs).not.toContain(marker)
  })
})

function style(name: string, description: string, extra = '', body = `STYLE-BODY ${name}`): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`
}

/**
 * A `registry.styles` double (W11.7 implements the real one): registrations announce `style` changes on the registry's
 * own listeners, like the host's `removeOwner` does when a plugin is disabled.
 */
function withFakeStyles(registry: Registry): { registry: Registry, styles: StyleRegistry } {
  const entries = new Map<string, RegisteredStyle>()
  const listeners = new Set<(change: RegistryChange) => void>()
  const notify = (change: RegistryChange): void => {
    for (const listener of [...listeners])
      listener(change)
  }
  const styles: StyleRegistry = {
    register: (pluginId: string, definition: OutputStyleDefinition): Disposable => {
      entries.set(definition.name, { pluginId, definition })
      notify({ kind: 'style', action: 'added', pluginId, key: definition.name })
      return {
        dispose: () => {
          if (entries.get(definition.name)?.pluginId !== pluginId)
            return
          entries.delete(definition.name)
          notify({ kind: 'style', action: 'removed', pluginId, key: definition.name })
        },
      }
    },
    get: name => entries.get(name),
    list: () => [...entries.values()].sort((a, b) => (a.definition.name < b.definition.name ? -1 : 1)),
    owner: name => entries.get(name)?.pluginId,
    onChange: (listener) => {
      const own = (change: RegistryChange): void => {
        if (change.kind === 'style')
          listener(change)
      }
      listeners.add(own)
      return { dispose: () => listeners.delete(own) }
    },
  }
  const wrapped: Registry = {
    ...registry,
    styles,
    onChange: (listener) => {
      listeners.add(listener)
      const inner = registry.onChange(listener)
      return {
        dispose: () => {
          listeners.delete(listener)
          inner.dispose()
        },
      }
    },
  }
  return { registry: wrapped, styles }
}

describe('output styles (Phase 11)', () => {
  it('lists the builtins, .harness over .claude, personal styles; reserved and invalid files; load re-reads the winner', async () => {
    const h = await open()
    await write(h.dir, {
      '.claude/output-styles/terse.md': style('terse', 'The claude copy.'),
      '.harness/output-styles/terse.md': style('Terse', 'The harness copy.', 'keep-coding-instructions: true\n', 'HARNESS-TERSE-BODY'),
      '.claude/output-styles/explanatory.md': style('explanatory', 'Tries to replace the builtin.'),
      '.claude/output-styles/nodesc.md': '---\nname: nodesc\n---\n',
      '.harness/output-styles/plain.md': style('plain', 'Plain prose.'),
    })
    const personal = await h.t.deps.customizations.create({ kind: 'style', content: style('Team Voice', 'PERSONAL-DESCRIPTION', '', 'PERSONAL-BODY') })
    expect(personal).toMatchObject({ kind: 'style', name: 'team-voice', fields: { label: 'Team Voice', keepCodingInstructions: false, content: 'PERSONAL-BODY' } })
    await expect(h.t.deps.customizations.create({ kind: 'style', content: style('learning', 'Mine.') })).rejects.toMatchObject({ code: 'validation_error' })

    const list = await h.t.deps.customizations.list({ projectId: h.project.id, kind: 'style' })
    expect(customizationListSchema.safeParse(list).success).toBe(true)
    expect(list.items.map(entry => [entry.name, entry.source, entry.path ?? null, entry.state])).toEqual([
      ['default', 'builtin', null, 'active'],
      ['explanatory', 'builtin', null, 'active'],
      ['explanatory', 'project', '.claude/output-styles/explanatory.md', 'invalid'],
      ['learning', 'builtin', null, 'active'],
      ['nodesc', 'project', '.claude/output-styles/nodesc.md', 'invalid'],
      ['plain', 'project', '.harness/output-styles/plain.md', 'active'],
      ['team-voice', 'user', null, 'active'],
      ['terse', 'project', '.harness/output-styles/terse.md', 'active'],
      ['terse', 'project', '.claude/output-styles/terse.md', 'shadowed'],
    ])
    expect(list.items.find(entry => entry.path === '.claude/output-styles/explanatory.md')?.diagnostics.map(item => item.code)).toEqual(['reserved-name'])
    expect(list.items.find(entry => entry.path === '.claude/output-styles/terse.md')?.shadowedBy).toEqual({ source: 'project', path: '.harness/output-styles/terse.md' })
    expect(list.project?.folders).toEqual(['.claude/output-styles', '.harness/output-styles'])

    const catalog = await h.t.deps.customizations.catalog(h.project.id)
    expect(catalog.styles().map(entry => entry.name)).toEqual(['default', 'explanatory', 'learning', 'plain', 'team-voice', 'terse'])
    const terse = catalog.style('terse')!
    expect(terse).toMatchObject({ source: 'project', label: 'Terse', keepCodingInstructions: true })
    expect(catalog.style('nodesc')).toBeNull()
    expect(catalog.style('explanatory')?.source).toBe('builtin')
    expect(await h.t.deps.customizations.load(terse)).toMatchObject({ definition: { kind: 'style', fields: { name: 'terse', label: 'Terse', keepCodingInstructions: true, content: 'HARNESS-TERSE-BODY' } } })
    expect(await h.t.deps.customizations.load(catalog.style('team-voice')!)).toMatchObject({ definition: { kind: 'style', fields: { content: 'PERSONAL-BODY' } } })
    expect((await h.t.deps.customizations.load(catalog.style('learning')!)).definition).toMatchObject({ kind: 'style', fields: { name: 'learning', label: 'Learning', keepCodingInstructions: true } })
    // The global catalog: builtins and personal styles only.
    expect((await h.t.deps.customizations.catalog(null)).styles().map(entry => entry.name)).toEqual(['default', 'explanatory', 'learning', 'team-voice'])

    // A personal style turned off is listed `off` and is no longer active.
    await h.t.deps.customizations.update(personal.id, { enabled: false })
    expect((await h.t.deps.customizations.catalog(h.project.id)).style('team-voice')).toBeNull()

    // `source` of a project style (the winner or a shadowed path) and of a builtin.
    expect((await h.t.deps.customizations.source({ projectId: h.project.id, kind: 'style', name: 'terse', source: 'project' })).path).toBe('.harness/output-styles/terse.md')
    expect((await h.t.deps.customizations.source({ projectId: h.project.id, kind: 'style', name: 'terse', source: 'project', path: '.claude/output-styles/terse.md' })).content).toContain('The claude copy.')
    expect((await h.t.deps.customizations.source({ kind: 'style', name: 'learning', source: 'builtin' })).content).toMatch(/^---\nname: Learning\ndescription: .+\nkeep-coding-instructions: true\n---\n\nTeach the user/)
  })

  it('drops a project catalog when a file of a style folder changes', async () => {
    const h = await open()
    const s = instrumented(h)
    await write(h.dir, { '.harness/output-styles/a.md': style('a', 'A.') })
    expect((await s.service.catalog(h.project.id)).style('a')).not.toBeNull()
    await write(h.dir, { '.harness/output-styles/b.md': style('b', 'B.') })
    expect((await s.service.catalog(h.project.id)).style('b')).toBeNull()
    h.t.deps.events.emit('workspace.changed', { projectId: h.project.id, chatId: null, batchId: null, source: 'tool', paths: ['.harness/output-styles/b.md'] })
    expect((await s.service.catalog(h.project.id)).style('b')).toMatchObject({ source: 'project' })
    expect(touchesDefinitions(['.claude/output-styles/x.md'])).toBe(true)
  })

  it('lists plugin styles of registry.styles until the plugin is disposed (every catalog dropped, an event)', async () => {
    const h = await open()
    const fake = withFakeStyles(h.t.deps.registry)
    const service = createCustomizationService({ ...h.t.deps, registry: fake.registry } as AppDeps, { eventIntervalMs: 0 })
    cleanups.push(() => service.stop())
    await write(h.dir, { '.claude/output-styles/pirate.md': style('pirate', 'The project pirate.') })
    expect((await service.catalog(null)).style('pirate')).toBeNull()

    const registration = fake.styles.register('acme', { name: 'pirate', description: 'Talks like a pirate.', content: 'PLUGIN-PIRATE-BODY', keepCodingInstructions: true })
    fake.styles.register('acme', { name: 'haiku', description: 'Answers in haiku.', content: 'Five, seven, five.' })
    const global = await service.catalog(null)
    expect(global.style('pirate')).toMatchObject({ source: 'plugin', pluginId: 'acme', label: 'pirate', keepCodingInstructions: true, state: 'active' })
    expect(global.style('haiku')).toMatchObject({ source: 'plugin', keepCodingInstructions: false })
    expect(await service.load(global.style('pirate')!)).toMatchObject({ definition: { kind: 'style', fields: { name: 'pirate', content: 'PLUGIN-PIRATE-BODY', keepCodingInstructions: true } } })
    expect((await service.source({ kind: 'style', name: 'pirate', source: 'plugin' })).content).toBe('---\nname: pirate\ndescription: Talks like a pirate.\nkeep-coding-instructions: true\n---\n\nPLUGIN-PIRATE-BODY\n')
    // A project file wins the name.
    const project = await service.catalog(h.project.id)
    expect(project.style('pirate')).toMatchObject({ source: 'project' })
    expect(project.entries.find(entry => entry.kind === 'style' && entry.source === 'plugin' && entry.name === 'pirate')).toMatchObject({ state: 'shadowed' })

    const events: CustomizationChangedData[] = []
    const subscription = h.t.deps.events.subscribe((event) => {
      if (event.type === 'customization.changed')
        events.push(event.data)
    })
    cleanups.push(() => subscription.dispose())
    const loaded = global.style('pirate')!
    registration.dispose()
    expect((await service.catalog(null)).style('pirate')).toBeNull()
    expect((await service.catalog(h.project.id)).entries.filter(entry => entry.source === 'plugin' && entry.kind === 'style').map(entry => entry.name)).toEqual(['haiku'])
    await expect(service.load(loaded)).rejects.toMatchObject({ code: 'not_found' })
    await vi.waitFor(() => expect(events).toContainEqual({}))
  })

  it('in safe mode lists no plugin style but the builtins', async () => {
    const h = await open({ env: { HF_SAFE_MODE: '1' } })
    const fake = withFakeStyles(h.t.deps.registry)
    const service = createCustomizationService({ ...h.t.deps, registry: fake.registry } as AppDeps)
    cleanups.push(() => service.stop())
    fake.styles.register('acme', { name: 'pirate', description: 'Talks like a pirate.', content: 'Arr.' })
    const catalog = await service.catalog(null)
    expect(catalog.styles().map(entry => entry.name)).toEqual(['default', 'explanatory', 'learning'])
    await expect(service.source({ kind: 'style', name: 'pirate', source: 'plugin' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('helpers', () => {
  it('touchesDefinitions: definition folders (any case), a possibly cut list; not other paths', () => {
    expect(touchesDefinitions(['src/a.ts'])).toBe(false)
    expect(touchesDefinitions(['.harness/plans/2026-10-04-x.md'])).toBe(false)
    expect(touchesDefinitions(['.harness/agents/a.md'])).toBe(true)
    expect(touchesDefinitions(['./.claude/commands/a/b.md'])).toBe(true)
    expect(touchesDefinitions(['.Harness/Skills/pdf/SKILL.md'])).toBe(true)
    expect(touchesDefinitions(['.harness'])).toBe(true)
    expect(touchesDefinitions([])).toBe(true)
    expect(touchesDefinitions(Array.from({ length: 200 }, (_, index) => `src/${index}.ts`))).toBe(true)
  })

  it('isDefinitionPath: only the paths discovery produces', () => {
    expect(isDefinitionPath('agent', '.harness/agents/a.md')).toBe(true)
    expect(isDefinitionPath('agent', '.harness/agents/x/a.md')).toBe(false)
    expect(isDefinitionPath('agent', '.harness/commands/a.md')).toBe(false)
    expect(isDefinitionPath('command', '.claude/commands/a/b/c/d.md')).toBe(true)
    expect(isDefinitionPath('command', '.claude/commands/a/b/c/d/e.md')).toBe(false)
    expect(isDefinitionPath('command', '.claude/commands/../../AGENTS.md')).toBe(false)
    expect(isDefinitionPath('skill', '.harness/skills/pdf/SKILL.md')).toBe(true)
    expect(isDefinitionPath('skill', '.harness/skills/pdf/ref.md')).toBe(false)
    expect(isDefinitionPath('agent', 'AGENTS.md')).toBe(false)
    expect(isDefinitionPath('style', '.harness/output-styles/terse.md')).toBe(true)
    expect(isDefinitionPath('style', '.claude/output-styles/x/terse.md')).toBe(false)
    expect(isDefinitionPath('style', '.harness/agents/terse.md')).toBe(false)
  })
})
