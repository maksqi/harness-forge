// Shared pieces of the `core-workspace` tools (Phase 7, ADR-032 / ADR-033): the guard timeouts of PLUGINS.md 1, the
// workspace of a call and the model text helper. Owner after P7-0b: W7.2 (the file tools; W7.3 imports from here for
// `shell`).
import type { ToolCallContext, ToolResultOutput, ToolWorkspace } from '@harness-forge/plugin-sdk'
import type { JSONValue } from 'ai'
import type { z } from 'zod'
import { HarnessError } from '@harness-forge/shared'

/** Guard timeout of `read_file` and `list_directory`. */
export const READ_TOOL_TIMEOUT_MS = 30_000
/** Guard timeout of `find_files` and `search_files` (walks of large folders). */
export const SEARCH_TOOL_TIMEOUT_MS = 60_000
/** Guard timeout of `write_file` and `edit_file`. */
export const WRITE_TOOL_TIMEOUT_MS = 30_000
/**
 * Guard timeout of `shell`: the frozen guard maximum (600 s). The tool's own `timeout_ms` caps at 590 s
 * (`WORKSPACE_LIMITS.shellTimeoutMaxMs`), so its own timeout always fires first and returns a normal result.
 */
export const SHELL_TOOL_TIMEOUT_MS = 600_000

/** The message of a call without a project folder (the host offers workspace tools only with one; defense in depth). */
export const NO_WORKSPACE_MESSAGE = 'This chat has no project folder: workspace tools work only in a chat of a project whose folder is available.'

/** The project folder of a call (`c.workspace`), or a `validation_error` when the run has none. */
export function requireWorkspace(c: ToolCallContext): ToolWorkspace {
  if (c.workspace === undefined)
    throw new HarnessError({ code: 'validation_error', message: NO_WORKSPACE_MESSAGE })
  return c.workspace
}

/** The `not_implemented` error of a P7-0b tool stub. */
export function toolNotImplemented(name: string): HarnessError {
  return new HarnessError({ code: 'not_implemented', message: `The ${name} tool is not implemented yet.` })
}

/**
 * A `toModelOutput` result built only from the stored output: the text of `build` when the output parses with the
 * tool's output schema, else the output as JSON (an output of an older format, or one the host replaced).
 */
export function textModelOutput<T>(schema: z.ZodType<T>, output: unknown, build: (value: T) => string): ToolResultOutput {
  const parsed = schema.safeParse(output)
  return parsed.success ? { type: 'text', value: build(parsed.data) } : { type: 'json', value: (output ?? null) as JSONValue }
}
