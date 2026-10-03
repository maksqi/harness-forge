// Sticky working folder of the `shell` tool (Phase 8, ADR-038). The folder a shell call ends in is stored in its output
// (`endCwd`); the next call of the chat starts there. Derived from the stored history, so it follows the shown branch
// and survives a restart.
//
// P8-A stub (coordinator): the signature is fixed for W8.5 (the pipeline seeds the run scope with it); W8.4 implements.
import type { HarnessUIMessage } from '@harness-forge/shared'

/**
 * The project-relative POSIX folder (`.` = the project root) where the first `shell` call of a run starts: the `endCwd`
 * of the last finished `shell` tool part on the run's active path (`history`, oldest first), `.` when there is none or
 * the output predates Phase 8. The caller re-checks it at the start of each call (a missing folder falls back to `.`).
 */
export function initialShellCwd(history: readonly HarnessUIMessage[]): string {
  void history
  return '.'
}
