// Steering (Phase 9, ADR-042, ARCHITECTURE.md 6.20): queued messages delivered to a running reply at step boundaries,
// and the placement of every chunk a step boundary adds to the transcript.
//
// - `stepInjector(source)` (COMPLETE since P9-0b, C26; frozen): the transform piped as
//   `ui.pipeThrough(stepInjector(session)).pipeThrough(storeGeneratedFiles(...))`. A step boundary (`prepareStep`) adds
//   chunks with `RunSession.inject(chunk, stepNumber)`: the `data-steer` parts of the steer step (W9.2) and the
//   `data-compaction` marker or a notice of the context guard (W9.1). The UI stream may lag behind the model stream
//   (the SDK enqueues step N+1's chunks while the consumer still reads step N), so the injector counts the `finish-step`
//   chunks it has passed and emits the chunks injected for step N right before the next `start-step` once N steps
//   finished, i.e. right before step N's own `start-step`. What is left when the stream ends (a step whose model call
//   failed before its `start-step`, an abort) is emitted before the `finish` chunk, or when the stream closes. Chunks
//   keep their injection order. A steer therefore always lands between two steps, so `splitSteers` rebuilds the same
//   model history from the saved reply.
// - `createSteerStep(input)` (W9.2): the second piece of the step composer (`steps.ts`). Before every model call (step 0
//   included: the first call of a new turn or of an approval continuation delivers what waited) it synchronously takes
//   every steerable queued item of the chat (`ChatQueue.takeSteerable`, reported `delivered`; the take cannot race a
//   `DELETE`) and injects one `data-steer { id, parts, queuedAt, deliveredAt }` per item for that step at once (so the
//   transcript holds every taken item, even when a conversion fails); then it turns each item into a user model
//   message (a one-message UI history through `prepareModelFiles` and `convertToModelMessages`, exactly what
//   `buildModelHistory` + `prepareModelFiles` make of the saved steer later) and appends them to `messages` (the SDK
//   carries them into later steps). An aborted run takes nothing (its end empties the queue). Steer texts are never
//   logged.
//   Phase 10 (ADR-046, W10.4): right after the queue, the same synchronous take empties the chat's inbox of finished
//   background tasks (`RunContext.background.takeResults(chatId, replyId)`: each result is delivered exactly once, into
//   this reply) and injects one `data-task-result` part per result for the step, after the steers; the model reads each
//   as a user message with `taskResultText` (one text part: exactly what `splitTaskResults` makes of the saved part).
//   Step 0 counts here too: a new turn or an approval continuation takes what waited. Reports are never logged.
//   Phase 11 (ADR-048, W11.2): an item queued with `UserPromptSubmit` records (`QueueEntry.hookRecords`, run at enqueue)
//   gets one `data-hook` part per record right after its `data-steer` part, and the model reads the record's model text
//   (`hookModelText(record, 'assistant')`: a context) as a user message right after the item's own: exactly what
//   `splitSteers` + `splitHooks` make of the saved reply (the record lies in the half after the steer). Records without
//   model text are stored only. Contexts are never logged.
import type { HarnessUIMessage, HookData, QueueItem, TaskResultData } from '@harness-forge/shared'
import type { ModelMessage, ToolSet } from 'ai'
import type { ResolvedModel } from '../providers/types.ts'
import type { HarnessUIMessageChunk } from './generated-files.ts'
import type { HarnessDataChunk, RunSession } from './pipeline.ts'
import type { StepPiece } from './steps.ts'
import { hookModelText, taskResultText } from '@harness-forge/shared'
import { convertToModelMessages } from 'ai'
import { prepareModelFiles } from './files.ts'
import { hookModelMessage } from './hooks.ts'

/** Where `stepInjector` takes the injected chunks from (`RunSession` implements it). */
export interface StepInjectionSource {
  /**
   * Removes and returns, in injection order, every pending chunk injected for a step `<= finishedSteps`
   * (`Number.POSITIVE_INFINITY`: every pending chunk).
   */
  takeInjections: (finishedSteps: number) => HarnessUIMessageChunk[]
}

/** The transform that places injected chunks at their step boundary (see the module comment). */
export function stepInjector(source: StepInjectionSource): TransformStream<HarnessUIMessageChunk, HarnessUIMessageChunk> {
  let finishedSteps = 0
  const emit = (controller: TransformStreamDefaultController<HarnessUIMessageChunk>, chunks: readonly HarnessUIMessageChunk[]): void => {
    for (const chunk of chunks)
      controller.enqueue(chunk)
  }
  return new TransformStream<HarnessUIMessageChunk, HarnessUIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type === 'start-step')
        emit(controller, source.takeInjections(finishedSteps))
      else if (chunk.type === 'finish')
        emit(controller, source.takeInjections(Number.POSITIVE_INFINITY))
      controller.enqueue(chunk)
      if (chunk.type === 'finish-step')
        finishedSteps += 1
    },
    flush(controller) {
      emit(controller, source.takeInjections(Number.POSITIVE_INFINITY))
    },
  })
}

/** What the steer step of a run needs. */
export interface SteerStepInput {
  /**
   * The run: its chat (`chatId`), the chat queue (`ctx.queue`), `inject` for the `data-steer` parts, the files service
   * and logger of `prepareModelFiles`, the clock (`ctx.now`, `deliveredAt`).
   */
  readonly session: RunSession
  /** The run's model (its capabilities decide how the files of a steered message are sent). */
  readonly model: ResolvedModel
  /** The run's tool set (`convertToModelMessages`). */
  readonly tools: ToolSet
}

/** The `data-steer` chunk of a delivered item (its id is the queued message id). */
export function steerChunk(item: QueueItem, deliveredAt: number): HarnessDataChunk {
  return { type: 'data-steer', data: { id: item.id, parts: item.message.parts, queuedAt: item.createdAt, deliveredAt } }
}

/** A delivered item as the one-message UI history of its user message (what `splitSteers` makes of the saved part). */
export function steerUIMessage(item: QueueItem): HarnessUIMessage {
  return { id: item.id, role: 'user', parts: item.message.parts }
}

/**
 * The user model message(s) of a delivered item: its files loaded for the run's model (`prepareModelFiles`), then
 * `convertToModelMessages`. A conversion that fails falls back to the item's text (the model still reads the steer).
 */
export async function steerModelMessages(item: QueueItem, input: SteerStepInput): Promise<ModelMessage[]> {
  const { session, model, tools } = input
  const { deps, logger } = session.ctx
  try {
    const files = await prepareModelFiles([steerUIMessage(item)], { capabilities: model.entry.capabilities, files: deps.files, logger })
    return await convertToModelMessages<HarnessUIMessage>(files.messages, { tools, ignoreIncompleteToolCalls: true })
  }
  catch (error) {
    logger.warn('a steered message could not be converted; its text is sent', { itemId: item.id, err: error })
    const text = item.message.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
    return [{ role: 'user', content: text === '' ? '(The user sent files that could not be read.)' : text }]
  }
}

/** The `data-task-result` chunk of a delivered background task result (Phase 10). */
export function taskResultChunk(data: TaskResultData): HarnessDataChunk {
  return { type: 'data-task-result', data }
}

/**
 * The user model message of a delivered background task result: one text part with `taskResultText`, exactly what
 * `buildModelHistory` (`splitTaskResults`) + `convertToModelMessages` make of the saved part later.
 */
export function taskResultModelMessage(data: TaskResultData): ModelMessage {
  return { role: 'user', content: [{ type: 'text', text: taskResultText(data) }] }
}

/** The `data-hook` chunk of a record delivered with a steered item (Phase 11). */
export function steerHookChunk(data: HookData): HarnessDataChunk {
  return { type: 'data-hook', data }
}

/** The user model messages of the records delivered with a steered item: their model text, when they have one. */
export function steerHookModelMessages(records: readonly HookData[]): ModelMessage[] {
  return records.flatMap((record) => {
    const text = hookModelText(record, 'assistant')
    return text === null ? [] : [hookModelMessage(text)]
  })
}

/** The finished background results waiting for the chat (`[]` when the manager fails: they stay undelivered then). */
function takeTaskResults(session: RunSession): TaskResultData[] {
  const { ctx } = session
  try {
    return ctx.background.takeResults(session.chatId, session.assistantId)
  }
  catch (error) {
    ctx.logger.warn('cannot take the finished background tasks of the chat', { err: error })
    return []
  }
}

/** The steer piece of the step composer (see the module comment). */
export function createSteerStep(input: SteerStepInput): StepPiece {
  const { session } = input
  return async ({ stepNumber, messages }) => {
    const { ctx } = session
    if (ctx.run.signal.aborted)
      return undefined
    // Synchronous takes and injections: a `DELETE` either removed the item before or answers 404 now; a background
    // result is either taken here (exactly once) or waits for a later boundary or the run's release.
    const entries = ctx.queue.takeSteerableEntries(session.chatId)
    const results = takeTaskResults(session)
    if (entries.length === 0 && results.length === 0)
      return undefined
    const deliveredAt = ctx.now()
    for (const entry of entries) {
      session.inject(steerChunk(entry.item, deliveredAt), stepNumber)
      for (const record of entry.hookRecords ?? [])
        session.inject(steerHookChunk(record), stepNumber)
    }
    for (const result of results)
      session.inject(taskResultChunk(result), stepNumber)
    if (entries.length > 0)
      ctx.logger.debug('steered queued messages into the run', { stepNumber, count: entries.length, itemIds: entries.map(entry => entry.item.id) })
    if (results.length > 0)
      ctx.logger.debug('delivered background task results into the run', { stepNumber, count: results.length, taskIds: results.map(result => result.taskId) })
    const steered: ModelMessage[] = []
    for (const entry of entries) {
      steered.push(...await steerModelMessages(entry.item, input))
      steered.push(...steerHookModelMessages(entry.hookRecords ?? []))
    }
    for (const result of results)
      steered.push(taskResultModelMessage(result))
    return { messages: [...messages, ...steered] }
  }
}
