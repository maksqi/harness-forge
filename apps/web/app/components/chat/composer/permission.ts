// Permission modes of the permission menu (docs/UI.md 7.11), bound to `ToolMode`. `ask` is the default. Accept edits
// (Phase 7, ADR-032) is offered only in project chats, or while it is already the current value.
import type { ToolMode } from '@harness-forge/shared'
import type { Component } from 'vue'
import { CircleSlashIcon, FilePenLineIcon, HandIcon, ZapIcon } from '@lucide/vue'

export interface ToolModeOption {
  value: ToolMode
  label: string
  icon: Component
  description: string
}

/** Every mode, in menu order: Ask · Accept edits · Auto · Off. */
export const TOOL_MODE_OPTIONS: readonly ToolModeOption[] = [
  { value: 'ask', label: 'Ask', icon: HandIcon, description: 'Ask before tools that can change things' },
  { value: 'edits', label: 'Accept edits', icon: FilePenLineIcon, description: 'Edit project files without asking; ask before shell commands' },
  { value: 'auto', label: 'Auto', icon: ZapIcon, description: 'Run tools without asking, except ones marked always-ask' },
  { value: 'off', label: 'Off', icon: CircleSlashIcon, description: 'Don\'t use tools' },
]

/** The option of a mode (falls back to Ask for an unexpected value). */
export function toolModeOption(value: ToolMode): ToolModeOption {
  return TOOL_MODE_OPTIONS.find(option => option.value === value) ?? TOOL_MODE_OPTIONS[0]!
}

/** The error of `/mode edits` (and of a pick of Accept edits) in a chat without a project. */
export const EDITS_NEEDS_PROJECT = 'Accept edits works in project chats.'

/**
 * The modes the permission menu offers, in menu order: Accept edits only in a project chat or while it is the current
 * value (so the menu always shows what is selected); Ask, Auto and Off always.
 */
export function offeredToolModes(options: { projectChat: boolean, current: ToolMode }): ToolMode[] {
  return TOOL_MODE_OPTIONS
    .map(option => option.value)
    .filter(mode => mode !== 'edits' || options.projectChat || options.current === 'edits')
}
