// The composer toolbar's narrow-screen rule (Phase 14, W14.8; docs/UI.md 14.5): the model name truncates first, down to
// a 40 px touch target, then the left tools wrap onto a second line; the right tools never shrink and stay on the bottom
// line. The classes are checked here, and a small model of CSS flex wrapping (one line break per overflow, the picker the
// only item that grows) shows what they do with the widest 390 px toolbar: no control is ever below 40 px. The DOM side
// (the classes landing on the toolbar, the picker and the toggle) is in ChatComposer.test.ts.
import { describe, expect, it } from 'vitest'
import { TOOLBAR_END_CLASS, TOOLBAR_PICKER_CLASS, TOOLBAR_START_CLASS, TOOLBAR_TOUCH_TARGET_PX } from './toolbar-layout'

/** Tailwind's spacing scale: `N` = N × 0.25rem = N × 4px. */
function spacingPx(className: string, prefix: string): number | null {
  const match = className.split(/\s+/).map(token => token.match(new RegExp(`^${prefix}-(\\d+(?:\\.\\d+)?)$`))).find(Boolean)
  return match ? Number(match[1]) * 4 : null
}

interface Item {
  name: string
  /** The flex basis (the width a line break counts). */
  basis: number
  /** Grows up to this width (only the model picker); fixed controls have max = basis. */
  max: number
}

/** CSS `flex-wrap: wrap` with `justify-content: start`: lines by basis, then the free width goes to the growers. */
function layout(items: readonly Item[], width: number, gap: number): Array<Array<{ name: string, width: number }>> {
  const lines: Item[][] = []
  let line: Item[] = []
  let used = 0
  for (const item of items) {
    const next = line.length === 0 ? item.basis : used + gap + item.basis
    if (line.length > 0 && next > width) {
      lines.push(line)
      line = [item]
      used = item.basis
    }
    else {
      line.push(item)
      used = next
    }
  }
  if (line.length > 0)
    lines.push(line)
  return lines.map((row) => {
    const taken = row.reduce((sum, item) => sum + item.basis, 0) + gap * (row.length - 1)
    let free = Math.max(width - taken, 0)
    return row.map((item) => {
      const grown = Math.min(item.max, item.basis + free)
      free -= grown - item.basis
      return { name: item.name, width: grown }
    })
  })
}

describe('composer toolbar layout rule', () => {
  it('the left tools wrap, the right tools never shrink and sit on the bottom line', () => {
    expect(TOOLBAR_START_CLASS.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'flex-wrap']))
    expect(TOOLBAR_END_CLASS.split(' ')).toEqual(expect.arrayContaining(['shrink-0', 'self-end']))
    expect(TOOLBAR_START_CLASS).not.toContain('flex-nowrap')
  })

  it('the model picker truncates down to the 40 px touch target, never below, and grows up to its content', () => {
    const classes = TOOLBAR_PICKER_CLASS.split(' ')
    expect(classes).toEqual(expect.arrayContaining(['grow', 'max-w-max']))
    expect(spacingPx(TOOLBAR_PICKER_CLASS, 'min-w')).toBe(TOOLBAR_TOUCH_TARGET_PX)
    expect(spacingPx(TOOLBAR_PICKER_CLASS, 'basis')).toBe(TOOLBAR_TOUCH_TARGET_PX)
    expect(TOOLBAR_TOUCH_TARGET_PX).toBe(40)
  })

  it('keeps every control at 40 px or more in the widest 390 px toolbar', () => {
    const target = TOOLBAR_TOUCH_TARGET_PX
    const basis = spacingPx(TOOLBAR_PICKER_CLASS, 'basis')!
    // A 390 px phone, the chat dock (12px gutters): the card's border and the footer's 8px padding leave 348 px; the
    // right tools take the permission menu (52), the context ring, the mic and Send (40 each) and three 4px gaps.
    const right = 52 + 40 + 40 + 40 + 3 * 4
    const left = 348 - right - 8
    const tools: Item[] = [
      { name: 'add', basis: target, max: target },
      { name: 'picker', basis, max: 140 },
      { name: 'effort', basis: 52, max: 52 },
      { name: 'style', basis: target, max: target },
      { name: 'web-search', basis: target, max: target },
    ]
    const lines = layout(tools, left, 2)
    const widths = lines.flat()
    expect(widths.map(item => item.name)).toEqual(tools.map(item => item.name))
    for (const item of widths)
      expect(item.width, item.name).toBeGreaterThanOrEqual(target)
    // It does not fit on one line: the tools after the picker wrap instead of squeezing it.
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]!.map(item => item.name)).toContain('picker')

    // On a wide composer everything stays on one line and the picker shows its whole name.
    const wide = layout(tools, 600, 2)
    expect(wide).toHaveLength(1)
    expect(wide[0]!.find(item => item.name === 'picker')!.width).toBe(140)
  })

  it('the one-line rule before Phase 14 (a picker shrinking to nothing) would have squeezed it below the target', () => {
    // The same toolbar on one line, the picker taking what is left.
    const fixed = 40 + 52 + 40 + 40 + 4 * 2
    const left = 348 - (52 + 40 + 40 + 40 + 3 * 4) - 8
    expect(left - fixed).toBeLessThan(TOOLBAR_TOUCH_TARGET_PX)
  })
})
