// Test doubles of the hook service (Phase 11, C36-T10), so the chat seams (`RunHooks`, approval, tools, the Stop gate,
// UserPromptSubmit / SessionStart, sub-agents) and the hook routes can be tested without hook processes:
//
//   const snapshot = createFakeHookSnapshot({ results: { PreToolUse: fakeHookResult({ decision: 'deny', reason: 'no' }) } })
//   await snapshot.run('PreToolUse', { tool: { name: 'shell', callId: 'c1', input: {} } }, { signal })   // the denial
//   snapshot.calls                                                    // [{ event, input, options }]
//
//   const t = await createTestApp({ hooks: 'fake' })                 // or overrides: { hooks: createFakeHookService() }
//   const fake = t.deps.hooks as FakeHookService
//   fake.results.set('Stop', fakeHookResult({ block: true, reason: 'run the tests', record: fakeHookRecord('Stop', 'continued') }))
//   fake.targets.set(hookTargetKey('PreToolUse', 'write_file'), fakeHookResult({ decision: 'ask' }))
//
// A snapshot answers, per event, the scripted result of the event and target (`targets`, key `<event>:<target>`, the
// target = `options.target ?? input.tool.name`), else the event's result (`results`), else "nothing ran"; a function
// result is called with the input and the options. `has(event)` is true for an event with a scripted result (any
// target) or listed in `present`. An aborted signal rejects `run` with its reason (like the real snapshot). Every call is
// recorded in the snapshot's `calls` (and in the service's `runCalls`). Snapshots of the fake service read the service's
// live `results` / `targets` / `present`, so a test may script them after the run took its snapshot. Personal hooks follow
// the contract in memory (fresh auth unless the update only turns a hook off, `LIMITS.personalHooksMax`, `not_found`,
// `hooks.changed`); `runs` answers `runLog`.
import type { HookData, HookEvent, HookList, HookRecordOutcome, HookRun, HookSwitches, PersonalHook } from '@harness-forge/shared'
import type { EventBus } from '../services/events/types.ts'
import type { HookEventResult, HookRunInput, HookRunOptions, HookScope, HookService, HookSnapshot } from '../services/hooks/types.ts'
import { createHookId, createHookRecordId, HarnessError, isHookTurnOff, LIMITS } from '@harness-forge/shared'
import { NOTHING_RAN, personalHookEntry } from '../services/hooks/index.ts'

/** A scripted result: a value, or a function of the run's input and options. */
export type FakeHookResult = HookEventResult | ((input: HookRunInput, options: HookRunOptions) => HookEventResult | Promise<HookEventResult>)

/** One `run` of a fake snapshot. */
export interface FakeHookCall {
  readonly event: HookEvent
  readonly input: HookRunInput
  readonly options: HookRunOptions
}

/** The key of a scripted result per event and target in `targets`. */
export function hookTargetKey(event: HookEvent, target: string): string {
  return `${event}:${target}`
}

/**
 * A result of hooks that ran: `ran: true`, no decision, no block, `continue: true`, no record, then `fields`. Pass a
 * `record` (`fakeHookRecord`) when the result should be stored.
 */
export function fakeHookResult(fields: Partial<HookEventResult> = {}): HookEventResult {
  return { ...NOTHING_RAN, ran: true, ...fields }
}

/** A `data-hook` record of one personal hook (`hev_` id, `createdAt` now, exit code 0), then `fields`. */
export function fakeHookRecord(event: HookEvent, outcome: HookRecordOutcome, fields: Partial<HookData> = {}): HookData {
  return {
    id: createHookRecordId(),
    event,
    outcome,
    createdAt: Date.now(),
    hooks: [{ source: 'personal', label: 'sh fake-hook.sh', exitCode: 0, durationMs: 1 }],
    ...fields,
  }
}

/** The scripts a fake snapshot reads (live: changes apply to later `has` / `run` calls). */
export interface FakeHookScript {
  /** Results per event. */
  readonly results: Map<HookEvent, FakeHookResult>
  /** Results per event and target (`hookTargetKey`); checked before `results`. */
  readonly targets: Map<string, FakeHookResult>
  /** Events `has()` reports true for without a scripted result (`run` answers "nothing ran"). */
  readonly present: Set<HookEvent>
}

export interface FakeHookSnapshotOptions {
  /** The snapshot's scope (default: a chat without a project, mode `ask`, origin `request`, model `mock:echo`). */
  scope?: HookScope
  /** Results per event. */
  results?: Partial<Record<HookEvent, FakeHookResult>>
  /** Results per event and target (`hookTargetKey(event, target)` → result). */
  targets?: Readonly<Record<string, FakeHookResult>>
  /** Events `has()` reports true for without a scripted result. */
  present?: readonly HookEvent[]
}

export interface FakeHookSnapshot extends HookSnapshot {
  /** The scripts this snapshot reads (its own, or the fake service's). */
  readonly script: FakeHookScript
  /** Every `run`, in order. */
  readonly calls: FakeHookCall[]
}

/** The scope of a fake snapshot taken without one. */
export const FAKE_HOOK_SCOPE: HookScope = Object.freeze({
  chatId: '0199a8f0-0000-7000-8000-0000000000b0',
  projectId: null,
  workspace: null,
  toolMode: 'ask',
  origin: 'request',
  modelRef: 'mock:echo',
})

function eventOf(key: string): string {
  return key.slice(0, key.indexOf(':'))
}

/** Builds the scripts of `options` (a fresh, mutable set of maps). */
export function createFakeHookScript(options: Omit<FakeHookSnapshotOptions, 'scope'> = {}): FakeHookScript {
  return {
    results: new Map(Object.entries(options.results ?? {}) as Array<[HookEvent, FakeHookResult]>),
    targets: new Map(Object.entries(options.targets ?? {})),
    present: new Set(options.present ?? []),
  }
}

function snapshotOver(scope: HookScope, script: FakeHookScript, record: (call: FakeHookCall) => void): FakeHookSnapshot {
  const calls: FakeHookCall[] = []
  return {
    scope,
    script,
    calls,
    has: event => script.results.has(event) || script.present.has(event) || [...script.targets.keys()].some(key => eventOf(key) === event),
    run: async (event, input, options) => {
      const call: FakeHookCall = { event, input, options }
      calls.push(call)
      record(call)
      options.signal.throwIfAborted()
      const target = options.target ?? input.tool?.name
      const scripted = (target === undefined ? undefined : script.targets.get(hookTargetKey(event, target))) ?? script.results.get(event)
      if (scripted === undefined)
        return NOTHING_RAN
      const result = typeof scripted === 'function' ? await scripted(input, options) : scripted
      options.signal.throwIfAborted()
      return result
    },
  }
}

/** A scripted snapshot (see the module comment). */
export function createFakeHookSnapshot(options: FakeHookSnapshotOptions = {}): FakeHookSnapshot {
  return snapshotOver(options.scope ?? FAKE_HOOK_SCOPE, createFakeHookScript(options), () => {})
}

export interface FakeHookServiceOptions extends Omit<FakeHookSnapshotOptions, 'scope'> {
  /** Receives `hooks.changed` on personal changes (default: no events). */
  events?: Pick<EventBus, 'emit'>
  /** The kill switches `list` answers (default: every switch on, no safe mode). */
  switches?: Partial<HookSwitches>
  /** The run log `runs` answers, newest first. */
  runLog?: readonly HookRun[]
  /** Clock (epoch ms; default `Date.now`). */
  now?: () => number
}

export interface FakeHookService extends HookService, FakeHookScript {
  /** Every snapshot taken, in order (each reads the service's live scripts). */
  readonly snapshots: FakeHookSnapshot[]
  /** Every `run` of every snapshot, in order. */
  readonly runCalls: FakeHookCall[]
  /** Personal hooks by id. */
  readonly personal: Map<string, PersonalHook>
  /** The run log `runs` answers, newest first; tests may edit it. */
  readonly runLog: HookRun[]
  /** The kill switches `list` answers; tests may edit them. */
  readonly switches: HookSwitches
  /** Number of calls of each member. */
  readonly calls: Record<keyof HookService, number>
  /** Every `invalidate` argument, in order. */
  readonly invalidated: Array<string | null>
}

function notFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Hook ${id} not found.` })
}

export function createFakeHookService(options: FakeHookServiceOptions = {}): FakeHookService {
  const now = options.now ?? Date.now
  const script = createFakeHookScript(options)
  const snapshots: FakeHookSnapshot[] = []
  const runCalls: FakeHookCall[] = []
  const personal = new Map<string, PersonalHook>()
  const runLog = [...(options.runLog ?? [])]
  const switches: HookSwitches = { setting: true, shell: true, safeMode: false, ...options.switches }
  const invalidated: Array<string | null> = []
  const calls: Record<keyof HookService, number> = { snapshot: 0, list: 0, create: 0, update: 0, remove: 0, runs: 0, invalidate: 0, stop: 0 }

  function changed(): void {
    options.events?.emit('hooks.changed', { projectId: null })
  }

  function get(id: string): PersonalHook {
    const hook = personal.get(id)
    if (hook === undefined)
      throw notFound(id)
    return hook
  }

  return {
    ...script,
    snapshots,
    runCalls,
    personal,
    runLog,
    switches,
    calls,
    invalidated,
    snapshot: async (scope, snapshotOptions) => {
      calls.snapshot += 1
      snapshotOptions?.signal?.throwIfAborted()
      const snapshot = snapshotOver(scope, script, call => runCalls.push(call))
      snapshots.push(snapshot)
      return snapshot
    },
    list: async (query): Promise<HookList> => {
      calls.list += 1
      const allowed = switches.setting && switches.shell && !switches.safeMode
      const rows = [...personal.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      return {
        items: rows.map(row => personalHookEntry(row, allowed)),
        diagnostics: [],
        switches: { ...switches },
        ...(query.projectId === undefined ? {} : { project: { id: query.projectId, available: true, files: [], pending: 0, scannedAt: now() } }),
      }
    },
    create: async (body, sensitive) => {
      calls.create += 1
      sensitive?.requireFreshAuth()
      if (personal.size >= LIMITS.personalHooksMax)
        throw new HarnessError({ code: 'conflict', message: `You already have ${LIMITS.personalHooksMax} personal hooks. Remove one first.` })
      const at = now()
      const hook: PersonalHook = {
        id: createHookId(),
        event: body.event,
        matcher: body.matcher ?? null,
        command: body.command,
        timeout: body.timeout ?? null,
        enabled: body.enabled ?? true,
        createdAt: at,
        updatedAt: at,
      }
      personal.set(hook.id, hook)
      changed()
      return hook
    },
    update: async (id, body, sensitive) => {
      calls.update += 1
      if (!isHookTurnOff(body))
        sensitive?.requireFreshAuth()
      const hook: PersonalHook = { ...get(id), ...body, updatedAt: now() }
      personal.set(id, hook)
      changed()
      return hook
    },
    remove: async (id) => {
      calls.remove += 1
      get(id)
      personal.delete(id)
      changed()
    },
    runs: (limit) => {
      calls.runs += 1
      return runLog.slice(0, Math.max(0, Math.min(limit ?? LIMITS.hookRunsKept, LIMITS.hookRunsKept)))
    },
    invalidate: (projectId) => {
      calls.invalidate += 1
      invalidated.push(projectId)
    },
    stop: async () => {
      calls.stop += 1
    },
  }
}
