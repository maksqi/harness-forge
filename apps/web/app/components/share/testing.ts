// Test helpers for the share components (not app code: only *.test.ts files import this module).
import type { ShareSummary, ShareView } from '@harness-forge/shared'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

/** Share tokens in the documented format: 16 alphanumeric characters + 22 base64url characters. */
export const TOKEN = '0bN3aK9xQ7fLm2PzRt5_uV-wXy8zAb1Cd2Ef3G'
export const OTHER_TOKEN = 'Zz9Yy8Xx7Ww6Vv5U-u4Tt3Ss2Rr1Qq0Pp_Oo9N'

export const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
export const OTHER_CHAT_ID = '0199a8f0-0000-7000-8000-000000000002'

/** `shr_` + 16 characters, varying in the last digits: shareId(1) -> 'shr_0000000000000001'. */
export function shareId(n: number): string {
  return `shr_${String(n).padStart(16, '0')}`
}

export function shareSummary(overrides: Partial<ShareSummary> = {}): ShareSummary {
  const id = overrides.id ?? shareId(1)
  return {
    id,
    chatId: CHAT_ID,
    chatTitle: 'Refactor auth flow',
    title: null,
    options: { reasoning: false, toolDetails: false, attachments: true },
    path: `/share/${id.slice(4)}AbCdEfGhIjKlMnOpQrStUv`,
    messageCount: 12,
    snapshotAt: Date.now() - 3 * 3_600_000,
    outdated: false,
    expiresAt: null,
    expired: false,
    createdAt: Date.now() - 3 * 3_600_000,
    ...overrides,
  }
}

export function shareView(overrides: Partial<ShareView> = {}): ShareView {
  return {
    title: 'Refactor auth flow',
    snapshotAt: new Date(2026, 8, 28, 12, 0).getTime(),
    options: { reasoning: false, toolDetails: false, attachments: true },
    messages: [],
    ...overrides,
  }
}

/** Lets promises, Vue updates and reka-ui's deferred work settle. */
export async function settle(rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await flushPromises()
    await nextTick()
  }
}

export function byTestId<T extends Element = HTMLElement>(id: string, root: ParentNode = document.body): T | null {
  return root.querySelector<T>(`[data-testid="${id}"]`)
}

export function allByTestId<T extends Element = HTMLElement>(id: string, root: ParentNode = document.body): T[] {
  return Array.from(root.querySelectorAll<T>(`[data-testid="${id}"]`))
}
