// Prompt hooks (Phase 12, ADR-057; ARCHITECTURE.md 6.37 "Prompt hooks"). Owner: W12.5.
//
// A prompt handler (`type: 'prompt'`) runs inside `snapshot.run` as one more `RanHook`, so the chat seams apply its
// effects exactly like a command hook's:
// 1. Prompt: `expandHookPrompt(prompt, payloadJson)` (`$ARGUMENTS` = the hook input JSON, appended when absent; `\$` is
//    a literal `$`).
// 2. Model, the first candidate that resolves (the `chat/title.ts` pattern): the handler's `model` (a model ref, or a
//    Claude model name through `resolveClaudeModel` and the setting `modelAliases`), the setting `hookModelRef`, the
//    run provider's `smallModelId`, the run model. None → a non-blocking error.
// 3. Call: `generateText` with reasoning off, `maxRetries: 0`, `LIMITS.promptHookMaxOutputTokens` output tokens, the
//    handler's timeout (default `LIMITS.promptHookTimeoutDefaultMs`, at most `LIMITS.hookTimeoutMaxMs`) and the run's
//    signal; at most `LIMITS.hookModelCallsMax` calls of the whole server at once (the limiter is shared by every
//    snapshot of the service; the others wait, leaving the queue when their run aborts). A usage row `purpose: 'hook'`.
// 4. Answer: only `readPromptHookAnswer`; the outcome only `promptHookOutcome(event, answer, { continueOnBlock })`, which
//    never allows anything (`ok: true` decides nothing).
// Failures (a timeout, a failing provider, an unreadable answer) are non-blocking errors with a fixed, safe text; only an
// abort of the run (or the service's stop) rejects. Prompts and answers are never logged (`debug` gets their sizes).
import type { HookEvent, HookOutcome, HookSource } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { ResolvedModel } from '../../providers/types.ts'
import type { AppDeps } from '../../types.ts'
import type { RanHook } from './record.ts'
import type { Semaphore } from './semaphore.ts'
import { performance } from 'node:perf_hooks'
import { claudeModelAlias, expandHookPrompt, LIMITS, promptHookOutcome, readPromptHookAnswer, safeParseModelRef } from '@harness-forge/shared'
import { generateText } from 'ai'
import { resolveClaudeModel } from '../../chat/model-aliases.ts'
import { providerReasoning } from '../../chat/params.ts'
import { catalogCost } from '../../chat/usage.ts'

/** The system text of every prompt-hook call. */
export const PROMPT_HOOK_INSTRUCTIONS = [
  'You check one step of a coding agent for its user.',
  'The user message holds the check to make and the step as JSON.',
  'Answer with one JSON object and nothing else: {"ok": true} when the check passes, or {"ok": false, "reason": "<why, in one or two sentences>"} when it does not.',
  'Add "impossible": true to a "no" only when the agent cannot do anything about it.',
].join(' ')

/** The errors of a prompt hook (safe to show; never the model's text or the provider's message). */
export const PROMPT_HOOK_ERRORS = {
  noModel: 'No model is available for the prompt hook.',
  timeout: 'The hook model did not answer in time.',
  failed: 'The hook model could not be reached.',
} as const

/** One prompt handler of a snapshot (the fields the runner reads). */
export interface PromptHookCall {
  readonly source: HookSource
  readonly prompt: string
  /** A model ref, a Claude model name, or null (the hook model). */
  readonly model: string | null
  /** Seconds; null = the prompt-hook default. */
  readonly timeoutSec: number | null
  readonly continueOnBlock: boolean
  /** The record label (the prompt's first line, redacted). */
  readonly label: string
  readonly pluginId?: string
}

/** What one prompt-hook run needs besides the handler. */
export interface PromptHookRunInput {
  readonly event: HookEvent
  readonly hook: PromptHookCall
  /** The hook input JSON (`buildHookPayload`). */
  readonly payload: string
  readonly chatId: string
  readonly messageId: string | null
  /** The run's model ref (`HookScope.modelRef`): its provider's small model and itself are the last candidates. */
  readonly runModelRef: string
  /** The run's signal combined with the service's stop. */
  readonly signal: AbortSignal
}

/** What the prompt-hook runner shares across snapshots (the service builds it once). */
export interface PromptHookRuntime {
  readonly deps: Pick<AppDeps, 'providers' | 'settings' | 'chats' | 'registry'>
  readonly logger: Logger
  /** The server-wide limiter (`LIMITS.hookModelCallsMax` slots). */
  readonly limiter: Semaphore
}

/** The timeout of a prompt hook: its own (seconds) or the default 30 s, at most 600 s. */
export function promptHookTimeoutMs(timeoutSec: number | null | undefined): number {
  const ms = typeof timeoutSec === 'number' && Number.isFinite(timeoutSec) && timeoutSec > 0
    ? Math.ceil(timeoutSec) * 1000
    : LIMITS.promptHookTimeoutDefaultMs
  return Math.min(ms, LIMITS.hookTimeoutMaxMs)
}

/** The record label of a prompt hook: its first non-empty line, blanks collapsed, cut. */
export function promptLabel(redactor: { readonly redactText: (text: string) => string }, prompt: string, file?: string): string {
  const line = prompt.split(/\r?\n/).map(value => value.trim()).find(value => value !== '') ?? ''
  const head = redactor.redactText(line.replace(/\s+/g, ' ').slice(0, LIMITS.hookLabelMaxChars * 2))
  const label = file === undefined ? head : `${file}: ${head}`
  return label.length <= LIMITS.hookLabelMaxChars ? label : label.slice(0, LIMITS.hookLabelMaxChars)
}

/**
 * The model refs to try, in order, without duplicates (see the module comment): the handler's `model`, the setting
 * `hookModelRef`, the run provider's small model, the run model.
 */
export async function promptHookModelCandidates(
  runtime: Pick<PromptHookRuntime, 'deps' | 'logger'>,
  model: string | null,
  runModelRef: string,
  signal: AbortSignal,
): Promise<string[]> {
  const settings = await runtime.deps.settings.get()
  const refs: string[] = []
  if (typeof model === 'string' && model.trim() !== '') {
    const value = model.trim()
    if (value.includes(':') && safeParseModelRef(value) !== null) {
      refs.push(value)
    }
    else {
      const alias = claudeModelAlias(value)
      if (alias !== null) {
        const resolved = await resolveClaudeModel(alias, { modelAliases: settings.modelAliases, providers: runtime.deps.providers, signal })
        if (resolved !== null)
          refs.push(resolved)
        else
          runtime.logger.debug('hooks: the Claude model name of a prompt hook has no model; the hook model is used')
      }
    }
  }
  if (settings.hookModelRef !== null)
    refs.push(settings.hookModelRef)
  const run = safeParseModelRef(runModelRef)
  if (run !== null) {
    try {
      const small = runtime.deps.registry.providers.get(run.providerId)?.definition.smallModelId
      if (typeof small === 'string' && small !== '')
        refs.push(`${run.providerId}:${small}`)
    }
    catch {
      // A provider that cannot be read adds no candidate.
    }
    refs.push(runModelRef)
  }
  return [...new Set(refs)]
}

async function resolveFirst(runtime: PromptHookRuntime, refs: readonly string[], signal: AbortSignal): Promise<ResolvedModel | null> {
  for (const ref of refs) {
    signal.throwIfAborted()
    try {
      return await runtime.deps.providers.resolveModel(ref, { signal })
    }
    catch (error) {
      if (signal.aborted)
        throw error
      runtime.logger.debug('hooks: a prompt hook model is not usable', { modelRef: ref, error: errorName(error) })
    }
  }
  return null
}

/** The name of an error (never its message or its fields). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function errorOutcome(event: HookEvent, error: string): HookOutcome {
  return promptHookOutcome(event, null, { error })
}

/**
 * Runs one prompt hook (see the module comment). Resolves with the `RanHook` (also for every failure); rejects only when
 * `input.signal` aborts.
 */
export async function runPromptHook(runtime: PromptHookRuntime, input: PromptHookRunInput): Promise<RanHook> {
  const { event, hook, signal } = input
  const begin = performance.now()
  const base = {
    source: hook.source,
    label: hook.label,
    ...(hook.pluginId === undefined ? {} : { pluginId: hook.pluginId }),
    kind: 'prompt' as const,
    exitCode: null,
  }
  const finish = (fields: { outcome: HookOutcome, timedOut?: boolean, model?: string, error?: string | null }): RanHook => ({
    ...base,
    ...(fields.model === undefined ? {} : { model: fields.model }),
    timedOut: fields.timedOut === true,
    durationMs: Math.round(performance.now() - begin),
    outcome: fields.outcome,
    error: fields.error === undefined ? fields.outcome.error : fields.error,
  })

  const release = await runtime.limiter.acquire(signal)
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new DOMException(PROMPT_HOOK_ERRORS.timeout, 'TimeoutError')), promptHookTimeoutMs(hook.timeoutSec))
  timer.unref?.()
  const callSignal = AbortSignal.any([signal, timeout.signal])
  let modelRef: string | undefined
  try {
    const candidates = await promptHookModelCandidates(runtime, hook.model, input.runModelRef, callSignal)
    const resolved = await resolveFirst(runtime, candidates, callSignal)
    if (resolved === null)
      return finish({ outcome: errorOutcome(event, PROMPT_HOOK_ERRORS.noModel) })
    modelRef = resolved.modelRef
    const reasoning = providerReasoning(resolved, 'off', runtime.logger)
    const prompt = expandHookPrompt(hook.prompt, input.payload)
    const result = await generateText({
      model: resolved.model,
      instructions: PROMPT_HOOK_INSTRUCTIONS,
      prompt,
      maxOutputTokens: Math.min(reasoning?.maxOutputTokens ?? LIMITS.promptHookMaxOutputTokens, LIMITS.promptHookMaxOutputTokens),
      maxRetries: 0,
      abortSignal: callSignal,
      ...(reasoning?.reasoning === undefined ? {} : { reasoning: reasoning.reasoning }),
      ...(reasoning?.providerOptions === undefined ? {} : { providerOptions: reasoning.providerOptions }),
    })
    const usage = result.usage
    try {
      await runtime.deps.chats.addUsage({
        chatId: input.chatId,
        messageId: input.messageId,
        purpose: 'hook',
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
        cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        costUsd: catalogCost(usage, resolved.entry.cost) ?? null,
      })
    }
    catch (error) {
      runtime.logger.warn('hooks: the usage of a prompt hook could not be stored', { err: error })
    }
    const read = readPromptHookAnswer(result.text)
    if (runtime.logger.isLevelEnabled('debug'))
      runtime.logger.debug('hooks: prompt hook answered', { event, modelRef, promptChars: prompt.length, answerChars: result.text.length, valid: read.valid })
    if (!read.valid)
      return finish({ outcome: errorOutcome(event, read.error), model: modelRef })
    return finish({ outcome: promptHookOutcome(event, read.answer, { continueOnBlock: hook.continueOnBlock }), model: modelRef, error: null })
  }
  catch (error) {
    if (signal.aborted)
      throw signal.reason ?? error
    if (timeout.signal.aborted)
      return finish({ outcome: errorOutcome(event, PROMPT_HOOK_ERRORS.timeout), timedOut: true, ...(modelRef === undefined ? {} : { model: modelRef }) })
    // Only the error's name: a provider error may carry the request body (the prompt).
    runtime.logger.debug('hooks: a prompt hook call failed', { event, error: errorName(error) })
    return finish({ outcome: errorOutcome(event, PROMPT_HOOK_ERRORS.failed), ...(modelRef === undefined ? {} : { model: modelRef }) })
  }
  finally {
    clearTimeout(timer)
    release()
  }
}
