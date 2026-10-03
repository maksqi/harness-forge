// Optional chat context of approval cards (docs/UI.md 7.3; W7.11). `ToolApprovalCard` and `ToolApprovalPreview`
// inject it when a chat view provides it (W7.10: `provide(TOOL_APPROVAL_CONTEXT, { toolMode: () =>
// session.toolMode.value, projectName: () => ... })`); without it the card offers "Accept all edits in this chat" for
// every write tool and the shell preview leaves out "In {project}". Keeps the frozen card props unchanged.
import type { ToolMode } from '@harness-forge/shared'
import type { InjectionKey } from 'vue'

export interface ToolApprovalContext {
  /** The chat's permission mode: in `edits` a write tool's card shows neither checkbox (the chat already accepts edits). */
  toolMode: () => ToolMode | null
  /** The name of the chat's project ("In {project}" on a shell approval); null when unknown. */
  projectName: () => string | null
}

export const TOOL_APPROVAL_CONTEXT: InjectionKey<ToolApprovalContext> = Symbol('hf-tool-approval-context')
