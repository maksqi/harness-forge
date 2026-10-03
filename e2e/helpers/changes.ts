// The changes panel, rewind and toasts for the Phase 8 specs (docs/UI.md 2.15, 7.21, 7.22, 13.9). Test ids first; the
// few documented hooks that are not test ids (the pane `aside#hf-changes-pane`, `data-slot` values of 13.9) are named
// here once, so the specs never spell a selector of their own.
import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { byTestId } from './locators.ts'
import { testIds } from './testids.ts'

/** The `localStorage` keys of the panel state (per browser): width in px, `1` / `0`, `chat` / `git`. */
export const CHANGES_STORAGE_KEYS = { width: 'hf-changes-width', open: 'hf-changes-open', view: 'hf-changes-view' } as const

/** The two views of the panel. */
export type ChangesView = 'chat' | 'git'

/** The changes toggle of the chat header (`data-state` open / closed, `data-count`). */
export function changesToggle(page: Page): Locator {
  return page.getByTestId(testIds.changesToggle)
}

/** The changes panel (pane or sheet; one at a time). */
export function changesPanel(page: Page): Locator {
  return page.getByTestId(testIds.changesPanel)
}

/** The desktop pane around the panel (an `<aside>` labelled "Changes", >= 1024 px). */
export function changesPane(page: Page): Locator {
  return page.locator('aside#hf-changes-pane')
}

/** A view tab of the panel (This chat / Git). */
export function changesViewTab(page: Page, view: ChangesView): Locator {
  return byTestId(changesPanel(page), testIds.changesViewOption, { 'data-value': view })
}

/** The row of a file in the panel. */
export function changesFile(page: Page, path: string): Locator {
  return byTestId(changesPanel(page), testIds.changesFile, { 'data-path': path })
}

/** The accordion button of a row (it carries `aria-expanded`; Revert is the row's other button). */
export function changesFileButton(row: Locator): Locator {
  return row.getByRole('button', { expanded: false }).or(row.getByRole('button', { expanded: true }))
}

/** The lazy diff block of an open row (`data-slot="changes-diff"`, `data-state` loading / ready / error). */
export function changesFileDiff(row: Locator): Locator {
  return row.locator('[data-slot="changes-diff"]')
}

/** The untracked note of This chat (`data-slot="changes-untracked"`). */
export function changesUntrackedNote(page: Page): Locator {
  return changesPanel(page).locator('[data-slot="changes-untracked"]')
}

/** Reads a `localStorage` key of the page's origin (null when unset). */
export function storageItem(page: Page, key: string): Promise<string | null> {
  return page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(key)})`)
}

/** The visible vue-sonner toast with this text (also custom toasts such as "Reverted {path}" with Undo). */
export function toastWith(page: Page, text: string | RegExp): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: text })
}

/**
 * Opens "Rewind files to here" of a user message: hovers the message (the action row shows on hover), then clicks its
 * `message-rewind` and waits for the dialog. Returns the dialog (`rewind-dialog`).
 */
export async function openRewind(page: Page, message: Locator): Promise<Locator> {
  const button = message.getByTestId(testIds.messageRewind)
  await expect(button).toHaveCount(1)
  await message.hover()
  await button.click()
  const dialog = page.getByTestId(testIds.rewindDialog)
  await expect(dialog).toBeVisible()
  return dialog
}
