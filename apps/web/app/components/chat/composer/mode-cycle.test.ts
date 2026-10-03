import type { ToolMode } from '@harness-forge/shared'
import type { ModeCycleOptions } from './mode-cycle'
import { describe, expect, it, vi } from 'vitest'
import { MODE_CYCLE_SHORTCUT, nextToolMode, useModeCycle } from './mode-cycle'

function shiftTab(init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true, ...init })
}

function cycle(overrides: Partial<ModeCycleOptions> & { mode?: ToolMode } = {}) {
  let mode: ToolMode = overrides.mode ?? 'ask'
  const set = vi.fn((next: ToolMode) => {
    mode = next
  })
  const announce = vi.fn()
  const handle = useModeCycle({
    enabled: () => true,
    current: () => mode,
    projectChat: () => true,
    set,
    announce,
    ...overrides,
  })
  return { handle, set, announce, mode: () => mode }
}

describe('nextToolMode', () => {
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
})

describe('useModeCycle', () => {
  it('takes Shift+Tab: switches to the next mode, announces it and prevents the focus move', () => {
    const { handle, set, announce, mode } = cycle()
    const labels: string[] = []
    for (let index = 0; index < 3; index++) {
      const event = shiftTab()
      expect(handle.handleKeydown(event)).toBe(true)
      expect(event.defaultPrevented).toBe(true)
      labels.push(mode())
    }
    expect(labels).toEqual(['edits', 'plan', 'ask'])
    expect(set).toHaveBeenCalledTimes(3)
    expect(announce.mock.calls.map(call => call[0])).toEqual([
      'Permission mode: Accept edits',
      'Permission mode: Plan',
      'Permission mode: Ask',
    ])
  })

  it('switches from Auto or Off to Ask, also outside project chats', () => {
    for (const mode of ['auto', 'off', 'edits', 'plan'] as const) {
      const { handle, set, announce } = cycle({ mode, projectChat: () => false })
      expect(handle.handleKeydown(shiftTab())).toBe(true)
      expect(set).toHaveBeenCalledWith('ask')
      expect(announce).toHaveBeenCalledWith('Permission mode: Ask')
    }
  })

  it('leaves the key alone when the next mode is the current one (Ask outside project chats)', () => {
    const { handle, set } = cycle({ projectChat: () => false })
    const event = shiftTab()
    expect(handle.handleKeydown(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('leaves the key alone while disabled (setting off, no permission menu, a menu open)', () => {
    const { handle, set, announce } = cycle({ enabled: () => false })
    const event = shiftTab()
    expect(handle.handleKeydown(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(set).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
  })

  it('takes only Shift+Tab without other modifiers and outside IME composition', () => {
    const { handle, set } = cycle()
    const others = [
      new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }),
      shiftTab({ ctrlKey: true }),
      shiftTab({ altKey: true }),
      shiftTab({ metaKey: true }),
      shiftTab({ isComposing: true }),
      shiftTab({ keyCode: 229 } as KeyboardEventInit),
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }),
    ]
    for (const event of others) {
      expect(handle.handleKeydown(event)).toBe(false)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(set).not.toHaveBeenCalled()
  })

  it('names the display-only shortcut', () => {
    expect(MODE_CYCLE_SHORTCUT).toEqual({ id: 'composer-cycle-mode', keys: 'shift+tab', description: 'Switch the permission mode', group: 'Composer' })
  })
})
