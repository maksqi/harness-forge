import { describe, expect, it, vi } from 'vitest'
import { MODE_CYCLE_SHORTCUT, nextToolMode, useModeCycle } from './mode-cycle'

describe('mode cycle (P9-0b signatures)', () => {
  it('cycles Ask, Accept edits and Plan in a project chat; Ask elsewhere', () => {
    const project = { projectChat: true }
    expect(nextToolMode('ask', project)).toBe('edits')
    expect(nextToolMode('edits', project)).toBe('plan')
    expect(nextToolMode('plan', project)).toBe('ask')
    expect(nextToolMode('auto', project)).toBe('ask')
    expect(nextToolMode('off', project)).toBe('ask')
    for (const mode of ['ask', 'edits', 'plan', 'auto', 'off'] as const)
      expect(nextToolMode(mode, { projectChat: false })).toBe('ask')
  })

  it('never takes the key until W9.10 implements it', () => {
    const set = vi.fn()
    const cycle = useModeCycle({ enabled: () => true, current: () => 'ask', projectChat: () => true, set, announce: vi.fn() })
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })
    expect(cycle.handleKeydown(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('names the display-only shortcut', () => {
    expect(MODE_CYCLE_SHORTCUT).toEqual({ id: 'composer-cycle-mode', keys: 'shift+tab', description: 'Switch the permission mode', group: 'Composer' })
  })
})
