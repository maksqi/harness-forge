// `mock:shell` (Phase 8, PROVIDERS.md 8): runs the user text (trimmed) as one `shell` call `{ command: '<user text>' }`
// (id `mock_call_<n>`); once the prompt holds that call's result after the last user message, the text `Shell done:
// <stdout>` (the stdout read like `mock:workspace` does, `mockShellStdout`, trimmed). An empty user text answers
// `(empty message)` without a call; without `shell` in the call: `Workspace tools are not available.`; a denied call:
// `The tool call was denied.`; a failed call: `The tool call failed: <error text>`. For the sticky-folder and shell-rule
// tests and probes (`cd sub`, then `pwd`; `ls && rm x`; `echo a > f`).
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { MockPlan } from './models.ts'
import { MOCK_EMPTY_MESSAGE } from './common.ts'
import { afterLastUser, failedText, MOCK_WORKSPACE_DENIED, MOCK_WORKSPACE_UNAVAILABLE, mockShellStdout, offeredTools, textPlan, toolCallPlan } from './workspace.ts'

/** Followed by the stdout of the shell call. */
export const MOCK_SHELL_DONE_PREFIX = 'Shell done:'

/** The answer of `mock:shell` to a call whose last user message has the text `userText` (see the module comment). */
export function mockShellPlan(options: LanguageModelV4CallOptions, userText: string): MockPlan {
  if (!offeredTools(options).has('shell'))
    return textPlan(MOCK_WORKSPACE_UNAVAILABLE)
  if (userText === '')
    return textPlan(MOCK_EMPTY_MESSAGE)
  const { results, denied } = afterLastUser(options.prompt)
  if (denied)
    return textPlan(MOCK_WORKSPACE_DENIED)
  const failed = failedText(results.at(-1))
  if (failed !== null)
    return textPlan(failed)
  const shell = results.findLast(result => result.toolName === 'shell')
  if (shell !== undefined)
    return textPlan(`${MOCK_SHELL_DONE_PREFIX} ${mockShellStdout(shell.output)}`.trimEnd())
  return toolCallPlan(options, { toolName: 'shell', input: { command: userText } })
}
