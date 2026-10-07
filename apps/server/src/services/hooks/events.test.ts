// The Phase 12 hook events in the snapshot (W12.5-T4 / -T5, ADR-057) with the `record` script: the payloads and the
// matcher subjects of PostToolUseFailure, PermissionRequest, SubagentStart, SubagentStop (agent matching), PostCompact
// and SessionEnd; the PermissionRequest decisions; `SessionEnd` on a single chat delete only (never delete-all or a
// project delete), within its budget, killed by `stop()`. Every spawned pid is dead at the end of each test.
import process from 'node:process'
import { hookAgentNames, LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_SCRIPT_TEXT, readHookLog, readSleepPids, writeHookScript } from '../../testing/hook-scripts.ts'
import { NOTHING_RAN } from './index.ts'
import { sessionEndBudgetMs } from './session-end.ts'
import { alive, createHookTestKit, hookScope, testSignal, waitFor } from './testing.ts'

const posix = process.platform !== 'win32'
const kit = createHookTestKit()
afterEach(kit.cleanup)

type Payload = Record<string, unknown> & { harness: Record<string, unknown> }

describe.skipIf(!posix)('the new events in the snapshot', () => {
  it('postToolUseFailure: tool names, the error in the payload; a block is feedback linked to the call', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'PostToolUseFailure', matcher: 'Bash', command: await writeHookScript(h.root, 'record') })
    await h.hooks.create({ event: 'PostToolUseFailure', matcher: 'Bash', command: await writeHookScript(h.root, 'exit2', { text: 'Run the linter first.' }) })
    const snapshot = await h.hooks.snapshot(hookScope(h))
    const result = await snapshot.run('PostToolUseFailure', { messageId: 'msg_1', tool: { name: 'shell', callId: 'call-9', input: { command: 'make' } }, error: 'make: *** [all] Error 2' }, { signal: testSignal(), target: 'shell' })
    expect(result).toMatchObject({ ran: true, block: true, reason: 'Run the linter first.', record: { event: 'PostToolUseFailure', outcome: 'blocked', toolCallId: 'call-9', toolName: 'shell' } })
    const [payload] = await readHookLog(h.root) as Payload[]
    expect(payload).toMatchObject({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'make' }, error: 'make: *** [all] Error 2', tool_use_id: 'call-9' })
    // Another tool: the Bash matcher does not match.
    expect((await snapshot.run('PostToolUseFailure', { tool: { name: 'read_file', callId: 'c', input: {} }, error: 'x' }, { signal: testSignal(), target: 'read_file' })).ran).toBe(false)
  })

  it('permissionRequest: allow and deny decisions through readHookOutput, records linked to the call', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'PermissionRequest', matcher: 'Write', command: await writeHookScript(h.root, 'permission-allow') })
    await h.hooks.create({ event: 'PermissionRequest', matcher: 'Bash', command: await writeHookScript(h.root, 'permission-deny') })
    await h.hooks.create({ event: 'PermissionRequest', command: await writeHookScript(h.root, 'record') })
    const snapshot = await h.hooks.snapshot(hookScope(h))
    const write = await snapshot.run('PermissionRequest', { tool: { name: 'write_file', callId: 'w1', input: { path: 'a.txt' } } }, { signal: testSignal(), target: 'write_file' })
    expect(write).toMatchObject({ decision: 'allow', block: false, continue: true, record: { event: 'PermissionRequest', outcome: 'allowed', toolCallId: 'w1', toolName: 'write_file' } })
    const shell = await snapshot.run('PermissionRequest', { tool: { name: 'shell', callId: 's1', input: { command: 'rm -rf /' } } }, { signal: testSignal(), target: 'shell' })
    expect(shell).toMatchObject({ decision: 'deny', block: true, reason: HOOK_SCRIPT_TEXT.permissionDeny, record: { outcome: 'denied', toolCallId: 's1' } })
    // A hook without a decision: no decision, no record.
    expect(await snapshot.run('PermissionRequest', { tool: { name: 'read_file', callId: 'r1', input: {} } }, { signal: testSignal(), target: 'read_file' })).toEqual({ ...NOTHING_RAN, ran: true })
    const log = await readHookLog(h.root) as Payload[]
    expect(log.map(entry => [entry.hook_event_name, entry.tool_name, entry.tool_use_id])).toEqual([['PermissionRequest', 'Write', 'w1'], ['PermissionRequest', 'Bash', 's1'], ['PermissionRequest', 'Read', 'r1']])
  })

  it('subagentStart and SubagentStop match the agent type (Claude names too); the payload names the agent', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'SubagentStart', matcher: 'general-purpose', command: await writeHookScript(h.root, 'agent-context') })
    await h.hooks.create({ event: 'SubagentStart', matcher: 'Explore', command: await writeHookScript(h.root, 'record', { file: 'record-start' }) })
    await h.hooks.create({ event: 'SubagentStop', matcher: 'Explore', command: await writeHookScript(h.root, 'record') })
    const snapshot = await h.hooks.snapshot(hookScope(h))
    const general = { id: 'call-1', type: 'general' }
    const start = await snapshot.run('SubagentStart', { messageId: 'msg_1', agent: general }, { signal: testSignal(), target: general.type, aliases: hookAgentNames(general.type) })
    expect(start).toMatchObject({ ran: true, context: HOOK_SCRIPT_TEXT.agentContext })
    const explore = { id: 'call-2', type: 'explore' }
    // The default subjects come from the target (or the input's agent) when no aliases are given.
    expect((await snapshot.run('SubagentStart', { agent: explore }, { signal: testSignal() })).ran).toBe(true)
    expect((await snapshot.run('SubagentStop', { stopHookActive: false, agent: general }, { signal: testSignal() })).ran).toBe(false)
    expect((await snapshot.run('SubagentStop', { stopHookActive: true, agent: explore }, { signal: testSignal(), target: 'explore' })).ran).toBe(true)
    // Without an agent (the v1.7 input) the matcher is ignored, as it was.
    expect((await snapshot.run('SubagentStop', { stopHookActive: false }, { signal: testSignal() })).ran).toBe(true)
    const log = await readHookLog(h.root) as Payload[]
    expect(log.map(entry => [entry.hook_event_name, entry.agent_id ?? null, entry.agent_type ?? null])).toEqual([
      ['SubagentStart', 'call-2', 'explore'],
      ['SubagentStop', 'call-2', 'explore'],
      ['SubagentStop', null, null],
    ])
  })

  it('postCompact matches its trigger; the payload carries it', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'PostCompact', matcher: 'manual', command: await writeHookScript(h.root, 'record') })
    const snapshot = await h.hooks.snapshot(hookScope(h))
    expect((await snapshot.run('PostCompact', { trigger: 'auto' }, { signal: testSignal() })).ran).toBe(false)
    expect(await snapshot.run('PostCompact', { trigger: 'manual', messageId: 'msg_1' }, { signal: testSignal() })).toEqual({ ...NOTHING_RAN, ran: true })
    const [payload] = await readHookLog(h.root) as Payload[]
    expect(payload).toMatchObject({ hook_event_name: 'PostCompact', trigger: 'manual' })
  })

  it('prompt handlers only for the seven events: a SessionStart prompt hook is refused', async () => {
    const h = await kit.open()
    await expect(h.hooks.create({ type: 'prompt', event: 'SessionStart', prompt: 'Hello' })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(h.hooks.create({ type: 'prompt', event: 'PostCompact', prompt: 'Hello' })).rejects.toMatchObject({ code: 'validation_error' })
  })
})

describe('sessionEnd budget', () => {
  it('1.5 s, raised by the explicit timeouts of matching handlers, at most 60 s', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'SessionEnd', command: 'sh a.sh' })
    const base = await h.hooks.snapshot(hookScope(h))
    expect(base.has('SessionEnd')).toBe(true)
    const hook = (timeoutSec: number | null, matcher: string | null = null) => ({ kind: 'command', source: 'personal', event: 'SessionEnd', matcher, compiled: { ok: true, test: (name: string) => matcher === null || name === matcher }, command: 'x', timeoutSec, label: 'x' }) as const
    expect(sessionEndBudgetMs([])).toBe(LIMITS.sessionEndBudgetMs)
    expect(sessionEndBudgetMs([hook(null)])).toBe(1500)
    expect(sessionEndBudgetMs([hook(1)])).toBe(1500)
    expect(sessionEndBudgetMs([hook(5)])).toBe(5000)
    expect(sessionEndBudgetMs([hook(5, 'logout')])).toBe(1500)
    expect(sessionEndBudgetMs([hook(600)])).toBe(LIMITS.sessionEndBudgetMaxMs)
  })
})

describe.skipIf(!posix)('sessionEnd', () => {
  it('a single chat delete runs SessionEnd once (reason other); delete-all and a project delete never do', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'SessionEnd', command: await writeHookScript(h.root, 'record') })
    await h.hooks.create({ event: 'SessionEnd', matcher: 'logout', command: await writeHookScript(h.root, 'record', { file: 'never' }) })
    const chat = await h.t.deps.chats.create({ projectId: h.project.id, settings: { toolMode: 'edits' }, modelRef: 'mock:echo' })
    const removed = await h.t.request(`/api/chats/${chat.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    await waitFor(async () => (await readHookLog(h.root)).length === 1)
    const [payload] = await readHookLog(h.root) as Payload[]
    expect(payload).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'other', session_id: chat.id, permission_mode: 'acceptEdits', cwd: h.root, harness: { chatId: chat.id, projectId: h.project.id, origin: 'request' } })
    expect(payload).not.toHaveProperty('transcript_path')

    await h.t.deps.chats.create({ projectId: h.project.id })
    await h.t.deps.chats.create({})
    const all = await h.t.request('/api/data/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) })
    expect(all.status).toBe(200)
    await h.t.deps.chats.create({ projectId: h.project.id })
    expect((await h.t.request(`/api/projects/${h.project.id}`, { method: 'DELETE' })).status).toBe(204)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await readHookLog(h.root)).toHaveLength(1)
    expect(h.spawned).toHaveLength(1)
  })

  it('the 1.5 s budget kills a slow hook; stop() kills one in flight and sessionEnd resolves; nothing after stop()', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'SessionEnd', command: await writeHookScript(h.root, 'sleep') })
    const chat = { id: '0199a8f0-0000-7000-8000-0000000000e1', projectId: h.project.id, modelRef: 'mock:echo', settings: {} }
    const started = Date.now()
    await h.hooks.sessionEnd(chat)
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(1400)
    expect(elapsed).toBeLessThan(4000)
    const sleepers = await readSleepPids(h.root)
    kit.pids.push(...sleepers)
    await waitFor(() => sleepers.every(pid => !alive(pid)))

    // An explicit timeout raises the budget; stop() ends it early.
    const second = await kit.open()
    await second.hooks.create({ event: 'SessionEnd', command: await writeHookScript(second.root, 'sleep'), timeout: 30 })
    const running = second.hooks.sessionEnd({ ...chat, projectId: second.project.id })
    await waitFor(async () => (await readSleepPids(second.root)).length === 2)
    kit.pids.push(...await readSleepPids(second.root))
    await second.hooks.stop()
    await running
    await second.hooks.sessionEnd({ ...chat, projectId: second.project.id })
    expect(second.spawned).toHaveLength(1)
  })
})
