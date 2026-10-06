// Hook snapshots (Phase 11, ADR-048; ARCHITECTURE.md 6.28): the hooks of one scope merged ONCE (per run and per
// prepare) and run per event.
//
// Sources (additive, in run order): personal rows (`enabled`, a valid matcher), plugin command hooks
// (`registry.hookCommands` of active plugins; `HARNESS_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` = the plugin folder) and the
// project's settings-file hooks (only when the run's project folder opened, the scan is of that folder and the item's
// sha256 is approved; identical hashes run once). The kill switches (`hooksEnabled`, `HF_WORKSPACE_SHELL=0`,
// `HF_SAFE_MODE`) leave no command hook; the plugin code hooks of the event (`code-hooks.ts`) run regardless.
//
// `run(event, input, { signal, target?, aliases? })`:
// - the matchers (compiled once per snapshot) are tested against the event's subject (`HOOK_MATCHER_SUBJECTS`): the
//   tool names (`aliases`, default `hookTargetNames(target)`), the SessionStart source, the PreCompact trigger or the
//   Notification type; events without a subject ignore the matcher;
// - at most `LIMITS.hooksPerEventMax` (20) matching command hooks run, in parallel, each through the server-wide
//   semaphore (`LIMITS.hookProcessesMax`, acquired with the run signal), each with its own timeout and process group;
// - a project item is verified right before its spawn (`projectConfig.verify`: the command and its referenced files are
//   hashed again); a mismatch skips it as pending, drops the project's config cache and announces the change;
// - the stdin payload is `buildHookPayload` (one per source: `harness.source` differs), the working folder the project
//   root, else `<dataDir>/hooks` (0700);
// - every outcome is read with `readHookOutput`, combined with the code hooks' outcome, and turned into the result and
//   its record (`record.ts`); every hook that ran is added to the run log and logged at `info` with the event, the
//   source, a hash prefix of the label, the exit code, the duration and the outcome only (the redacted command at
//   `debug`; payloads, stdout and stderr never).
// An abort of the run (or the service's `stop()`) kills the running groups and rejects `run`; nothing else rejects.
import type { HookName } from '@harness-forge/plugin-sdk'
import type { CompiledMatcher, HookEvent, HookOutcome, HookPayloadInput, HookRun, HookSource } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { ProjectHookItem } from '../project-config/types.ts'
import type { RanHook } from './record.ts'
import type { HookRunLog } from './run-log.ts'
import type { CommandHookOptions } from './runner.ts'
import type { Semaphore } from './semaphore.ts'
import type { HookEventResult, HookRunInput, HookRunOptions, HookScope, HookSnapshot } from './types.ts'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { buildHookPayload, createHookRecordId, HOOK_EVENTS, HOOK_MATCHER_SUBJECTS, hookTargetNames, LIMITS, readHookOutput } from '@harness-forge/shared'
import { redactShellCommand } from '../../workspace/shell.ts'
import { codeHookOf, codeHookPlugins, runCodeHooks } from './code-hooks.ts'
import { eventResult, singleOutcome } from './record.ts'
import { cutText } from './run-log.ts'
import { hookTimeoutMs, runCommandHook } from './runner.ts'

/** One command hook of a snapshot. */
export interface SnapshotHook {
  readonly source: HookSource
  readonly event: HookEvent
  /** The matcher as configured (null = every target). */
  readonly matcher: string | null
  readonly compiled: Extract<CompiledMatcher, { readonly ok: true }>
  readonly command: string
  /** Seconds; null = the default. */
  readonly timeoutSec: number | null
  /** The record / run log label (the redacted command head; a project item adds its file). */
  readonly label: string
  readonly pluginId?: string
  /** The plugin folder (`HARNESS_PLUGIN_ROOT`). */
  readonly pluginRoot?: string
  /** A project item: verified right before its spawn. */
  readonly item?: ProjectHookItem
}

/** What the snapshots of one service share. */
export interface SnapshotRuntime {
  readonly deps: Pick<AppDeps, 'registry' | 'plugins' | 'projectConfig' | 'redactor'>
  readonly logger: Logger
  readonly semaphore: Semaphore
  readonly runLog: HookRunLog
  /** Aborted by the service's `stop()`: every running hook is killed. */
  readonly stopSignal: AbortSignal
  /** `<dataDir>/hooks`, created 0700 on first use. */
  readonly hooksDir: () => Promise<string>
  /** A project item no longer matches its approval (verify-before-run failed). */
  readonly onStale: (projectId: string) => void
  /** Keeps `stop()` waiting for a run until it settled. */
  readonly track: <T>(promise: Promise<T>) => Promise<T>
  readonly runner: CommandHookOptions
  readonly now: () => number
}

/** The sources of a snapshot, gathered by the service. */
export interface SnapshotSources {
  readonly scope: HookScope
  /** The command hooks in run order (personal, plugin, project); empty when a kill switch is on. */
  readonly hooks: readonly SnapshotHook[]
  /** Events with code hooks of an active plugin (at snapshot time). */
  readonly codeEvents: ReadonlySet<HookEvent>
}

/** First 12 hex characters of the sha256 of a label: what `info` logs instead of the command. */
export function labelHash(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 12)
}

/** The label of a command hook: its redacted, cut command (a project item is prefixed with its settings file). */
export function commandLabel(redactor: { readonly redactText: (text: string) => string }, command: string, file?: string): string {
  const head = redactor.redactText(cutText(command.replace(/\s+/g, ' ').trim(), LIMITS.hookLabelMaxChars * 2))
  return cutText(file === undefined ? head : `${file}: ${head}`, LIMITS.hookLabelMaxChars)
}

/** The names a hook's matcher is tested against for `event`, or null when the event ignores matchers. */
export function matcherSubjects(event: HookEvent, input: HookRunInput, options: Pick<HookRunOptions, 'target' | 'aliases'>): readonly string[] | null {
  switch (HOOK_MATCHER_SUBJECTS[event]) {
    case 'tool': {
      if (options.aliases !== undefined)
        return options.aliases
      const target = options.target ?? input.tool?.name
      return target === undefined ? [] : hookTargetNames(target)
    }
    case 'source':
      return [input.sessionSource ?? 'startup']
    case 'trigger':
      return [input.trigger ?? 'auto']
    case 'notification':
      return input.notificationType === undefined ? [] : [input.notificationType]
    default:
      return null
  }
}

/** The hook matches the event's subject. */
export function hookMatches(hook: Pick<SnapshotHook, 'matcher' | 'compiled'>, subjects: readonly string[] | null): boolean {
  if (subjects === null || hook.matcher === null)
    return true
  return subjects.some(name => hook.compiled.test(name))
}

/** Rejects with the reason of the first aborted signal (the run's before the service's). */
function throwIfAborted(run: AbortSignal, stop: AbortSignal): void {
  run.throwIfAborted()
  stop.throwIfAborted()
}

/** Settles when `promise` does, or rejects with `signal`'s reason once it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** The reading of a hook process that never started. */
function startFailure(event: HookEvent): HookOutcome {
  return readHookOutput(event, { exitCode: null, timedOut: false, stdout: '', stdoutTruncated: false, stderr: '' })
}

interface RanCommand {
  readonly hook: SnapshotHook
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  readonly outcome: HookOutcome
  readonly error: string | null
}

/** Builds the snapshot of `sources` (see the module comment). */
export function createSnapshot(runtime: SnapshotRuntime, sources: SnapshotSources): HookSnapshot {
  const { scope } = sources
  const byEvent = new Map<HookEvent, SnapshotHook[]>()
  for (const hook of sources.hooks) {
    const list = byEvent.get(hook.event) ?? []
    list.push(hook)
    byEvent.set(hook.event, list)
  }
  const present = new Set<HookEvent>(HOOK_EVENTS.filter(event => (byEvent.get(event)?.length ?? 0) > 0 || sources.codeEvents.has(event)))
  const log = runtime.logger

  function payloadInput(event: HookEvent, input: HookRunInput, cwd: string, source: HookSource): HookPayloadInput {
    // `SubagentStop`'s `task` call is for the plugin code hooks only (never in the command payload).
    const tool = event === 'SubagentStop' ? undefined : input.tool
    return {
      chatId: scope.chatId,
      projectId: scope.projectId,
      modelRef: scope.modelRef,
      origin: scope.origin,
      toolMode: scope.toolMode,
      cwd,
      source,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      ...(tool === undefined ? {} : { tool }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.stopHookActive === undefined ? {} : { stopHookActive: input.stopHookActive }),
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      ...(input.customInstructions === undefined ? {} : { customInstructions: input.customInstructions }),
      ...(input.sessionSource === undefined ? {} : { sessionSource: input.sessionSource }),
      ...(input.message === undefined ? {} : { message: input.message }),
      ...(input.notificationType === undefined ? {} : { notificationType: input.notificationType }),
    }
  }

  async function verified(hook: SnapshotHook, signal: AbortSignal): Promise<boolean> {
    if (hook.item === undefined || scope.projectId === null)
      return true
    try {
      return await runtime.deps.projectConfig.verify(scope.projectId, hook.item, signal)
    }
    catch (error) {
      if (signal.aborted)
        throw error
      log.debug('hooks: a project hook could not be verified; it does not run', { err: error })
      return false
    }
  }

  async function runCommand(event: HookEvent, hook: SnapshotHook, cwd: string | null, payload: (source: HookSource) => string, signal: AbortSignal): Promise<RanCommand | null> {
    const release = await runtime.semaphore.acquire(signal)
    try {
      if (!await verified(hook, signal)) {
        log.info('hooks: a project hook changed since it was approved and did not run', { event, source: hook.source, hook: labelHash(hook.label) })
        if (scope.projectId !== null)
          runtime.onStale(scope.projectId)
        return null
      }
      if (cwd === null) {
        const outcome = startFailure(event)
        return { hook, exitCode: null, timedOut: false, durationMs: 0, outcome, error: 'The hook folder could not be created.' }
      }
      const env: Record<string, string> = { HARNESS_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd }
      if (hook.pluginRoot !== undefined && hook.pluginRoot !== '') {
        env.HARNESS_PLUGIN_ROOT = hook.pluginRoot
        env.CLAUDE_PLUGIN_ROOT = hook.pluginRoot
      }
      if (log.isLevelEnabled('debug'))
        log.debug('hooks: running a command hook', { event, source: hook.source, command: redactShellCommand(hook.command) })
      const run = await runCommandHook({ command: hook.command, cwd, timeoutMs: hookTimeoutMs(hook.timeoutSec), payload: payload(hook.source), env, signal }, runtime.runner)
      const outcome = run.startError === null ? readHookOutput(event, run.process) : startFailure(event)
      if (log.isLevelEnabled('debug')) {
        log.debug('hooks: command hook output', {
          event,
          source: hook.source,
          stdoutChars: run.process.stdout.length,
          stderrChars: run.process.stderr.length,
          diagnostics: outcome.diagnostics.map(diagnostic => diagnostic.code),
        })
      }
      return {
        hook,
        exitCode: run.process.exitCode,
        timedOut: run.process.timedOut,
        durationMs: run.durationMs,
        outcome,
        error: run.startError ?? outcome.error,
      }
    }
    finally {
      release()
    }
  }

  async function runCode(event: HookEvent, name: HookName, input: HookRunInput, signal: AbortSignal): Promise<{ plugins: string[], outcome: HookOutcome, durationMs: number } | null> {
    const plugins = codeHookPlugins(runtime.deps.registry, name, id => runtime.deps.plugins.isActive(id))
    if (plugins.length === 0)
      return null
    const begin = performance.now()
    let outcome: HookOutcome | null
    try {
      outcome = await untilAborted(runCodeHooks(runtime.deps.registry, event, scope, input), signal)
    }
    catch (error) {
      if (signal.aborted)
        throw error
      // The registry's runner swallows handler failures; anything else is a failure of the call itself.
      log.warn('hooks: the plugin code hooks failed', { event, hook: name, err: error })
      return null
    }
    if (outcome === null)
      return null
    return { plugins, outcome, durationMs: Math.round(performance.now() - begin) }
  }

  async function run(event: HookEvent, input: HookRunInput, options: HookRunOptions): Promise<HookEventResult> {
    throwIfAborted(options.signal, runtime.stopSignal)
    const subjects = matcherSubjects(event, input, options)
    const matching = (byEvent.get(event) ?? []).filter(hook => hookMatches(hook, subjects))
    const selected = matching.slice(0, LIMITS.hooksPerEventMax)
    if (matching.length > selected.length)
      log.warn('hooks: too many hooks match one event; only the first ones run', { event, matching: matching.length, run: selected.length })
    const codeName = sources.codeEvents.has(event) ? codeHookOf(event) : null
    if (selected.length === 0 && codeName === null)
      return noneRan()

    const signal = AbortSignal.any([options.signal, runtime.stopSignal])
    let cwd: string | null = scope.workspace?.root ?? null
    if (cwd === null && selected.length > 0) {
      try {
        cwd = await runtime.hooksDir()
      }
      catch (error) {
        log.warn('hooks: the hook folder could not be created', { err: error })
      }
    }
    const payloads = new Map<HookSource, string>()
    const payload = (source: HookSource): string => {
      let json = payloads.get(source)
      if (json === undefined) {
        const built = buildHookPayload(event, payloadInput(event, input, cwd ?? '', source), { maxBytes: LIMITS.hookPayloadBytes })
        if (built.truncated)
          log.debug('hooks: the payload was cut to its size limit', { event, source })
        json = built.json
        payloads.set(source, json)
      }
      return json
    }

    const commands = selected.map(hook => runCommand(event, hook, cwd, payload, signal))
    const code = codeName === null ? Promise.resolve(null) : runCode(event, codeName, input, signal)
    const settled = await runtime.track(Promise.allSettled([Promise.allSettled(commands), code]))
    throwIfAborted(options.signal, runtime.stopSignal)

    const [commandResults, codeResult] = settled
    const ran: RanCommand[] = []
    if (commandResults.status === 'fulfilled') {
      for (const entry of commandResults.value) {
        if (entry.status === 'fulfilled' && entry.value !== null)
          ran.push(entry.value)
        else if (entry.status === 'rejected')
          log.warn('hooks: a command hook failed unexpectedly', { event, err: entry.reason })
      }
    }
    const codeRan = codeResult.status === 'fulfilled' ? codeResult.value : null
    if (ran.length === 0 && codeRan === null)
      return noneRan()

    const id = createHookRecordId()
    const at = runtime.now()
    const ranHooks: RanHook[] = [
      ...ran.map(entry => ({
        source: entry.hook.source,
        label: entry.hook.label,
        ...(entry.hook.pluginId === undefined ? {} : { pluginId: entry.hook.pluginId }),
        exitCode: entry.exitCode,
        timedOut: entry.timedOut,
        durationMs: entry.durationMs,
        outcome: entry.outcome,
        error: entry.error,
      })),
      ...(codeRan === null || codeName === null
        ? []
        : codeRan.plugins.map((pluginId, index) => ({
            source: 'plugin' as const,
            label: `${pluginId}: ${codeName}`,
            pluginId,
            exitCode: null,
            timedOut: false,
            durationMs: codeRan.durationMs,
            outcome: codeRan.outcome,
            error: null,
            shared: index > 0,
          }))),
    ]
    const tool = input.tool === undefined ? null : { callId: input.tool.callId, name: options.target ?? input.tool.name }
    const { result } = eventResult({ event, ran: ranHooks, id, createdAt: at, tool })

    for (const hook of ranHooks) {
      const outcome = hook.shared === true ? null : singleOutcome(event, hook)
      const entry: HookRun = {
        id,
        at,
        event,
        source: hook.source,
        label: cutText(hook.label, LIMITS.hookLabelMaxChars),
        ...(hook.pluginId === undefined ? {} : { pluginId: hook.pluginId }),
        chatId: scope.chatId,
        exitCode: hook.exitCode,
        timedOut: hook.timedOut,
        durationMs: Math.max(0, hook.durationMs),
        outcome,
        ...(hook.error === null ? {} : { error: hook.error }),
      }
      runtime.runLog.add(entry)
      log.info('hook ran', { event, source: hook.source, hook: labelHash(hook.label), exitCode: hook.exitCode, durationMs: entry.durationMs, outcome })
    }
    return result
  }

  return Object.freeze({
    scope,
    has: (event: HookEvent) => present.has(event),
    run: (event: HookEvent, input: HookRunInput, options: HookRunOptions) => run(event, input, options),
  })
}

/** The result of an event for which no hook ran (a fresh object: callers may keep it). */
function noneRan(): HookEventResult {
  return { ran: false, decision: null, reason: null, context: null, block: false, continue: true, stopReason: null, record: null }
}
