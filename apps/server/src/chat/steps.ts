// The step composer of a run (Phase 9, ADR-040 / ADR-042 / ADR-043, ARCHITECTURE.md 6.20). FROZEN after P9-0b (C26,
// complete); Phase 11 (C37) adds the hooks piece; FROZEN again after P11-0b.
//
// `createPrepareStep({ contextGuard, hooks?, steer, finalize? })` builds the `prepareStep` function of `streamText`,
// which the AI SDK calls before every model call (step 0 included, never after a step without tool calls or with an
// open approval). Several features share it without editing one hot function; its pieces run in this fixed order on
// one step input, each seeing the messages the previous piece returned:
//   1. the context guard (`compaction/guard.ts`, W9.1): may replace `messages` with a compacted history;
//   2. the hooks piece (Phase 11, ADR-048, `hooks.ts`; C37, FROZEN after P11-0b): records the step number on the run
//      (`session.stepNumber`, where hook records are placed) and appends the model texts of the hooks that ran since the
//      previous step (`PostToolUse` contexts and block reasons) as user messages, before any steer, so the in-run order
//      equals what `splitHooks` rebuilds from the saved reply; absent = none (a sub-agent passes its own);
//   3. the steer step (`steer.ts`, W9.2): appends the queued messages as user messages;
//   4. the finalize nudge (sub-agents only, `subagent/index.ts`, W9.5): `activeTools` and `instructions` of the last
//      allowed step.
// The result carries `messages` only when a piece changed them (a piece that returns the array it was given changes
// nothing), plus `activeTools` / `instructions` from the finalize piece; nothing (undefined) otherwise, so the SDK
// keeps its own values. The SDK carries returned messages (and instructions) into the later steps. Only an abort error
// propagates (the run ends `aborted`); any other error of a piece is logged and the piece counts as unchanged (the guard
// falls back to trimming on its own, the steer step logs).
// Phase 12 (C44, ADR-057; COMPLETE and FROZEN after P12-0b): the composer is unchanged. The hooks piece also stores the
// hook records of a tool call nobody settled (`ToolHooks.settle`, `hooks.ts`), and its queue also holds the model texts
// of `PostToolUseFailure` records. A sub-agent's `SubagentStart` context is not queued: it is part of the child's first
// user message (`childFirstMessage`, `subagent/host.ts`).
import type { Instructions, ModelMessage, PrepareStepFunction, StepResult, ToolSet } from 'ai'
import type { Logger } from '../logger.ts'
import { isAbortError } from './errors.ts'

/** What a piece of the composer sees before one model call. */
export interface StepInput {
  /** The step about to run: 0 is the first model call of this run (a new turn or an approval continuation). */
  readonly stepNumber: number
  /** The messages of the call: the SDK's, or those the previous piece returned. */
  readonly messages: ModelMessage[]
  /** The instructions of the call, as text (undefined when the run has none). */
  readonly instructions: string | undefined
  /** The steps of this run that finished (`StepResult.usage` of the last one sizes the context). */
  readonly steps: ReadonlyArray<StepResult<ToolSet>>
}

/** What a piece returns: undefined (or `{}`) when it changes nothing. */
export interface StepPieceResult {
  /** The new messages of the call (carried into the later steps by the SDK). */
  messages?: ModelMessage[]
  /** The finalize piece only: the tools the model may call in this step (`[]` = none). */
  activeTools?: string[]
  /** The finalize piece only: the instructions of this step (carried into the later steps by the SDK). */
  instructions?: string
}

/** One piece of the composer. Throw only to abort (anything else is logged and ignored). */
export type StepPiece = (input: StepInput) => StepPieceResult | undefined | Promise<StepPieceResult | undefined>

/** A piece that changes nothing (the stubs, and the steer slot of a sub-agent). */
export const noopStepPiece: StepPiece = () => undefined

export interface StepComposerInput {
  /** 1. The context guard (`createContextGuard`). */
  contextGuard: StepPiece
  /** 2. The hooks piece (Phase 11, `RunHooks.stepPiece()` / `ChildHooks.stepPiece()`); absent = none. */
  hooks?: StepPiece
  /** 3. The steer step (`createSteerStep`). */
  steer: StepPiece
  /** 4. The finalize nudge of a sub-agent; absent for chat runs. */
  finalize?: StepPiece
  /** Warnings about a piece that threw (anything but an abort). */
  logger: Logger
}

/** The result `prepareStep` hands back to the SDK (undefined = no override). */
export type ComposedStep = { messages?: ModelMessage[], activeTools?: string[], instructions?: string } | undefined

/** The text of the SDK's instructions (a string, or system messages joined by a blank line). */
export function instructionsText(instructions: Instructions | undefined): string | undefined {
  if (instructions === undefined)
    return undefined
  if (typeof instructions === 'string')
    return instructions
  const list = Array.isArray(instructions) ? instructions : [instructions]
  return list.map(message => message.content).join('\n\n')
}

/** The names of the pieces, in their order (log fields). */
type PieceName = 'contextGuard' | 'hooks' | 'steer' | 'finalize'

/**
 * The composer over one `StepInput` (see the module comment): what `createPrepareStep` runs for every SDK call, also
 * callable directly (tests).
 */
export function composeSteps(input: StepComposerInput): (step: StepInput) => Promise<ComposedStep> {
  const pieces: ReadonlyArray<readonly [name: PieceName, piece: StepPiece | undefined]> = [
    ['contextGuard', input.contextGuard],
    ['hooks', input.hooks],
    ['steer', input.steer],
    ['finalize', input.finalize],
  ]
  return async (step) => {
    let messages = step.messages
    let changed = false
    let activeTools: string[] | undefined
    let instructions: string | undefined
    for (const [name, piece] of pieces) {
      if (piece === undefined)
        continue
      let result: StepPieceResult | undefined
      try {
        result = await piece({ ...step, messages })
      }
      catch (error) {
        if (isAbortError(error))
          throw error
        input.logger.warn('a step piece failed; the step goes on without it', { piece: name, stepNumber: step.stepNumber, err: error })
        continue
      }
      if (result === undefined)
        continue
      if (result.messages !== undefined && result.messages !== messages) {
        messages = result.messages
        changed = true
      }
      if (name === 'finalize') {
        activeTools = result.activeTools
        instructions = result.instructions
      }
    }
    if (!changed && activeTools === undefined && instructions === undefined)
      return undefined
    return {
      ...(changed ? { messages } : {}),
      ...(activeTools === undefined ? {} : { activeTools }),
      ...(instructions === undefined ? {} : { instructions }),
    }
  }
}

/** The `prepareStep` of `streamText`: the pieces in the fixed order guard → hooks → steer → finalize (module comment). */
export function createPrepareStep(input: StepComposerInput): PrepareStepFunction<ToolSet> {
  const compose = composeSteps(input)
  return options => compose({
    stepNumber: options.stepNumber,
    messages: options.messages,
    instructions: instructionsText(options.instructions),
    steps: options.steps,
  })
}
