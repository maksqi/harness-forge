/* eslint-disable no-template-curly-in-string -- `${VAR}` references of `.mcp.json` are part of these fixtures */
// Project trust (Phase 11, W11.3-T2 … T6): the listing of every executable kind (hooks, `.mcp.json` servers, command
// files with `!` spans), approve (fresh auth, 409 stale, nothing written), revoke (idempotent, orphans), the `changed`
// state, the memoized approved set, the pending count, the events and the lifecycle of the rows.
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectTrustListSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { projectTrust } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { createProjectConfigService } from '../project-config/index.ts'
import { commandTrustSubject } from '../project-config/refs.ts'

const cleanups: Array<() => Promise<void>> = []
const CHECK = 'sh .claude/hooks/check.sh'

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

/** The events of project trust (the project MCP manager may add its own `project-mcp.changed`). */
function trustEvents(h: Harness) {
  return h.events.events.filter(event => event.type === 'project-trust.changed' || event.type === 'hooks.changed')
}

async function setup(): Promise<Harness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const events = createRecordingEventBus()
  const t = await createTestApp({
    builtins: [],
    workspaceRoots: [base],
    overrides: { events },
    // No background rechecks: the events of these tests come from approve and revoke.
    factories: { projectConfig: deps => createProjectConfigService(deps, { recheckDelayMs: 60_000 }) },
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

const STATUS_MD = '---\ndescription: Show the status\n---\nStatus: !`git status --short` and !`sh scripts/count.sh`\n\nThen read @README.md and $ARGUMENTS\n'

async function writeFixture(h: Harness): Promise<void> {
  await h.put('.claude/hooks/check.sh', 'echo ok\n')
  await h.put('scripts/count.sh', 'echo 1\n')
  await h.put('.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: CHECK }] }] } }))
  await h.put('.mcp.json', JSON.stringify({ mcpServers: { remote: { type: 'sse', url: 'https://mcp.example.invalid/sse', headers: { 'X-Token': '${MCP_TOKEN}' } } } }))
  await h.put('.harness/commands/status.md', STATUS_MD)
  // Shadowed by the `.harness` file: never runs, never listed.
  await h.put('.claude/commands/status.md', '---\ndescription: Old status\n---\n!`echo old`\n')
  // No spans: nothing to approve.
  await h.put('.claude/commands/plain.md', '---\ndescription: Plain\n---\nSay hi to $ARGUMENTS\n')
}

function stored(h: Harness) {
  return h.t.db.select().from(projectTrust)
}

describe('projectTrust.list', () => {
  it('lists hooks, .mcp.json servers and command files with spans, with exactly what runs', async () => {
    const h = await setup()
    await writeFixture(h)
    const list = projectTrustListSchema.parse(await h.t.deps.projectTrust.list(h.projectId))

    expect(list).toMatchObject({ orphaned: 0, available: true })
    expect(list.items.map(item => [item.kind, item.label, item.path, item.state])).toEqual([
      ['hook', CHECK, '.claude/settings.json', 'pending'],
      ['mcp', 'remote', '.mcp.json', 'pending'],
      ['command', '/status', '.harness/commands/status.md', 'pending'],
    ])
    const [hook, mcp, command] = list.items
    expect(hook).toMatchObject({ detail: { event: 'PreToolUse', matcher: 'Bash', command: CHECK, timeout: null }, refs: [{ path: '.claude/hooks/check.sh', sha256: expect.any(String) }], warnings: [] })
    expect(mcp).toMatchObject({ detail: { name: 'remote', id: 'remote', transport: 'sse', url: 'https://mcp.example.invalid/sse', envNames: [], headerNames: ['X-Token'], variables: ['MCP_TOKEN'] } })
    expect(JSON.stringify(mcp)).not.toContain('Bearer')
    expect(command).toMatchObject({ detail: { name: 'status', spans: ['git status --short', 'sh scripts/count.sh'] }, refs: [{ path: 'scripts/count.sh', sha256: expect.any(String) }] })
    // The command hash is the shared rule of the command resolution (W11.5).
    expect(command!.sha256).toBe((await commandTrustSubject(h.root, 'status', ['git status --short', 'sh scripts/count.sh'])).sha256)
    expect(list.items.some(item => 'changed' in item)).toBe(false)
    expect(await h.t.deps.projectTrust.pending(h.projectId)).toBe(3)
  })

  it('answers not_found for an unknown project and available: false for a folder that is gone', async () => {
    const h = await setup()
    await expect(h.t.deps.projectTrust.list('prj_ZZZZZZZZZZZZZZZZ')).rejects.toMatchObject({ code: 'not_found' })
    expect(await h.t.deps.projectTrust.pending('prj_ZZZZZZZZZZZZZZZZ')).toBe(0)
    await h.t.db.insert(projectTrust).values({ projectId: h.projectId, sha256: 'a'.repeat(64), kind: 'hook', label: 'x' })
    await rm(h.root, { recursive: true, force: true })
    const list = await h.t.deps.projectTrust.list(h.projectId)
    expect(list).toMatchObject({ items: [], orphaned: 0, available: false, issue: expect.any(String) })
    expect(await h.t.deps.projectTrust.pending(h.projectId)).toBe(0)
    // Revoking while the folder is gone never removes the other approvals.
    await h.t.deps.projectTrust.revoke(h.projectId, 'b'.repeat(64))
    expect(await stored(h)).toHaveLength(1)
  })
})

describe('projectTrust.approve / revoke', () => {
  it('approves current hashes in one batch after a fresh scan; a stale hash or kind refuses the whole batch', async () => {
    const h = await setup()
    await writeFixture(h)
    const list = await h.t.deps.projectTrust.list(h.projectId)
    const [hook, mcp, command] = list.items
    h.events.clear()

    await expect(h.t.deps.projectTrust.approve(h.projectId, [{ kind: 'hook', sha256: hook!.sha256 }, { kind: 'mcp', sha256: 'f'.repeat(64) }]))
      .rejects
      .toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    await expect(h.t.deps.projectTrust.approve(h.projectId, [{ kind: 'command', sha256: hook!.sha256 }]))
      .rejects
      .toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    // The file changed after the review.
    await h.put('scripts/count.sh', 'echo 2\n')
    await expect(h.t.deps.projectTrust.approve(h.projectId, [{ kind: 'command', sha256: command!.sha256 }]))
      .rejects
      .toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    expect(await stored(h)).toEqual([])
    expect(trustEvents(h)).toEqual([])

    let fresh = 0
    const approved = await h.t.deps.projectTrust.approve(h.projectId, [{ kind: 'hook', sha256: hook!.sha256 }, { kind: 'mcp', sha256: mcp!.sha256 }], { requireFreshAuth: () => void (fresh += 1) })
    expect(fresh).toBe(1)
    expect(approved.items.map(item => [item.kind, item.state])).toEqual([['hook', 'approved'], ['mcp', 'approved'], ['command', 'pending']])
    expect((await stored(h)).map(row => [row.kind, row.label]).sort()).toEqual([['hook', CHECK], ['mcp', 'remote']])
    expect(await h.t.deps.projectTrust.approved(h.projectId)).toEqual(new Set([hook!.sha256, mcp!.sha256]))
    expect(trustEvents(h).map(event => [event.type, event.data])).toEqual([
      ['project-trust.changed', { projectId: h.projectId, pending: 1 }],
      ['hooks.changed', { projectId: h.projectId }],
    ])
    // Approving again is no error.
    await h.t.deps.projectTrust.approve(h.projectId, [{ kind: 'hook', sha256: hook!.sha256 }])
    expect(await stored(h)).toHaveLength(2)
  })

  it('calls requireFreshAuth first: a refusal writes nothing', async () => {
    const h = await setup()
    await writeFixture(h)
    const [hook] = (await h.t.deps.projectTrust.list(h.projectId)).items
    const refuse = { requireFreshAuth: () => {
      throw new Error('login')
    } }
    await expect(h.t.deps.projectTrust.approve(h.projectId, [{ kind: 'hook', sha256: hook!.sha256 }], refuse)).rejects.toThrow('login')
    await expect(h.t.deps.projectTrust.approve('prj_ZZZZZZZZZZZZZZZZ', [{ kind: 'hook', sha256: hook!.sha256 }])).rejects.toMatchObject({ code: 'not_found' })
    expect(await stored(h)).toEqual([])
  })

  it('a changed item is pending with changed: true; revoke is idempotent and clears the orphaned approvals', async () => {
    const h = await setup()
    await writeFixture(h)
    const [hook] = (await h.t.deps.projectTrust.list(h.projectId)).items
    await h.t.deps.projectTrust.approve(h.projectId, [{ kind: 'hook', sha256: hook!.sha256 }])

    // Editing the referenced script makes the hook pending again ("Changed").
    await h.put('.claude/hooks/check.sh', 'echo changed\n')
    const changed = await h.t.deps.projectTrust.list(h.projectId)
    expect(changed.items[0]).toMatchObject({ kind: 'hook', state: 'pending', changed: true })
    expect(changed.items[0]!.sha256).not.toBe(hook!.sha256)
    expect(changed.orphaned).toBe(1)
    expect(await h.t.deps.projectTrust.approved(h.projectId)).toEqual(new Set([hook!.sha256]))

    h.events.clear()
    const revoked = await h.t.deps.projectTrust.revoke(h.projectId, 'e'.repeat(64))
    expect(revoked.orphaned).toBe(0)
    expect(revoked.items[0]).toMatchObject({ state: 'pending' })
    expect('changed' in revoked.items[0]!).toBe(false)
    expect(await stored(h)).toEqual([])
    expect(await h.t.deps.projectTrust.approved(h.projectId)).toEqual(new Set())
    expect(trustEvents(h).map(event => event.type)).toEqual(['project-trust.changed', 'hooks.changed'])
    expect(h.events.ofType('project-trust.changed')[0]!.data).toEqual({ projectId: h.projectId, pending: 3 })

    // Revoking a current approval makes the item pending again.
    const current = changed.items[0]!
    await h.t.deps.projectTrust.approve(h.projectId, [{ kind: 'hook', sha256: current.sha256 }])
    const after = await h.t.deps.projectTrust.revoke(h.projectId, current.sha256)
    expect(after.items[0]).toMatchObject({ sha256: current.sha256, state: 'pending' })
    await expect(h.t.deps.projectTrust.revoke('prj_ZZZZZZZZZZZZZZZZ', current.sha256)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a list that finds another pending count announces it', async () => {
    const h = await setup()
    await writeFixture(h)
    expect(await h.t.deps.projectTrust.pending(h.projectId)).toBe(3)
    h.events.clear()
    await h.t.deps.projectTrust.list(h.projectId)
    expect(h.events.ofType('project-trust.changed')).toEqual([])
    await h.put('.harness/commands/deploy.md', '---\ndescription: Deploy\n---\n!`sh scripts/count.sh deploy`\n')
    const list = await h.t.deps.projectTrust.list(h.projectId)
    expect(list.items.map(item => item.label)).toContain('/deploy')
    expect(h.events.ofType('project-trust.changed').map(event => event.data)).toEqual([{ projectId: h.projectId, pending: 4 }])
  })
})

describe('project trust rows: lifecycle', () => {
  it('the rows survive delete-all and go with their project (foreign key) with a final event', async () => {
    const h = await setup()
    await writeFixture(h)
    const [hook] = (await h.t.deps.projectTrust.list(h.projectId)).items
    await h.t.deps.projectTrust.approve(h.projectId, [{ kind: 'hook', sha256: hook!.sha256 }])

    await h.t.deps.data.deleteAll({ confirm: 'DELETE' })
    expect(await stored(h)).toHaveLength(1)
    expect(await h.t.deps.projectTrust.approved(h.projectId)).toEqual(new Set([hook!.sha256]))

    h.events.clear()
    await h.t.deps.projects.remove(h.projectId)
    expect(await stored(h)).toEqual([])
    expect(await h.t.deps.projectTrust.approved(h.projectId)).toEqual(new Set())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.events.ofType('project-trust.changed').map(event => event.data)).toEqual([{ projectId: h.projectId, pending: 0 }])
  })

  it('never logs a command, a URL or a variable name at info', async () => {
    const h = await setup()
    await writeFixture(h)
    const list = await h.t.deps.projectTrust.list(h.projectId)
    await h.t.deps.projectTrust.approve(h.projectId, list.items.map(item => ({ kind: item.kind, sha256: item.sha256 })))
    await h.t.deps.projectTrust.revoke(h.projectId, list.items[0]!.sha256)
    const info = h.t.logs.records.filter(record => record.level !== 'debug').map(record => JSON.stringify(record)).join('\n')
    expect(info).toContain('project items approved')
    for (const secret of [CHECK, 'git status', 'mcp.example.invalid', 'MCP_TOKEN', 'X-Token'])
      expect(info).not.toContain(secret)
  })
})
