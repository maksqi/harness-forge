import { toolModeSchema } from '@harness-forge/shared'
import { ClipboardListIcon, FilePenLineIcon, HandIcon } from '@lucide/vue'
import { describe, expect, it } from 'vitest'
import { isProjectOnlyMode, offeredToolModes, TOOL_MODE_OPTIONS, toolModeOption } from './permission'

describe('permission modes', () => {
  it('lists every tool mode once: Ask, Accept edits, Plan, Auto, Off', () => {
    expect(TOOL_MODE_OPTIONS.map(option => [option.value, option.label])).toEqual([
      ['ask', 'Ask'],
      ['edits', 'Accept edits'],
      ['plan', 'Plan'],
      ['auto', 'Auto'],
      ['off', 'Off'],
    ])
    expect([...TOOL_MODE_OPTIONS.map(option => option.value)].sort()).toEqual([...toolModeSchema.options].sort())
  })

  it('finds the option of a mode, with the Accept edits and Plan icons and descriptions', () => {
    const edits = toolModeOption('edits')
    expect(edits.label).toBe('Accept edits')
    expect(edits.icon).toBe(FilePenLineIcon)
    expect(edits.description).toBe('Edit project files without asking; ask before shell commands')
    const plan = toolModeOption('plan')
    expect(plan.icon).toBe(ClipboardListIcon)
    expect(plan.description).toBe('Explore and plan; change nothing until you approve the plan')
    expect(toolModeOption('ask').icon).toBe(HandIcon)
    expect(toolModeOption('nope' as never).value).toBe('ask')
  })

  it('offers Accept edits and Plan only in a project chat or while selected', () => {
    expect(offeredToolModes({ projectChat: false, current: 'ask' })).toEqual(['ask', 'auto', 'off'])
    expect(offeredToolModes({ projectChat: false, current: 'auto' })).toEqual(['ask', 'auto', 'off'])
    expect(offeredToolModes({ projectChat: false, current: 'edits' })).toEqual(['ask', 'edits', 'auto', 'off'])
    expect(offeredToolModes({ projectChat: false, current: 'plan' })).toEqual(['ask', 'plan', 'auto', 'off'])
    expect(offeredToolModes({ projectChat: true, current: 'off' })).toEqual(['ask', 'edits', 'plan', 'auto', 'off'])
    expect(TOOL_MODE_OPTIONS.filter(option => isProjectOnlyMode(option.value)).map(option => option.value)).toEqual(['edits', 'plan'])
  })
})
