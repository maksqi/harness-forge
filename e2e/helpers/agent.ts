// Agent 2.0 helpers for the Phase 9 specs (docs/UI.md 2.16, 7.24 – 7.27, 13.10; docs/PROVIDERS.md 8 "Agent mocks
// (Phase 9)"): what the agent mocks write and answer, the Agent settings, a project chat, messages queued through the
// API while a run is active, the composer's polite live region, and a state recorder for UI states that last only a few
// hundred milliseconds.
//
// Why a recorder: Playwright's web-first assertions retry after 100, 250, 500 and then every 1000 ms, so a state that
// lasts 400 ms (a step of `mock:todo` or `mock:steer`) can fall between two checks. `recordStates` installs a
// MutationObserver (an init script, so it also survives a reload) that writes every distinct snapshot of the matching
// elements into the page; the spec reads the whole history afterwards and asserts the order of the states.
import type { Locator, Page } from '@playwright/test'
import type { QueueItem, Settings, ToolMode } from '../../packages/shared/src/index.ts'
import type { HarnessApi } from './api.ts'
import type { CleanupTask } from './fixtures.ts'
import type { TestId } from './testids.ts'
import type { SeededProject, SeedFolderOptions } from './workspace.ts'
import { expect } from '@playwright/test'
import { createMessageId } from '../../packages/shared/src/index.ts'
import { composer } from './chat.ts'
import { testIdSelector } from './locators.ts'
import { seedProject } from './workspace.ts'

// ---------- the agent mocks (docs/PROVIDERS.md 8) ----------

/** The three items of `mock:todo` (content, then the in-progress wording). */
export const MOCK_TODO_ITEMS = [
  { id: '1', content: 'Read the code', activeForm: 'Reading the code' },
  { id: '2', content: 'Change the code', activeForm: 'Changing the code' },
  { id: '3', content: 'Run the tests', activeForm: 'Running the tests' },
] as const
/** The last answer of a `mock:todo` run. */
export const MOCK_TODO_DONE = 'All 3 tasks done.'

/** The two items of the `todo_write` call of `mock:plan`: the first in progress, the second to do. */
export const MOCK_PLAN_TODOS = [
  { id: '1', content: 'Explore the project', activeForm: 'Exploring the project' },
  { id: '2', content: 'Write the plan', activeForm: 'Writing the plan' },
] as const
/** The file `mock:plan` writes once its plan is approved, and its content. */
export const MOCK_PLAN_FILE = 'notes.txt'
export const MOCK_PLAN_FILE_CONTENT = 'Planned and done.\n'
/** The heading of the first plan and of a revised plan. */
export const MOCK_PLAN_HEADING = 'Plan'
export const MOCK_PLAN_REVISED_HEADING = 'Plan (revised)'
/** The answer of `mock:plan` after the approved plan ran. */
export function mockPlanDone(mode: 'edits' | 'ask'): string {
  return `Plan done in mode ${mode}.`
}
/** The answer of `mock:plan` to "Keep planning" with feedback (then a new plan card). */
export function mockPlanRevising(reason: string): string {
  return `Revising: ${reason}`
}

/** The default two `task` calls of `mock:subagent` (explore, then general). */
export const MOCK_SUBAGENT_TASKS = [
  { description: 'List the project files', prompt: 'List the project files.', kind: 'explore' },
  { description: 'Check the time', prompt: 'Check the time.', kind: 'general' },
] as const
/** The file a general sub-agent of `mock:subagent` writes when the user text contains `write` (Accept edits). */
export const MOCK_SUBAGENT_FILE = 'subagent.txt'
export const MOCK_SUBAGENT_FILE_CONTENT = 'Written by a sub-agent.\n'

/** The final answer of a `mock:steer` turn `steps <n>` that received these steers. */
export function mockSteerFinished(steps: number, steers: readonly string[]): string {
  return `Finished ${steps} steps. Steers: ${steers.length > 0 ? steers.join(' | ') : 'none'}`
}

/**
 * A user text for `mock:compact` that fills its 2000-token context window quickly: the echo of the text plus 150
 * filler words per turn, about 760 estimated tokens. Two such turns stay below 80 % of the window (no compaction yet);
 * the third passes it (an automatic compaction before the reply, or with `autoCompact` off the trimming notice).
 */
export function compactFiller(label: string): string {
  return `${label} ${Array.from({ length: 24 }, (_, index) => `w${index}`.padEnd(40, 'x')).join(' ')}`
}

// ---------- settings ----------

/** The keys of Settings -> General -> Agent and the Shift+Tab switch (docs/UI.md 9.11). */
export const AGENT_SETTINGS_KEYS = ['autoCompact', 'compactModelRef', 'subagentModelRef', 'subagentMaxSteps', 'shiftTabModes'] as const
export type AgentSettings = Pick<Settings, (typeof AGENT_SETTINGS_KEYS)[number]>

/** The Agent keys of a `Settings` (restore them with `cleanup(api => api.updateSettings(before))`). */
export function agentSettingsOf(settings: Settings): AgentSettings {
  return {
    autoCompact: settings.autoCompact,
    compactModelRef: settings.compactModelRef,
    subagentModelRef: settings.subagentModelRef,
    subagentMaxSteps: settings.subagentMaxSteps,
    shiftTabModes: settings.shiftTabModes,
  }
}

/**
 * Changes Agent settings for one test: the current values are restored through `cleanup` (registered first), e.g.
 * `await useAgentSettings(api, cleanup, { subagentModelRef: 'mock:subagent' })`.
 */
export async function useAgentSettings(api: HarnessApi, cleanup: (task: CleanupTask) => void, patch: Partial<AgentSettings>): Promise<void> {
  const before = agentSettingsOf(await api.getSettings())
  // This `api` (not the fixture's): it may belong to another server, e.g. a password server of the spec.
  cleanup(() => api.updateSettings(before))
  await api.updateSettings(patch)
}

// ---------- chats ----------

export interface ProjectChat extends SeededProject {
  /** The chat in the project (removed through `cleanup`). */
  chatId: string
}

/** A seeded project (`seedProject`) and an empty chat in it with `modelRef`, everything undone through `cleanup`. */
export async function seedProjectChat(
  api: HarnessApi,
  cleanup: (task: CleanupTask) => void,
  options: SeedFolderOptions & { modelRef: string, name?: string, title?: string },
): Promise<ProjectChat> {
  const seeded = await seedProject(api, cleanup, options)
  const chat = await api.createChat({ title: options.title ?? `Agent ${seeded.folder.name}`, projectId: seeded.project.id, modelRef: options.modelRef })
  cleanup(api => api.removeChat(chat.id))
  return { ...seeded, chatId: chat.id }
}

export interface QueueMessageOptions {
  /** Default `mock:steer`. */
  modelRef?: string
  /** Default `ask`. */
  toolMode?: ToolMode
  /** How long to retry while the run has not started yet (409 `run-idle`), default 10 s. */
  timeout?: number
}

/**
 * Queues a user message through `POST /api/chat/:id/queue` (docs/API.md 4.26) while a run of the chat is active,
 * retrying the 409 `run-idle` of a run that has not started yet (start the run without awaiting it, e.g.
 * `const run = api.sendChat({ ... })`, then queue, then `await run`). Resolves to the queue item.
 */
export async function queueMessage(api: HarnessApi, chatId: string, text: string, options: QueueMessageOptions = {}): Promise<QueueItem> {
  const deadline = Date.now() + (options.timeout ?? 10_000)
  for (;;) {
    try {
      return await api.client.chatQueue.add({
        params: { id: chatId },
        body: {
          message: { id: createMessageId(), role: 'user', parts: [{ type: 'text', text }] },
          modelRef: options.modelRef ?? 'mock:steer',
          reasoningEffort: 'auto',
          toolMode: options.toolMode ?? 'ask',
        },
      })
    }
    catch (error) {
      const reason = (error as { details?: { reason?: unknown } }).details?.reason
      if (reason !== 'run-idle' || Date.now() > deadline)
        throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

// ---------- page ----------

/** The composer's polite live region with this text, e.g. "Permission mode: Plan" (docs/UI.md 7.11, 14.2). */
export function composerAnnouncement(page: Page, text: string): Locator {
  return composer(page).locator('[aria-live="polite"]').filter({ hasText: text })
}

/** A `data-notice` line of the transcript by its code, e.g. `context-trimmed` (docs/UI.md 13.10). */
export function noticeLine(scope: Page | Locator, code: string): Locator {
  return scope.locator(`[data-slot="notice-part"][data-code="${code}"]`)
}

/**
 * Waits until at least `count` elements (default 1) with the test id and data attributes exist, checking on every
 * animation frame (for states that last only a few hundred milliseconds, see the top of this file).
 */
export async function waitForTestId(
  page: Page,
  id: TestId,
  attributes: Readonly<Record<`data-${string}`, string>> = {},
  options: { count?: number, timeout?: number } = {},
): Promise<void> {
  // A function, not a string: the app's CSP forbids `eval`, which a string predicate needs.
  await page.waitForFunction(([selector, count]) => {
    const { document } = globalThis as unknown as { document: { querySelectorAll: (selector: string) => { length: number } } }
    return document.querySelectorAll(selector).length >= count
  }, [testIdSelector(id, attributes), options.count ?? 1] as const, { timeout: options.timeout ?? 15_000, polling: 'raf' })
}

export interface StateRecorder {
  /** Every distinct snapshot so far, oldest first (`''` = no matching element). */
  states: () => Promise<string[]>
}

/**
 * Records every distinct snapshot of the elements with test id `id` from now on, also across reloads (an init script
 * plus the current document). `snapshot` is the body of a function of `el` (one matching element) returning a string,
 * e.g. `"el.dataset.state + ' ' + el.dataset.value"`; the snapshot of the page is the elements' strings joined with
 * `" || "`. Call it before the state changes start (before sending the message).
 */
export async function recordStates(page: Page, name: string, id: TestId, snapshot: string): Promise<StateRecorder> {
  return recordSelectorStates(page, name, testIdSelector(id), snapshot)
}

/** `recordStates` for a CSS selector (documented hooks that are not test ids, such as the live regions). */
export async function recordSelectorStates(page: Page, name: string, selector: string, snapshot: string): Promise<StateRecorder> {
  const script = `(() => {
    const all = (window.__hfRecorders ??= {})
    if (all[${JSON.stringify(name)}]) return
    const states = (all[${JSON.stringify(name)}] = [])
    const read = (el) => { ${snapshot.includes('return') ? snapshot : `return String(${snapshot})`} }
    const take = () => {
      const value = [...document.querySelectorAll(${JSON.stringify(selector)})].map(read).join(' || ')
      if (states.length === 0 || states[states.length - 1] !== value) states.push(value)
    }
    take()
    new MutationObserver(take).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  })()`
  await page.addInitScript({ content: script })
  await page.evaluate(script)
  return {
    states: () => page.evaluate<string[]>(`[...(window.__hfRecorders?.[${JSON.stringify(name)}] ?? [])]`),
  }
}

/**
 * Records what the polite live regions announce (docs/UI.md 14.2: the chat view's `role="status"` region and the
 * composer's region). A region holds only its latest text ("Response finished" replaces "Conversation compacted" a
 * moment later), so specs check the history with `expectAnnounced`.
 */
export function recordAnnouncements(page: Page): Promise<StateRecorder> {
  return recordSelectorStates(page, 'announcements', '[aria-live="polite"]', `return el.textContent.replace(/\\s+/g, ' ').trim()`)
}

/** Waits until a recorded live region announced `text` (see `recordAnnouncements`). */
export async function expectAnnounced(recorder: StateRecorder, text: string): Promise<void> {
  // Announcements made within one tick are joined with ". " ("Conversation compacted. Response finished").
  const said = (region: string) => region === text || region.startsWith(`${text}. `) || region.endsWith(`. ${text}`) || region.includes(`. ${text}. `)
  await expect.poll(async () => (await recorder.states()).some(state => state.split(' || ').some(said)), { message: `"${text}" was announced` }).toBe(true)
}

/**
 * Asserts that `states` contains snapshots matching every pattern, in this order (other snapshots may come between).
 */
export function expectStatesInOrder(states: readonly string[], patterns: readonly (string | RegExp)[], message: string): void {
  let from = 0
  for (const pattern of patterns) {
    const index = states.findIndex((state, at) => at >= from && (typeof pattern === 'string' ? state === pattern : pattern.test(state)))
    expect(index, `${message}: ${String(pattern)} after snapshot ${from} in ${JSON.stringify(states)}`).toBeGreaterThanOrEqual(0)
    from = index + 1
  }
}
