/* eslint-disable no-template-curly-in-string -- `${VAR}` references of `.mcp.json` are part of these fixtures */
// The project config reader (Phase 11, W11.3-T1): the four settings files and `.mcp.json` through the workspace guard,
// the item hashes with their referenced files, diagnostics without contents, verify-before-run, the 10 s cache and its
// invalidation, and the change announcements.
import type { TrustHashItem } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import type { ProjectConfigServiceOptions } from './index.ts'
import type { ProjectConfigSnapshot } from './types.ts'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS, trustHashInput } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chats } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { createProjectConfigService, emptyProjectConfigSnapshot, trustSha256 } from './index.ts'

const cleanups: Array<() => Promise<void>> = []
const CHAT = '0199a8f0-0000-7000-8000-00000000c0f1'
const SENTINEL = 'sentinel-content-7f3a'

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

interface Harness {
  t: TestApp
  events: RecordingEventBus
  projectId: string
  root: string
  put: (rel: string, content: string) => Promise<void>
}

async function setup(options: ProjectConfigServiceOptions = {}): Promise<Harness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const events = createRecordingEventBus()
  const t = await createTestApp({
    builtins: [],
    workspaceRoots: [base],
    overrides: { events },
    factories: { projectConfig: deps => createProjectConfigService(deps, { recheckDelayMs: 5, ...options }) },
  })
  cleanups.push(() => t.close())
  const project = await t.deps.projects.create({ name: 'Demo', path: base, newFolder: 'demo' })
  const root = join(base, 'demo')
  const put = async (rel: string, content: string): Promise<void> => {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), content)
  }
  return { t, events, projectId: project.id, root, put }
}

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function settings(hooks: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, hooks }, null, 2)
}

const CHECK = 'sh .claude/hooks/check.sh'
const PRE_BASH = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: CHECK, timeout: 5 }] }] }

async function writeFixture(h: Harness): Promise<void> {
  await h.put('.claude/hooks/check.sh', 'echo ok\n')
  await h.put('servers/mcp.mjs', 'console.log(1)\n')
  await h.put('.claude/settings.json', settings({
    ...PRE_BASH,
    PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }],
  }, { permissions: { allow: ['Bash(rm -rf /)'] } }))
  await h.put('.claude/settings.local.json', settings({ SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }))
  // The same PreToolUse hook again (listed once) and a hook whose script is missing.
  await h.put('.harness/settings.json', settings({
    ...PRE_BASH,
    Stop: [{ hooks: [{ type: 'command', command: 'sh .harness/hooks/missing.sh' }] }],
  }))
  await h.put('.mcp.json', JSON.stringify({
    mcpServers: {
      'local': { command: 'node', args: ['./servers/mcp.mjs'], env: { TOKEN: '${MCP_TOKEN}' } },
      'My_Server.v2': { type: 'http', url: 'http://localhost:${MCP_PORT:-9}/mcp', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
      'broken': { type: 'ftp', url: 'ftp://example.invalid' },
    },
  }))
}

describe('projectConfig.snapshot: the reads', () => {
  it('reads the hooks of the settings files in precedence order and the .mcp.json servers with their hashes', async () => {
    const h = await setup()
    await writeFixture(h)
    const snapshot = await h.t.deps.projectConfig.snapshot(h.projectId)

    expect(snapshot).toMatchObject({ projectId: h.projectId, available: true, issue: null, root: h.root, mcpFile: true })
    expect(snapshot.settingsFiles).toEqual(['.claude/settings.json', '.claude/settings.local.json', '.harness/settings.json'])
    expect(snapshot.hooks.map(item => [item.path, item.spec.event, item.label])).toEqual([
      ['.claude/settings.json', 'PreToolUse', CHECK],
      ['.claude/settings.json', 'PostToolUse', 'npm run lint'],
      ['.claude/settings.local.json', 'SessionStart', 'echo hi'],
      ['.harness/settings.json', 'Stop', 'sh .harness/hooks/missing.sh'],
    ])
    const pre = snapshot.hooks[0]!
    const expected: TrustHashItem = { kind: 'hook', event: 'PreToolUse', matcher: 'Bash', command: CHECK, timeoutSec: 5, refs: [{ path: '.claude/hooks/check.sh', sha256: sha('echo ok\n') }] }
    expect(pre.hashItem).toEqual(expected)
    expect(pre.sha256).toBe(createHash('sha256').update(trustHashInput(expected), 'utf8').digest('hex'))
    expect(pre.warnings).toEqual([])
    expect(snapshot.hooks[1]!.warnings).toEqual(['runs-repository-code'])
    expect(snapshot.hooks[3]!.warnings).toEqual(['referenced-file-missing'])
    expect(snapshot.hooks[3]!.hashItem.refs).toEqual([{ path: '.harness/hooks/missing.sh', sha256: null }])

    expect(snapshot.mcpServers.map(item => [item.server.name, item.server.id, item.server.transport.type, item.warnings])).toEqual([
      ['local', 'local', 'stdio', ['runs-repository-code']],
      ['My_Server.v2', 'my-server-v2', 'http', ['private-network']],
    ])
    const local = snapshot.mcpServers[0]!
    expect(local.hashItem).toEqual({ kind: 'mcp', name: 'local', server: { command: 'node', args: ['./servers/mcp.mjs'], env: { TOKEN: '${MCP_TOKEN}' } }, refs: [{ path: 'servers/mcp.mjs', sha256: sha('console.log(1)\n') }] })
    expect(local.sha256).toBe(trustSha256(local.hashItem))
    expect(snapshot.mcpDiagnostics.some(diagnostic => diagnostic.server === 'broken')).toBe(true)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.hooks)).toBe(true)
  })

  it('reports invalid, oversized and linked files as diagnostics without their contents', async () => {
    const h = await setup()
    await h.put('elsewhere/settings.json', settings({ Stop: [{ hooks: [{ type: 'command', command: `echo ${SENTINEL}` }] }] }))
    await h.put('.claude/settings.json', `{ "hooks": ${SENTINEL}`)
    await h.put('.claude/settings.local.json', `${' '.repeat(LIMITS.projectSettingsFileBytes)}{"x":"${SENTINEL}"}`)
    await symlink(join(h.root, 'elsewhere'), join(h.root, '.harness'))
    await symlink(join(h.root, 'elsewhere/settings.json'), join(h.root, '.mcp.json'))
    const snapshot = await h.t.deps.projectConfig.snapshot(h.projectId)

    expect(snapshot.hooks).toEqual([])
    expect(snapshot.mcpServers).toEqual([])
    expect(snapshot.settingsFiles).toEqual(['.claude/settings.json'])
    expect(snapshot.mcpFile).toBe(false)
    expect(snapshot.hookDiagnostics.map(diagnostic => [diagnostic.file, diagnostic.code])).toEqual([
      ['.claude/settings.json', 'invalid-json'],
      ['.claude/settings.local.json', 'too-large'],
      ['.harness/settings.json', 'not-an-object'],
      ['.harness/settings.local.json', 'not-an-object'],
    ])
    expect(snapshot.hookDiagnostics[2]!.message).toContain('symbolic link')
    expect(snapshot.mcpDiagnostics).toEqual([expect.objectContaining({ level: 'error', message: expect.stringContaining('symbolic link') })])
    expect(JSON.stringify(snapshot)).not.toContain(SENTINEL)
    expect(h.t.logs.text()).not.toContain(SENTINEL)
  })

  it('a reformatted file keeps every hash; editing the command or the referenced script changes it', async () => {
    const h = await setup()
    await writeFixture(h)
    const first = await h.t.deps.projectConfig.snapshot(h.projectId, { refresh: true })
    const hashes = (snapshot: ProjectConfigSnapshot) => [...snapshot.hooks, ...snapshot.mcpServers].map(item => item.sha256)

    // Reformatted: other whitespace, other key order.
    await h.put('.claude/settings.json', JSON.stringify({
      hooks: {
        PostToolUse: [{ hooks: [{ command: 'npm run lint', type: 'command' }], matcher: 'Write|Edit' }],
        PreToolUse: [{ hooks: [{ timeout: 5, command: CHECK, type: 'command' }], matcher: 'Bash' }],
      },
    }))
    const reformatted = await h.t.deps.projectConfig.snapshot(h.projectId, { refresh: true })
    expect(new Set(hashes(reformatted))).toEqual(new Set(hashes(first)))

    await h.put('.claude/hooks/check.sh', 'echo changed\n')
    const script = await h.t.deps.projectConfig.snapshot(h.projectId, { refresh: true })
    expect(script.hooks.find(item => item.spec.event === 'PreToolUse')!.sha256).not.toBe(first.hooks[0]!.sha256)

    await h.put('.claude/settings.json', settings({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${CHECK} --strict`, timeout: 5 }] }] }))
    const command = await h.t.deps.projectConfig.snapshot(h.projectId, { refresh: true })
    expect(command.hooks.some(item => item.sha256 === script.hooks[0]!.sha256)).toBe(false)
  })

  it('an unknown project is unavailable; an aborted signal rejects', async () => {
    const h = await setup()
    const unknown = await h.t.deps.projectConfig.snapshot('prj_ZZZZZZZZZZZZZZZZ')
    expect(unknown).toMatchObject({ available: false, root: null, hooks: [], mcpServers: [], settingsFiles: [] })
    expect(unknown.issue).toEqual(expect.any(String))
    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(h.t.deps.projectConfig.snapshot(h.projectId, { signal: aborted.signal })).rejects.toThrow('stopped')
    expect(emptyProjectConfigSnapshot('prj_AAAAAAAAAAAAAAAA', { available: false, issue: 'gone', root: null }, 5)).toMatchObject({ scannedAt: 5, issue: 'gone', hooks: [] })
  })
})

describe('projectConfig.verify', () => {
  it('re-hashes the referenced files right before a run; a changed or tampered item fails closed', async () => {
    const h = await setup()
    await writeFixture(h)
    const snapshot = await h.t.deps.projectConfig.snapshot(h.projectId)
    const pre = snapshot.hooks[0]!
    const local = snapshot.mcpServers[0]!
    expect(await h.t.deps.projectConfig.verify(h.projectId, pre)).toBe(true)
    expect(await h.t.deps.projectConfig.verify(h.projectId, local)).toBe(true)

    // A subject that drops its referenced file never verifies (the paths come from the command).
    const dropped = { ...pre.hashItem, refs: [] }
    expect(await h.t.deps.projectConfig.verify(h.projectId, { kind: 'hook', sha256: trustSha256(dropped), hashItem: dropped })).toBe(false)
    expect(await h.t.deps.projectConfig.verify('prj_ZZZZZZZZZZZZZZZZ', pre)).toBe(false)

    await h.put('.claude/hooks/check.sh', 'echo changed\n')
    expect(await h.t.deps.projectConfig.verify(h.projectId, pre)).toBe(false)
    await h.put('servers/mcp.mjs', 'console.log(2)\n')
    expect(await h.t.deps.projectConfig.verify(h.projectId, local)).toBe(false)

    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(h.t.deps.projectConfig.verify(h.projectId, pre, aborted.signal)).rejects.toThrow('stopped')
  })

  it('a mismatch drops the snapshot and announces the change', async () => {
    const h = await setup()
    await writeFixture(h)
    const snapshot = await h.t.deps.projectConfig.snapshot(h.projectId)
    h.events.clear()
    await h.put('.claude/hooks/check.sh', 'echo changed\n')
    expect(await h.t.deps.projectConfig.verify(h.projectId, snapshot.hooks[0]!)).toBe(false)
    await vi.waitFor(() => expect(h.events.ofType('project-trust.changed')).toHaveLength(1))
    expect(h.events.ofType('project-trust.changed')[0]!.data).toEqual({ projectId: h.projectId, pending: 6 })
    expect(h.events.ofType('hooks.changed').map(event => event.data)).toEqual([{ projectId: h.projectId }])
    expect((await h.t.deps.projectConfig.snapshot(h.projectId)).hooks[0]!.sha256).not.toBe(snapshot.hooks[0]!.sha256)
  })
})

describe('projectConfig cache and invalidation', () => {
  it('never opens the workspace of a run: one project lookup, then the cached root is re-checked', async () => {
    const h = await setup()
    await writeFixture(h)
    const opens = vi.spyOn(h.t.deps.projects, 'openWorkspace')
    const lookups = vi.spyOn(h.t.deps.projects, 'get')
    const config = h.t.deps.projectConfig
    const first = await config.snapshot(h.projectId)
    await config.snapshot(h.projectId, { refresh: true })
    expect(await config.verify(h.projectId, first.hooks[0]!)).toBe(true)
    config.invalidate(h.projectId)
    await config.snapshot(h.projectId)
    expect(opens).not.toHaveBeenCalled()
    expect(lookups).toHaveBeenCalledTimes(1)

    // A project.changed (a moved folder, a rename) looks the folder up again.
    h.events.emit('project.changed', { id: h.projectId, project: await h.t.deps.projects.get(h.projectId) })
    lookups.mockClear()
    await config.snapshot(h.projectId)
    expect(lookups).toHaveBeenCalledTimes(1)

    expect(opens).not.toHaveBeenCalled()

    // A deleted folder is noticed by the root check.
    await rm(h.root, { recursive: true, force: true })
    expect((await config.snapshot(h.projectId, { refresh: true })).available).toBe(false)
    expect(await config.verify(h.projectId, first.hooks[0]!)).toBe(false)
  })

  it('serves the cached snapshot for 10 s; refresh reads again', async () => {
    let clock = 1_000_000
    const h = await setup({ now: () => clock })
    await writeFixture(h)
    const first = await h.t.deps.projectConfig.snapshot(h.projectId)
    expect(await h.t.deps.projectConfig.snapshot(h.projectId)).toBe(first)
    clock += 9_999
    expect(await h.t.deps.projectConfig.snapshot(h.projectId)).toBe(first)
    clock += 1
    const rebuilt = await h.t.deps.projectConfig.snapshot(h.projectId)
    expect(rebuilt).not.toBe(first)
    const refreshed = await h.t.deps.projectConfig.snapshot(h.projectId, { refresh: true })
    expect(refreshed).not.toBe(rebuilt)
    expect(await h.t.deps.projectConfig.snapshot(h.projectId)).toBe(refreshed)
  })

  it('drops a project snapshot on a workspace.changed of a config file or a referenced file, project.changed and run.finished', async () => {
    const h = await setup({ recheckDelayMs: 60_000 })
    await writeFixture(h)
    const config = h.t.deps.projectConfig
    const workspaceChanged = (paths: string[]) => h.events.emit('workspace.changed', { projectId: h.projectId, chatId: null, batchId: null, source: 'tool', paths })

    let snapshot = await config.snapshot(h.projectId)
    workspaceChanged(['src/index.ts'])
    expect(await config.snapshot(h.projectId)).toBe(snapshot)
    for (const paths of [['.claude/settings.json'], ['./.mcp.json'], ['.harness/hooks/new.sh'], ['servers/mcp.mjs'], []]) {
      workspaceChanged(paths)
      const next = await config.snapshot(h.projectId)
      expect(next, paths.join(',')).not.toBe(snapshot)
      snapshot = next
    }

    h.events.emit('project.changed', { id: h.projectId, project: await h.t.deps.projects.get(h.projectId) })
    const afterProject = await config.snapshot(h.projectId)
    expect(afterProject).not.toBe(snapshot)

    await h.t.db.insert(chats).values({ id: CHAT, projectId: h.projectId })
    h.events.emit('run.finished', { chatId: CHAT, messageId: 'msg_sample0000000001', outcome: 'completed', awaitingApproval: false })
    await vi.waitFor(async () => expect(await config.snapshot(h.projectId)).not.toBe(afterProject))

    config.invalidate(null)
    expect(await config.snapshot(h.projectId)).not.toBe(afterProject)
  })

  it('a dropped snapshot is rebuilt after the recheck delay and a change is announced once; no change, no event', async () => {
    const h = await setup()
    await writeFixture(h)
    await h.t.deps.projectConfig.snapshot(h.projectId)
    h.events.clear()

    // Nothing changed: the recheck finds the same items.
    h.events.emit('workspace.changed', { projectId: h.projectId, chatId: null, batchId: null, source: 'tool', paths: ['.claude/settings.json'] })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.events.ofType('project-trust.changed')).toEqual([])

    // An `.mcp.json` server changed: trust changes, hooks do not.
    await h.put('.mcp.json', JSON.stringify({ mcpServers: { local: { command: 'node', args: ['./servers/mcp.mjs', '--v2'] } } }))
    h.events.emit('workspace.changed', { projectId: h.projectId, chatId: null, batchId: null, source: 'tool', paths: ['.mcp.json'] })
    await vi.waitFor(() => expect(h.events.ofType('project-trust.changed')).toHaveLength(1))
    expect(h.events.ofType('project-trust.changed')[0]!.data).toEqual({ projectId: h.projectId, pending: 5 })
    expect(h.events.ofType('hooks.changed')).toEqual([])
  })

  it('stop drops the caches and the subscription and is idempotent', async () => {
    const h = await setup()
    await writeFixture(h)
    const first = await h.t.deps.projectConfig.snapshot(h.projectId)
    const subscribers = h.events.subscriberCount()
    h.t.deps.projectConfig.stop()
    h.t.deps.projectConfig.stop()
    expect(h.events.subscriberCount()).toBe(subscribers - 1)
    const after = await h.t.deps.projectConfig.snapshot(h.projectId)
    expect(after).not.toBe(first)
    expect(after.hooks.map(item => item.sha256)).toEqual(first.hooks.map(item => item.sha256))
  })
})
