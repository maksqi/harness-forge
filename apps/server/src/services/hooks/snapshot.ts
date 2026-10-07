// Hook snapshots (Phase 11, ADR-048; ARCHITECTURE.md 6.28; Phase 12 ADR-057, 6.37): the hooks of one scope merged ONCE
// (per run and per prepare) and run per event. Owner: W11.1, Phase 12: W12.5.
//
// Sources (additive, in run order): personal rows (`enabled`, a valid matcher), plugin hooks (`registry.hookCommands`
// of active plugins; `HARNESS_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` = the plugin folder, plus the plugin's extra
// environment `CLAUDE_PLUGIN_DATA` / `CLAUDE_PLUGIN_OPTION_<KEY>`) and the project's settings-file hooks (only when the
// run's project folder opened, the scan is of that folder and the item's sha256 is approved; identical hashes run once).
// Each source gives command handlers and (Phase 12) prompt handlers. The kill switches: `hooksEnabled: false` and
// `HF_SAFE_MODE` leave no command and no prompt hook, `HF_WORKSPACE_SHELL=0` leaves no command hook (prompt hooks run no
// shell); the plugin code hooks of the event (`code-hooks.ts`) run regardless.
//
// `run(event, input, { signal, target?, aliases? })`:
// - the matchers (compiled once per snapshot) are tested against the event's subject (`HOOK_MATCHER_SUBJECTS`): the
//   tool names (`aliases`, default `hookTargetNames(target)`), the agent type of SubagentStart / SubagentStop (`aliases`,
//   default `hookAgentNames(type)`; an event without an agent ignores the matcher, as in v1.7), the SessionStart source,
//   the PreCompact / PostCompact trigger, the Notification type or the SessionEnd reason; events without a subject ignore
//   the matcher. On the tool events a handler's `if` rule must match the call too (`matchHookIf`: a command the shell
//   parser cannot split matches, an invalid rule never does);
// - at most `LIMITS.hooksPerEventMax` (20) matching handlers run, in parallel: command hooks through the server-wide
//   process semaphore (`LIMITS.hookProcessesMax`, acquired with the run signal), each with its own timeout and process
//   group (exec-form `args` through `exec-form.ts`, still `runShellCommand`; W12.16: a plugin hook's `${user_config.KEY}`
//   references are substituted there, at spawn, from its extra environment, so a snapshot, its labels and the run log
//   never hold an option value); prompt hooks through the prompt-hook runner (`prompt-hooks.ts`, the limiter of
//   `LIMITS.hookModelCallsMax` calls); `async` command hooks start detached (tracked, their timeout enforced, killed by
//   the service's `stop()`, never by the run; their outcome only reaches the run log, never the result);
// - a project item is verified right before its spawn or model call (`projectConfig.verify`: the item and its referenced
//   files are hashed again); a mismatch skips it as pending, drops the project's config cache and announces the change;
// - when a command or prompt hook runs, the chat's transcript is written first (`transcripts.ts`) and its path joins the
//   payload (`transcript_path`); the stdin payload is `buildHookPayload` (one per source: `harness.source` differs), the
//   working folder the project root, else `<dataDir>/hooks` (0700);
// - every command outcome is read with `readHookOutput`, every prompt outcome comes from `promptHookOutcome`; they are
//   combined with the code hooks' outcome and turned into the result and its record (`record.ts`); every hook that ran is
//   added to the run log and logged at `info` with the event, the source, a hash prefix of the label, the exit code, the
//   duration and the outcome only (the redacted command at `debug`; payloads, prompts, answers, stdout and stderr never).
// `statusMessage(event, target?)`: the label of the first handler (source and declaration order) with a `statusMessage`
// whose matcher, and on a tool target whose `if` rule, would let it run.
// An abort of the run (or the service's `stop()`) kills the running groups and rejects `run`; nothing else rejects.
import type { HookName } from '@harness-forge/plugin-sdk'
import type { CompiledMatcher, HookEvent, HookIfTarget, HookOutcome, HookPayloadInput, HookRun, HookSource } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { ProjectHookItem } from '../project-config/types.ts'
import type { PromptHookRuntime } from './prompt-hooks.ts'
import type { RanHook } from './record.ts'
import type { HookRunLog } from './run-log.ts'
import type { CommandHookOptions } from './runner.ts'
import type { Semaphore } from './semaphore.ts'
import type { TranscriptWriter } from './transcripts.ts'
import type { HookEventResult, HookRunInput, HookRunOptions, HookScope, HookSnapshot } from './types.ts'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  buildHookPayload,
  createHookRecordId,
  HOOK_EVENTS,
  HOOK_MATCHER_SUBJECTS,
  hookAgentNames,
  hookTargetNames,
  LIMITS,
  matchHookIf,
  readHookOutput,
  TOOL_HOOK_EVENTS,
} from '@harness-forge/shared'
import { redactShellCommand } from '../../workspace/shell.ts'
import { codeHookOf, codeHookPlugins, runCodeHooks } from './code-hooks.ts'
import { commandHookEnv, commandHookLine, commandHookLogLine } from './exec-form.ts'
import { runPromptHook } from './prompt-hooks.ts'
import { eventResult, singleOutcome } from './record.ts'
import { cutText } from './run-log.ts'
import { HOOK_START_ERROR, hookTimeoutMs, runCommandHook } from './runner.ts'

/** What every handler of a snapshot has. */
interface SnapshotHookBase {
  readonly source: HookSource
  readonly event: HookEvent
  /** The matcher as configured (null = every target). */
  readonly matcher: string | null
  readonly compiled: Extract<CompiledMatcher, { readonly ok: true }>
  /** Seconds; null = the default (60 s for a command hook, 30 s for a prompt hook). */
  readonly timeoutSec: number | null
  /** The record / run log label (the redacted command head or the prompt's first line; a project item adds its file). */
  readonly label: string
  readonly pluginId?: string
  /** The plugin folder (`HARNESS_PLUGIN_ROOT`). */
  readonly pluginRoot?: string
  /** A project item: verified right before it runs. */
  readonly item?: ProjectHookItem
  /** Phase 12: the `if` rule (tool events only). */
  readonly if?: string
  /** Phase 12: the activity label while the handler runs. */
  readonly statusMessage?: string
}

/** One command handler of a snapshot. */
export interface SnapshotCommandHook extends SnapshotHookBase {
  readonly kind: 'command'
  /** The shell command, or the program of the exec form. */
  readonly command: string
  /** Phase 12: exec form (`execFormCommand`); a plugin hook's `${user_config.KEY}` references as written (W12.16). */
  readonly args?: readonly string[]
  /** Phase 12: runs detached, without an effect on the result. */
  readonly async?: boolean
  /** Phase 12: a plugin hook's extra environment (`RegisteredHookCommands.env`). */
  readonly pluginEnv?: Readonly<Record<string, string>>
}

/** One prompt handler of a snapshot (Phase 12). */
export interface SnapshotPromptHook extends SnapshotHookBase {
  readonly kind: 'prompt'
  readonly prompt: string
  /** A model ref, a Claude model name, or null (the hook model). */
  readonly model: string | null
  readonly continueOnBlock: boolean
}

/** One handler of a snapshot. */
export type SnapshotHook = SnapshotCommandHook | SnapshotPromptHook

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
  /** Phase 12: the prompt-hook runner's deps and limiter; absent = prompt hooks fail as non-blocking errors. */
  readonly prompts?: PromptHookRuntime
  /** Phase 12: the transcript writer; absent = no `transcript_path`. */
  readonly transcripts?: TranscriptWriter
}

/** The sources of a snapshot, gathered by the service. */
export interface SnapshotSources {
  readonly scope: HookScope
  /** The handlers in run order (personal, plugin, project); without the ones a kill switch stops. */
  readonly hooks: readonly SnapshotHook[]
  /** Events with code hooks of an active plugin (at snapshot time). */
  readonly codeEvents: ReadonlySet<HookEvent>
}

/** First 12 hex characters of the sha256 of a label: what `info` logs instead of the command. */
export function labelHash(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 12)
}

/** The label of a command hook: its redacted, cut command (a project item is prefixed with its settings file). */
export function commandLabel(redactor: { readonly redactText: (text: string) => string }, command: string, file?: string, args?: readonly string[]): string {
  const line = args === undefined || args.length === 0 ? command : `${command} ${args.join(' ')}`
  const head = redactor.redactText(cutText(line.replace(/\s+/g, ' ').trim(), LIMITS.hookLabelMaxChars * 2))
  return cutText(file === undefined ? head : `${file}: ${head}`, LIMITS.hookLabelMaxChars)
}

const TOOL_EVENT_SET: ReadonlySet<HookEvent> = new Set(TOOL_HOOK_EVENTS)

/** The names a hook's matcher is tested against for `event`, or null when the event ignores matchers. */
export function matcherSubjects(event: HookEvent, input: HookRunInput, options: Pick<HookRunOptions, 'target' | 'aliases'>): readonly string[] | null {
  switch (HOOK_MATCHER_SUBJECTS[event]) {
    case 'tool': {
      if (options.aliases !== undefined)
        return options.aliases
      const target = options.target ?? input.tool?.name
      return target === undefined ? [] : hookTargetNames(target)
    }
    case 'agent': {
      if (options.aliases !== undefined)
        return options.aliases
      const type = options.target ?? input.agent?.type
      // No agent named (the v1.7 input of SubagentStop): the matcher is ignored, as it was.
      return type === undefined || type === '' ? null : hookAgentNames(type)
    }
    case 'source':
      return [input.sessionSource ?? 'startup']
    case 'trigger':
      return [input.trigger ?? 'auto']
    case 'notification':
      return input.notificationType === undefined ? [] : [input.notificationType]
    case 'reason':
      return [input.sessionEndReason ?? 'other']
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

/** The project MCP server name an alias list carries for `tool` (`mcp__<name>__<tool>` other than the tool itself). */
function mcpServerNameOf(aliases: readonly string[] | undefined, tool: string): string | undefined {
  for (const alias of aliases ?? []) {
    if (alias === tool || !alias.startsWith('mcp__'))
      continue
    const end = alias.indexOf('__', 5)
    if (end > 5)
      return alias.slice(5, end)
  }
  return undefined
}

/** The tool call an `if` rule of `event` is tested against; null for the events without one. */
export function ifTargetOf(event: HookEvent, input: HookRunInput, options: Pick<HookRunOptions, 'target' | 'aliases'>): HookIfTarget | null {
  if (!TOOL_EVENT_SET.has(event))
    return null
  const tool = options.target ?? input.tool?.name ?? ''
  const server = mcpServerNameOf(options.aliases, tool)
  return { tool, ...(input.tool === undefined ? {} : { input: input.tool.input }), ...(server === undefined ? {} : { mcpServerName: server }) }
}

/** The handler's `if` rule lets it run for the call (no rule, or an event without a call: always). */
export function hookIfMatches(hook: Pick<SnapshotHook, 'if'>, target: HookIfTarget | null): boolean {
  if (hook.if === undefined || target === null)
    return true
  return matchHookIf(hook.if, target)
}

/** The handler would run for `target` of `event` (the `statusMessage` test; see the module comment). */
function labelMatches(hook: SnapshotHook, event: HookEvent, target: string | undefined): boolean {
  const subject = HOOK_MATCHER_SUBJECTS[event]
  if (target === undefined) {
    if (hook.if !== undefined && TOOL_EVENT_SET.has(event))
      return false
    return subject === null || hook.matcher === null
  }
  const subjects = subject === 'tool' ? hookTargetNames(target) : subject === 'agent' ? hookAgentNames(target) : subject === null ? null : [target]
  if (!hookMatches(hook, subjects))
    return false
  return !TOOL_EVENT_SET.has(event) || hookIfMatches(hook, { tool: target })
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

/** The record entry fields of a handler that ran. */
function ranBase(hook: SnapshotHook): Pick<RanHook, 'source' | 'label' | 'pluginId'> {
  return { source: hook.source, label: hook.label, ...(hook.pluginId === undefined ? {} : { pluginId: hook.pluginId }) }
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

  function payloadInput(event: HookEvent, input: HookRunInput, cwd: string, source: HookSource, transcriptPath: string | null): HookPayloadInput {
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
      ...(transcriptPath === null ? {} : { transcriptPath }),
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.sessionEndReason === undefined ? {} : { sessionEndReason: input.sessionEndReason }),
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

  /** Verify-before-run; a stale project item is reported (and never runs). */
  async function stillApproved(event: HookEvent, hook: SnapshotHook, signal: AbortSignal): Promise<boolean> {
    if (await verified(hook, signal))
      return true
    log.info('hooks: a project hook changed since it was approved and did not run', { event, source: hook.source, hook: labelHash(hook.label) })
    if (scope.projectId !== null)
      runtime.onStale(scope.projectId)
    return false
  }

  /** One command hook process (`signal` = the run's, or the service's stop for an `async` hook). */
  async function runCommand(event: HookEvent, hook: SnapshotCommandHook, cwd: string | null, payload: (source: HookSource) => string, signal: AbortSignal): Promise<RanHook | null> {
    const release = await runtime.semaphore.acquire(signal)
    try {
      if (!await stillApproved(event, hook, signal))
        return null
      const line = cwd === null ? null : commandHookLine(hook, cwd)
      if (cwd === null || line === null) {
        const error = cwd === null ? 'The hook folder could not be created.' : HOOK_START_ERROR
        return { ...ranBase(hook), exitCode: null, timedOut: false, durationMs: 0, outcome: startFailure(event), error }
      }
      // The line that runs may hold plugin option values (W12.16): the debug log shows the references as written.
      if (log.isLevelEnabled('debug'))
        log.debug('hooks: running a command hook', { event, source: hook.source, command: redactShellCommand(commandHookLogLine(hook, cwd)), async: hook.async === true })
      const run = await runCommandHook({ command: line, cwd, timeoutMs: hookTimeoutMs(hook.timeoutSec), payload: payload(hook.source), env: commandHookEnv(hook, cwd), signal }, runtime.runner)
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
        ...ranBase(hook),
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

  /** One prompt hook (the model call through the server-wide limiter). */
  async function runPrompt(event: HookEvent, hook: SnapshotPromptHook, input: HookRunInput, payload: (source: HookSource) => string, signal: AbortSignal): Promise<RanHook | null> {
    if (!await stillApproved(event, hook, signal))
      return null
    if (runtime.prompts === undefined)
      return { ...ranBase(hook), kind: 'prompt', exitCode: null, timedOut: false, durationMs: 0, outcome: startFailure(event), error: HOOK_START_ERROR }
    return runPromptHook(runtime.prompts, {
      event,
      hook: {
        source: hook.source,
        prompt: hook.prompt,
        model: hook.model,
        timeoutSec: hook.timeoutSec,
        continueOnBlock: hook.continueOnBlock,
        label: hook.label,
        ...(hook.pluginId === undefined ? {} : { pluginId: hook.pluginId }),
      },
      payload: payload(hook.source),
      chatId: scope.chatId,
      messageId: input.messageId ?? null,
      runModelRef: scope.modelRef,
      signal,
    })
  }

  /** Adds an entry to the run log and logs the run (no command, payload, prompt or answer). */
  function logRun(event: HookEvent, id: string, at: number, hook: RanHook, outcome: HookRun['outcome']): void {
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
    log.info('hook ran', { event, source: hook.source, ...(hook.kind === 'prompt' ? { kind: 'prompt' } : {}), hook: labelHash(hook.label), exitCode: hook.exitCode, durationMs: entry.durationMs, outcome })
  }

  /**
   * Starts an `async` command hook: detached from the run (only the service's stop kills it before its timeout), its
   * outcome goes to the run log only (`error` when it failed, else no outcome).
   */
  function startDetached(event: HookEvent, hook: SnapshotCommandHook, cwd: string | null, payload: (source: HookSource) => string): void {
    void runtime.track((async () => {
      let ran: RanHook | null
      try {
        ran = await runCommand(event, hook, cwd, payload, runtime.stopSignal)
      }
      catch (error) {
        if (!runtime.stopSignal.aborted)
          log.warn('hooks: an async hook failed unexpectedly', { event, err: error })
        return
      }
      if (ran === null)
        return
      const failed = ran.outcome.status === 'error' || ran.error !== null || ran.timedOut
      logRun(event, createHookRecordId(), runtime.now(), ran, failed ? 'error' : null)
    })())
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

  async function transcriptOf(cwd: string | null, signal: AbortSignal): Promise<string | null> {
    if (runtime.transcripts === undefined || cwd === null)
      return null
    try {
      return await runtime.transcripts.ensure(scope.chatId, cwd, signal)
    }
    catch (error) {
      if (signal.aborted)
        throw error
      return null
    }
  }

  async function run(event: HookEvent, input: HookRunInput, options: HookRunOptions): Promise<HookEventResult> {
    throwIfAborted(options.signal, runtime.stopSignal)
    const subjects = matcherSubjects(event, input, options)
    const ifTarget = ifTargetOf(event, input, options)
    const matching = (byEvent.get(event) ?? []).filter(hook => hookMatches(hook, subjects) && hookIfMatches(hook, ifTarget))
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
    // Phase 12: the transcript, written only now that a command or prompt hook runs.
    const transcriptPath = selected.length > 0 ? await transcriptOf(cwd, signal) : null
    throwIfAborted(options.signal, runtime.stopSignal)
    const payloads = new Map<HookSource, string>()
    const payload = (source: HookSource): string => {
      let json = payloads.get(source)
      if (json === undefined) {
        const built = buildHookPayload(event, payloadInput(event, input, cwd ?? '', source, transcriptPath), { maxBytes: LIMITS.hookPayloadBytes })
        if (built.truncated)
          log.debug('hooks: the payload was cut to its size limit', { event, source })
        json = built.json
        payloads.set(source, json)
      }
      return json
    }

    const attached: Promise<RanHook | null>[] = []
    for (const hook of selected) {
      if (hook.kind === 'command' && hook.async === true)
        startDetached(event, hook, cwd, payload)
      else if (hook.kind === 'command')
        attached.push(runCommand(event, hook, cwd, payload, signal))
      else
        attached.push(runPrompt(event, hook, input, payload, signal))
    }
    const code = codeName === null ? Promise.resolve(null) : runCode(event, codeName, input, signal)
    const settled = await runtime.track(Promise.allSettled([Promise.allSettled(attached), code]))
    throwIfAborted(options.signal, runtime.stopSignal)

    const [handlerResults, codeResult] = settled
    const ran: RanHook[] = []
    if (handlerResults.status === 'fulfilled') {
      for (const entry of handlerResults.value) {
        if (entry.status === 'fulfilled' && entry.value !== null)
          ran.push(entry.value)
        else if (entry.status === 'rejected')
          log.warn('hooks: a hook failed unexpectedly', { event, err: entry.reason })
      }
    }
    const codeRan = codeResult.status === 'fulfilled' ? codeResult.value : null
    if (ran.length === 0 && codeRan === null)
      return noneRan()

    const id = createHookRecordId()
    const at = runtime.now()
    const ranHooks: RanHook[] = [
      ...ran,
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

    for (const hook of ranHooks)
      logRun(event, id, at, hook, hook.shared === true ? null : singleOutcome(event, hook))
    return result
  }

  function statusMessage(event: HookEvent, target?: string): string | null {
    for (const hook of byEvent.get(event) ?? []) {
      if (hook.statusMessage === undefined || hook.statusMessage === '')
        continue
      if (labelMatches(hook, event, typeof target === 'string' && target !== '' ? target : undefined))
        return hook.statusMessage
    }
    return null
  }

  return Object.freeze({
    scope,
    has: (event: HookEvent) => present.has(event),
    run: (event: HookEvent, input: HookRunInput, options: HookRunOptions) => run(event, input, options),
    statusMessage: (event: HookEvent, target?: string) => {
      try {
        return statusMessage(event, target)
      }
      catch {
        return null
      }
    },
  })
}

/** The result of an event for which no hook ran (a fresh object: callers may keep it). */
function noneRan(): HookEventResult {
  return { ran: false, decision: null, reason: null, context: null, block: false, continue: true, stopReason: null, record: null }
}
