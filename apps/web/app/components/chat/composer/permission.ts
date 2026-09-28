// Permission modes of the permission menu (docs/UI.md 7.11), bound to `ToolMode`. `ask` is the default.
import type { ToolMode } from '@harness-forge/shared'
import type { Component } from 'vue'
import { CircleSlashIcon, HandIcon, ZapIcon } from '@lucide/vue'

export interface ToolModeOption {
  value: ToolMode
  label: string
  icon: Component
  description: string
}

export const TOOL_MODE_OPTIONS: readonly ToolModeOption[] = [
  { value: 'ask', label: 'Ask', icon: HandIcon, description: 'Ask before tools that can change things' },
  { value: 'auto', label: 'Auto', icon: ZapIcon, description: 'Run tools without asking, except ones marked always-ask' },
  { value: 'off', label: 'Off', icon: CircleSlashIcon, description: 'Don\'t use tools' },
]

/** The option of a mode (falls back to Ask for an unexpected value). */
export function toolModeOption(value: ToolMode): ToolModeOption {
  return TOOL_MODE_OPTIONS.find(option => option.value === value) ?? TOOL_MODE_OPTIONS[0]!
}
