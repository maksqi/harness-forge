// The run scope of a chat run with a workspace (Phase 8, ADR-036 / ADR-038, ARCHITECTURE.md 6.13): built once per run
// by the pipeline (`modelStream`, before `assembleTools`) from
// - the assistant message id of the run (`session.assistantId`; a continuation after an approval keeps the id),
// - the run's journal `deps.checkpoints.journal({ chatId, messageId, projectId })` (synchronous, nothing is read yet),
// - the shell rules `await deps.shellRules.forRun(projectId)` (read once per run; a rule added during the run applies
//   from the next one),
// - the shared working folder `{ current: initialShellCwd(history) }` (one object for every call of the run).
// `wrapToolExecute` binds it with each call's `toolCallId` to the tool's call context and `createToolApproval` to the
// policy function's context (`workspace/run-scope.ts`). Failures never stop the run: a journal that cannot be opened
// writes without recording, rules that cannot be read are an empty set (every shell command asks), a folder that cannot
// be derived is the project folder.
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { CheckpointJournal } from '../services/checkpoints/types.ts'
import type { OpenWorkspace } from '../services/projects/types.ts'
import type { ShellRuleSet } from '../services/shell-rules/types.ts'
import type { AppDeps } from '../types.ts'
import type { WorkspaceRunScopeInit } from '../workspace/run-scope.ts'
import { initialShellCwd } from '../workspace/shell-cwd.ts'

export interface RunScopeInput {
  chatId: string
  /** The assistant message of the run (`session.assistantId`). */
  messageId: string
  /** The open project folder of the run (`prepared.workspace`); null = no scope. */
  workspace: Pick<OpenWorkspace, 'projectId'> | null
  /** The run's active-path UI history (`prepared.history`, oldest first; a continuation ends with its message). */
  history: readonly HarnessUIMessage[]
  logger: Logger
}

/** An empty rule set (frozen): with it every `shell` command asks outside Auto. */
function noRules(projectId: string): ShellRuleSet {
  return Object.freeze({ projectId, prefixes: Object.freeze([]) })
}

/** The run scope without a tool call (see the module comment); null for a run without an open workspace. */
export async function createRunScope(deps: Pick<AppDeps, 'checkpoints' | 'shellRules'>, input: RunScopeInput): Promise<WorkspaceRunScopeInit | null> {
  if (input.workspace === null)
    return null
  const { chatId, messageId, logger } = input
  const projectId = input.workspace.projectId

  let journal: CheckpointJournal | null = null
  try {
    journal = deps.checkpoints.journal({ chatId, messageId, projectId })
  }
  catch (error) {
    logger.warn('cannot open the checkpoint journal; the run writes without recording', { err: error })
  }

  let shellRules: ShellRuleSet
  try {
    shellRules = await deps.shellRules.forRun(projectId)
  }
  catch (error) {
    logger.warn('cannot read the shell rules; every shell command asks', { err: error })
    shellRules = noRules(projectId)
  }

  let current = '.'
  try {
    current = initialShellCwd(input.history)
  }
  catch (error) {
    logger.warn('cannot derive the shell working folder; the run starts in the project folder', { err: error })
  }

  return { chatId, messageId, projectId, journal, shellRules, shellCwd: { current } }
}
