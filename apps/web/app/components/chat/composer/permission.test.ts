import { toolModeSchema } from '@harness-forge/shared'
import { FilePenLineIcon, HandIcon } from '@lucide/vue'
import { describe, expect, it } from 'vitest'
import { offeredToolModes, TOOL_MODE_OPTIONS, toolModeOption } from './permission'

describe('permission modes', () => {
  it('lists every tool mode once: Ask, Accept edits, Auto, Off', () => {
    expect(TOOL_MODE_OPTIONS.map(option => [option.value, option.label])).toEqual([
      ['ask', 'Ask'],
      ['edits', 'Accept edits'],
      ['auto', 'Auto'],
      ['off', 'Off'],
    ])
    // The plan mode (Phase 9, ADR-041) joins the menu with the web skeleton (P9-0b); until then it falls back to Ask.
    expect([...TOOL_MODE_OPTIONS.map(option => option.value)].sort()).toEqual(toolModeSchema.options.filter(mode => mode !== 'plan').sort())
  })

  it('finds the option of a mode, with the Accept edits icon and description', () => {
    const edits = toolModeOption('edits')
    expect(edits.label).toBe('Accept edits')
    expect(edits.icon).toBe(FilePenLineIcon)
    expect(edits.description).toBe('Edit project files without asking; ask before shell commands')
    expect(toolModeOption('ask').icon).toBe(HandIcon)
    expect(toolModeOption('nope' as never).value).toBe('ask')
  })

  it('offers Accept edits only in a project chat or while it is selected', () => {
    expect(offeredToolModes({ projectChat: false, current: 'ask' })).toEqual(['ask', 'auto', 'off'])
    expect(offeredToolModes({ projectChat: false, current: 'auto' })).toEqual(['ask', 'auto', 'off'])
    expect(offeredToolModes({ projectChat: false, current: 'edits' })).toEqual(['ask', 'edits', 'auto', 'off'])
    expect(offeredToolModes({ projectChat: true, current: 'off' })).toEqual(['ask', 'edits', 'auto', 'off'])
  })
})
