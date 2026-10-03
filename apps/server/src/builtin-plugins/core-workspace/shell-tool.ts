// The `shell` tool of `core-workspace` (ADR-033; policy `ask`, access `execute`, timeout 600 s). P7-0b skeleton (C14):
// the definition and the `createShellTool(options)` signature are final; `execute` / `toModelOutput` are W7.3's (the
// runner `workspace/shell.ts`: `bash -c`, else `sh -c`, in the project folder or `cwd` inside it, a minimal
// environment, its own process group, `timeout_ms` up to 590 s, capped output; "Exit code: N" or "Stopped after 120 s
// (timeout)", then stdout and stderr, for the model). Not registered on Windows (`createWorkspaceTools` in ./index.ts);
// never offered while `HF_WORKSPACE_SHELL=0` (the chat pipeline drops `execute` tools).
import type { Logger, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ShellToolInput, ShellToolOutput } from '@harness-forge/shared'
import { shellToolInputSchema, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { SHELL_TOOL_TIMEOUT_MS, toolNotImplemented } from './common.ts'

export const SHELL_TOOL_NAME = 'shell'

export interface ShellToolOptions {
  /**
   * The plugin logger (`ctx.logger` of `core-workspace`): one `info` line per call (exit code, signal, timed out,
   * duration, byte counts), the command text only at `debug`, redacted; never the output.
   */
  logger: Logger
}

export function createShellTool(_options: ShellToolOptions): ToolDefinition<ShellToolInput, ShellToolOutput> {
  return {
    name: SHELL_TOOL_NAME,
    description: 'Run a shell command (bash, else sh) in the project folder, or in cwd inside it. Each call is a new process: cd does not persist, there is no stdin, and background processes are stopped when the command ends. timeout_ms defaults to 120000 (at most 590000). Returns the exit code, stdout and stderr (long output keeps its start and end). Use description to say in a few words what the command does.',
    inputSchema: shellToolInputSchema,
    policy: 'ask',
    timeoutMs: SHELL_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.shell,
    async execute() {
      throw toolNotImplemented(SHELL_TOOL_NAME)
    },
  }
}
