// Layout measurements for the mobile specs (docs/UI.md 14.5, 14.6): sideways overflow of the document, boxes inside
// the viewport, and touch-target sizes.
import type { Locator, Page } from '@playwright/test'

export interface Size {
  width: number
  height: number
}

export interface Box extends Size {
  x: number
  y: number
}

/** `scrollWidth` and `clientWidth` of <html>: the page scrolls sideways when the first is larger than the viewport. */
export async function documentWidths(page: Page): Promise<{ scrollWidth: number, clientWidth: number }> {
  return page.locator('html').evaluate(root => ({ scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }))
}

/** The bounding box of a visible element (fails when it has none). */
export async function boxOf(target: Locator): Promise<Box> {
  const box = await target.boundingBox()
  if (!box)
    throw new Error(`${target} has no bounding box (not visible).`)
  return box
}

/**
 * The size an element answers touches in: its own box, or the box of a positioned `::after` hit area when that is
 * larger (the 32 px send button reaches 44 px this way, docs/UI.md 14.5).
 */
export async function touchTargetSize(target: Locator): Promise<Size> {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    let width = rect.width
    let height = rect.height
    const after = element.ownerDocument.defaultView!.getComputedStyle(element, '::after')
    if (after.content !== 'none' && after.content !== 'normal' && after.position === 'absolute') {
      const px = (value: string) => (value.endsWith('px') ? Number.parseFloat(value) : 0)
      const hitWidth = after.width.endsWith('px') ? px(after.width) : rect.width - px(after.left) - px(after.right)
      const hitHeight = after.height.endsWith('px') ? px(after.height) : rect.height - px(after.top) - px(after.bottom)
      width = Math.max(width, hitWidth)
      height = Math.max(height, hitHeight)
    }
    return { width, height }
  })
}
