// Trust v2 of project hooks (W12.5-T8, ADR-057, open point 2): prompt handlers and the command fields `args` / `async` /
// `if` hash as trust item v2 while every v1 item keeps its v1.7 bytes; the script files of exec-form arguments are trust
// references (editing one makes the item pending); the trust detail shows the prompt and the fields; a project prompt hook
// stays pending until approved and then runs (on `mock:prompt-hook`); a file saved from the UI (`workspace.changed {
// source: 'user' }`) announces the new pending count.
import type { HookSpec, PromptHookSpec, TrustHashItem } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { projectTrustListSchema, trustHashInput } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { mergeHookSpecs, projectPromptSpec } from './hook-items.ts'
import { createProjectConfigService, trustSha256 } from './index.ts'

const posix = process.platform !== 'win32'
const cleanups: Array<() => Promise<void>> = []

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

async function setup(): Promise<Harness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const events = createRecordingEventBus()
  const t = await createTestApp({
    workspaceRoots: [base],
    env: { HF_MOCK_PROVIDER: '1' },
    overrides: { events },
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

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

const V1 = { type: 'command', command: 'sh .claude/hooks/check.sh', timeout: 5 }
const EXEC = { type: 'command', command: 'sh', args: ['.claude/hooks/lint.sh', '--fix'] }
const PROMPT = { type: 'prompt', prompt: 'Did the agent run the tests?\nAnswer strictly.', model: 'haiku', statusMessage: 'Checking…' }

async function writeSettings(h: Harness): Promise<void> {
  await h.put('.claude/hooks/check.sh', 'echo ok\n')
  await h.put('.claude/hooks/lint.sh', 'echo lint\n')
  await h.put('.claude/settings.json', JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [V1, { ...V1, if: 'Bash(git:*)' }, { ...V1, async: true }] }],
      PostToolUse: [{ matcher: 'Write', hooks: [EXEC] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }, PROMPT, { type: 'command', command: 'echo after' }] }],
      SessionStart: [{ hooks: [{ type: 'prompt', prompt: 'Hello' }] }],
    },
  }))
}

describe('trust item v2 of project hooks', () => {
  it('v1 items keep their bytes; args / async / if and prompt handlers hash as v2; statusMessage is not hashed', async () => {
    const h = await setup()
    await writeSettings(h)
    const snapshot = await h.t.deps.projectConfig.snapshot(h.projectId)
    const items = snapshot.hooks
    expect(items.map(item => [item.spec.event, item.label])).toEqual([
      ['PreToolUse', 'sh .claude/hooks/check.sh'],
      ['PreToolUse', 'sh .claude/hooks/check.sh'],
      ['PreToolUse', 'sh .claude/hooks/check.sh'],
      ['PostToolUse', 'sh .claude/hooks/lint.sh --fix'],
      ['Stop', 'echo stop'],
      ['Stop', 'Did the agent run the tests?'],
      ['Stop', 'echo after'],
    ])
    const checkRef = { path: '.claude/hooks/check.sh', sha256: sha('echo ok\n') }
    const v1: TrustHashItem = { kind: 'hook', event: 'PreToolUse', matcher: 'Bash', command: V1.command, timeoutSec: 5, refs: [checkRef] }
    expect(items[0]!.hashItem).toEqual(v1)
    expect(items[0]!.sha256).toBe(createHash('sha256').update(trustHashInput(v1), 'utf8').digest('hex'))
    expect(trustHashInput(items[0]!.hashItem).startsWith('["hook",1,')).toBe(true)
    expect(items[1]!.hashItem).toEqual({ ...v1, extra: { if: 'Bash(git:*)' } })
    expect(items[2]!.hashItem).toEqual({ ...v1, extra: { async: true } })
    for (const item of items.slice(1, 4))
      expect(trustHashInput(item.hashItem).startsWith('["hook",2,')).toBe(true)
    // The exec form: the script its arguments name is a reference.
    expect(items[3]!.hashItem).toEqual({ kind: 'hook', event: 'PostToolUse', matcher: 'Write', command: 'sh', timeoutSec: null, extra: { args: EXEC.args }, refs: [{ path: '.claude/hooks/lint.sh', sha256: sha('echo lint\n') }] })
    // A prompt hook: no command, the prompt fields in `extra`; `statusMessage` stays out of the hash.
    const prompt = items[5]!
    expect(prompt.hashItem).toEqual({ kind: 'hook', event: 'Stop', matcher: null, command: null, timeoutSec: null, extra: { type: 'prompt', prompt: PROMPT.prompt, model: 'haiku', continueOnBlock: false }, refs: [] })
    expect(prompt.spec).toMatchObject({ event: 'Stop', command: '', statusMessage: 'Checking…' })
    expect(projectPromptSpec(prompt)).toMatchObject({ event: 'Stop', prompt: PROMPT.prompt, model: 'haiku', continueOnBlock: false, statusMessage: 'Checking…', position: [0, 1] })
    expect(projectPromptSpec(items[4]!)).toBeNull()
    expect(prompt.warnings).toEqual([])
    // A prompt handler on an event without prompt hooks is a diagnostic, never an item.
    expect(snapshot.hookDiagnostics).toContainEqual(expect.objectContaining({ code: 'unsupported-type', event: 'SessionStart', file: '.claude/settings.json' }))

    await h.put('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ ...PROMPT, statusMessage: 'Other label' }] }] } }))
    h.t.deps.projectConfig.invalidate(h.projectId)
    const relabeled = await h.t.deps.projectConfig.snapshot(h.projectId)
    expect(relabeled.hooks[0]!.sha256).toBe(prompt.sha256)
  })

  it('editing the script an exec-form argument names makes the item pending (verify fails, a new hash)', async () => {
    const h = await setup()
    await writeSettings(h)
    const before = (await h.t.deps.projectConfig.snapshot(h.projectId)).hooks[3]!
    expect(await h.t.deps.projectConfig.verify(h.projectId, before)).toBe(true)
    await h.put('.claude/hooks/lint.sh', 'echo changed\n')
    expect(await h.t.deps.projectConfig.verify(h.projectId, before)).toBe(false)
    const after = (await h.t.deps.projectConfig.snapshot(h.projectId, { refresh: true })).hooks[3]!
    expect(after.sha256).not.toBe(before.sha256)
  })

  it('the trust listing shows the prompt and the handler fields (open point 2)', async () => {
    const h = await setup()
    await writeSettings(h)
    const list = projectTrustListSchema.parse(await h.t.deps.projectTrust.list(h.projectId))
    const details = list.items.filter(item => item.kind === 'hook').map(item => item.kind === 'hook' ? item.detail : null)
    expect(details).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', command: V1.command, timeout: 5 },
      { event: 'PreToolUse', matcher: 'Bash', command: V1.command, timeout: 5, if: 'Bash(git:*)' },
      { event: 'PreToolUse', matcher: 'Bash', command: V1.command, timeout: 5, async: true },
      { event: 'PostToolUse', matcher: 'Write', command: 'sh', timeout: null, args: EXEC.args },
      { event: 'Stop', matcher: null, command: 'echo stop', timeout: null },
      { event: 'Stop', matcher: null, command: '', timeout: null, type: 'prompt', prompt: PROMPT.prompt, model: 'haiku', statusMessage: 'Checking…' },
      { event: 'Stop', matcher: null, command: 'echo after', timeout: null },
    ])
    expect(list.items.every(item => item.state === 'pending')).toBe(true)
  })

  it('mergeHookSpecs keeps the command order and places each prompt at its declaration place', () => {
    const command = (event: HookSpec['event'], position: [number, number]): HookSpec => ({ event, matcher: null, command: `${event}-${position.join('.')}`, timeoutSec: null, position })
    const prompt = (event: HookSpec['event'], position: [number, number]): PromptHookSpec => ({ event, matcher: null, prompt: `${event}-${position.join('.')}`, model: null, timeoutSec: null, continueOnBlock: false, position })
    const merged = mergeHookSpecs([command('Stop', [0, 0]), command('Stop', [1, 0]), command('PreToolUse', [0, 0])], [prompt('Stop', [0, 1]), prompt('Stop', [2, 0]), prompt('UserPromptSubmit', [0, 0])])
    expect(merged.map(entry => `${entry.kind}:${entry.kind === 'prompt' ? entry.spec.prompt : entry.spec.command}`)).toEqual([
      'command:Stop-0.0',
      'prompt:Stop-0.1',
      'command:Stop-1.0',
      'prompt:Stop-2.0',
      'command:PreToolUse-0.0',
      'prompt:UserPromptSubmit-0.0',
    ])
  })
})

describe.skipIf(!posix)('a project prompt hook through trust', () => {
  it('pending until approved (no model call), then it runs on mock:prompt-hook', async () => {
    const h = await setup()
    await h.t.deps.settings.update({ hookModelRef: 'mock:prompt-hook' })
    await h.put('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is it done? [[ph:deny Run the tests.]]' }] }] } }))
    const opened = await h.t.deps.projects.openWorkspace(h.projectId)
    if (!opened.ok)
      throw new Error(opened.message)
    const scope = { chatId: '0199a8f0-0000-7000-8000-0000000000f1', projectId: h.projectId, workspace: opened.workspace, toolMode: 'ask' as const, origin: 'request' as const, modelRef: 'mock:echo' }
    const resolve = vi.spyOn(h.t.deps.providers, 'resolveModel')
    const listed = await h.t.deps.hooks.list({ projectId: h.projectId })
    expect(listed.items).toEqual([expect.objectContaining({ source: 'project', type: 'prompt', command: '', prompt: 'Is it done? [[ph:deny Run the tests.]]', state: 'pending', position: [0, 0] })])
    expect(listed.project?.pending).toBe(1)
    expect((await h.t.deps.hooks.snapshot(scope)).has('Stop')).toBe(false)
    expect(await h.t.deps.projectTrust.pending(h.projectId)).toBe(1)

    const [item] = (await h.t.deps.projectTrust.list(h.projectId)).items
    expect(item).toMatchObject({ kind: 'hook', state: 'pending', detail: { type: 'prompt' } })
    await h.t.deps.projectTrust.approve(h.projectId, [{ kind: 'hook', sha256: item!.sha256 }])
    expect((await h.t.deps.hooks.list({ projectId: h.projectId })).items[0]).toMatchObject({ state: 'active', type: 'prompt' })
    expect(resolve).not.toHaveBeenCalled()
    const result = await (await h.t.deps.hooks.snapshot(scope)).run('Stop', { stopHookActive: false }, { signal: new AbortController().signal })
    expect(result).toMatchObject({ block: true, reason: 'Run the tests.', record: { outcome: 'continued', hooks: [{ source: 'project', kind: 'prompt', model: 'mock:prompt-hook' }] } })
  })
})

describe('a file saved from the UI announces the pending count', () => {
  it('workspace.changed { source: user } → project-trust.changed with the new count, also before any read', async () => {
    const h = await setup()
    await h.put('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo one' }] }] } }))
    h.events.clear()
    // As W12.4 saves: the event, then the invalidation.
    h.events.emit('workspace.changed', { projectId: h.projectId, chatId: null, batchId: null, source: 'user', paths: ['.claude/settings.json'] })
    h.t.deps.projectConfig.invalidate(h.projectId)
    await vi.waitFor(() => expect(h.events.ofType('project-trust.changed').map(event => event.data)).toEqual([{ projectId: h.projectId, pending: 1 }]))

    await h.put('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo one' }, { type: 'prompt', prompt: 'Two?' }] }] } }))
    h.events.emit('workspace.changed', { projectId: h.projectId, chatId: null, batchId: null, source: 'user', paths: ['.claude/settings.json'] })
    h.t.deps.projectConfig.invalidate(h.projectId)
    await vi.waitFor(() => expect(h.events.ofType('project-trust.changed').map(event => event.data)).toEqual([{ projectId: h.projectId, pending: 1 }, { projectId: h.projectId, pending: 2 }]))
    // One announcement per save.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.events.ofType('project-trust.changed')).toHaveLength(2)
    // A user save elsewhere in the project announces nothing.
    const count = h.events.ofType('project-trust.changed').length
    h.events.emit('workspace.changed', { projectId: h.projectId, chatId: null, batchId: null, source: 'user', paths: ['src/app.ts'] })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.events.ofType('project-trust.changed')).toHaveLength(count)
    expect(trustSha256({ kind: 'hook', event: 'Stop', matcher: null, command: 'echo one', timeoutSec: null, refs: [] })).toMatch(/^[0-9a-f]{64}$/)
  })
})
