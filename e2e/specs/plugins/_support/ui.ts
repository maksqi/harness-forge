// UI helpers of the plugin specs: locators over the test-id contract (docs/UI.md 13) and the few multi-step
// interactions several specs share (model picker, sending a message, the install dialog, the code editor).
import type { Locator, Page } from '@playwright/test'
import type { Buffer } from 'node:buffer'
import type { TestId } from './testids.ts'
import { expect } from '@playwright/test'
import { testIds } from './testids.ts'

export type PluginFilter = 'all' | 'providers' | 'tools' | 'mcp' | 'commands' | 'disabled'
export const PLUGIN_FILTERS: readonly PluginFilter[] = ['all', 'providers', 'tools', 'mcp', 'commands', 'disabled']

/** Builtin plugins of a server started with `HF_MOCK_PROVIDER=1` (docs/DECISIONS.md "Identifiers"). */
export const BUILTIN_PLUGIN_IDS = ['core-providers', 'core-tools', 'core-commands', 'core-mcp', 'mock'] as const

function quote(value: string): string {
  return `"${value.replace(/["\\]/g, match => `\\${match}`)}"`
}

/** Elements with this test id whose data attributes equal the given values, inside `scope`. */
export function byTestId(scope: Page | Locator, id: TestId, attributes: Readonly<Record<`data-${string}`, string>> = {}): Locator {
  const extra = Object.entries(attributes).map(([name, value]) => `[${name}=${quote(value)}]`).join('')
  return scope.locator(`[data-testid=${quote(id)}]${extra}`)
}

// ---------- plugins tab ----------

export function pluginCard(page: Page, id: string): Locator {
  return byTestId(page, testIds.pluginCard, { 'data-plugin-id': id })
}

/** A Browse filter row of the Plugins sidebar. */
export function browseFilter(page: Page, filter: PluginFilter): Locator {
  return byTestId(page.getByTestId(testIds.sidebar), testIds.pluginsFilter, { 'data-value': filter })
}

/** The count badge of a Browse filter row. */
export function browseFilterCount(page: Page, filter: PluginFilter): Locator {
  return page.getByTestId(testIds.sidebar).locator(`[data-slot="plugins-filter-count"][data-value=${quote(filter)}]`)
}

/** Opens the install dialog from the page header of `/plugins`. */
export async function openInstallDialog(page: Page): Promise<Locator> {
  await page.getByTestId(testIds.pageHeader).getByTestId(testIds.pluginsInstall).click()
  const dialog = page.getByTestId(testIds.installDialog)
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('data-step', 'source')
  return dialog
}

/** Picks a zip in the Zip tab of the install dialog. */
export async function chooseZip(dialog: Locator, fileName: string, zip: Buffer): Promise<void> {
  await dialog.getByTestId(testIds.installZipInput).setInputFiles({ name: fileName, mimeType: 'application/zip', buffer: zip })
  await expect(dialog).toContainText(fileName)
}

/** Opens the `⋯` menu of the plugin detail header and chooses Uninstall…; returns the confirm button. */
export async function openUninstall(page: Page): Promise<Locator> {
  await page.getByTestId(testIds.pluginMenu).click()
  await page.getByTestId(testIds.pluginUninstall).click()
  const confirm = page.getByTestId(testIds.pluginUninstallConfirm)
  await expect(confirm).toBeVisible()
  return confirm
}

// ---------- chat ----------

/** Opens `/` (a new chat) and waits for the composer. */
export async function startNewChat(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId(testIds.composer)).toBeVisible()
}

/** Starts a new chat without reloading the app: Chat mode tab, then "New chat" (the stores keep their state). */
export async function startNewChatInApp(page: Page): Promise<void> {
  await page.getByTestId(testIds.modeTabChat).click()
  await page.getByTestId(testIds.newChat).click()
  await expect(page).toHaveURL(/\/(?:\?|$)/)
  await expect(page.getByTestId(testIds.composer)).toBeVisible()
}

/** Opens the model picker of the composer and returns its content. */
export async function openModelPicker(page: Page): Promise<Locator> {
  const picker = page.getByTestId(testIds.modelPicker)
  await page.getByTestId(testIds.modelPickerTrigger).click()
  await expect(picker).toBeVisible()
  return picker
}

export async function closeModelPicker(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId(testIds.modelPicker)).toBeHidden()
}

/** Picker items whose model ref starts with `prefix` (`mock:`) or equals it. */
export function pickerItems(scope: Page | Locator, prefix: string): Locator {
  return scope.locator(`[data-testid=${quote(testIds.modelPickerItem)}][data-model-ref^=${quote(prefix)}]`)
}

/** Selects a model in the composer's picker. */
export async function selectModel(page: Page, ref: string): Promise<void> {
  const picker = await openModelPicker(page)
  await byTestId(picker, testIds.modelPickerItem, { 'data-model-ref': ref }).first().click()
  await expect(picker).toBeHidden()
  await expect(page.getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', ref)
}

const CHAT_URL = /\/chat\/([\w-]+)/

/** Types a message and sends it; from `/` the app moves to `/chat/<id>`. Resolves to the chat id. */
export async function sendMessage(page: Page, text: string): Promise<string> {
  await page.getByTestId(testIds.composerInput).fill(text)
  await page.getByTestId(testIds.composerSend).click()
  await expect(page).toHaveURL(CHAT_URL)
  const id = new URL(page.url()).pathname.match(CHAT_URL)?.[1]
  if (id === undefined)
    throw new Error(`No chat id in ${page.url()}`)
  return id
}

export function lastAssistantMessage(page: Page): Locator {
  return page.getByTestId(testIds.messageAssistant).last()
}

export function toolRow(scope: Page | Locator, toolName: string): Locator {
  return byTestId(scope, testIds.toolRow, { 'data-tool-name': toolName })
}

// ---------- code editor (CodeMirror 6) ----------
// CodeMirror resolves `Mod` from `navigator.platform`, which stays the host's under the config's device (only the user
// agent says Windows), so Playwright's host-based `ControlOrMeta` is the right key here. App shortcuts are different:
// see `pressShortcut` in e2e/helpers.

function editorContent(page: Page): Locator {
  return page.getByTestId(testIds.codeEditor).locator('.cm-content')
}

/**
 * Inserts text at the end of the open file. `insertText` sends the whole string as one input event, so CodeMirror's
 * auto-indent and bracket closing (which react to single typed characters and Enter) leave it unchanged.
 */
export async function appendToEditor(page: Page, text: string): Promise<void> {
  await editorContent(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(text)
}

/** Replaces the whole content of the open file. */
export async function replaceEditorContent(page: Page, text: string): Promise<void> {
  await editorContent(page).click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(text)
}
