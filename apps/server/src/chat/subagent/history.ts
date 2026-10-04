// Sub-agent outputs in the model history (Phase 9, ADR-043, ARCHITECTURE.md 6.18 step 3 / 6.22). Signature FROZEN after
// P9-0b (C26); the implementation is W9.5's.
//
// `reduceAgentOutputs(messages)`, step 3 of `buildModelHistory` (`model-history.ts`): every stored `tool-task` part of
// an assistant message whose output is a `TaskOutput` (any object with a string `status` and a string `report`) keeps
// only `{ status, report, error?, taskId? }` (Phase 10: the `taskId` of a background launch, ADR-046), so the progress
// trace (steps, previews, usage, the model) never reaches a model, also when the `task` tool is not offered in a later
// run (the tool parts then go to the model as text). The model text
// of `task` (`taskModelText`) reads exactly these fields. Other outputs (a hook's replacement, the truncation marker)
// and other parts stay as they are; messages without such parts are returned as the same objects.
import type { HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import { TASK_TOOL_NAME } from '../../builtin-plugins/core-agent/index.ts'

/** The type of a stored `task` tool part. */
export const TASK_PART_TYPE = `tool-${TASK_TOOL_NAME}`

/** What the model history keeps of a `task` output. */
export interface ReducedTaskOutput {
  status: string
  report: string
  error?: string
  /** Phase 10: the background task of a `background: true` launch (the model text names it). */
  taskId?: string
}

/** `{ status, report, error?, taskId? }` of a `TaskOutput`-like value, or null when it is not one. */
export function reduceTaskOutput(output: unknown): ReducedTaskOutput | null {
  if (typeof output !== 'object' || output === null || Array.isArray(output))
    return null
  const { status, report, error, taskId } = output as Record<string, unknown>
  if (typeof status !== 'string' || typeof report !== 'string')
    return null
  return {
    status,
    report,
    ...(typeof error === 'string' ? { error } : {}),
    ...(typeof taskId === 'string' ? { taskId } : {}),
  }
}

/** The part with its `task` output reduced, or the same part when there is nothing to reduce. */
function reducePart(part: HarnessUIMessagePart): HarnessUIMessagePart {
  if (part.type !== TASK_PART_TYPE)
    return part
  const value = part as unknown as { output?: unknown }
  if (!('output' in value))
    return part
  const reduced = reduceTaskOutput(value.output)
  if (reduced === null)
    return part
  return { ...part, output: reduced } as unknown as HarnessUIMessagePart
}

/** The messages with stored sub-agent outputs reduced for the model (see the module comment). */
export function reduceAgentOutputs(messages: readonly HarnessUIMessage[]): HarnessUIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || !message.parts.some(part => part.type === TASK_PART_TYPE))
      return message
    let changed = false
    const parts = message.parts.map((part) => {
      const next = reducePart(part)
      changed ||= next !== part
      return next
    })
    return changed ? { ...message, parts } : message
  })
}
