// Locator helpers over the test-id contract: `byTestId(page, testIds.chatRow, { 'data-chat-id': id })` matches the
// element whose `data-testid` and data attributes all equal the given values (docs/UI.md 13).
import type { Locator, Page } from '@playwright/test'
import type { TestId } from './testids.ts'

/** Data attributes to match exactly, e.g. `{ 'data-model-ref': 'mock:echo' }`. */
export type DataAttributes = Readonly<Record<`data-${string}`, string>>

function quote(value: string): string {
  return `"${value.replace(/["\\]/g, match => `\\${match}`)}"`
}

/** CSS selector of a test id plus exact data attribute values. */
export function testIdSelector(id: TestId, attributes: DataAttributes = {}): string {
  const extra = Object.entries(attributes).map(([name, value]) => `[${name}=${quote(value)}]`).join('')
  return `[data-testid=${quote(id)}]${extra}`
}

/** Elements with this test id (and these data attribute values) inside `scope`. */
export function byTestId(scope: Page | Locator, id: TestId, attributes: DataAttributes = {}): Locator {
  return scope.locator(testIdSelector(id, attributes))
}
