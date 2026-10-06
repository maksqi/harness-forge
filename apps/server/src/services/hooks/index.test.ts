// Smoke tests of the hook service stub (Phase 11, C36-T2): the final signatures with "nothing runs" behavior. W11.1
// replaces the stub and these expectations with the real ones.
import type { ProjectSummary } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { HookScope } from './types.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_EVENTS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { hooks } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { commandHooksAllowed, emptyHookSnapshot, NOTHING_RAN, personalHookEntry } from './index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function open(env: Record<string, string> = {}): Promise<{ t: TestApp, project: ProjectSummary }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const t = await createTestApp({ builtins: [], workspaceRoots: [root], env })
  cleanups.push(() => t.close())
  const project = await t.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })
  return { t, project }
}

function scope(fields: Partial<HookScope> = {}): HookScope {
  return { chatId: '0199a8f0-0000-7000-8000-0000000000c1', projectId: null, workspace: null, toolMode: 'ask', origin: 'request', modelRef: 'mock:echo', ...fields }
}

describe('hook service stub (P11-0b)', () => {
  it('snapshot: no hook for any event; run answers "nothing ran"; an aborted signal rejects', async () => {
    const { t } = await open()
    const snapshot = await t.deps.hooks.snapshot(scope({ origin: 'hook' }))
    expect(snapshot.scope.origin).toBe('hook')
    for (const event of HOOK_EVENTS)
      expect(snapshot.has(event), event).toBe(false)
    const signal = new AbortController().signal
    expect(await snapshot.run('PreToolUse', { tool: { name: 'shell', callId: 'c1', input: { command: 'ls' } } }, { signal, target: 'shell' })).toEqual(NOTHING_RAN)
    expect(NOTHING_RAN).toEqual({ ran: false, decision: null, reason: null, context: null, block: false, continue: true, stopReason: null, record: null })

    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(snapshot.run('Stop', { stopHookActive: false }, { signal: aborted.signal })).rejects.toThrow('stopped')
    await expect(t.deps.hooks.snapshot(scope(), { signal: aborted.signal })).rejects.toThrow('stopped')
    expect(emptyHookSnapshot(scope()).has('Stop')).toBe(false)
  })

  it('list: the personal rows in run order with their states and the kill switches; a project scan; 404 for an unknown project', async () => {
    const { t, project } = await open()
    await t.db.insert(hooks).values([
      { id: 'hok_AAAAAAAAAAAAAAAA', event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh', timeout: 30, createdAt: 1, updatedAt: 1 },
      { id: 'hok_BBBBBBBBBBBBBBBB', event: 'Stop', command: 'sh stop.sh', enabled: false, createdAt: 2, updatedAt: 2 },
      // A row whose matcher was never validated (written directly): listed as invalid, never run.
      { id: 'hok_CCCCCCCCCCCCCCCC', event: 'PostToolUse', matcher: '^Bash', command: 'sh post.sh', createdAt: 3, updatedAt: 3 },
    ])
    const list = await t.deps.hooks.list({})
    expect(list.switches).toEqual({ setting: true, shell: true, safeMode: false })
    expect(list.project).toBeUndefined()
    expect(list.diagnostics).toEqual([])
    expect(list.items.map(item => [item.key, item.source, item.kind, item.state])).toEqual([
      ['personal:hok_AAAAAAAAAAAAAAAA', 'personal', 'command', 'active'],
      ['personal:hok_BBBBBBBBBBBBBBBB', 'personal', 'command', 'off'],
      ['personal:hok_CCCCCCCCCCCCCCCC', 'personal', 'command', 'invalid'],
    ])
    expect(list.items[0]).toMatchObject({ id: 'hok_AAAAAAAAAAAAAAAA', event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh', timeout: 30, diagnostics: [] })
    expect(list.items[2]?.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['invalid-matcher'])

    // The setting turns command hooks off: enabled rows are blocked.
    await t.deps.settings.update({ hooksEnabled: false })
    const blocked = await t.deps.hooks.list({ projectId: project.id })
    expect(blocked.switches.setting).toBe(false)
    expect(blocked.items.map(item => item.state)).toEqual(['blocked', 'off', 'invalid'])
    expect(blocked.project).toMatchObject({ id: project.id, available: true, files: [], pending: 0 })

    await expect(t.deps.hooks.list({ projectId: 'prj_ZZZZZZZZZZZZZZZZ' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('list: HF_SAFE_MODE and HF_WORKSPACE_SHELL=0 are switches', async () => {
    const { t } = await open({ HF_SAFE_MODE: '1', HF_WORKSPACE_SHELL: '0' })
    const list = await t.deps.hooks.list({})
    expect(list.switches).toEqual({ setting: true, shell: false, safeMode: true })
    expect(commandHooksAllowed(list.switches)).toBe(false)
    expect(commandHooksAllowed({ setting: true, shell: true, safeMode: false })).toBe(true)
    expect(personalHookEntry({ id: 'hok_AAAAAAAAAAAAAAAA', event: 'Stop', matcher: null, command: 'sh x.sh', timeout: null, enabled: true }, false).state).toBe('blocked')
  })

  it('the personal CRUD answers not_implemented; runs is empty; invalidate and stop are no-ops', async () => {
    const { t } = await open()
    await expect(t.deps.hooks.create({ event: 'Stop', command: 'sh stop.sh' })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(t.deps.hooks.update('hok_AAAAAAAAAAAAAAAA', { enabled: false })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(t.deps.hooks.remove('hok_AAAAAAAAAAAAAAAA')).rejects.toMatchObject({ code: 'not_implemented' })
    expect(t.deps.hooks.runs()).toEqual([])
    expect(t.deps.hooks.runs(5)).toEqual([])
    expect(t.deps.hooks.invalidate(null)).toBeUndefined()
    expect(t.deps.hooks.invalidate('prj_AAAAAAAAAAAAAAAA')).toBeUndefined()
    await expect(t.deps.hooks.stop()).resolves.toBeUndefined()
  })
})
