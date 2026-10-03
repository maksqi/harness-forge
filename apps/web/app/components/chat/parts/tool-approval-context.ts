// Optional chat context of approval cards (docs/UI.md 7.3, 11.5; W7.11). `ToolApprovalCard` and `ToolApprovalPreview`
// inject it when a chat view provides it (`ChatView`: `provide(TOOL_APPROVAL_CONTEXT, { toolMode: () =>
// session.toolMode.value, ... })`); without it the card offers "Accept all edits in this chat" for every write tool and
// the shell preview leaves out "In {project}". Keeps the frozen card props unchanged.
// Phase 8 (C20 declares, W8.10 uses; frozen from Gate P8-0b): `projectId` (the scope "This project" of a shell rule)
// and `shellCwd` (the sticky shell folder: "In {project}/{cwd}" and the running TerminalOutput).
import type { ToolMode } from '@harness-forge/shared'
import type { InjectionKey } from 'vue'

export interface ToolApprovalContext {
  /** The chat's permission mode: in `edits` a write tool's card shows neither checkbox (the chat already accepts edits). */
  toolMode: () => ToolMode | null
  /** The name of the chat's project ("In {project}" on a shell approval); null when unknown. */
  projectName: () => string | null
  /** + Phase 8: the chat's project (the scope "This project" of a shell rule); null without one. */
  projectId: () => string | null
  /**
   * + Phase 8: the folder the chat's next shell call starts in (`session.cwd`, project-relative); null = the project
   * folder.
   */
  shellCwd: () => string | null
}

export const TOOL_APPROVAL_CONTEXT: InjectionKey<ToolApprovalContext> = Symbol('hf-tool-approval-context')
