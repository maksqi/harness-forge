// `mock:workspace` (Phase 7, PROVIDERS.md 8): a deterministic agent that walks through the builtin workspace tools of
// `core-workspace` in a project chat, for pipeline tests and e2e. The step is the number of workspace tool results that
// follow the last user message:
//   0: `write_file` `{ path: 'mock-workspace.txt', content: 'Hello from the mock agent.\n' }`
//   1: `edit_file` `{ path: 'mock-workspace.txt', old_string: 'mock agent', new_string: 'workspace agent' }`
//   2: `shell` `{ command: 'cat mock-workspace.txt' }`, skipped when `shell` is not offered (`HF_WORKSPACE_SHELL=0`,
//      Windows)
//   then the text `Workspace done: <stdout of the shell call>` (`Workspace done: Hello from the workspace agent.` after
//   a full run), or `Workspace done.` without the shell.
// A denied call ends the plan with `The tool call was denied.`; a failed call (an error result) with `The tool call
// failed: <error text>`; without `write_file` and `edit_file` in the call (a chat without a project, tool mode `off`,
// the folder unavailable, the tools disabled) the answer is `Workspace tools are not available.`.
//
// The shell result reaches the model as the shell tool's `toModelOutput` text (W7.3: a status line "Exit code: N" or
// "Stopped after …", then stdout and stderr), or as JSON (`ShellToolOutput`) without one: `mockShellStdout` reads
// `stdout` from a JSON output, else the text after the status line (a `stdout:` label line is skipped, and the text
// stops at a `stderr:` label line).
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { WorkspaceToolName } from '@harness-forge/shared'
import type { MockPlan } from './models.ts'
import { WORKSPACE_TOOL_NAMES } from '@harness-forge/shared'

export const MOCK_WORKSPACE_FILE = 'mock-workspace.txt'
export const MOCK_WORKSPACE_CONTENT = 'Hello from the mock agent.\n'
export const MOCK_WORKSPACE_OLD_STRING = 'mock agent'
export const MOCK_WORKSPACE_NEW_STRING = 'workspace agent'
export const MOCK_WORKSPACE_COMMAND = `cat ${MOCK_WORKSPACE_FILE}`
export const MOCK_WORKSPACE_UNAVAILABLE = 'Workspace tools are not available.'
export const MOCK_WORKSPACE_DONE = 'Workspace done.'
/** Followed by the stdout of the shell call. */
export const MOCK_WORKSPACE_DONE_PREFIX = 'Workspace done:'
/** Followed by the error text of the failed call. */
export const MOCK_WORKSPACE_FAILED_PREFIX = 'The tool call failed:'
/** The same text as `mock:tool-approval` after a denial. */
export const MOCK_WORKSPACE_DENIED = 'The tool call was denied.'

/** One planned workspace tool call. */
export interface MockWorkspaceStep {
  toolName: WorkspaceToolName
  input: Record<string, string>
}

/** The calls of a full run: write, edit, then the shell when it is offered. */
export function mockWorkspaceSteps(shell: boolean): MockWorkspaceStep[] {
  return [
    { toolName: 'write_file', input: { path: MOCK_WORKSPACE_FILE, content: MOCK_WORKSPACE_CONTENT } },
    { toolName: 'edit_file', input: { path: MOCK_WORKSPACE_FILE, old_string: MOCK_WORKSPACE_OLD_STRING, new_string: MOCK_WORKSPACE_NEW_STRING } },
    ...(shell ? [{ toolName: 'shell' as const, input: { command: MOCK_WORKSPACE_COMMAND } }] : []),
  ]
}

const WORKSPACE_TOOLS: ReadonlySet<string> = new Set(WORKSPACE_TOOL_NAMES)

/** A workspace tool result after the last user message. */
export interface WorkspaceResult {
  toolName: string
  output: LanguageModelV4ToolResultOutput
}

/**
 * What followed the last user message: the workspace tool results in order, and whether a call was denied (shared by
 * `mock:workspace`, `mock:checkpoint` and `mock:shell`).
 */
export function afterLastUser(prompt: LanguageModelV4Prompt): { results: WorkspaceResult[], denied: boolean } {
  let start = 0
  for (let index = prompt.length - 1; index >= 0; index--) {
    if (prompt[index]?.role === 'user') {
      start = index + 1
      break
    }
  }
  const results: WorkspaceResult[] = []
  let denied = false
  for (const message of prompt.slice(start)) {
    if (message.role !== 'tool')
      continue
    for (const part of message.content) {
      if (part.type === 'tool-approval-response' && !part.approved)
        denied = true
      if (part.type !== 'tool-result' || !WORKSPACE_TOOLS.has(part.toolName))
        continue
      if (part.output.type === 'execution-denied')
        denied = true
      else
        results.push({ toolName: part.toolName, output: part.output })
    }
  }
  return { results, denied }
}

/** The text of a tool result output (JSON outputs serialized). */
export function textOf(output: LanguageModelV4ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value) ?? ''
    case 'content':
      return output.value.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
    default:
      return ''
  }
}

const STATUS_LINE = /^(?:Exit code:|Stopped after)/i
const STDOUT_LABEL = /^stdout:?$/i
const STDERR_LABEL = /^stderr:?$/i

/** The stdout of a shell result as the model sees it (see the module comment), trimmed. */
export function mockShellStdout(output: LanguageModelV4ToolResultOutput): string {
  if (output.type === 'json') {
    const value = output.value as { stdout?: unknown } | null
    return typeof value?.stdout === 'string' ? value.stdout.trim() : ''
  }
  const lines = textOf(output).replace(/\r\n/g, '\n').split('\n')
  if (STATUS_LINE.test(lines[0] ?? ''))
    lines.shift()
  const label = lines.findIndex(line => STDOUT_LABEL.test(line.trim()))
  const body = label >= 0 ? lines.slice(label + 1) : lines
  const end = body.findIndex(line => STDERR_LABEL.test(line.trim()))
  return (end >= 0 ? body.slice(0, end) : body).join('\n').trim()
}

/** A plan that answers `text` and stops. */
export function textPlan(text: string): MockPlan {
  return { reasoning: null, text, toolCall: null, finishReason: 'stop' }
}

/** The names of the function tools offered in the call. */
export function offeredTools(options: LanguageModelV4CallOptions): Set<string> {
  return new Set((options.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.name] : [])))
}

/** The failure text of an error result (`The tool call failed: <error text>`), or null for any other output. */
export function failedText(result: WorkspaceResult | undefined): string | null {
  if (result === undefined || (result.output.type !== 'error-text' && result.output.type !== 'error-json'))
    return null
  return `${MOCK_WORKSPACE_FAILED_PREFIX} ${textOf(result.output)}`.trimEnd()
}

/** One tool call of a plan with id `mock_call_<n>` (n = assistant messages of the prompt + 1). */
export function toolCallPlan(options: LanguageModelV4CallOptions, step: MockWorkspaceStep): MockPlan {
  const assistantMessages = options.prompt.filter(message => message.role === 'assistant').length
  return {
    reasoning: null,
    text: null,
    toolCall: { toolCallId: `mock_call_${assistantMessages + 1}`, toolName: step.toolName, input: JSON.stringify(step.input) },
    finishReason: 'tool-calls',
  }
}

/** The answer of `mock:workspace` to a call (see the module comment). */
export function mockWorkspacePlan(options: LanguageModelV4CallOptions): MockPlan {
  const offered = offeredTools(options)
  if (!offered.has('write_file') || !offered.has('edit_file'))
    return textPlan(MOCK_WORKSPACE_UNAVAILABLE)
  const { results, denied } = afterLastUser(options.prompt)
  if (denied)
    return textPlan(MOCK_WORKSPACE_DENIED)
  const failed = failedText(results.at(-1))
  if (failed !== null)
    return textPlan(failed)
  const steps = mockWorkspaceSteps(offered.has('shell'))
  const step = steps[results.length]
  if (step === undefined) {
    const shell = results.findLast(result => result.toolName === 'shell')
    return textPlan(shell === undefined ? MOCK_WORKSPACE_DONE : `${MOCK_WORKSPACE_DONE_PREFIX} ${mockShellStdout(shell.output)}`.trimEnd())
  }
  return toolCallPlan(options, step)
}
