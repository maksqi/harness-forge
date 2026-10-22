// The hook records of an approval card's tool call (v1.8.1; docs/UI.md 7.31, 7.34). `ToolPart` provides its `hooks`
// (`provide(TOOL_APPROVAL_HOOKS, () => props.hooks)`); `ToolApprovalCard` injects them and shows the reason of the
// call's `PermissionRequest` records (`permissionRequestAnswers`). An injection keeps the frozen card props unchanged
// (the `TOOL_APPROVAL_CONTEXT` pattern); a card without a provider (TaskBlock's) shows no such line.
import type { HookData } from '@harness-forge/shared'
import type { InjectionKey } from 'vue'

/** The hook records of the card's tool call (`toolHooksOf(parts).get(toolCallId)`), in part order. */
export type ToolApprovalHooks = () => readonly HookData[]

export const TOOL_APPROVAL_HOOKS: InjectionKey<ToolApprovalHooks> = Symbol('hf-tool-approval-hooks')
