// Shared pieces of the `core-agent` tools (Phase 9, ADR-041 / ADR-043): the guard timeouts of PLUGINS.md 1, the
// `not_implemented` error of the P9-0b stubs, the permission-mode labels the model reads and the model text helper.
// FROZEN after P9-0b (C27): the timeouts and the model texts are part of the tool contract.
import type { ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { ToolMode } from '@harness-forge/shared'
import type { JSONValue } from 'ai'
import type { z } from 'zod'
import { HarnessError } from '@harness-forge/shared'

/** Guard timeout of `todo_write` (the default 60 s, explicit). */
export const TODO_WRITE_TIMEOUT_MS = 60_000
/** Guard timeout of `exit_plan_mode` (the default 60 s, explicit; the approval wait is not part of the call). */
export const EXIT_PLAN_MODE_TIMEOUT_MS = 60_000
/**
 * Guard timeout of `task`: the frozen guard maximum (600 s). A child has its own deadline below it
 * (`LIMITS.subagentTimeoutMs`, 570 s), so it can still return a partial report before the guard fires.
 */
export const TASK_TIMEOUT_MS = 600_000

/** The UI labels of the permission modes (the composer's permission menu), as the model reads them. */
export const TOOL_MODE_LABELS: Readonly<Record<ToolMode, string>> = {
  off: 'Off',
  ask: 'Ask',
  edits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
}

/** The `not_implemented` error of a P9-0b tool stub (the feature wave implements the body). */
export function agentToolNotImplemented(name: string): HarnessError {
  return new HarnessError({ code: 'not_implemented', message: `The ${name} tool is not implemented yet.` })
}

/**
 * A `toModelOutput` result built only from the stored output: the text of `build` when the output parses with the
 * tool's output schema, else the output as JSON (an output of another format, or one a hook replaced).
 */
export function textModelOutput<T>(schema: z.ZodType<T>, output: unknown, build: (value: T) => string): ToolResultOutput {
  const parsed = schema.safeParse(output)
  return parsed.success ? { type: 'text', value: build(parsed.data) } : { type: 'json', value: (output ?? null) as JSONValue }
}
