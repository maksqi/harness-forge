// Prompt hooks (W12.5-T1, ADR-057): the runner against `MockLanguageModelV4` models (every event × every answer, the
// timeout, the model candidates, the usage row, the server-wide limiter, nothing of the prompt or the answer at `info`),
// and the hooks of the service on the `mock:prompt-hook` model (the kill switches, the record, the usage row).
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { HookEvent, Settings } from '@harness-forge/shared'
import type { ResolvedModel } from '../../providers/types.ts'
import type { UsageInput } from '../chats/types.ts'
import type { PromptHookCall, PromptHookRuntime } from './prompt-hooks.ts'
import { DEFAULT_SETTINGS, HarnessError, hookDataSchema, PROMPT_HOOK_EVENTS } from '@harness-forge/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { usage as usageTable } from '../../db/schema.ts'
import { createMemoryLogger } from '../../logger.ts'
import { writeHookScript } from '../../testing/hook-scripts.ts'
import { PROMPT_HOOK_ERRORS, PROMPT_HOOK_INSTRUCTIONS, promptHookModelCandidates, promptHookTimeoutMs, promptLabel, runPromptHook } from './prompt-hooks.ts'
import { eventResult } from './record.ts'
import { createSemaphore } from './semaphore.ts'
import { createHookTestKit, hookScope, stubModels, testSignal } from './testing.ts'

const PROMPT = 'Check that the agent kept the tests green. [[ph:secret-prompt-marker]]'
const PAYLOAD = '{"hook_event_name":"Stop","session_id":"chat-1"}'

function usageOf(input: number, output: number) {
  return { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } }
}

/** A model that answers `text`, recording its calls. */
function textModel(text: string, calls: LanguageModelV4CallOptions[] = []): LanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options)
      return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage: usageOf(12, 7), warnings: [] }
    },
  })
}

/** A model that answers only when its call is aborted (then it rejects). */
function silentModel(started?: () => void): LanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: options => new Promise((_resolve, reject) => {
      started?.()
      options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true })
    }),
  })
}

function resolved(modelRef: string, model: LanguageModelV4): ResolvedModel {
  const [providerId = '', modelId = ''] = modelRef.split(':')
  return {
    modelRef,
    providerId,
    modelId,
    model,
    info: { id: modelId },
    entry: { kind: 'chat', cost: { input: 1, output: 2 }, capabilities: { reasoning: false }, reasoningEfforts: [] },
    provider: { pluginId: 'demo', definition: { id: providerId, name: providerId, credentials: [], createLanguageModel: () => model } },
  } as unknown as ResolvedModel
}

interface Unit {
  readonly runtime: PromptHookRuntime
  readonly usage: UsageInput[]
  readonly asked: string[]
  readonly logs: ReturnType<typeof createMemoryLogger>
}

function unit(models: Record<string, LanguageModelV4>, settings: Partial<Settings> = {}, limit = 8): Unit {
  const usage: UsageInput[] = []
  const asked: string[] = []
  const logs = createMemoryLogger()
  const runtime: PromptHookRuntime = {
    deps: {
      settings: { get: async () => ({ ...DEFAULT_SETTINGS, ...settings }) },
      providers: {
        resolveModel: async (ref: string) => {
          asked.push(ref)
          const model = models[ref]
          if (model === undefined)
            throw new HarnessError({ code: 'provider_not_configured', message: 'not configured' })
          return resolved(ref, model)
        },
      },
      chats: {
        addUsage: async (input: UsageInput) => {
          usage.push(input)
        },
      },
      registry: { providers: { get: (id: string) => id === 'prov' ? { definition: { smallModelId: 'small' } } : undefined } },
    } as unknown as PromptHookRuntime['deps'],
    logger: logs.logger,
    limiter: createSemaphore(limit),
  }
  return { runtime, usage, asked, logs }
}

function call(fields: Partial<PromptHookCall> = {}): PromptHookCall {
  return { source: 'personal', prompt: PROMPT, model: null, timeoutSec: null, continueOnBlock: false, label: 'Check the tests', ...fields }
}

async function answer(u: Unit, event: HookEvent, fields: Partial<PromptHookCall> = {}) {
  const ran = await runPromptHook(u.runtime, { event, hook: call(fields), payload: PAYLOAD, chatId: 'chat-1', messageId: 'msg_1', runModelRef: 'prov:run', signal: testSignal() })
  const { result } = eventResult({ event, ran: [ran], id: 'hev_AAAAAAAAAAAAAAAA', createdAt: 1, tool: { callId: 'call-1', name: 'shell' } })
  return { ran, result }
}

const NO = '{"ok":false,"reason":"Not yet."}'
const IMPOSSIBLE = '{"ok":false,"reason":"Cannot be done.","impossible":true}'
const FENCED = 'Here is my answer:\n```json\n{"ok":false,"reason":"fenced"}\n```'

describe('prompt hooks: the runner', () => {
  it('sends the prompt with $ARGUMENTS as the payload, the instructions, 512 output tokens; records the usage', async () => {
    const calls: LanguageModelV4CallOptions[] = []
    const u = unit({ 'prov:small': textModel('{"ok":true}', calls) })
    const { ran, result } = await answer(u, 'Stop', { prompt: 'Look at $ARGUMENTS and decide.' })
    expect(ran).toMatchObject({ kind: 'prompt', model: 'prov:small', exitCode: null, timedOut: false, error: null })
    expect(result).toMatchObject({ ran: true, block: false, continue: true, record: null })
    const sent = JSON.stringify(calls[0]?.prompt)
    expect(sent).toContain(JSON.stringify(PROMPT_HOOK_INSTRUCTIONS).slice(1, -1))
    expect(sent).toContain(`Look at ${PAYLOAD.replace(/"/g, '\\"')} and decide.`)
    expect(calls[0]?.maxOutputTokens).toBe(512)
    expect(u.usage).toEqual([expect.objectContaining({ chatId: 'chat-1', messageId: 'msg_1', purpose: 'hook', providerId: 'prov', modelId: 'small', inputTokens: 12, outputTokens: 7 })])
  })

  it('every event × every answer: ok decides nothing; a "no" per event; impossible; fenced; invalid', async () => {
    const outcomes: Record<string, unknown> = {}
    for (const event of PROMPT_HOOK_EVENTS) {
      for (const [name, text] of [['ok', '{"ok":true}'], ['no', NO], ['impossible', IMPOSSIBLE], ['fenced', FENCED], ['invalid', 'I cannot decide.']] as const) {
        for (const continueOnBlock of event === 'PreToolUse' || event === 'PostToolUse' ? [false, true] : [false]) {
          const u = unit({ 'prov:small': textModel(text) })
          const { result } = await answer(u, event, { continueOnBlock })
          if (result.record !== null)
            expect(hookDataSchema.safeParse(result.record).success).toBe(true)
          outcomes[`${event}${continueOnBlock ? '+cob' : ''}:${name}`] = [result.record?.outcome ?? null, result.decision, result.block, result.continue]
        }
      }
    }
    expect(outcomes).toEqual({
      'PreToolUse:ok': [null, null, false, true],
      'PreToolUse:no': ['denied', 'deny', true, false],
      'PreToolUse:impossible': ['denied', 'deny', true, false],
      'PreToolUse:fenced': ['denied', 'deny', true, false],
      'PreToolUse:invalid': ['error', null, false, true],
      'PreToolUse+cob:ok': [null, null, false, true],
      'PreToolUse+cob:no': ['denied', 'deny', true, true],
      'PreToolUse+cob:impossible': ['denied', 'deny', true, true],
      'PreToolUse+cob:fenced': ['denied', 'deny', true, true],
      'PreToolUse+cob:invalid': ['error', null, false, true],
      'PostToolUse:ok': [null, null, false, true],
      'PostToolUse:no': ['stopped', null, false, false],
      'PostToolUse:impossible': ['stopped', null, false, false],
      'PostToolUse:fenced': ['stopped', null, false, false],
      'PostToolUse:invalid': ['error', null, false, true],
      'PostToolUse+cob:ok': [null, null, false, true],
      'PostToolUse+cob:no': ['blocked', null, true, true],
      'PostToolUse+cob:impossible': ['blocked', null, true, true],
      'PostToolUse+cob:fenced': ['blocked', null, true, true],
      'PostToolUse+cob:invalid': ['error', null, false, true],
      'PostToolUseFailure:ok': [null, null, false, true],
      'PostToolUseFailure:no': ['blocked', null, true, true],
      'PostToolUseFailure:impossible': ['blocked', null, true, true],
      'PostToolUseFailure:fenced': ['blocked', null, true, true],
      'PostToolUseFailure:invalid': ['error', null, false, true],
      'UserPromptSubmit:ok': [null, null, false, true],
      'UserPromptSubmit:no': ['blocked', null, true, true],
      'UserPromptSubmit:impossible': ['blocked', null, true, true],
      'UserPromptSubmit:fenced': ['blocked', null, true, true],
      'UserPromptSubmit:invalid': ['error', null, false, true],
      'Stop:ok': [null, null, false, true],
      'Stop:no': ['continued', null, true, true],
      'Stop:impossible': ['context', null, false, true],
      'Stop:fenced': ['continued', null, true, true],
      'Stop:invalid': ['error', null, false, true],
      'SubagentStop:ok': [null, null, false, true],
      'SubagentStop:no': ['blocked', null, true, true],
      'SubagentStop:impossible': ['context', null, false, true],
      'SubagentStop:fenced': ['blocked', null, true, true],
      'SubagentStop:invalid': ['error', null, false, true],
      'PermissionRequest:ok': [null, null, false, true],
      'PermissionRequest:no': ['context', null, false, true],
      'PermissionRequest:impossible': ['context', null, false, true],
      'PermissionRequest:fenced': ['context', null, false, true],
      'PermissionRequest:invalid': ['error', null, false, true],
    })
    // The reasons travel with the records; a "no" is never an allow.
    const u = unit({ 'prov:small': textModel(NO) })
    const permission = await answer(u, 'PermissionRequest')
    expect(permission.result.record).toMatchObject({ event: 'PermissionRequest', outcome: 'context', reason: 'Not yet.', toolCallId: 'call-1', hooks: [{ kind: 'prompt', model: 'prov:small' }] })
    expect(permission.result.decision).toBeNull()
    expect((await answer(unit({ 'prov:small': textModel(FENCED) }), 'Stop')).result.reason).toBe('fenced')
    const invalid = await answer(unit({ 'prov:small': textModel('I cannot decide.') }), 'Stop')
    expect(invalid.result.record?.hooks[0]).toMatchObject({ kind: 'prompt', error: 'The hook model did not answer with a JSON object.' })
  })

  it('a model that does not answer in time is a non-blocking error (timedOut); an aborted run rejects', async () => {
    const u = unit({ 'prov:small': silentModel() })
    const { ran, result } = await answer(u, 'PreToolUse', { timeoutSec: 1 })
    expect(ran).toMatchObject({ timedOut: true, error: PROMPT_HOOK_ERRORS.timeout, model: 'prov:small' })
    expect(result).toMatchObject({ block: false, decision: null, continue: true, record: { outcome: 'error', hooks: [{ timedOut: true }] } })
    expect(u.usage).toEqual([])

    const aborted = new AbortController()
    const running = runPromptHook(u.runtime, { event: 'Stop', hook: call(), payload: PAYLOAD, chatId: 'chat-1', messageId: null, runModelRef: 'prov:run', signal: aborted.signal })
    aborted.abort(new Error('stopped by the user'))
    await expect(running).rejects.toThrow('stopped by the user')
    expect(promptHookTimeoutMs(null)).toBe(30_000)
    expect(promptHookTimeoutMs(5)).toBe(5000)
    expect(promptHookTimeoutMs(9999)).toBe(600_000)
  })

  it('the model candidates: the handler model, a Claude name through modelAliases, hookModelRef, the small model, the run model', async () => {
    const u = unit({}, { hookModelRef: 'prov:hook', modelAliases: { sonnet: 'prov:sonnet', opus: null, haiku: null, fable: null } })
    const signal = testSignal()
    expect(await promptHookModelCandidates(u.runtime, 'prov:own', 'prov:run', signal)).toEqual(['prov:own', 'prov:hook', 'prov:small', 'prov:run'])
    expect(await promptHookModelCandidates(u.runtime, 'sonnet', 'prov:run', signal)).toEqual(['prov:sonnet', 'prov:hook', 'prov:small', 'prov:run'])
    // A Claude name without a model in the setting falls back to the hook model.
    expect(await promptHookModelCandidates(u.runtime, 'haiku', 'prov:run', signal)).toEqual(['prov:hook', 'prov:small', 'prov:run'])
    expect(await promptHookModelCandidates(unit({}).runtime, null, 'other:run', signal)).toEqual(['other:run'])

    // The first candidate that resolves answers; none → a non-blocking error.
    const fallback = unit({ 'prov:run': textModel('{"ok":true}') })
    expect((await answer(fallback, 'Stop', { model: 'prov:missing' })).ran.model).toBe('prov:run')
    expect(fallback.asked).toEqual(['prov:missing', 'prov:small', 'prov:run'])
    const none = unit({})
    const { ran, result } = await answer(none, 'UserPromptSubmit')
    expect(ran).toMatchObject({ kind: 'prompt', error: PROMPT_HOOK_ERRORS.noModel })
    expect(ran.model).toBeUndefined()
    expect(result).toMatchObject({ block: false, record: { outcome: 'error' } })
  })

  it('at most 8 prompt-hook calls run at once; the 9th waits for a slot', async () => {
    let running = 0
    let peak = 0
    const releases: Array<() => void> = []
    const model = new MockLanguageModelV4({
      doGenerate: () => new Promise((resolve) => {
        running += 1
        peak = Math.max(peak, running)
        releases.push(() => {
          running -= 1
          resolve({ content: [{ type: 'text', text: '{"ok":true}' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: usageOf(1, 1), warnings: [] })
        })
      }),
    })
    const u = unit({ 'prov:small': model })
    const calls = Array.from({ length: 9 }, () => answer(u, 'Stop'))
    await vi_waitFor(() => releases.length === 8)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(releases).toHaveLength(8)
    expect(u.runtime.limiter.waiting()).toBe(1)
    // One call ends: the waiting one takes its slot.
    releases.splice(0, 1)[0]!()
    await vi_waitFor(() => releases.length === 8)
    expect(u.runtime.limiter.waiting()).toBe(0)
    for (const release of releases.splice(0))
      release()
    await Promise.all(calls)
    expect(peak).toBe(8)
    expect(u.runtime.limiter.active()).toBe(0)
  })

  it('never logs the prompt or the answer at info (debug carries sizes only); the label is the first line', async () => {
    const u = unit({ 'prov:small': textModel('{"ok":false,"reason":"secret-answer-marker"}') })
    await answer(u, 'Stop')
    const text = u.logs.text()
    expect(text).not.toContain('secret-prompt-marker')
    expect(text).not.toContain('secret-answer-marker')
    expect(promptLabel({ redactText: value => value }, '\n  First line   here\nsecond line')).toBe('First line here')
    expect(promptLabel({ redactText: value => value }, 'Check', '.claude/settings.json')).toBe('.claude/settings.json: Check')
  })
})

/** Polls a condition (the limiter test settles through promises and microtasks). */
async function vi_waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for a condition.')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const kit = createHookTestKit()
afterEach(kit.cleanup)

describe('prompt hooks in the hook service (mock:prompt-hook)', () => {
  it('a personal prompt hook blocks a prompt through mock:prompt-hook; the record and the usage row', async () => {
    const h = await kit.open()
    await h.t.deps.settings.update({ hookModelRef: 'mock:prompt-hook' })
    await h.hooks.create({ type: 'prompt', event: 'UserPromptSubmit', prompt: 'Refuse prompts about Fridays. [[ph:deny Not on Fridays.]]', statusMessage: 'Checking the prompt…' })
    const chat = await h.t.deps.chats.create({ projectId: h.project.id })
    const snapshot = await h.hooks.snapshot(hookScope(h, { chatId: chat.id }))
    expect(snapshot.statusMessage('UserPromptSubmit')).toBe('Checking the prompt…')
    const result = await snapshot.run('UserPromptSubmit', { prompt: 'deploy on friday', messageId: 'msg_1' }, { signal: testSignal() })
    expect(result).toMatchObject({ ran: true, block: true, reason: 'Not on Fridays.', record: { outcome: 'blocked', hooks: [{ source: 'personal', kind: 'prompt', model: 'mock:prompt-hook', exitCode: null }] } })
    const rows = await h.t.db.select().from(usageTable).where(eq(usageTable.chatId, chat.id))
    expect(rows).toEqual([expect.objectContaining({ purpose: 'hook', providerId: 'mock', modelId: 'prompt-hook', input: 10, output: 5, messageId: 'msg_1' })])
    expect(h.hooks.runs()[0]).toMatchObject({ event: 'UserPromptSubmit', source: 'personal', outcome: 'blocked', exitCode: null })
    expect(h.spawned).toEqual([])
    // Nothing of the prompt or of the answer at info.
    expect(h.t.logs.records.filter(record => record.level === 'info').map(record => JSON.stringify(record)).join('\n')).not.toContain('Fridays')
  })

  it('without a model of their own and without hookModelRef they run on the small model (mock:echo: an invalid answer)', async () => {
    const h = await kit.open()
    await h.hooks.create({ type: 'prompt', event: 'Stop', prompt: 'Is the work done? [[ph:deny no]]' })
    const result = await (await h.hooks.snapshot(hookScope(h))).run('Stop', { stopHookActive: false }, { signal: testSignal() })
    expect(result).toMatchObject({ block: false, record: { outcome: 'error', hooks: [{ kind: 'prompt', model: 'mock:echo' }] } })
  })

  it('a MockLanguageModelV4 as the handler model; continueOnBlock on PreToolUse only denies', async () => {
    const h = await kit.open()
    const calls: LanguageModelV4CallOptions[] = []
    stubModels(h.t, { 'mock:judge': textModel(NO, calls) })
    await h.hooks.create({ type: 'prompt', event: 'PreToolUse', matcher: 'Bash', prompt: 'Is $ARGUMENTS safe?', model: 'mock:judge', continueOnBlock: true })
    const snapshot = await h.hooks.snapshot(hookScope(h))
    const result = await snapshot.run('PreToolUse', { tool: { name: 'shell', callId: 'c1', input: { command: 'rm -rf build' } } }, { signal: testSignal(), target: 'shell' })
    expect(result).toMatchObject({ decision: 'deny', block: true, continue: true, reason: 'Not yet.', record: { outcome: 'denied', toolCallId: 'c1', hooks: [{ kind: 'prompt', model: 'mock:judge' }] } })
    expect(JSON.stringify(calls[0]?.prompt)).toContain('rm -rf build')
    // Another tool: the matcher does not match.
    expect((await snapshot.run('PreToolUse', { tool: { name: 'read_file', callId: 'c2', input: {} } }, { signal: testSignal(), target: 'read_file' })).ran).toBe(false)
  })

  it('the kill switches: hooksEnabled off and HF_SAFE_MODE stop prompt hooks, HF_WORKSPACE_SHELL=0 does not', async () => {
    const off = await kit.open()
    await off.hooks.create({ type: 'prompt', event: 'Stop', prompt: 'Done? [[ph:ok]]' })
    await off.t.deps.settings.update({ hooksEnabled: false })
    expect((await off.hooks.snapshot(hookScope(off))).has('Stop')).toBe(false)
    expect((await off.hooks.list({})).items[0]).toMatchObject({ type: 'prompt', state: 'blocked' })

    const safe = await kit.open({ env: { HF_SAFE_MODE: '1' } })
    await safe.hooks.create({ type: 'prompt', event: 'Stop', prompt: 'Done? [[ph:ok]]' })
    expect((await safe.hooks.snapshot(hookScope(safe))).has('Stop')).toBe(false)

    const shell = await kit.open({ env: { HF_WORKSPACE_SHELL: '0' } })
    await shell.t.deps.settings.update({ hookModelRef: 'mock:prompt-hook' })
    await shell.hooks.create({ type: 'prompt', event: 'Stop', prompt: 'Done? [[ph:deny Run the tests.]]' })
    await shell.hooks.create({ event: 'Stop', command: await writeHookScript(shell.root, 'record') })
    const list = await shell.hooks.list({})
    expect(list.items.map(item => [item.kind === 'command' ? item.type ?? 'command' : 'code', item.state])).toEqual([['prompt', 'active'], ['command', 'blocked']])
    const result = await (await shell.hooks.snapshot(hookScope(shell))).run('Stop', { stopHookActive: false }, { signal: testSignal() })
    expect(result).toMatchObject({ block: true, reason: 'Run the tests.', record: { outcome: 'continued', hooks: [{ kind: 'prompt' }] } })
    expect(shell.spawned).toEqual([])
  })
})
