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
// - `createSteerStep(input)` (stub until W9.2: a piece that changes nothing): the second piece of the step composer
//   (`steps.ts`). W9.2: synchronously takes every steerable queued item of the chat (`ChatQueue.takeSteerable`), turns
//   each into a user model message (a one-message UI history through `prepareModelFiles` and `convertToModelMessages`),
//   appends them to `messages` (carried into later steps) and injects `data-steer { id, parts, queuedAt, deliveredAt }`
//   for that step; step 0 counts (the first call of a new turn or of an approval continuation).
import type { ToolSet } from 'ai'
import type { ResolvedModel } from '../providers/types.ts'
import type { HarnessUIMessageChunk } from './generated-files.ts'
import type { RunSession } from './pipeline.ts'
import type { StepPiece } from './steps.ts'
import { noopStepPiece } from './steps.ts'

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

/** The steer piece of the step composer (stub until W9.2: changes nothing; see the module comment). */
export function createSteerStep(_input: SteerStepInput): StepPiece {
  return noopStepPiece
}
