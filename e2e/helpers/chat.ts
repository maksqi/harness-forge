// UI helpers for the chat flow (docs/UI.md 2.1, 2.2, 7): open a new chat, pick a model in the composer, send, and find
// messages. Every helper waits with web-first assertions, never with fixed sleeps.
import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { byTestId } from './locators.ts'
import { testIds } from './testids.ts'

/** Matches `/chat/<uuid>` and captures the chat id. */
export const CHAT_URL_PATTERN = /\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** The chat id of the current `/chat/<id>` URL. */
export function chatIdFromUrl(page: Page): string {
  const id = new URL(page.url()).pathname.match(CHAT_URL_PATTERN)?.[1]
  if (!id)
    throw new Error(`Not a chat URL: ${page.url()}`)
  return id
}

/** The composer of the current page. */
export function composer(page: Page): Locator {
  return page.getByTestId(testIds.composer)
}

/** Opens `/` (empty state) and waits until the composer is ready for input. */
export async function openNewChat(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
  await expect(page.getByTestId(testIds.composerInput)).toBeEditable()
}

/**
 * Selects `modelRef` (`provider:model`) in the composer's model picker and checks the trigger shows it. Waits for the
 * default model first, so a late default never overrides the choice.
 */
export async function selectModel(page: Page, modelRef: string): Promise<void> {
  const trigger = composer(page).getByTestId(testIds.modelPickerTrigger)
  await expect(trigger).toHaveAttribute('data-model-ref', /.+/)
  if (await trigger.getAttribute('data-model-ref') === modelRef)
    return
  await trigger.click()
  const picker = page.getByTestId(testIds.modelPicker)
  await expect(picker).toBeVisible()
  await picker.getByTestId(testIds.modelPickerSearch).fill(modelRef.slice(modelRef.indexOf(':') + 1))
  await byTestId(picker, testIds.modelPickerItem, { 'data-model-ref': modelRef }).first().click()
  await expect(picker).toBeHidden()
  await expect(trigger).toHaveAttribute('data-model-ref', modelRef)
}

/**
 * Sets the composer's permission mode (`ask` | `auto` | `off`, docs/UI.md 7.11) and checks the trigger shows it. The
 * menu only exists when the selected model can call tools.
 */
export async function selectPermissionMode(page: Page, mode: 'ask' | 'auto' | 'off'): Promise<void> {
  const trigger = composer(page).getByTestId(testIds.permissionMenuTrigger)
  await expect(trigger).toBeVisible()
  if (await trigger.getAttribute('data-value') === mode)
    return
  await trigger.click()
  await byTestId(page, testIds.permissionOption, { 'data-value': mode }).click()
  await expect(trigger).toHaveAttribute('data-value', mode)
}

/** Types `text` into the composer and clicks Send (the button must be ready). */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.getByTestId(testIds.composerInput)
  await input.fill(text)
  const send = page.getByTestId(testIds.composerSend)
  await expect(send).toHaveAttribute('data-state', 'ready')
  await send.click()
}

/**
 * New chat with `modelRef`: opens `/`, selects the model, sends `text` and waits for the move to `/chat/<id>`.
 * Returns the chat id.
 */
export async function startChat(page: Page, options: { modelRef: string, text: string }): Promise<string> {
  await openNewChat(page)
  await selectModel(page, options.modelRef)
  await sendMessage(page, options.text)
  await expect(page).toHaveURL(CHAT_URL_PATTERN)
  return chatIdFromUrl(page)
}

/** Every user message of the transcript. */
export function userMessages(page: Page): Locator {
  return page.getByTestId(testIds.messageUser)
}

/** Every assistant message of the transcript. */
export function assistantMessages(page: Page): Locator {
  return page.getByTestId(testIds.messageAssistant)
}

/** The last assistant message (the one that streams). */
export function lastAssistantMessage(page: Page): Locator {
  return assistantMessages(page).last()
}

/** Message states of `data-status` (docs/UI.md 13.2). */
export type MessageStatus = 'streaming' | 'done' | 'aborted' | 'error'

/** Waits until `message` has the given `data-status` (`done` by default). */
export async function expectMessageStatus(message: Locator, status: MessageStatus = 'done', timeout?: number): Promise<void> {
  await expect(message).toHaveAttribute('data-status', status, timeout === undefined ? {} : { timeout })
}

/** The sidebar row of a chat. */
export function chatRow(page: Page, chatId: string): Locator {
  return byTestId(page.getByTestId(testIds.sidebar), testIds.chatRow, { 'data-chat-id': chatId })
}
