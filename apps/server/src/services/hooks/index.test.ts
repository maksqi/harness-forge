// Tests of the hook service (Phase 11, W11.1; ADR-048): real `sh` hook processes from `testing/hook-scripts.ts` in
// `realpath(mkdtemp())` projects invoked as `sh <relative path>`, the C36 fakes of the project config reader and project
// trust, plugin command hooks through a spied registry and plugin code hooks registered on the `mock` builtin. Every
// spawned pid (the shells and the background `sleep`s) is dead at the end of each test.
import type { HookEvent, HookSpec, ProjectSummary, ServerEvent } from '@harness-forge/shared'
import type { RegisteredHookCommands } from '../../registry/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeProjectConfigService } from '../../testing/fake-project-config.ts'
import type { FakeProjectTrustService } from '../../testing/fake-project-trust.ts'
import type { OpenWorkspace } from '../projects/types.ts'
import type { HookServiceOptions } from './index.ts'
import type { HookRunInput, HookScope, HookService } from './types.ts'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { HOOK_EVENTS, hookDataSchema, hookListSchema, hookRunSchema, LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hooks as hooksTable } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { fakeProjectConfigSnapshot, fakeProjectHookItem } from '../../testing/fake-project-config.ts'
import { HOOK_SCRIPT_TEXT, readHookEnv, readHookLog, readSleepPids, writeHookScript } from '../../testing/hook-scripts.ts'
import { commandHooksAllowed, createHookService, emptyHookSnapshot, NOTHING_RAN, personalHookEntry } from './index.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-0000000000c1'
const posix = process.platform !== 'win32'

const cleanups: Array<() => Promise<void> | void> = []
/** Every pid a test started (shells via `onSpawn`, plus the `sleep` pids it read): all must be dead afterwards. */
const pids: number[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for a condition.')
    await delay(20)
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
  const started = pids.splice(0)
  // A killed process may stay a zombie for a moment until its parent (or init) reaps it.
  await waitFor(() => started.every(pid => !alive(pid)))
})

interface Harness {
  t: TestApp
  hooks: HookService
  project: ProjectSummary
  /** The project folder (canonical). */
  root: string
  workspace: OpenWorkspace
  config: FakeProjectConfigService
  trust: FakeProjectTrustService
  events: ServerEvent[]
  /** Shell pids in spawn order. */
  spawned: number[]
}

async function open(options: { env?: Record<string, string>, service?: HookServiceOptions } = {}): Promise<Harness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const spawned: number[] = []
  const t = await createTestApp({
    workspaceRoots: [base],
    env: { HF_MOCK_PROVIDER: '1', ...options.env },
    projectConfig: 'fake',
    projectTrust: 'fake',
    factories: {
      hooks: deps => createHookService(deps, {
        ...options.service,
        runner: {
          killGraceMs: 200,
          ...options.service?.runner,
          onSpawn: (pid) => {
            spawned.push(pid)
            pids.push(pid)
          },
        },
      }),
    },
  })
  cleanups.push(() => t.close())
  const project = await t.deps.projects.create({ name: 'Demo', path: base, newFolder: 'demo' })
  const opened = await t.deps.projects.openWorkspace(project.id)
  if (!opened.ok)
    throw new Error(opened.message)
  const events: ServerEvent[] = []
  const subscription = t.deps.events.subscribe(event => events.push(event))
  cleanups.push(() => subscription.dispose())
  return {
    t,
    hooks: t.deps.hooks,
    project,
    root: opened.workspace.root,
    workspace: opened.workspace,
    config: t.deps.projectConfig as FakeProjectConfigService,
    trust: t.deps.projectTrust as FakeProjectTrustService,
    events,
    spawned,
  }
}

function scope(h: Harness, fields: Partial<HookScope> = {}): HookScope {
  return { chatId: CHAT_ID, projectId: h.project.id, workspace: h.workspace, toolMode: 'ask', origin: 'request', modelRef: 'mock:echo', ...fields }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

/** Plugin command hooks of `mock` (the registry's registration is W11.7's; spied here). */
function pluginHooks(h: Harness, root: string, specs: ReadonlyArray<Partial<HookSpec> & { command: string, event: HookEvent }>): void {
  const registration: RegisteredHookCommands = {
    pluginId: 'mock',
    root,
    hooks: specs.map((spec, index) => ({ matcher: null, timeoutSec: null, position: [0, index] as const, ...spec })),
    diagnostics: [],
  }
  vi.spyOn(h.t.deps.registry.hookCommands, 'list').mockReturnValue([registration])
}

/** Sets the project's scan (rooted at the real project folder) and approves `approved`. */
function projectItems(h: Harness, items: ReturnType<typeof fakeProjectHookItem>[], approved: ReturnType<typeof fakeProjectHookItem>[] = items): void {
  h.config.snapshots.set(h.project.id, fakeProjectConfigSnapshot(h.project.id, { root: h.root, hooks: items }))
  h.trust.approvedHashes.set(h.project.id, new Set(approved.map(item => item.sha256)))
}

const TOOL = { name: 'write_file', callId: 'call-1', input: { path: 'notes.txt', content: 'hi' } }

describe.skipIf(!posix)('hook service: sources', () => {
  it('personal, plugin and approved project hooks all run for one event; a pending project item never runs', async () => {
    const h = await open()
    expect(h.t.deps.plugins.isActive('mock')).toBe(true)
    const command = await writeHookScript(h.root, 'record')
    const sentinel = await writeHookScript(h.root, 'record', { file: 'pending' })
    await h.hooks.create({ event: 'UserPromptSubmit', command })
    pluginHooks(h, h.root, [{ event: 'UserPromptSubmit', command }])
    const approved = fakeProjectHookItem({ event: 'UserPromptSubmit', command })
    // The same item in a second settings file: identical hashes run once.
    const twin = fakeProjectHookItem({ event: 'UserPromptSubmit', command }, { path: '.harness/settings.json' })
    const pending = fakeProjectHookItem({ event: 'UserPromptSubmit', command: sentinel })
    expect(twin.sha256).toBe(approved.sha256)
    projectItems(h, [approved, twin, pending], [approved])

    const snapshot = await h.hooks.snapshot(scope(h))
    expect(snapshot.scope.chatId).toBe(CHAT_ID)
    expect(snapshot.has('UserPromptSubmit')).toBe(true)
    expect(snapshot.has('Stop')).toBe(false)
    const result = await snapshot.run('UserPromptSubmit', { prompt: 'hello', messageId: 'msg_1' }, { signal: signal() })
    expect(result).toEqual({ ...NOTHING_RAN, ran: true })
    const log = await readHookLog(h.root) as Array<{ harness: { source: string } }>
    expect(log.map(entry => entry.harness.source).sort()).toEqual(['personal', 'plugin', 'project'])
    expect(h.spawned).toHaveLength(3)
  })

  it('a project without approvals is never read; a snapshot never opens the project folder itself', async () => {
    const h = await open()
    const opens = vi.spyOn(h.t.deps.projects, 'openWorkspace')
    h.config.snapshots.set(h.project.id, fakeProjectConfigSnapshot(h.project.id, { root: h.root, hooks: [fakeProjectHookItem({ event: 'Stop', command: 'sh x.sh' })] }))
    expect((await h.hooks.snapshot(scope(h))).has('Stop')).toBe(false)
    expect(h.config.reads).toEqual([])
    h.trust.approvedHashes.set(h.project.id, new Set(['f'.repeat(64)]))
    expect((await h.hooks.snapshot(scope(h))).has('Stop')).toBe(false)
    expect(h.config.reads).toEqual([{ projectId: h.project.id, refresh: false }])
    expect(opens).not.toHaveBeenCalled()
  })

  it('a snapshot is immutable; without a workspace no project hook runs; an unread source is left out', async () => {
    const h = await open()
    const command = await writeHookScript(h.root, 'record')
    projectItems(h, [fakeProjectHookItem({ event: 'Stop', command })])
    const before = await h.hooks.snapshot(scope(h, { projectId: null, workspace: null }))
    expect(before.has('Stop')).toBe(false)
    await h.hooks.create({ event: 'Stop', command: 'sh missing.sh' })
    expect(before.has('Stop')).toBe(false)
    expect((await h.hooks.snapshot(scope(h, { projectId: null, workspace: null }))).has('Stop')).toBe(true)

    // A scan of another folder than the one the run opened is never used.
    h.config.snapshots.set(h.project.id, fakeProjectConfigSnapshot(h.project.id, { root: '/elsewhere', hooks: [fakeProjectHookItem({ event: 'PostToolUse', command })] }))
    expect((await h.hooks.snapshot(scope(h))).has('PostToolUse')).toBe(false)

    // A failing source is left out; the others stay.
    vi.spyOn(h.config, 'snapshot').mockRejectedValue(new Error('disk on fire'))
    const snapshot = await h.hooks.snapshot(scope(h))
    expect(snapshot.has('Stop')).toBe(true)
  })

  it('an aborted signal rejects snapshot and run', async () => {
    const h = await open()
    await h.hooks.create({ event: 'Stop', command: 'sh x.sh' })
    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(h.hooks.snapshot(scope(h), { signal: aborted.signal })).rejects.toThrow('stopped')
    const snapshot = await h.hooks.snapshot(scope(h))
    await expect(snapshot.run('Stop', { stopHookActive: false }, { signal: aborted.signal })).rejects.toThrow('stopped')
    expect(h.spawned).toEqual([])
    expect(emptyHookSnapshot(scope(h)).has('Stop')).toBe(false)
  })
})

describe.skipIf(!posix)('hook service: matching', () => {
  it('tool matchers: "Write" matches write_file, "Bash|Write" and "*" match, a regex-looking matcher never runs', async () => {
    const h = await open()
    for (const [matcher, text] of [['Write', 'A'], ['Bash|Write', 'B'], ['*', 'C'], ['mcp__memory__.*', 'M']] as const)
      await h.hooks.create({ event: 'PreToolUse', matcher, command: await writeHookScript(h.root, 'allow', { file: `allow-${text}`, text }) })
    // Written directly (never validated): listed invalid, never run.
    await h.t.db.insert(hooksTable).values({ id: 'hok_DDDDDDDDDDDDDDDD', event: 'PreToolUse', matcher: '^Bash', command: await writeHookScript(h.root, 'deny'), createdAt: 1, updatedAt: 1 })
    const snapshot = await h.hooks.snapshot(scope(h))
    const reasons = async (target: string, aliases?: string[]): Promise<string[]> => {
      const result = await snapshot.run('PreToolUse', { tool: { name: target, callId: `c-${target}`, input: {} } }, { signal: signal(), target, ...(aliases === undefined ? {} : { aliases }) })
      expect(result.decision).toBe('allow')
      return (result.reason ?? '').split('\n').sort()
    }
    expect(await reasons('write_file')).toEqual(['A', 'B', 'C'])
    expect(await reasons('shell')).toEqual(['B', 'C'])
    expect(await reasons('read_file')).toEqual(['C'])
    expect(await reasons('mcp__mem__store', ['mcp__mem__store', 'mcp__memory__store'])).toEqual(['C', 'M'])
    const list = await h.hooks.list({})
    expect(list.items.find(item => item.id === 'hok_DDDDDDDDDDDDDDDD')).toMatchObject({ state: 'invalid', diagnostics: [{ code: 'invalid-matcher' }] })
  })

  it('sessionStart matches its source, PreCompact its trigger; UserPromptSubmit and Stop ignore the matcher', async () => {
    const h = await open()
    for (const [event, matcher, text] of [
      ['SessionStart', 'startup', 'on startup'],
      ['SessionStart', 'compact', 'after compact'],
      ['UserPromptSubmit', 'NoSuchTool', 'every prompt'],
    ] as const)
      await h.hooks.create({ event, matcher, command: await writeHookScript(h.root, 'context', { file: `ctx-${matcher}`, text }) })
    const snapshot = await h.hooks.snapshot(scope(h))
    expect((await snapshot.run('SessionStart', { sessionSource: 'startup' }, { signal: signal() })).context).toBe('on startup')
    expect((await snapshot.run('SessionStart', { sessionSource: 'compact' }, { signal: signal() })).context).toBe('after compact')
    expect((await snapshot.run('UserPromptSubmit', { prompt: 'x' }, { signal: signal() })).context).toBe('every prompt')
  })
})

describe.skipIf(!posix)('hook service: runner', () => {
  it('the record script sees the payload on stdin: Claude fields + harness', async () => {
    const h = await open()
    await h.hooks.create({ event: 'PreToolUse', matcher: 'Write', command: await writeHookScript(h.root, 'record') })
    const snapshot = await h.hooks.snapshot(scope(h, { toolMode: 'edits' }))
    const result = await snapshot.run('PreToolUse', { messageId: 'msg_1', tool: TOOL }, { signal: signal(), target: 'write_file' })
    expect(result).toEqual({ ...NOTHING_RAN, ran: true })
    const [payload] = await readHookLog(h.root)
    expect(payload).toEqual({
      session_id: CHAT_ID,
      cwd: h.root,
      permission_mode: 'acceptEdits',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: TOOL.input,
      tool_use_id: 'call-1',
      harness: { version: 1, chatId: CHAT_ID, projectId: h.project.id, messageId: 'msg_1', modelRef: 'mock:echo', origin: 'request', tool: 'write_file', source: 'personal' },
    })
  })

  it('the environment: the project-dir variables, the plugin root, never HF_* or provider keys', async () => {
    vi.stubEnv('HF_PROBE_SECRET', 'hf-secret-value')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key')
    const h = await open()
    const command = await writeHookScript(h.root, 'env')
    await h.hooks.create({ event: 'Stop', command })
    let snapshot = await h.hooks.snapshot(scope(h))
    await snapshot.run('Stop', { stopHookActive: false }, { signal: signal() })
    const env = await readHookEnv(h.root)
    expect(env.HARNESS_PROJECT_DIR).toBe(h.root)
    expect(env.CLAUDE_PROJECT_DIR).toBe(h.root)
    expect(env.HARNESS_PLUGIN_ROOT).toBeUndefined()
    expect(Object.keys(env).filter(key => key.startsWith('HF_'))).toEqual([])
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain('sk-ant-test-key')

    // A plugin hook also gets its folder.
    await h.hooks.remove((await h.hooks.list({})).items[0]!.id!)
    pluginHooks(h, '/opt/plugins/mock', [{ event: 'Stop', command }])
    snapshot = await h.hooks.snapshot(scope(h))
    await snapshot.run('Stop', { stopHookActive: false }, { signal: signal() })
    const pluginEnv = await readHookEnv(h.root)
    expect(pluginEnv.HARNESS_PLUGIN_ROOT).toBe('/opt/plugins/mock')
    expect(pluginEnv.CLAUDE_PLUGIN_ROOT).toBe('/opt/plugins/mock')
  })

  it('without a project folder the hooks run in <dataDir>/hooks (0700)', async () => {
    const h = await open()
    const dir = join(h.t.env.dataDir, 'hooks')
    // The script lives in the hooks folder itself (relative path, like a project's).
    const command = await writeHookScript(dir, 'record')
    await h.hooks.create({ event: 'Stop', command })
    const snapshot = await h.hooks.snapshot(scope(h, { projectId: null, workspace: null }))
    await snapshot.run('Stop', { stopHookActive: false }, { signal: signal() })
    const [payload] = await readHookLog(dir) as Array<{ cwd: string, harness: { projectId: unknown } }>
    expect(payload?.cwd).toBe(dir)
    expect(payload?.harness.projectId).toBeNull()
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })

  it('a timeout kills the hook and its grandchild and leaves a non-blocking error record', async () => {
    const h = await open()
    await h.hooks.create({ event: 'Stop', command: await writeHookScript(h.root, 'sleep'), timeout: 1 })
    const snapshot = await h.hooks.snapshot(scope(h))
    const result = await snapshot.run('Stop', { stopHookActive: false }, { signal: signal() })
    const sleepers = await readSleepPids(h.root)
    pids.push(...sleepers)
    expect(sleepers).toHaveLength(2)
    expect(result).toMatchObject({ ran: true, block: false, continue: true })
    expect(result.record).toMatchObject({ event: 'Stop', outcome: 'error', hooks: [{ source: 'personal', exitCode: null, timedOut: true, error: 'The hook timed out.' }] })
    expect(hookDataSchema.safeParse(result.record).success).toBe(true)
    await waitFor(() => sleepers.every(pid => !alive(pid)))
  })

  it('an abort kills the running hooks and rejects; a waiting hook never starts', async () => {
    const h = await open({ service: { processesMax: 2 } })
    const command = await writeHookScript(h.root, 'sleep')
    for (let index = 0; index < 3; index++)
      await h.hooks.create({ event: 'Stop', command })
    const snapshot = await h.hooks.snapshot(scope(h))
    const controller = new AbortController()
    const running = snapshot.run('Stop', { stopHookActive: false }, { signal: controller.signal })
    await waitFor(async () => (await readSleepPids(h.root)).length === 4)
    await delay(200)
    expect(h.spawned).toHaveLength(2)
    controller.abort(new DOMException('Stopped by the user.', 'AbortError'))
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.spawned).toHaveLength(2)
    const sleepers = await readSleepPids(h.root)
    pids.push(...sleepers)
    await waitFor(() => [...h.spawned, ...sleepers].every(pid => !alive(pid)))
    expect(h.hooks.runs()).toEqual([])
  })

  it('17 concurrent hooks wait for the server-wide semaphore of 16 processes', async () => {
    const h = await open()
    const command = await writeHookScript(h.root, 'sleep')
    for (let index = 0; index < LIMITS.hookProcessesMax + 1; index++)
      await h.hooks.create({ event: 'Stop', command })
    const snapshot = await h.hooks.snapshot(scope(h))
    const controller = new AbortController()
    const running = snapshot.run('Stop', { stopHookActive: false }, { signal: controller.signal })
    // Every admitted hook started its background sleep: 16 processes run, the 17th waits for a slot.
    await waitFor(async () => (await readSleepPids(h.root)).length === 2 * LIMITS.hookProcessesMax, 15_000)
    await delay(300)
    expect(h.spawned).toHaveLength(LIMITS.hookProcessesMax)
    controller.abort(new DOMException('Stopped by the user.', 'AbortError'))
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    pids.push(...await readSleepPids(h.root))
    expect(h.spawned).toHaveLength(LIMITS.hookProcessesMax)
  })

  it('stop() kills the running hooks; the run rejects', async () => {
    const h = await open()
    await h.hooks.create({ event: 'Stop', command: await writeHookScript(h.root, 'sleep') })
    const snapshot = await h.hooks.snapshot(scope(h))
    const running = snapshot.run('Stop', { stopHookActive: false }, { signal: signal() })
    await waitFor(async () => (await readSleepPids(h.root)).length === 2)
    await h.hooks.stop()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    const sleepers = await readSleepPids(h.root)
    pids.push(...sleepers)
    await waitFor(() => [...h.spawned, ...sleepers].every(pid => !alive(pid)))
    await expect(h.hooks.stop()).resolves.toBeUndefined()
  })

  it('at most 20 matching hooks run for one event', async () => {
    const h = await open()
    const command = await writeHookScript(h.root, 'record')
    for (let index = 0; index < LIMITS.hooksPerEventMax + 2; index++)
      await h.hooks.create({ event: 'Notification', command })
    const snapshot = await h.hooks.snapshot(scope(h))
    await snapshot.run('Notification', { message: 'The agent needs your permission to use Bash.', notificationType: 'permission_prompt' }, { signal: signal() })
    expect(await readHookLog(h.root)).toHaveLength(LIMITS.hooksPerEventMax)
  })
})

describe.skipIf(!posix)('hook service: results and records', () => {
  it('preToolUse: deny, ask, allow, rewrite, exit 2', async () => {
    const h = await open()
    const cases = [
      ['deny', { decision: 'deny', block: true }, { outcome: 'denied', reason: HOOK_SCRIPT_TEXT.deny }],
      ['ask', { decision: 'ask', block: false }, { outcome: 'asked', reason: HOOK_SCRIPT_TEXT.ask }],
      ['allow', { decision: 'allow', block: false }, { outcome: 'allowed', reason: HOOK_SCRIPT_TEXT.allow }],
      ['rewrite', { decision: null, block: false, updatedInput: { command: 'echo rewritten' } }, { outcome: 'rewritten', updatedInput: { command: 'echo rewritten' } }],
      ['exit2', { decision: 'deny', block: true }, { outcome: 'denied', reason: HOOK_SCRIPT_TEXT.exit2 }],
    ] as const
    for (const [name, expected, record] of cases) {
      const command = await writeHookScript(h.root, name)
      const created = await h.hooks.create({ event: 'PreToolUse', command })
      const snapshot = await h.hooks.snapshot(scope(h))
      const result = await snapshot.run('PreToolUse', { tool: { name: 'shell', callId: `c-${name}`, input: { command: 'ls' } } }, { signal: signal(), target: 'shell' })
      expect(result, name).toMatchObject({ ran: true, ...expected })
      expect(result.record, name).toMatchObject({ event: 'PreToolUse', toolCallId: `c-${name}`, toolName: 'shell', ...record })
      expect(hookDataSchema.safeParse(result.record).success, name).toBe(true)
      await h.hooks.remove(created.id)
    }
  })

  it('postToolUse context and exit 2; Stop continuation; UserPromptSubmit block; a failing hook', async () => {
    const h = await open()
    const run = async (event: HookEvent, command: string, input: HookRunInput) => {
      const created = await h.hooks.create({ event, command })
      const result = await (await h.hooks.snapshot(scope(h))).run(event, input, { signal: signal() })
      await h.hooks.remove(created.id)
      if (result.record !== null)
        expect(hookDataSchema.safeParse(result.record).success).toBe(true)
      return result
    }
    const post = { tool: { ...TOOL, output: { ok: true } } }
    const context = await writeHookScript(h.root, 'context')
    const exit2 = await writeHookScript(h.root, 'exit2')
    const stopOnce = await writeHookScript(h.root, 'stop-once')
    expect(await run('PostToolUse', context, post)).toMatchObject({ context: HOOK_SCRIPT_TEXT.context, record: { outcome: 'context', context: HOOK_SCRIPT_TEXT.context, toolCallId: 'call-1', toolName: 'write_file' } })
    expect(await run('PostToolUse', exit2, post)).toMatchObject({ block: true, reason: HOOK_SCRIPT_TEXT.exit2, record: { outcome: 'blocked', reason: HOOK_SCRIPT_TEXT.exit2 } })
    expect(await run('Stop', stopOnce, { stopHookActive: false })).toMatchObject({ block: true, reason: HOOK_SCRIPT_TEXT.stop, record: { outcome: 'continued', reason: HOOK_SCRIPT_TEXT.stop } })
    // Already a continuation: the script lets the agent stop (a silent success).
    expect(await run('Stop', stopOnce, { stopHookActive: true })).toEqual({ ...NOTHING_RAN, ran: true })
    expect(await run('UserPromptSubmit', await writeHookScript(h.root, 'prompt-block'), { prompt: 'x' })).toMatchObject({ block: true, reason: HOOK_SCRIPT_TEXT.promptBlock, record: { outcome: 'blocked' } })
    expect(await run('UserPromptSubmit', context, { prompt: 'x' })).toMatchObject({ block: false, context: HOOK_SCRIPT_TEXT.context, record: { outcome: 'context' } })
    const failed = await run('Stop', await writeHookScript(h.root, 'error', { text: 'STDERR-MARKER-41d' }), { stopHookActive: false })
    expect(failed).toMatchObject({ ran: true, block: false, continue: true, reason: null, record: { outcome: 'error', hooks: [{ exitCode: 1, error: 'The hook failed with exit code 1.' }] } })
    expect(JSON.stringify(failed.record)).not.toContain('STDERR-MARKER-41d')
    // SessionStart cannot block: exit 2 is an error whose stderr is the reason shown.
    expect(await run('SessionStart', exit2, { sessionSource: 'startup' })).toMatchObject({ block: false, record: { outcome: 'error', reason: HOOK_SCRIPT_TEXT.exit2 } })
  })
})

describe.skipIf(!posix)('hook service: verify-before-run', () => {
  it('a project item whose referenced script changed after the snapshot does not run and is announced', async () => {
    const h = await open()
    const command = await writeHookScript(h.root, 'record')
    const item = fakeProjectHookItem({ event: 'Stop', command }, { refs: [{ path: '.harness/hooks/record.sh', sha256: 'c'.repeat(64) }] })
    projectItems(h, [item])
    const snapshot = await h.hooks.snapshot(scope(h))
    expect(snapshot.has('Stop')).toBe(true)
    h.config.changed.add(item.sha256)
    const result = await snapshot.run('Stop', { stopHookActive: false }, { signal: signal() })
    expect(result).toEqual(NOTHING_RAN)
    expect(await readHookLog(h.root)).toEqual([])
    expect(h.spawned).toEqual([])
    expect(h.config.verified).toEqual([{ projectId: h.project.id, sha256: item.sha256 }])
    expect(h.config.invalidated).toContain(h.project.id)
    await waitFor(() => h.events.some(event => event.type === 'project-trust.changed'))
    expect(h.events.filter(event => event.type === 'project-trust.changed').map(event => event.data)).toEqual([{ projectId: h.project.id, pending: 0 }])
    expect(h.events.some(event => event.type === 'hooks.changed' && event.data.projectId === h.project.id)).toBe(true)

    // Unchanged: it runs (verified right before the spawn).
    h.config.changed.clear()
    await (await h.hooks.snapshot(scope(h))).run('Stop', { stopHookActive: false }, { signal: signal() })
    expect(await readHookLog(h.root)).toHaveLength(1)
  })
})

describe.skipIf(!posix)('hook service: kill switches', () => {
  for (const [name, env, update] of [
    ['the setting hooksEnabled', {}, true],
    ['HF_WORKSPACE_SHELL=0', { HF_WORKSPACE_SHELL: '0' }, false],
    ['HF_SAFE_MODE=1', { HF_SAFE_MODE: '1' }, false],
  ] as const) {
    it(`${name}: no command hook spawns; plugin code hooks still run`, async () => {
      const h = await open({ env })
      if (update)
        await h.t.deps.settings.update({ hooksEnabled: false })
      const command = await writeHookScript(h.root, 'record')
      await h.hooks.create({ event: 'UserPromptSubmit', command })
      pluginHooks(h, h.root, [{ event: 'UserPromptSubmit', command }])
      projectItems(h, [fakeProjectHookItem({ event: 'UserPromptSubmit', command })])
      const before = await h.hooks.snapshot(scope(h))
      expect(before.has('UserPromptSubmit')).toBe(false)
      expect(await before.run('UserPromptSubmit', { prompt: 'x' }, { signal: signal() })).toEqual(NOTHING_RAN)

      const code = h.t.deps.registry.hooks.on('mock', 'prompt.submit', (_input, output) => {
        output.context = 'from code'
      })
      cleanups.push(() => code.dispose())
      const snapshot = await h.hooks.snapshot(scope(h))
      expect(snapshot.has('UserPromptSubmit')).toBe(true)
      expect(await snapshot.run('UserPromptSubmit', { prompt: 'x' }, { signal: signal() })).toMatchObject({ ran: true, context: 'from code' })
      expect(await readHookLog(h.root)).toEqual([])
      expect(h.spawned).toEqual([])
      const list = await h.hooks.list({ projectId: h.project.id })
      expect(commandHooksAllowed(list.switches)).toBe(false)
      expect(list.items.filter(item => item.kind === 'command').map(item => [item.source, item.state])).toEqual([['personal', 'blocked'], ['plugin', 'blocked'], ['project', 'blocked']])
      expect(list.items.find(item => item.kind === 'code')).toMatchObject({ source: 'plugin', state: 'active', event: 'prompt.submit', pluginId: 'mock' })
    })
  }
})

describe.skipIf(!posix)('hook service: plugin code hooks', () => {
  it('prompt.submit, session.start, run.stop, subagent.stop, compact.before and notification join their events', async () => {
    const h = await open()
    const seen: Array<[string, unknown]> = []
    const handlers = [
      h.t.deps.registry.hooks.on('mock', 'prompt.submit', (input, output) => {
        seen.push(['prompt.submit', input])
        output.block = 'Not on Fridays.'
      }),
      h.t.deps.registry.hooks.on('mock', 'session.start', (input, output) => {
        seen.push(['session.start', input])
        output.context = 'Session context.'
      }),
      h.t.deps.registry.hooks.on('mock', 'run.stop', (input, output) => {
        seen.push(['run.stop', input])
        output.continue = 'Run the linter.'
      }),
      h.t.deps.registry.hooks.on('mock', 'subagent.stop', (input, output) => {
        seen.push(['subagent.stop', input])
        output.continue = 'Check again.'
      }),
      h.t.deps.registry.hooks.on('mock', 'compact.before', (input) => {
        seen.push(['compact.before', input])
      }),
      h.t.deps.registry.hooks.on('mock', 'notification', (input) => {
        seen.push(['notification', input])
      }),
    ]
    cleanups.push(() => handlers.forEach(handler => handler.dispose()))
    const snapshot = await h.hooks.snapshot(scope(h, { origin: 'hook' }))
    // The six events with a code hook; the tool events and the Phase 12 events have none.
    for (const event of HOOK_EVENTS)
      expect(snapshot.has(event), event).toBe(['UserPromptSubmit', 'SessionStart', 'Stop', 'SubagentStop', 'PreCompact', 'Notification'].includes(event))

    const prompt = await snapshot.run('UserPromptSubmit', { prompt: '/greet Ada', command: 'greet' }, { signal: signal() })
    expect(prompt).toMatchObject({ ran: true, block: true, reason: 'Not on Fridays.', record: { outcome: 'blocked', hooks: [{ source: 'plugin', label: 'mock: prompt.submit', pluginId: 'mock', exitCode: null }] } })
    expect(await snapshot.run('SessionStart', { sessionSource: 'compact' }, { signal: signal() })).toMatchObject({ context: 'Session context.', record: { outcome: 'context' } })
    expect(await snapshot.run('Stop', { stopHookActive: true }, { signal: signal() })).toMatchObject({ block: true, reason: 'Run the linter.', record: { outcome: 'continued' } })
    const task = { name: 'task', callId: 'task-1', input: { type: 'explore', prompt: 'look' }, output: 'Found it.' }
    expect(await snapshot.run('SubagentStop', { stopHookActive: false, tool: task }, { signal: signal() })).toMatchObject({ block: true, reason: 'Check again.', record: { outcome: 'blocked' } })
    expect(await snapshot.run('PreCompact', { trigger: 'manual', customInstructions: 'keep the plan' }, { signal: signal() })).toEqual({ ...NOTHING_RAN, ran: true })
    expect(await snapshot.run('Notification', { message: 'Needs you.', notificationType: 'permission_prompt' }, { signal: signal() })).toEqual({ ...NOTHING_RAN, ran: true })
    expect(seen).toEqual([
      ['prompt.submit', { chatId: CHAT_ID, modelRef: 'mock:echo', prompt: '/greet Ada', projectId: h.project.id, command: 'greet' }],
      ['session.start', { chatId: CHAT_ID, modelRef: 'mock:echo', source: 'compact', projectId: h.project.id }],
      ['run.stop', { chatId: CHAT_ID, modelRef: 'mock:echo', origin: 'hook', hookActive: true, projectId: h.project.id }],
      ['subagent.stop', { chatId: CHAT_ID, modelRef: 'mock:echo', type: 'explore', toolCallId: 'task-1', report: 'Found it.', hookActive: false }],
      ['compact.before', { chatId: CHAT_ID, modelRef: 'mock:echo', trigger: 'manual', focus: 'keep the plan' }],
      ['notification', { chatId: CHAT_ID, modelRef: 'mock:echo', type: 'permission_prompt', message: 'Needs you.' }],
    ])
    expect(h.hooks.runs().map(entry => [entry.event, entry.source, entry.label, entry.outcome])).toContainEqual(['UserPromptSubmit', 'plugin', 'mock: prompt.submit', 'blocked'])
  })

  it('command and code outcomes combine (a code block wins over a command context)', async () => {
    const h = await open()
    await h.hooks.create({ event: 'UserPromptSubmit', command: await writeHookScript(h.root, 'context') })
    const code = h.t.deps.registry.hooks.on('mock', 'prompt.submit', (_input, output) => {
      output.block = 'No.'
    })
    cleanups.push(() => code.dispose())
    const result = await (await h.hooks.snapshot(scope(h))).run('UserPromptSubmit', { prompt: 'x' }, { signal: signal() })
    expect(result).toMatchObject({ block: true, reason: 'No.', context: HOOK_SCRIPT_TEXT.context, record: { outcome: 'blocked', context: HOOK_SCRIPT_TEXT.context } })
    expect(result.record?.hooks.map(hook => hook.source)).toEqual(['personal', 'plugin'])
  })
})

describe.skipIf(!posix)('hook service: run log and logging', () => {
  it('runs: newest first, never a command, payload or output; info logs carry no command, payload or output', async () => {
    const h = await open()
    const context = await writeHookScript(h.root, 'context', { text: 'CONTEXT-MARKER-7f3' })
    await h.hooks.create({ event: 'UserPromptSubmit', command: context })
    await h.hooks.create({ event: 'UserPromptSubmit', command: await writeHookScript(h.root, 'error', { text: 'STDERR-MARKER-9c1' }) })
    const snapshot = await h.hooks.snapshot(scope(h))
    const result = await snapshot.run('UserPromptSubmit', { prompt: 'PROMPT-MARKER-2b8' }, { signal: signal() })
    expect(result.record?.outcome).toBe('context')
    await snapshot.run('Stop', { stopHookActive: false }, { signal: signal() })
    const runs = h.hooks.runs()
    expect(runs).toHaveLength(2)
    for (const entry of runs)
      expect(hookRunSchema.safeParse(entry).success).toBe(true)
    // Both hooks of the event (rows created in the same millisecond run in id order, so compare as a set).
    expect(runs.map(entry => [entry.event, entry.source, entry.exitCode, entry.outcome]).sort()).toEqual([
      ['UserPromptSubmit', 'personal', 0, 'context'],
      ['UserPromptSubmit', 'personal', 1, 'error'],
    ])
    expect(runs.every(entry => entry.id === result.record?.id && entry.chatId === CHAT_ID)).toBe(true)
    expect(h.hooks.runs(1)).toHaveLength(1)
    const serialized = JSON.stringify(runs)
    for (const marker of ['CONTEXT-MARKER-7f3', 'STDERR-MARKER-9c1', 'PROMPT-MARKER-2b8'])
      expect(serialized).not.toContain(marker)

    const info = h.t.logs.records.filter(record => record.level !== 'debug')
    const text = JSON.stringify(info)
    for (const marker of ['CONTEXT-MARKER-7f3', 'STDERR-MARKER-9c1', 'PROMPT-MARKER-2b8', 'context.sh', 'error.sh', 'hook_event_name'])
      expect(text, marker).not.toContain(marker)
    const ran = info.filter(record => record.msg === 'hook ran')
    expect(ran).toHaveLength(2)
    for (const record of ran) {
      expect(Object.keys(record).filter(key => !['time', 'level', 'msg', 'component'].includes(key)).sort()).toEqual(['durationMs', 'event', 'exitCode', 'hook', 'outcome', 'source'])
      expect(record.hook).toMatch(/^[0-9a-f]{12}$/)
    }
  })
})

describe('hook service: personal hooks', () => {
  it('create, update, remove: fresh auth, validation, the 100 cap, not_found, hooks.changed', async () => {
    const h = await open()
    const fresh = vi.fn()
    const created = await h.hooks.create({ event: 'PreToolUse', matcher: ' Write|Edit ', command: '  sh guard.sh  ', timeout: 30 }, { requireFreshAuth: fresh })
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(created).toMatchObject({ event: 'PreToolUse', matcher: 'Write|Edit', command: 'sh guard.sh', timeout: 30, enabled: true })
    expect(created.id).toMatch(/^hok_[0-9A-Z]{16}$/i)
    expect(h.events.filter(event => event.type === 'hooks.changed').map(event => event.data)).toEqual([{ projectId: null }])

    const refused = vi.fn(() => {
      throw new Error('fresh auth needed')
    })
    await expect(h.hooks.create({ event: 'Stop', command: 'sh x.sh' }, { requireFreshAuth: refused })).rejects.toThrow('fresh auth needed')
    await expect(h.hooks.update(created.id, { command: 'sh other.sh' }, { requireFreshAuth: refused })).rejects.toThrow('fresh auth needed')
    // Turning a hook off needs no fresh auth.
    const off = await h.hooks.update(created.id, { enabled: false }, { requireFreshAuth: refused })
    expect(off).toMatchObject({ id: created.id, enabled: false, command: 'sh guard.sh' })
    expect(off.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
    const changed = await h.hooks.update(created.id, { matcher: null, timeout: null, enabled: true }, { requireFreshAuth: fresh })
    expect(changed).toMatchObject({ matcher: null, timeout: null, enabled: true })

    await expect(h.hooks.create({ event: 'PreToolUse', matcher: '^Bash', command: 'sh x.sh' })).rejects.toMatchObject({ code: 'validation_error', details: { issues: [expect.objectContaining({ path: ['matcher'] })] } })
    await expect(h.hooks.update(created.id, { matcher: '(Write)+' })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(h.hooks.create({ event: 'Stop', command: '   ' })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(h.hooks.update('hok_ZZZZZZZZZZZZZZZZ', { enabled: false })).rejects.toMatchObject({ code: 'not_found', message: 'Hook hok_ZZZZZZZZZZZZZZZZ not found.' })
    await expect(h.hooks.remove('hok_ZZZZZZZZZZZZZZZZ')).rejects.toMatchObject({ code: 'not_found' })

    await h.hooks.remove(created.id)
    expect((await h.hooks.list({})).items).toEqual([])
    expect(h.events.filter(event => event.type === 'hooks.changed')).toHaveLength(4)

    await h.t.db.insert(hooksTable).values(Array.from({ length: LIMITS.personalHooksMax }, (_, index) => ({
      id: `hok_${String(index).padStart(16, '0')}`,
      event: 'Stop' as const,
      command: 'sh x.sh',
      createdAt: index,
      updatedAt: index,
    })))
    h.hooks.invalidate(null)
    await expect(h.hooks.create({ event: 'Stop', command: 'sh x.sh' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect((await h.hooks.list({})).items).toHaveLength(LIMITS.personalHooksMax)
  })
})

describe('hook service: list', () => {
  it('personal, plugin command and code hooks, the project hooks with their trust state and diagnostics; 404', async () => {
    const h = await open()
    const personal = await h.hooks.create({ event: 'Stop', command: 'sh stop.sh' })
    await h.hooks.create({ event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh', enabled: false })
    vi.spyOn(h.t.deps.registry.hookCommands, 'list').mockReturnValue([{
      pluginId: 'mock',
      root: '/opt/plugins/mock',
      hooks: [{ event: 'PostToolUse', matcher: 'Write', command: 'sh fmt.sh', timeoutSec: 30, position: [0, 0] }],
      diagnostics: [
        { level: 'info', code: 'ignored-field', message: 'The field "x" is ignored.', event: 'PostToolUse', position: [0, 0] },
        { level: 'info', code: 'unknown-event', message: 'The event "Other" is not supported; its hooks are ignored.' },
      ],
    }])
    const code = h.t.deps.registry.hooks.on('mock', 'run.stop', () => {})
    cleanups.push(() => code.dispose())
    const approved = fakeProjectHookItem({ event: 'PostToolUse', matcher: 'Edit', command: 'sh .claude/hooks/lint.sh', timeoutSec: 20, position: [0, 0] })
    const pending = fakeProjectHookItem({ event: 'Stop', command: 'sh .claude/hooks/tests.sh', position: [1, 0] }, { path: '.claude/settings.local.json' })
    h.config.snapshots.set(h.project.id, fakeProjectConfigSnapshot(h.project.id, {
      root: h.root,
      hooks: [approved, pending],
      hookDiagnostics: [
        { level: 'warning', code: 'invalid-timeout', message: 'The timeout is longer than 600 seconds; 600 seconds are used.', file: '.claude/settings.json', event: 'PostToolUse', position: [0, 0] },
        { level: 'error', code: 'invalid-json', message: 'The settings file is not valid JSON.', file: '.harness/settings.json' },
      ],
    }))
    h.trust.approvedHashes.set(h.project.id, new Set([approved.sha256]))

    const list = await h.hooks.list({ projectId: h.project.id })
    expect(hookListSchema.safeParse(list).success).toBe(true)
    expect(list.switches).toEqual({ setting: true, shell: true, safeMode: false })
    expect(list.items.map(item => [item.key, item.kind, item.source, item.state])).toEqual([
      [`personal:${personal.id}`, 'command', 'personal', 'active'],
      [expect.stringMatching(/^personal:hok_/), 'command', 'personal', 'off'],
      ['plugin:mock:0', 'command', 'plugin', 'active'],
      ['plugin:mock:code:run.stop:0', 'code', 'plugin', 'active'],
      [`project:${approved.sha256}`, 'command', 'project', 'active'],
      [`project:${pending.sha256}`, 'command', 'project', 'pending'],
    ])
    expect(list.items[2]).toMatchObject({ pluginId: 'mock', event: 'PostToolUse', matcher: 'Write', command: 'sh fmt.sh', timeout: 30, diagnostics: [{ code: 'ignored-field' }] })
    expect(list.items[4]).toMatchObject({ event: 'PostToolUse', matcher: 'Edit', command: 'sh .claude/hooks/lint.sh', timeout: 20, path: '.claude/settings.json', sha256: approved.sha256, diagnostics: [{ code: 'invalid-timeout' }] })
    expect(list.items[5]).toMatchObject({ path: '.claude/settings.local.json', diagnostics: [] })
    expect(list.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['unknown-event', 'invalid-json'])
    expect(list.project).toMatchObject({ id: h.project.id, available: true, files: ['.claude/settings.json', '.claude/settings.local.json'], pending: 1 })

    // Without projectId: no project hooks and no scan.
    const global = await h.hooks.list({})
    expect(global.project).toBeUndefined()
    expect(global.items.some(item => item.source === 'project')).toBe(false)

    // A plugin that is not active: its hooks are off.
    vi.spyOn(h.t.deps.plugins, 'isActive').mockReturnValue(false)
    expect((await h.hooks.list({})).items.filter(item => item.source === 'plugin').map(item => item.state)).toEqual(['off', 'off'])

    await expect(h.hooks.list({ projectId: 'prj_ZZZZZZZZZZZZZZZZ' })).rejects.toMatchObject({ code: 'not_found' })
    expect(personalHookEntry({ id: 'hok_AAAAAAAAAAAAAAAA', event: 'Stop', matcher: null, command: 'sh x.sh', timeout: null, enabled: true }, false).state).toBe('blocked')
  })

  it('an unavailable folder lists no project hooks', async () => {
    const h = await open()
    h.config.snapshots.set(h.project.id, { ...fakeProjectConfigSnapshot(h.project.id), available: false, issue: 'The project folder is not available.', root: null })
    const list = await h.hooks.list({ projectId: h.project.id })
    expect(list.project).toMatchObject({ available: false, issue: 'The project folder is not available.', files: [], pending: 0 })
  })
})

describe('hook service: events and invalidation', () => {
  it('registry changes of plugin hooks and workspace changes of .claude / .harness files emit hooks.changed', async () => {
    const h = await open()
    await h.hooks.list({})
    const code = h.t.deps.registry.hooks.on('mock', 'session.start', () => {})
    cleanups.push(() => code.dispose())
    // A hook of a pipeline event (not a Phase 11 event) is not a listed hook.
    const other = h.t.deps.registry.hooks.on('mock', 'chat.params', () => {})
    cleanups.push(() => other.dispose())
    h.t.deps.events.emit('workspace.changed', { projectId: h.project.id, chatId: null, batchId: null, source: 'tool', paths: ['.claude/settings.json'] })
    h.t.deps.events.emit('workspace.changed', { projectId: h.project.id, chatId: null, batchId: null, source: 'tool', paths: ['src/index.ts'] })
    await delay(0)
    expect(h.events.filter(event => event.type === 'hooks.changed').map(event => event.data)).toEqual([{ projectId: null }, { projectId: h.project.id }])
    h.hooks.invalidate(h.project.id)
    h.hooks.invalidate(null)
  })

  it('the kill switch hooksEnabled emits hooks.changed { projectId: null } once per change, before any other use; other settings never', async () => {
    const h = await open()
    const changed = () => h.events.filter(event => event.type === 'hooks.changed').map(event => event.data)
    // PUT /settings (the route) before the service was used at all.
    const response = await h.t.client.settings.update({ body: { hooksEnabled: false } })
    expect(response.hooksEnabled).toBe(false)
    await delay(0)
    expect(changed()).toEqual([{ projectId: null }])
    // The same value again and another key: nothing.
    await h.t.deps.settings.update({ hooksEnabled: false })
    await h.t.deps.settings.update({ displayName: 'Hooks test' })
    await delay(0)
    expect(changed()).toHaveLength(1)
    // Together with another key: once.
    await h.t.deps.settings.update({ hooksEnabled: true, displayName: 'Hooks test 2' })
    await delay(0)
    expect(changed()).toEqual([{ projectId: null }, { projectId: null }])
    // The listing follows the setting.
    const created = await h.hooks.create({ event: 'Stop', command: 'sh stop.sh' })
    expect((await h.hooks.list({})).items.map(item => item.state)).toEqual(['active'])
    await h.t.deps.settings.update({ hooksEnabled: false })
    await delay(0)
    expect(changed()).toHaveLength(4)
    expect((await h.hooks.list({})).items.map(item => [item.id, item.state])).toEqual([[created.id, 'blocked']])
    // After stop(): nothing.
    await h.hooks.stop()
    await h.t.deps.settings.update({ hooksEnabled: true })
    await delay(0)
    expect(changed()).toHaveLength(4)
  })
})

describe('hook service: personal hook states under the kill switches', () => {
  for (const [name, env, update] of [
    ['the setting hooksEnabled', {}, true],
    ['HF_WORKSPACE_SHELL=0', { HF_WORKSPACE_SHELL: '0' }, false],
    ['HF_SAFE_MODE=1', { HF_SAFE_MODE: '1' }, false],
  ] as const) {
    it(`${name}: a turned-off personal hook is off (never blocked), an enabled one blocked, an invalid one invalid`, async () => {
      const h = await open({ env })
      if (update)
        await h.t.deps.settings.update({ hooksEnabled: false })
      const on = await h.hooks.create({ event: 'Stop', command: 'sh on.sh' })
      const off = await h.hooks.create({ event: 'Stop', command: 'sh off.sh', enabled: false })
      const turnedOff = await h.hooks.create({ event: 'PreToolUse', matcher: 'Bash', command: 'sh later.sh' })
      await h.hooks.update(turnedOff.id, { enabled: false })
      // A stored matcher that no longer compiles (written past the API's validation).
      await h.t.db.insert(hooksTable).values({ id: 'hok_ZZZZZZZZZZZZZZZ1', event: 'PreToolUse', matcher: '^Bash', command: 'sh x.sh', createdAt: Date.now() + 1000, updatedAt: Date.now() + 1000 })
      await h.t.db.insert(hooksTable).values({ id: 'hok_ZZZZZZZZZZZZZZZ2', event: 'PreToolUse', matcher: '^Bash', command: 'sh y.sh', enabled: false, createdAt: Date.now() + 2000, updatedAt: Date.now() + 2000 })
      h.hooks.invalidate(null)
      const list = await h.hooks.list({})
      expect(commandHooksAllowed(list.switches)).toBe(false)
      expect(list.items.map(item => [item.id, item.state])).toEqual([
        [on.id, 'blocked'],
        [off.id, 'off'],
        [turnedOff.id, 'off'],
        ['hok_ZZZZZZZZZZZZZZZ1', 'invalid'],
        ['hok_ZZZZZZZZZZZZZZZ2', 'off'],
      ])
    })
  }

  it('personalHookEntry: off wins over invalid and blocked; blocked only for an enabled valid hook', () => {
    const row = { id: 'hok_AAAAAAAAAAAAAAAA', event: 'PreToolUse' as const, matcher: 'Bash', command: 'sh x.sh', timeout: null, enabled: true }
    expect(personalHookEntry(row, true).state).toBe('active')
    expect(personalHookEntry(row, false).state).toBe('blocked')
    expect(personalHookEntry({ ...row, enabled: false }, false).state).toBe('off')
    expect(personalHookEntry({ ...row, enabled: false }, true).state).toBe('off')
    expect(personalHookEntry({ ...row, matcher: '^Bash' }, false).state).toBe('invalid')
    expect(personalHookEntry({ ...row, matcher: '^Bash', enabled: false }, false).state).toBe('off')
  })
})
