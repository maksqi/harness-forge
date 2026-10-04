// Agent customization helpers for the Phase 10 specs (docs/UI.md 2.17, 7.28 – 7.30, 9.12, 13.11; docs/PROVIDERS.md 8
// "Customization mocks (Phase 10)"): definition files, personal definitions created and removed through the API, the
// Customize page (rows, their menus, the project select), declarative plugins with agents and skills, the dock's
// background agents, and what the customization mocks answer.
//
// Personal definitions are global state of the server: every helper that creates one registers its removal through
// the `cleanup` fixture by kind and name (a delete with Undo re-creates a definition with a new id, so the id alone is
// not enough). Definition names come from `uniqueId()`, so specs never collide on a shared server.
import type { Locator, Page } from '@playwright/test'
import type { BackgroundTask, Customization, CustomizationKind, Settings } from '../../packages/shared/src/index.ts'
import type { HarnessApi } from './api.ts'
import type { CleanupTask } from './fixtures.ts'
import type { DataAttributes } from './locators.ts'
import { expect } from '@playwright/test'
import { byTestId } from './locators.ts'
import { testIds } from './testids.ts'

// ---------- the customization mocks (docs/PROVIDERS.md 8) ----------

/** Drives custom agents, skills and custom commands (`agents?`, `skills?`, `tools?`, `agent <type>`, `skill <name>`). */
export const MOCK_AGENTS_MODEL = 'mock:agents'
/** Drives background sub-agents (`bg [type] [steps <N>] [slow <K> | loop]`). */
export const MOCK_BACKGROUND_MODEL = 'mock:background'
/** The report of a `mock:background` child. */
export const MOCK_BACKGROUND_REPORT = 'Report: background done'
/** The file a `mock:agents` child writes when its prompt says `write`. */
export const MOCK_AGENT_FILE = 'agent.txt'

/** The report of a `mock:agents` child: its persona (`PERSONA:` of its body) and the tools it was offered. */
export function mockAgentReport(persona: string, tools: readonly string[]): string {
  const list = [...tools].sort()
  return `Report: persona=${persona} | tools: ${list.length > 0 ? list.join(', ') : 'none'} | model=agents`
}

/** What `mock:background` answers to a delivered result (`<status>` of the result, its first report line). */
export function mockBackgroundResult(status: 'completed' | 'failed' | 'aborted' | 'limit', firstLine = MOCK_BACKGROUND_REPORT): string {
  return `Background result: ${status} | ${firstLine}`
}

/** The description of a `mock:background` launch (`bg <type> …`). */
export function mockBackgroundDescription(type = 'explore'): string {
  return `Background ${type}`
}

// ---------- definition files ----------

/** A frontmatter value: text as is, a list as `[a, b]`; undefined leaves the key out. */
export type DefinitionValue = string | readonly string[] | undefined

/**
 * A definition file (markdown with YAML frontmatter, ADR-044): `definitionFile({ name: 'x', description: 'y', tools:
 * ['read_file'] }, 'PERSONA: x\n')`. Keys keep their order (`argument-hint`, `allowed-tools` as written).
 */
export function definitionFile(fields: Readonly<Record<string, DefinitionValue>>, body: string): string {
  const lines = Object.entries(fields)
    .filter((entry): entry is [string, string | readonly string[]] => entry[1] !== undefined)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : `[${value.join(', ')}]`}`)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

// ---------- personal definitions (API) ----------

/** Deletes every personal definition of this kind and name (none is fine). */
export async function removePersonalDefinitions(api: HarnessApi, kind: CustomizationKind, name: string): Promise<void> {
  const { items } = await api.client.customizations.list({ query: { kind } })
  for (const entry of items) {
    if (entry.source !== 'user' || entry.name !== name || !entry.id)
      continue
    try {
      await api.client.customizations.remove({ params: { id: entry.id } })
    }
    catch (error) {
      if ((error as { code?: unknown }).code !== 'not_found')
        throw error
    }
  }
}

/**
 * Removes the personal definitions of this kind and name after the test (also those the test creates through the UI,
 * and re-creations by Undo). Register it before the definition is made.
 */
export function cleanupPersonalDefinition(cleanup: (task: CleanupTask) => void, kind: CustomizationKind, name: string): void {
  cleanup(api => removePersonalDefinitions(api, kind, name))
}

/** Creates a personal definition through the API (`POST /api/customizations`), removed again through `cleanup`. */
export async function createPersonalDefinition(
  api: HarnessApi,
  cleanup: (task: CleanupTask) => void,
  input: { kind: CustomizationKind, name: string, content: string, enabled?: boolean },
): Promise<Customization> {
  cleanupPersonalDefinition(cleanup, input.kind, input.name)
  return api.client.customizations.create({ body: { kind: input.kind, content: input.content, ...(input.enabled === undefined ? {} : { enabled: input.enabled }) } })
}

/** The personal definition of this kind and name (fails when there is none). */
export async function personalDefinition(api: HarnessApi, kind: CustomizationKind, name: string): Promise<Customization> {
  const { items } = await api.client.customizations.list({ query: { kind } })
  const entry = items.find(item => item.source === 'user' && item.name === name)
  if (!entry?.id)
    throw new Error(`No personal ${kind} named ${name}.`)
  return api.client.customizations.get({ params: { id: entry.id } })
}

// ---------- plugins with agents and skills ----------

type PluginManifest = Parameters<HarnessApi['client']['pluginDrafts']['create']>[0]['body']['manifest']

/** A declarative plugin manifest for plugin API 1.4.0 (`engines.harness` `^1.4.0`) with these contributions. */
export function customizationPluginManifest(id: string, name: string, contributes: Readonly<Record<string, unknown>>): PluginManifest {
  return {
    manifestVersion: 1,
    id,
    name,
    version: '1.0.0',
    description: `End-to-end plugin ${name}.`,
    engines: { harness: '^1.4.0' },
    contributes,
  } as unknown as PluginManifest
}

/** Creates a declarative plugin (`POST /api/plugins`), uninstalled again through `cleanup`. */
export async function createCustomizationPlugin(api: HarnessApi, cleanup: (task: CleanupTask) => void, manifest: PluginManifest): Promise<void> {
  const id = (manifest as { id: string }).id
  cleanup(async (api) => {
    try {
      await api.client.plugins.remove({ params: { id }, query: {} })
    }
    catch (error) {
      if ((error as { code?: unknown }).code !== 'not_found')
        throw error
    }
  })
  const plugin = await api.client.pluginDrafts.create({ body: { manifest } })
  expect(plugin.state, `plugin ${id} is active`).toBe('active')
}

// ---------- settings ----------

/** The plan-file keys of Settings -> General -> Agent (docs/UI.md 9.11, Phase 10). */
export type PlanSettings = Pick<Settings, 'planFiles' | 'planDirectory'>

/** Changes the plan-file settings for one test and restores them through `cleanup` (registered first). */
export async function usePlanSettings(api: HarnessApi, cleanup: (task: CleanupTask) => void, patch: Partial<PlanSettings>): Promise<void> {
  const settings = await api.getSettings()
  const before: PlanSettings = { planFiles: settings.planFiles, planDirectory: settings.planDirectory }
  cleanup(() => api.updateSettings(before))
  await api.updateSettings(patch)
}

// ---------- the Customize page ----------

/** A row of the Customize page (`customization-row`) by its data attributes, e.g. `{ 'data-source': 'user', 'data-name': x }`. */
export function customizationRow(scope: Page | Locator, attributes: DataAttributes): Locator {
  return byTestId(scope, testIds.customizationRow, attributes)
}

/** A section of the Customize page by source (`user` / `project` / `plugin` / `builtin`). */
export function customizeSection(page: Page, source: 'user' | 'project' | 'plugin' | 'builtin'): Locator {
  return byTestId(page, testIds.customizeSection, { 'data-source': source })
}

/**
 * Opens the `⋯` menu of a row and picks an item by its test id (`customization-edit`, `customization-toggle`, …). The
 * row emits the action once the menu has closed.
 */
export async function chooseRowAction(page: Page, row: Locator, item: string): Promise<void> {
  await row.getByTestId(testIds.customizationRowMenu).click()
  const menuItem = page.getByRole('menu').getByTestId(item)
  await expect(menuItem).toBeVisible()
  await menuItem.click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}

/** Picks a project (or "No project" for null) in the Customize page's Project select and waits for `?project=`. */
export async function selectCustomizeProject(page: Page, projectId: string | null): Promise<void> {
  const select = page.getByTestId(testIds.customizeProjectSelect)
  await select.click()
  await page.getByRole('option').and(page.locator(`[data-value="${projectId ?? ''}"]`)).click()
  await expect(select).toHaveAttribute('data-value', projectId ?? '')
  if (projectId)
    await expect(page).toHaveURL(new RegExp(`[?&]project=${projectId}(?:&|$)`))
  else
    await expect(page).not.toHaveURL(/[?&]project=/)
}

/** The editable area of a `MarkdownEditor` (CodeMirror's `.cm-content`, or the textarea fallback). */
export function markdownEditorInput(editor: Locator): Locator {
  return editor.locator('.cm-content').or(editor.locator('textarea'))
}

/**
 * Replaces the text of a `MarkdownEditor` (the body of the Customize editor). `insertText` sends the whole string as
 * one input, so CodeMirror's auto-indent and bracket closing leave it unchanged; `ControlOrMeta+A` follows the host,
 * like CodeMirror's own `Mod` (docs: e2e/README.md "Keyboard").
 */
export async function fillMarkdownEditor(page: Page, editor: Locator, text: string): Promise<void> {
  await expect(editor).toHaveAttribute('data-ready', 'true')
  await markdownEditorInput(editor).click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(text)
}

// ---------- background agents (docs/UI.md 7.29) ----------

/** The dock's background agents list. */
export function backgroundAgents(page: Page): Locator {
  return page.getByTestId(testIds.backgroundAgents)
}

/** A row of the dock list, e.g. `{ 'data-state': 'running' }`. */
export function backgroundAgentRow(page: Page, attributes: DataAttributes = {}): Locator {
  return byTestId(page, testIds.backgroundAgent, attributes)
}

/** Opens the dock list when it is closed (the toggle line). */
export async function openBackgroundAgents(page: Page): Promise<Locator> {
  const list = backgroundAgents(page)
  await expect(list).toBeVisible()
  if (await list.getAttribute('data-state') !== 'open')
    await list.getByTestId(testIds.backgroundAgentsToggle).click()
  await expect(list).toHaveAttribute('data-state', 'open')
  return list
}

/** The background tasks of a chat (`GET /api/chat/:id/tasks`). */
export async function chatTasks(api: HarnessApi, chatId: string): Promise<BackgroundTask[]> {
  return (await api.client.chatTasks.list({ params: { id: chatId } })).items
}

/** Polls the chat's tasks until one matches (`{ status: 'running' }` …) and returns it. */
export async function waitForChatTask(
  api: HarnessApi,
  chatId: string,
  match: (task: BackgroundTask) => boolean,
  options: { timeout?: number, message?: string } = {},
): Promise<BackgroundTask> {
  let found: BackgroundTask | undefined
  await expect.poll(async () => {
    found = (await chatTasks(api, chatId)).find(match)
    return found !== undefined
  }, { timeout: options.timeout ?? 15_000, message: options.message ?? `a background task of chat ${chatId} matches` }).toBe(true)
  return found!
}

/** Stops every running background task of a chat (for `cleanup`; a gone chat is fine). */
export async function stopChatTasks(api: HarnessApi, chatId: string): Promise<void> {
  let tasks: BackgroundTask[]
  try {
    tasks = await chatTasks(api, chatId)
  }
  catch (error) {
    if ((error as { code?: unknown }).code === 'not_found')
      return
    throw error
  }
  for (const task of tasks) {
    if (task.status !== 'running')
      continue
    await api.client.chatTasks.stop({ params: { id: chatId, taskId: task.id } }).catch(() => {})
  }
}
