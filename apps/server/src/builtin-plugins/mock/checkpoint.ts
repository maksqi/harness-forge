// `mock:checkpoint` (Phase 8, PROVIDERS.md 8): a deterministic agent for rewind, the changes panel, the sticky working
// folder and shell rules in a project chat (ADR-036, ADR-038). The step is the number of workspace tool results that
// follow the last user message:
//   0: `write_file` `{ path: 'checkpoint.txt', content: 'Turn <n>\n' }` (n = the user messages of the prompt, so every
//      turn changes the file and each user message is a rewind point)
//   1: `shell` `{ command: 'mkdir -p mock-dir && cd mock-dir' }`
//   2: `shell` `{ command: 'ls' }`, which runs in `mock-dir` (the folder the previous call ended in)
//   then the text `Checkpoint done.`
// Steps 1 and 2 are skipped when `shell` is not offered (`HF_WORKSPACE_SHELL=0`, Windows). Ids `mock_call_<n>` and
// `finishReason: 'tool-calls'` as `mock:workspace`; a denied call ends with `The tool call was denied.`, a failed one with
// `The tool call failed: <error text>`, and without `write_file` in the call the answer is `Workspace tools are not
// available.`. In `edits` the write runs without a card and both shell calls ask unless shell rules allow them (rules
// `mkdir` and `ls`; `cd mock-dir` into a project folder needs no rule).
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { MockPlan } from './models.ts'
import type { MockWorkspaceStep } from './workspace.ts'
import { afterLastUser, failedText, MOCK_WORKSPACE_DENIED, MOCK_WORKSPACE_UNAVAILABLE, offeredTools, textPlan, toolCallPlan } from './workspace.ts'

export const MOCK_CHECKPOINT_FILE = 'checkpoint.txt'
/** The folder the first shell step creates and enters. */
export const MOCK_CHECKPOINT_DIR = 'mock-dir'
export const MOCK_CHECKPOINT_MKDIR_COMMAND = `mkdir -p ${MOCK_CHECKPOINT_DIR} && cd ${MOCK_CHECKPOINT_DIR}`
export const MOCK_CHECKPOINT_LS_COMMAND = 'ls'
export const MOCK_CHECKPOINT_DONE = 'Checkpoint done.'

/** The content `write_file` writes on turn `turn` (the number of user messages of the prompt). */
export function mockCheckpointContent(turn: number): string {
  return `Turn ${turn}\n`
}

/** The user messages of the prompt (on the run's path): the turn number of `mock:checkpoint`. */
export function mockCheckpointTurn(prompt: LanguageModelV4Prompt): number {
  return prompt.filter(message => message.role === 'user').length
}

/** The calls of one turn: the write, then the two shell calls when the shell is offered. */
export function mockCheckpointSteps(turn: number, shell: boolean): MockWorkspaceStep[] {
  return [
    { toolName: 'write_file', input: { path: MOCK_CHECKPOINT_FILE, content: mockCheckpointContent(turn) } },
    ...(shell
      ? [
          { toolName: 'shell' as const, input: { command: MOCK_CHECKPOINT_MKDIR_COMMAND } },
          { toolName: 'shell' as const, input: { command: MOCK_CHECKPOINT_LS_COMMAND } },
        ]
      : []),
  ]
}

/** The answer of `mock:checkpoint` to a call (see the module comment). */
export function mockCheckpointPlan(options: LanguageModelV4CallOptions): MockPlan {
  const offered = offeredTools(options)
  if (!offered.has('write_file'))
    return textPlan(MOCK_WORKSPACE_UNAVAILABLE)
  const { results, denied } = afterLastUser(options.prompt)
  if (denied)
    return textPlan(MOCK_WORKSPACE_DENIED)
  const failed = failedText(results.at(-1))
  if (failed !== null)
    return textPlan(failed)
  const step = mockCheckpointSteps(mockCheckpointTurn(options.prompt), offered.has('shell'))[results.length]
  return step === undefined ? textPlan(MOCK_CHECKPOINT_DONE) : toolCallPlan(options, step)
}
