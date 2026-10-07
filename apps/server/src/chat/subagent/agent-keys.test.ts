// W12.6 (ADR-057 / ADR-058) over `MockLanguageModelV4` and the C43 fake snapshot: `SubagentStart` before a child's step 0
// (foreground and background; matched on the agent type with its Claude Code names; the context in the first user
// message), `SubagentStop` with the child's agent (matched on its type; a prompt hook's `ok: false` continues once more
// unless `impossible`, at most `LIMITS.subagentStopContinuationsMax` rounds) and the agent keys in children: `maxTurns`,
// the `skills` preload (≤ 5 skills, ≤ 32 KiB, after the agent's body), `disallowedTools` (restrict-only) and a Claude
// model name through `resolveClaudeModel`. Skill bodies, contexts and reasons never reach the log at `info`.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { CustomizationEntry, Settings, TaskInput, TaskOutput, ToolMode } from '@harness-forge/shared'
import type { MemoryLogger } from '../../logger.ts'
import type { ResolvedModel } from '../../providers/types.ts'
import type { RegisteredTool } from '../../registry/types.ts'
import type { FakeCustomizationService } from '../../testing/fake-customizations.ts'
import type { FakeHookSnapshot, FakeHookSnapshotOptions } from '../../testing/fake-hooks.ts'
import type { RunSession } from '../pipeline.ts'
import { Buffer } from 'node:buffer'
import { DEFAULT_SETTINGS, HarnessError, hookModelText, LIMITS } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMemoryLogger } from '../../logger.ts'
import { createFakeBackgroundTasks } from '../../testing/fake-background-tasks.ts'
import { catalogEntryKey, createFakeCustomizationService } from '../../testing/fake-customizations.ts'
import { createFakeHookSnapshot, fakeHookResult, hookTargetKey } from '../../testing/fake-hooks.ts'
import { promptHookResult } from '../hooks-prompt-testing.ts'
import { createRunHooks, detachedHooks } from '../hooks.ts'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../markers.ts'
import { catalogEntry, testCatalog } from '../testing.ts'
import { createDetachedSession, DEFAULT_CHILD_SPEC } from './host.ts'
import {
  agentModelRef,
  childSpec,
  createSubagentRunner,
  PRELOADED_SKILLS_HEADER,
  PRELOADED_SKILLS_INTRO,
  preloadedSkillHeading,
  preloadedSkillsText,
  runDetachedChild,
  SUBAGENT_FINALIZE_TEXT,
  subagentStepLimitText,
} from './index.ts'

const resolveClaude = vi.hoisted(() => vi.fn(async (_alias: string, _context: unknown): Promise<string | null> => null))
vi.mock('../model-aliases.ts', () => ({ resolveClaudeModel: resolveClaude }))

const MESSAGE_ID = 'msg_a000000000000001'
const TASK: TaskInput = { description: 'Check the build', prompt: 'Build the project and report.', type: 'general' }
const AGENT_PATH = '.harness/agents/builder.md'
const SKILL_SECRET = 'skill-body-sentinel-91fe'
const CONTEXT_SECRET = 'start-context-sentinel-2a7c'
const REASON_SECRET = 'stop-reason-sentinel-d03b'

beforeEach(() => {
  resolveClaude.mockReset()
  resolveClaude.mockResolvedValue(null)
})

// ---------- model helpers ----------

function finishPart(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finishPart()]
}

function callParts(toolCallId: string, toolName: string): LanguageModelV4StreamPart[] {
  return [{ type: 'tool-call', toolCallId, toolName, input: '{}' }, finishPart('tool-calls')]
}

function scripted(script: (options: LanguageModelV4CallOptions, call: number) => LanguageModelV4StreamPart[], modelId = 'child') {
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    provider: 'testkit',
    modelId,
    doStream: async (options) => {
      calls.push(options)
      return { stream: convertArrayToReadableStream(script(options, calls.length)) }
    },
  })
  return { model, calls }
}

function toolNames(call: LanguageModelV4CallOptions | undefined): string[] {
  return (call?.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.name] : [])).sort()
}

function systemOf(call: LanguageModelV4CallOptions | undefined): string {
  const first = call?.prompt[0]
  return first?.role === 'system' ? first.content : ''
}

/** The text parts of the first user message of a call. */
function firstUserTexts(call: LanguageModelV4CallOptions | undefined): string[] {
  const user = call?.prompt.find(message => message.role === 'user')
  return user?.role === 'user' ? user.content.flatMap(part => (part.type === 'text' ? [part.text] : [])) : []
}

function resolvedModel(model: LanguageModelV4, modelId = 'child'): ResolvedModel {
  return {
    modelRef: `testkit:${modelId}`,
    providerId: 'testkit',
    modelId,
    info: { id: modelId, name: modelId },
    entry: {
      ref: `testkit:${modelId}`,
      kind: 'chat',
      contextWindow: 128_000,
      capabilities: { tools: true, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false },
      reasoningEfforts: [],
      cost: { input: 1, output: 2 },
    },
    provider: { definition: {}, pluginId: 'testkit' },
    model,
  } as unknown as ResolvedModel
}

// ---------- a fake parent run ----------

function safeTool(name: string): RegisteredTool {
  return {
    pluginId: 'acme',
    mcpServerId: null,
    title: null,
    definition: {
      name,
      description: name,
      inputSchema: z.object({}),
      policy: 'safe',
      execute: async (_input: unknown, _c: ToolCallContext) => `${name} result`,
    } as ToolDefinition,
  }
}

interface Harness {
  session: RunSession
  snapshot: FakeHookSnapshot
  logs: MemoryLogger
  customizations: FakeCustomizationService
  resolved: string[]
}

interface HarnessOptions {
  hooks?: FakeHookSnapshotOptions
  settings?: Partial<Settings>
  tools?: readonly string[]
  models?: Readonly<Record<string, LanguageModelV4>>
}

function harness(options: HarnessOptions = {}): Harness {
  const logs = createMemoryLogger()
  const tools = (options.tools ?? ['probe']).map(safeTool)
  const customizations = createFakeCustomizationService()
  const resolved: string[] = []
  const deps = {
    registry: {
      tools: { list: () => tools, get: (name: string) => tools.find(entry => entry.definition.name === name), register: () => ({ dispose() {} }) },
      hooks: { run: async () => {}, on: () => ({ dispose() {} }), list: () => [] },
    },
    plugins: { guard: async <T>(_id: string, fn: (signal: AbortSignal) => T | Promise<T>) => fn(new AbortController().signal), isActive: () => true },
    tools: { prefs: async () => new Map() },
    mcp: { list: async () => [] },
    env: { workspaceShell: true },
    providers: {
      resolveModel: async (ref: string) => {
        resolved.push(ref)
        const model = options.models?.[ref]
        if (model === undefined)
          throw new HarnessError({ code: 'model_not_found', message: `No model ${ref}.` })
        return resolvedModel(model, ref.slice(ref.indexOf(':') + 1))
      },
      mapError: (_providerId: string, error: unknown) => new HarnessError({ code: 'provider_error', message: error instanceof Error ? error.message : 'error' }),
    },
    chats: { addUsage: async () => {} },
    redactor: { redactText: (text: string) => text },
    customizations,
  }
  const settings = { ...DEFAULT_SETTINGS, instructions: 'Global rules.', subagentModelRef: null, subagentMaxSteps: 30, autoCompact: false, ...options.settings }
  const session = {
    chatId: 'chat',
    assistantId: MESSAGE_ID,
    notices: [],
    addExtraCost: () => {},
    inject: () => {},
    writeTransient: () => {},
    ctx: {
      deps,
      prepared: { settings, chat: { settings: {} }, history: [] },
      reasoningEffort: 'auto',
      run: { signal: new AbortController().signal },
      now: () => Date.now(),
      logger: logs.logger,
    },
  } as unknown as RunSession
  const snapshot = createFakeHookSnapshot(options.hooks ?? {})
  Object.assign(session, { hooks: createRunHooks({ snapshot, host: { stepNumber: 0, inject: () => {}, writeTransient: () => {} }, continued: null, messageId: MESSAGE_ID, logger: logs.logger }) })
  return { session, snapshot, logs, customizations, resolved }
}

/** The project agent `builder` (these frontmatter lines, this body) in `h`'s customizations; its catalog entry. */
function builderAgent(h: Harness, frontmatter: readonly string[], body = 'PERSONA: builder\nBuild it.'): CustomizationEntry {
  const entry = catalogEntry('agent', 'builder', { source: 'project', path: AGENT_PATH, description: 'Builds.' })
  h.customizations.bodies.set(catalogEntryKey(entry), ['---', 'name: builder', 'description: Builds.', ...frontmatter, '---', body].join('\n'))
  return entry
}

/** A project skill `name` with `body` in `h`'s customizations; its catalog entry. */
function skill(h: Harness, name: string, body: string): CustomizationEntry {
  const entry = catalogEntry('skill', name, { source: 'project', path: `.harness/skills/${name}/SKILL.md`, description: `The ${name} skill.` })
  h.customizations.bodies.set(catalogEntryKey(entry), ['---', `name: ${name}`, `description: The ${name} skill.`, '---', body].join('\n'))
  return entry
}

function catalogOf(...entries: CustomizationEntry[]) {
  return testCatalog([catalogEntry('agent', 'explore'), catalogEntry('agent', 'general'), ...entries])
}

async function run(h: Harness, model: LanguageModelV4, task: TaskInput, catalog = catalogOf(), toolMode: ToolMode = 'auto'): Promise<TaskOutput[]> {
  const runner = createSubagentRunner({
    session: h.session,
    model: resolvedModel(model),
    toolMode,
    workspace: null,
    scope: null,
    catalog,
    background: createFakeBackgroundTasks(),
    origin: 'request',
  })
  const outputs: TaskOutput[] = []
  for await (const output of runner.run(task, { toolCallId: 'call_parent', signal: new AbortController().signal }))
    outputs.push(output)
  return outputs
}

/** A child that calls `probe` while it is offered, then reports. */
function looping() {
  return scripted((options, call) => (toolNames(options).includes('probe') ? callParts(`c${call}`, 'probe') : textParts('Final report.')))
}

// ---------- SubagentStart (W12.6-T1) ----------

describe('subagentStart (W12.6-T1)', () => {
  const contextOf = (text: string): string => hookModelText({ event: 'SubagentStart', outcome: 'context', context: text }, 'user')!

  it('matched on the agent type: general-purpose runs general and gets the context; another type runs nothing', async () => {
    const h = harness({ hooks: { targets: { [hookTargetKey('SubagentStart', 'general')]: fakeHookResult({ context: CONTEXT_SECRET }) } } })
    const { model, calls } = scripted(() => textParts('Done.'))
    expect((await run(h, model, { ...TASK, type: 'general-purpose' })).at(-1)).toMatchObject({ status: 'completed', type: 'general' })
    expect(firstUserTexts(calls[0])).toEqual([TASK.prompt, contextOf(CONTEXT_SECRET)])
    expect(h.snapshot.calls[0]).toMatchObject({ event: 'SubagentStart', input: { agent: { id: 'call_parent', type: 'general' } }, options: { target: 'general', aliases: ['general', 'general-purpose'] } })

    // A custom agent is matched on its own name: the `general` matcher does not apply, so its prompt stays alone.
    const custom = harness({ hooks: { targets: { [hookTargetKey('SubagentStart', 'general')]: fakeHookResult({ context: CONTEXT_SECRET }) } } })
    const entry = builderAgent(custom, [])
    const other = scripted(() => textParts('Built.'))
    expect((await run(custom, other.model, { ...TASK, type: 'builder' }, catalogOf(entry))).at(-1)).toMatchObject({ status: 'completed', type: 'builder' })
    expect(firstUserTexts(other.calls[0])).toEqual([TASK.prompt])
    expect(custom.snapshot.calls[0]).toMatchObject({ event: 'SubagentStart', input: { agent: { id: 'call_parent', type: 'builder' } }, options: { target: 'builder' } })
    expect(JSON.stringify(h.logs.records)).not.toContain(CONTEXT_SECRET)
  })

  it('a background child runs it on its detached host: the context reaches its first user message', async () => {
    const h = harness()
    const snapshot = createFakeHookSnapshot({ results: { SubagentStart: fakeHookResult({ context: 'Use the staging database.' }) } })
    const session = createDetachedSession({
      deps: h.session.ctx.deps,
      chatId: 'chat',
      messageId: MESSAGE_ID,
      settings: h.session.ctx.prepared.settings,
      chatInstructions: undefined,
      reasoningEffort: 'auto',
      signal: new AbortController().signal,
      logger: h.logs.logger,
      hooks: detachedHooks({ snapshot, messageId: MESSAGE_ID, logger: h.logs.logger }),
    })
    const { model, calls } = scripted(() => textParts('Done in the background.'))
    const outputs: TaskOutput[] = []
    for await (const output of runDetachedChild({ session, model: resolvedModel(model), toolMode: 'auto', workspace: null, scope: null, catalog: catalogOf(), task: { ...TASK, background: true }, toolCallId: 'call_bg' }))
      outputs.push(output)
    expect(outputs.at(-1)).toMatchObject({ status: 'completed', report: 'Done in the background.' })
    expect(firstUserTexts(calls[0])).toEqual([TASK.prompt, contextOf('Use the staging database.')])
    expect(snapshot.calls.map(call => [call.event, call.input.agent])).toEqual([['SubagentStart', { id: 'call_bg', type: 'general' }]])
  })
})

// ---------- SubagentStop (W12.6-T2) ----------

describe('subagentStop (W12.6-T2)', () => {
  const feedback = (reason: string): string => hookModelText({ event: 'SubagentStop', outcome: 'continued', reason }, 'user')!

  it('carries the agent and is matched on its type (a custom agent by its name, general by its Claude name too)', async () => {
    const block = (input: { stopHookActive?: boolean }) => (input.stopHookActive === true ? fakeHookResult() : fakeHookResult({ block: true, reason: 'add tests' }))
    const h = harness({ hooks: { targets: { [hookTargetKey('SubagentStop', 'builder')]: block } } })
    const entry = builderAgent(h, [])
    const { model, calls } = scripted((_options, call) => textParts(call === 1 ? 'First.' : 'Second.'))
    expect((await run(h, model, { ...TASK, type: 'builder' }, catalogOf(entry))).at(-1)).toMatchObject({ status: 'completed', report: 'Second.' })
    expect(calls).toHaveLength(2)
    const stops = h.snapshot.calls.filter(call => call.event === 'SubagentStop')
    expect(stops.map(call => [call.input.agent, call.input.stopHookActive, call.options.target])).toEqual([
      [{ id: 'call_parent', type: 'builder' }, false, 'builder'],
      [{ id: 'call_parent', type: 'builder' }, true, 'builder'],
    ])

    // A matcher of another type does not continue the child.
    const other = harness({ hooks: { targets: { [hookTargetKey('SubagentStop', 'explore')]: fakeHookResult({ block: true, reason: 'no' }) } } })
    const once = scripted(() => textParts('Only once.'))
    expect((await run(other, once.model, TASK)).at(-1)).toMatchObject({ status: 'completed', report: 'Only once.' })
    expect(once.calls).toHaveLength(1)
    expect(other.snapshot.calls.find(call => call.event === 'SubagentStop')?.options).toMatchObject({ target: 'general', aliases: ['general', 'general-purpose'] })
  })

  it('a prompt hook: ok false continues the child once with its reason; impossible lets it end', async () => {
    const h = harness({ hooks: { results: { SubagentStop: input => (input.stopHookActive === true
      ? promptHookResult('SubagentStop', '{"ok":true}')
      : promptHookResult('SubagentStop', JSON.stringify({ ok: false, reason: REASON_SECRET }))) } } })
    const { model, calls } = scripted((_options, call) => textParts(call === 1 ? 'Draft.' : 'Checked.'))
    expect((await run(h, model, TASK)).at(-1)).toMatchObject({ status: 'completed', report: 'Checked.' })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.prompt.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: feedback(REASON_SECRET), providerOptions: undefined }], providerOptions: undefined })
    expect(JSON.stringify(h.logs.records)).not.toContain(REASON_SECRET)

    const impossible = harness({ hooks: { results: { SubagentStop: promptHookResult('SubagentStop', '{"ok":false,"reason":"cannot verify","impossible":true}') } } })
    const single = scripted(() => textParts('Done.'))
    expect((await run(impossible, single.model, TASK)).at(-1)).toMatchObject({ status: 'completed', report: 'Done.' })
    expect(single.calls).toHaveLength(1)

    // An unreadable answer is a non-blocking error: the child ends.
    const invalid = harness({ hooks: { results: { SubagentStop: promptHookResult('SubagentStop', 'I cannot decide.') } } })
    const plain = scripted(() => textParts('Done.'))
    expect((await run(invalid, plain.model, TASK)).at(-1)?.status).toBe('completed')
    expect(plain.calls).toHaveLength(1)
  })

  it('a prompt hook that always says no: at most two more rounds (the Phase 11 cap)', async () => {
    const h = harness({ hooks: { results: { SubagentStop: promptHookResult('SubagentStop', '{"ok":false,"reason":"again"}') } } })
    const { model, calls } = scripted((_options, call) => textParts(`Round ${call}`))
    expect((await run(h, model, TASK)).at(-1)).toMatchObject({ status: 'completed', report: `Round ${1 + LIMITS.subagentStopContinuationsMax}` })
    expect(calls).toHaveLength(1 + LIMITS.subagentStopContinuationsMax)
  })
})

// ---------- the agent keys (W12.6-T3) ----------

describe('agent keys in children (W12.6-T3)', () => {
  it('maxTurns: 2 stops the child at 2 steps (the finalize nudge at the second); without it the child runs on', async () => {
    const h = harness()
    const entry = builderAgent(h, ['maxTurns: 2'])
    const { model, calls } = looping()
    const final = (await run(h, model, { ...TASK, type: 'builder' }, catalogOf(entry))).at(-1)!
    expect(final).toMatchObject({ status: 'limit', report: 'Final report.', error: subagentStepLimitText(2) })
    expect(calls).toHaveLength(2)
    expect(toolNames(calls[0])).toEqual(['probe'])
    expect(toolNames(calls[1])).toEqual([])
    expect(systemOf(calls[1])).toContain(SUBAGENT_FINALIZE_TEXT)

    // maxTurns never raises the limit: subagentMaxSteps 3 wins over maxTurns 50.
    const low = harness({ settings: { subagentMaxSteps: 3 } })
    const lowEntry = builderAgent(low, ['maxTurns: 50'])
    const three = looping()
    expect((await run(low, three.model, { ...TASK, type: 'builder' }, catalogOf(lowEntry))).at(-1)).toMatchObject({ status: 'limit', error: subagentStepLimitText(3) })
    expect(three.calls).toHaveLength(3)
  })

  it('the skills preload: the bodies after the agent\'s body and before the global rules; missing skills skipped', async () => {
    const h = harness()
    const entry = builderAgent(h, ['skills: [checklist, missing, notes]'], 'PERSONA: builder')
    const checklist = skill(h, 'checklist', `Check every file. ${SKILL_SECRET}`)
    const notes = skill(h, 'notes', 'Write short notes.')
    const { model, calls } = scripted(() => textParts('Done.'))
    expect((await run(h, model, { ...TASK, type: 'builder' }, catalogOf(entry, checklist, notes))).at(-1)?.status).toBe('completed')
    const system = systemOf(calls[0])
    expect(system.startsWith(SUBAGENT_INSTRUCTIONS_MARKER)).toBe(true)
    const header = system.indexOf(PRELOADED_SKILLS_HEADER)
    expect(header).toBeGreaterThan(system.indexOf('PERSONA: builder'))
    expect(system.indexOf('Global rules.')).toBeGreaterThan(header)
    expect(system).toContain([PRELOADED_SKILLS_HEADER, '', PRELOADED_SKILLS_INTRO, '', preloadedSkillHeading('checklist'), '', `Check every file. ${SKILL_SECRET}`, '', preloadedSkillHeading('notes'), '', 'Write short notes.'].join('\n'))
    expect(system).not.toContain(preloadedSkillHeading('missing'))
    expect(JSON.stringify(h.logs.records)).not.toContain(SKILL_SECRET)
  })

  it('preloadedSkillsText: at most five skills, at most 32 KiB in total, a skill named twice once, none without a catalog', async () => {
    const h = harness()
    const names = ['s1', 's2', 's3', 's4', 's5', 's6']
    const entries = names.map(name => skill(h, name, `Body of ${name}.`))
    const signal = new AbortController().signal
    const text = (await preloadedSkillsText(h.session, [...names, 's1'], catalogOf(...entries), signal, 'builder'))!
    for (const name of names.slice(0, LIMITS.agentSkillsPreloadMax))
      expect(text).toContain(preloadedSkillHeading(name))
    expect(text).not.toContain(preloadedSkillHeading('s6'))
    expect(text.split(preloadedSkillHeading('s1'))).toHaveLength(2)
    const twice = (await preloadedSkillsText(h.session, ['s1', 's1'], catalogOf(...entries), signal, 'builder'))!
    expect(twice.split(preloadedSkillHeading('s1'))).toHaveLength(2)

    const big = [skill(h, 'big1', 'a'.repeat(20_000)), skill(h, 'big2', 'é'.repeat(20_000)), skill(h, 'big3', 'never')]
    const capped = (await preloadedSkillsText(h.session, ['big1', 'big2', 'big3'], catalogOf(...big), signal, 'builder'))!
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(LIMITS.agentSkillsPreloadBytes)
    expect(Buffer.byteLength(capped, 'utf8')).toBeGreaterThan(LIMITS.agentSkillsPreloadBytes - 2)
    expect(capped).toContain(preloadedSkillHeading('big2'))
    expect(capped).not.toContain(preloadedSkillHeading('big3'))
    expect(capped).not.toContain('�')

    expect(await preloadedSkillsText(h.session, ['s1'], null, signal, 'builder')).toBeNull()
    expect(await preloadedSkillsText(h.session, ['missing'], catalogOf(...entries), signal, 'builder')).toBeNull()
    expect(await preloadedSkillsText(h.session, [], catalogOf(...entries), signal, 'builder')).toBeNull()
    const aborted = new AbortController()
    aborted.abort(new DOMException('stopped', 'AbortError'))
    await expect(preloadedSkillsText(h.session, ['s1'], catalogOf(...entries), aborted.signal, 'builder')).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('disallowedTools: Bash removes shell before tools narrows the set (restrict-only)', async () => {
    const h = harness({ tools: ['shell', 'probe', 'other'] })
    const nobash = builderAgent(h, ['disallowedTools: Bash'])
    const { model, calls } = scripted(() => textParts('Done.'))
    await run(h, model, { ...TASK, type: 'builder' }, catalogOf(nobash))
    expect(toolNames(calls[0])).toEqual(['other', 'probe'])

    // `tools` cannot bring a disallowed tool back; a specifier removes the whole tool.
    const both = harness({ tools: ['shell', 'probe', 'other'] })
    const narrowed = builderAgent(both, ['tools: [shell, probe]', 'disallowedTools: "Bash(git:*)"'])
    const second = scripted(() => textParts('Done.'))
    await run(both, second.model, { ...TASK, type: 'builder' }, catalogOf(narrowed))
    expect(toolNames(second.calls[0])).toEqual(['probe'])

    const plain = harness({ tools: ['shell', 'probe'] })
    const all = builderAgent(plain, [])
    const third = scripted(() => textParts('Done.'))
    await run(plain, third.model, { ...TASK, type: 'builder' }, catalogOf(all))
    expect(toolNames(third.calls[0])).toEqual(['probe', 'shell'])
  })

  it('childSpec: a builtin and a definition without the keys keep the default spec', async () => {
    const h = harness()
    const signal = new AbortController().signal
    const choice = { name: 'builder', base: 'general' as const, entry: null, agent: { source: 'project' as const, description: 'Builds.' } }
    expect(await childSpec(h.session, choice, null, signal, catalogOf())).toBe(DEFAULT_CHILD_SPEC)
    expect(await childSpec(h.session, choice, { name: 'builder', description: 'Builds.', tools: null, model: null, instructions: 'Build.', skills: ['missing'] }, signal, catalogOf())).toBe(DEFAULT_CHILD_SPEC)
    expect(await childSpec(h.session, choice, { name: 'builder', description: 'Builds.', tools: null, model: null, instructions: 'Build.', maxTurns: 3, disallowedTools: [] }, signal, catalogOf())).toEqual({ maxTurns: 3, skillsText: null, disallowedTools: null })
  })

  it('a Claude model name runs on the model resolveClaudeModel names; an unmapped one falls back with a warning', async () => {
    const own = scripted(() => textParts('From sonnet.'), 'sonnet-model')
    const h = harness({ models: { 'testkit:sonnet-model': own.model }, settings: { modelAliases: { sonnet: 'testkit:sonnet-model', opus: null, haiku: null, fable: null } } })
    resolveClaude.mockResolvedValue('testkit:sonnet-model')
    const entry = builderAgent(h, ['model: sonnet'])
    const parentModel = scripted(() => textParts('From the parent.'))
    expect((await run(h, parentModel.model, { ...TASK, type: 'builder' }, catalogOf(entry))).at(-1)).toMatchObject({ status: 'completed', modelRef: 'testkit:sonnet-model', report: 'From sonnet.' })
    expect(resolveClaude).toHaveBeenCalledTimes(1)
    expect(resolveClaude.mock.calls[0]![0]).toBe('sonnet')
    expect(resolveClaude.mock.calls[0]![1]).toMatchObject({ modelAliases: { sonnet: 'testkit:sonnet-model' } })
    expect(parentModel.calls).toHaveLength(0)

    // Unmapped: the default child model (`subagentModelRef ?? the parent's model`), a warning without the name.
    const fallback = harness()
    resolveClaude.mockResolvedValue(null)
    const unmapped = builderAgent(fallback, ['model: opus'])
    const parent = scripted(() => textParts('From the parent.'))
    expect((await run(fallback, parent.model, { ...TASK, type: 'builder' }, catalogOf(unmapped))).at(-1)).toMatchObject({ status: 'completed', modelRef: 'testkit:child' })
    const warnings = fallback.logs.records.filter(record => record.level === 'warn')
    expect(warnings.map(record => record.msg)).toContain('the agent\'s Claude model name has no model; the default model runs the sub-agent')
    expect(JSON.stringify(fallback.logs.records.filter(record => record.level !== 'debug'))).not.toContain('opus')
  })

  it('agentModelRef: a declared model wins; no model and no alias is null; an abort rejects', async () => {
    const h = harness()
    const signal = new AbortController().signal
    expect(await agentModelRef(h.session, { model: 'testkit:own', modelAlias: 'sonnet' }, 'builder', signal)).toBe('testkit:own')
    expect(await agentModelRef(h.session, { model: 'inherit' }, 'builder', signal)).toBe('inherit')
    expect(await agentModelRef(h.session, { model: null }, 'builder', signal)).toBeNull()
    expect(resolveClaude).not.toHaveBeenCalled()
    resolveClaude.mockRejectedValueOnce(new DOMException('stopped', 'AbortError'))
    const aborted = new AbortController()
    aborted.abort(new DOMException('stopped', 'AbortError'))
    await expect(agentModelRef(h.session, { model: null, modelAlias: 'haiku' }, 'builder', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
